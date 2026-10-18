//! Read-only Codex adapter. Raw payloads never enter its public output types.

mod decode;
mod process;
mod tail;
mod watch;

pub use decode::{Diagnostics, RolloutStream};
pub use process::{match_process, process_event, ProcessMatch};
pub use tail::{RolloutTailer, TailCheckpoint};

use std::{collections::BTreeMap, ffi::OsString, path::{Path, PathBuf}, time::{Duration, Instant}};
use collector::{Adapter, AdapterContext, AdapterError};
use collector::contracts::{AgentEvent, common::Tool};
use watch::RolloutWatch;

/// At most one existence check per interval while a provisional root waits for its folder.
const ATTACH_EVERY: Duration = Duration::from_secs(1);
/// A folder that exists but cannot be watched is retried this many times, then given up on.
const ATTACH_TRIES: u8 = 5;

/// A configured root whose folder did not exist yet. The root path itself lives in `CodexAdapter::root`.
struct Pending { last_check: Option<Instant>, failures: u8 }

/// One connector for one explicitly configured Codex sessions root.
#[derive(Default)]
pub struct CodexAdapter {
    diagnostics: Diagnostics,
    watch: Option<RolloutWatch>,
    root: Option<PathBuf>,
    pending: Option<Pending>,
    sessions: BTreeMap<String, decode::Session>,
    /// The service's waker, shared with the rollout watch's notice callback (review r1 M5).
    waker: std::sync::Arc<std::sync::Mutex<Option<collector::Waker>>>,
}

impl CodexAdapter {
    pub fn new() -> Self { Self::default() }

    /// Watch a sessions root. Does not inspect config, credentials, or notify.
    pub fn watch(root: impl AsRef<Path>) -> Result<Self, AdapterError> {
        let mut adapter = Self::for_root(root)?;
        adapter.watch = Some(RolloutWatch::new(adapter.root.as_ref().unwrap(), adapter.waker.clone())?);
        Ok(adapter)
    }

    /// Like `watch`, but a sessions root (or some of its ancestors) that does not exist yet is accepted.
    /// The adapter then maps hooks at once and attaches its watcher from a later `poll`, at most one
    /// existence check per second. The root identity is the path `canonicalize` will return once the
    /// folder exists (nearest existing ancestor canonicalized, missing names appended), so the
    /// connector id does not change when the folder appears. Symlinks on the existing part and `..`
    /// anywhere are rejected, as everywhere else.
    pub fn watch_or_wait(root: impl AsRef<Path>) -> Result<Self, AdapterError> {
        let root = root.as_ref();
        let absolute = tail::absolute(root)?;
        match std::fs::symlink_metadata(&absolute) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::provisional(&absolute),
            _ => Self::watch(root).or_else(|_| Self::for_root(root)),
        }
    }

    fn provisional(absolute: &Path) -> Result<Self, AdapterError> {
        tail::reject_symlinks(absolute)?;
        let mut missing: Vec<OsString> = Vec::new();
        let mut base = absolute;
        loop {
            match std::fs::symlink_metadata(base) {
                Ok(metadata) if metadata.is_dir() => break,
                Ok(_) => return Err(AdapterError::InvalidPayload),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Only plain names can be missing: `..` was rejected by `absolute`, a root has no name.
                    missing.push(base.file_name().ok_or(AdapterError::InvalidPayload)?.to_owned());
                    base = base.parent().ok_or(AdapterError::InvalidPayload)?;
                },
                Err(_) => return Err(AdapterError::Io),
            }
        }
        let mut canonical = std::fs::canonicalize(base).map_err(|_| AdapterError::Io)?;
        canonical.extend(missing.iter().rev());
        Ok(Self { root: Some(canonical), pending: Some(Pending { last_check: None, failures: 0 }), ..Self::default() })
    }

    /// Attach the watcher once the provisional folder exists. Never blocks beyond one `symlink_metadata`.
    fn attach_if_due(&mut self, force: bool) {
        let Some(pending) = self.pending.as_mut() else { return; };
        if self.watch.is_some() { self.pending = None; return; }
        if !force && pending.last_check.is_some_and(|at| at.elapsed() < ATTACH_EVERY) { return; }
        pending.last_check = Some(Instant::now());
        let Some(root) = self.root.clone() else { self.pending = None; return; };
        match std::fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => { self.attach_failed(true); return; },
            Ok(_) => {},
        }
        // The identity must not change: attach only if the real path is exactly the stored one.
        let same = tail::reject_symlinks(&root).is_ok() && std::fs::canonicalize(&root).is_ok_and(|real| real == root);
        if !same { self.attach_failed(true); return; }
        match RolloutWatch::new(&root, self.waker.clone()) {
            Ok(watch) => { self.watch = Some(watch); self.pending = None; },
            Err(_) => self.attach_failed(false),
        }
    }

    fn attach_failed(&mut self, final_failure: bool) {
        self.diagnostics.io_errors = self.diagnostics.io_errors.saturating_add(1);
        if let Some(pending) = self.pending.as_mut() {
            pending.failures = pending.failures.saturating_add(1);
            if final_failure || pending.failures >= ATTACH_TRIES { self.pending = None; }
        }
    }

    /// Hook-only connectors still need an explicitly configured data root.
    pub fn for_root(root: impl AsRef<Path>) -> Result<Self, AdapterError> {
        let root = tail::absolute(root.as_ref())?;
        tail::reject_symlinks(&root)?;
        let canonical = std::fs::canonicalize(&root).map_err(|_| AdapterError::Io)?;
        tail::reject_symlinks(&root)?;
        Ok(Self { root: Some(canonical), ..Self::default() })
    }

    pub fn root_id(&self, ctx: &AdapterContext) -> String {
        let root = self.root.as_ref().map(|p| p.to_string_lossy()).unwrap_or_else(|| "unconfigured-synthetic-root".into());
        ctx.instance(Tool::Codex, &root)
    }

    pub fn diagnostics(&self) -> Diagnostics { self.diagnostics }

    /// One newline-free record. Content-bearing fields are skipped by serde.
    /// Bad records and unknown vocabulary produce counters, never parser text.
    pub fn decode_record(&mut self, stream: &mut RolloutStream, line: &[u8], ctx: &AdapterContext)
        -> Result<Vec<AgentEvent>, AdapterError>
    {
        let root = self.root_id(ctx);
        let events = decode::record(stream, line, ctx, &root, &mut self.diagnostics)?;
        if let Some(session) = &stream.session { self.sessions.insert(session.instance.clone(), session.clone()); }
        Ok(events)
    }
}

impl Adapter for CodexAdapter {
    fn tool(&self) -> Tool { Tool::Codex }

    fn set_waker(&mut self, waker: collector::Waker) {
        if let Ok(mut slot) = self.waker.lock() { *slot = Some(waker); }
    }

    fn map_hook(&mut self, body: &[u8], ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        let root = self.root_id(ctx);
        decode::hook(body, ctx, &root, &self.sessions, &mut self.diagnostics)
    }

    fn rebuild(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        self.attach_if_due(true);
        let Some(mut watch) = self.watch.take() else { return Ok(Vec::new()); };
        let result = watch.rebuild(self, ctx);
        self.watch = Some(watch);
        result
    }

    fn poll(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        self.attach_if_due(false);
        let Some(mut watch) = self.watch.take() else { return Ok(Vec::new()); };
        let result = watch.poll(self, ctx);
        self.watch = Some(watch);
        result
    }
}
