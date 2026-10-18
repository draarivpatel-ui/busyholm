use std::{collections::{BTreeMap, BTreeSet, VecDeque}, fs::{self, ReadDir}, path::{Path, PathBuf},
    sync::{mpsc::{self, Receiver}, Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use collector::{AdapterContext, AdapterError};
use collector::contracts::AgentEvent;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use crate::{CodexAdapter, RolloutTailer, tail::{absolute, reject_symlinks, rollout_name}};

const MAX_NOTICES: usize = 64;
const MAX_ENTRIES: usize = 128;
const MAX_FILES: usize = 16;
const BACKSTOP: Duration = Duration::from_secs(2);
/// Hard cap on the polls one rebuild may run while draining startup history.
const REBUILD_PASSES: usize = 256;

/// The directory is opened only when the scan reaches the front of the queue, so pending scans hold no descriptor.
struct DirectoryScan { path: PathBuf, depth: usize, entries: Option<ReadDir>, recent: bool }

pub(crate) struct RolloutWatch {
    root: PathBuf,
    _watcher: RecommendedWatcher,
    notices: Receiver<notify::Result<Event>>,
    dropped: Arc<AtomicBool>,
    tails: BTreeMap<PathBuf, RolloutTailer>,
    ready: VecDeque<PathBuf>,
    queued: BTreeSet<PathBuf>,
    scans: VecDeque<DirectoryScan>,
    last_scan: Instant,
}

impl RolloutWatch {
    /// `waker` is filled by the service (`Adapter::set_waker`); a notice wakes it so the new lines are polled at once
    /// instead of at the next period (review r1 M5).
    pub fn new(root: &Path, waker: Arc<std::sync::Mutex<Option<collector::Waker>>>) -> Result<Self, AdapterError> {
        let root = absolute(root)?; reject_symlinks(&root)?;
        if !fs::symlink_metadata(&root).map_err(|_| AdapterError::Io)?.is_dir() { return Err(AdapterError::InvalidPayload); }
        let (sender, notices) = mpsc::sync_channel(128);
        let dropped = Arc::new(AtomicBool::new(false)); let overflow = Arc::clone(&dropped);
        let mut watcher = RecommendedWatcher::new(move |event: notify::Result<Event>| {
            if sender.try_send(event).is_err() { overflow.store(true, Ordering::Relaxed); }
            if let Some(waker) = waker.lock().ok().and_then(|w| w.clone()) { waker.wake(); }
        }, Config::default().with_follow_symlinks(false)).map_err(|_| AdapterError::Unavailable)?;
        watcher.watch(&root, RecursiveMode::Recursive).map_err(|_| AdapterError::Unavailable)?;
        let entries = fs::read_dir(&root).map_err(|_| AdapterError::Io)?;
        let scans = VecDeque::from([DirectoryScan { path: root.clone(), depth: 0, entries: Some(entries), recent: true }]);
        Ok(Self { root, _watcher: watcher, notices, dropped, tails: BTreeMap::new(), ready: VecDeque::new(),
            queued: BTreeSet::new(), scans, last_scan: Instant::now() })
    }

    fn queue(&mut self, path: PathBuf) {
        if self.queued.insert(path.clone()) { self.ready.push_back(path); }
    }

    fn add_file(&mut self, path: PathBuf, recent: bool) {
        if !self.tails.contains_key(&path) {
            let tailer = if recent { RolloutTailer::recent(&path) } else { RolloutTailer::new(&path) };
            let Ok(tailer) = tailer else { return; };
            self.tails.insert(path.clone(), tailer);
        }
        self.queue(path);
    }

    fn directory(&mut self, path: PathBuf, recent: bool) {
        let Ok(relative) = path.strip_prefix(&self.root) else { return; };
        let depth = relative.components().count();
        if depth > 3 || self.scans.iter().any(|scan| scan.path == path) || reject_symlinks(&path).is_err() { return; }
        self.scans.push_back(DirectoryScan { path, depth, entries: None, recent });
    }

    fn discover(&mut self, adapter: &mut CodexAdapter, ctx: &AdapterContext) {
        for _ in 0..MAX_ENTRIES {
            let Some(mut scan) = self.scans.pop_front() else { break; };
            if scan.entries.is_none() {
                match fs::read_dir(&scan.path) { Ok(entries) => scan.entries = Some(entries), Err(_) => continue }
            }
            let entry = scan.entries.as_mut().and_then(|entries| entries.next());
            let depth = scan.depth; let recent = scan.recent;
            if entry.is_some() { self.scans.push_front(scan); }
            let Some(Ok(entry)) = entry else { continue; };
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                adapter.diagnostics.io_errors = adapter.diagnostics.io_errors.saturating_add(1); continue;
            };
            if metadata.file_type().is_symlink() { continue; }
            if metadata.is_dir() && depth < 3 {
                // Only descend through the YYYY/MM/DD layout, never arbitrary agent folders.
                let name = entry.file_name(); let name = name.to_string_lossy();
                let expected = if depth == 0 { 4 } else { 2 };
                if name.len() == expected && name.bytes().all(|byte| byte.is_ascii_digit()) {
                    self.directory(entry.path(), recent);
                }
            } else if metadata.is_file() && rollout_name(&entry.path()) {
                if recent {
                    let age = metadata.modified().ok().and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|at| ctx.now_ms().saturating_sub(at.as_millis() as u64)).unwrap_or(0);
                    if age > 600_000 { continue; }
                }
                self.add_file(entry.path(), recent);
            }
        }
    }

    pub fn rebuild(&mut self, adapter: &mut CodexAdapter, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        self.directory(self.root.clone(), true);
        let mut events = self.poll(adapter, ctx)?;
        // Each poll is bounded, so startup history may need several. Drain it here so it is
        // never replayed as live work by later polls.
        for _ in 1..REBUILD_PASSES {
            if self.ready.is_empty() && self.scans.is_empty() { break; }
            events.extend(self.poll(adapter, ctx)?);
        }
        Ok(events)
    }

    pub fn poll(&mut self, adapter: &mut CodexAdapter, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        let rescan = self.dropped.swap(false, Ordering::Relaxed) || self.last_scan.elapsed() >= BACKSTOP;
        if rescan {
            // Recent only: files too old for the startup scan must not be tailed from byte 0 here.
            self.directory(self.root.clone(), true);
            let paths: Vec<_> = self.tails.keys().cloned().collect();
            for path in paths { self.queue(path); }
            self.last_scan = Instant::now();
        }
        for _ in 0..MAX_NOTICES {
            let Ok(notice) = self.notices.try_recv() else { break; };
            let event = match notice {
                Ok(event) => event,
                Err(_) => {
                    adapter.diagnostics.io_errors = adapter.diagnostics.io_errors.saturating_add(1);
                    self.directory(self.root.clone(), true); continue;
                }
            };
            if matches!(event.kind, EventKind::Access(_)) { continue; }
            for path in event.paths {
                if !path.starts_with(&self.root) { continue; }
                if rollout_name(&path) {
                    // A file notice can beat all its date-directory notices.
                    self.add_file(path, false);
                } else if fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
                    self.directory(path, false);
                }
            }
        }
        self.discover(adapter, ctx);
        let mut events = Vec::new();
        for _ in 0..MAX_FILES {
            let Some(path) = self.ready.pop_front() else { break; };
            self.queued.remove(&path);
            let Some(tailer) = self.tails.get_mut(&path) else { continue; };
            let result = tailer.poll(adapter, ctx);
            let more = tailer.needs_more;
            match result {
                Ok(mapped) => events.extend(mapped),
                // A deleted rollout is forgotten, not retried on every rescan.
                Err(_) if fs::symlink_metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) => {
                    self.tails.remove(&path); continue;
                },
                Err(_) => adapter.diagnostics.io_errors = adapter.diagnostics.io_errors.saturating_add(1),
            }
            if more { self.queue(path); }
        }
        Ok(events)
    }
}
