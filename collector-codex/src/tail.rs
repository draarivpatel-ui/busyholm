use std::{fs::{self, File}, io::{Read, Seek, SeekFrom}, path::{Component, Path, PathBuf}};
#[cfg(windows)]
use std::fs::OpenOptions;
use collector::{AdapterContext, AdapterError};
use collector::contracts::AgentEvent;
use serde::{Deserialize, Serialize};
use crate::{CodexAdapter, RolloutStream};

pub(crate) const MAX_LINE: usize = 1_048_576;
const READ_BUDGET: usize = MAX_LINE + 65_536;
const RECORD_BUDGET: usize = 128;
const BACKFILL: u64 = 65_536;
/// A rollout last written this long ago is history: the startup scan skips it, and a file attached later drops
/// records this old instead of replaying them as new work.
pub(crate) const RECENT_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct FileIdentity { device: u64, file: u64 }

/// Persist only offsets, file identity, hashes and counts. Never a path or partial line.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TailCheckpoint {
    pub offset: u64,
    identity: Option<FileIdentity>,
    stream: RolloutStream,
    discarding: bool,
}

pub struct RolloutTailer {
    path: PathBuf,
    checkpoint: TailCheckpoint,
    recent: bool,
    live_only: bool,
    pub(crate) needs_more: bool,
}

impl RolloutTailer {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, AdapterError> {
        let path = absolute(path.as_ref())?;
        validate_rollout_path(&path)?;
        reject_symlinks(&path)?;
        if fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.is_file()) {
            return Err(AdapterError::InvalidPayload);
        }
        Ok(Self { path, checkpoint: TailCheckpoint::default(), recent: false, live_only: false, needs_more: false })
    }

    pub fn resume(path: impl AsRef<Path>, checkpoint: TailCheckpoint) -> Result<Self, AdapterError> {
        if !checkpoint.stream.valid() { return Err(AdapterError::InvalidPayload); }
        let mut tailer = Self::new(path)?;
        tailer.checkpoint = checkpoint;
        Ok(tailer)
    }

    pub(crate) fn recent(path: &Path) -> Result<Self, AdapterError> {
        let mut tailer = Self::new(path)?; tailer.recent = true; Ok(tailer)
    }

    /// A file first seen after startup (new, resumed or long idle), without records older than `RECENT_MS`: all of it
    /// when its session began within `RECENT_MS`, else its recent tail.
    pub(crate) fn live(path: &Path) -> Result<Self, AdapterError> {
        let mut tailer = Self::recent(path)?; tailer.live_only = true; Ok(tailer)
    }

    pub fn checkpoint(&self) -> TailCheckpoint { self.checkpoint.clone() }

    pub fn poll(&mut self, adapter: &mut CodexAdapter, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        let mut file = open_readonly(&self.path)?;
        let metadata = file.metadata().map_err(|_| AdapterError::Io)?;
        if !metadata.is_file() { return Err(AdapterError::InvalidPayload); }
        let identity = file_identity(&file)?;
        if self.checkpoint.stream.session.as_ref().is_some_and(|session| session.root_id != adapter.root_id(ctx))
            || self.checkpoint.identity.is_some_and(|previous| previous != identity)
            || metadata.len() < self.checkpoint.offset
        {
            self.checkpoint = TailCheckpoint::default(); self.recent = false;
        }
        self.checkpoint.identity = Some(identity);
        let mut events = Vec::new();
        if self.recent {
            // Recover the session hash from the bounded header before the recent tail.
            let header = read_header(&mut file)?;
            let mut fresh = false;
            if let Some((line, end)) = header {
                let mapped = adapter.decode_record(&mut self.checkpoint.stream, &line, ctx)?;
                // A file met after startup whose session began recently is a new session: read all of it. Only an
                // old session resumed skips its history.
                let now = ctx.now_ms();
                fresh = self.live_only && mapped.iter().any(|e| e.et.is_some_and(|et| now.saturating_sub(et) <= RECENT_MS));
                events.extend(mapped);
                self.checkpoint.offset = end;
            }
            if !fresh && metadata.len() > BACKFILL && metadata.len() - BACKFILL > self.checkpoint.offset {
                let start = metadata.len() - BACKFILL;
                self.checkpoint.offset = next_newline(&mut file, start, metadata.len())?;
            }
            self.recent = false;
        }
        file.seek(SeekFrom::Start(self.checkpoint.offset)).map_err(|_| AdapterError::Io)?;
        let start = self.checkpoint.offset;
        let mut position = start;
        let mut consumed = 0;
        let mut records = 0;
        let mut line = Vec::new();
        let mut buffer = [0u8; 16_384];
        self.needs_more = false;
        'reading: while consumed < READ_BUDGET {
            let count = file.read(&mut buffer[..(READ_BUDGET - consumed).min(16_384)])
                .map_err(|_| AdapterError::Io)?;
            if count == 0 { break; }
            consumed += count;
            for &byte in &buffer[..count] {
                position += 1;
                if byte == b'\n' {
                    // CRLF files: a blank CRLF line is blank, not a malformed record.
                    if line.last() == Some(&b'\r') { line.pop(); }
                    if !self.checkpoint.discarding && !line.is_empty() {
                        events.extend(adapter.decode_record(&mut self.checkpoint.stream, &line, ctx)?);
                    }
                    self.checkpoint.discarding = false;
                    self.checkpoint.offset = position;
                    line.clear();
                    records += 1;
                    if records == RECORD_BUDGET {
                        self.needs_more = position < metadata.len();
                        break 'reading;
                    }
                } else if self.checkpoint.discarding {
                    self.checkpoint.offset = position;
                } else if line.len() == MAX_LINE {
                    adapter.diagnostics.oversized_lines = adapter.diagnostics.oversized_lines.saturating_add(1);
                    self.checkpoint.discarding = true;
                    self.checkpoint.offset = position;
                    line.clear();
                } else { line.push(byte); }
            }
        }
        // An incomplete allowed-size last line is re-read after the next append.
        // Oversized lines retain only the skip flag and byte offset across calls.
        self.needs_more |= consumed == READ_BUDGET && self.checkpoint.offset > start;
        if self.live_only {
            let now = ctx.now_ms();
            events.retain(|e| e.et.is_none_or(|et| now.saturating_sub(et) <= RECENT_MS));
        }
        Ok(events)
    }
}

fn read_header(file: &mut File) -> Result<Option<(Vec<u8>, u64)>, AdapterError> {
    file.seek(SeekFrom::Start(0)).map_err(|_| AdapterError::Io)?;
    let mut line = Vec::new();
    let mut buffer = [0u8; 4096];
    while line.len() <= MAX_LINE {
        let count = file.read(&mut buffer).map_err(|_| AdapterError::Io)?;
        if count == 0 { return Ok(None); }
        if let Some(end) = buffer[..count].iter().position(|byte| *byte == b'\n') {
            line.extend_from_slice(&buffer[..end]);
            let offset = line.len() as u64 + 1;
            return Ok((line.len() <= MAX_LINE).then_some((line, offset)));
        }
        line.extend_from_slice(&buffer[..count]);
    }
    Ok(None)
}

fn next_newline(file: &mut File, start: u64, end: u64) -> Result<u64, AdapterError> {
    file.seek(SeekFrom::Start(start)).map_err(|_| AdapterError::Io)?;
    let mut buffer = [0u8; 4096]; let mut at = start;
    while at < end {
        let count = file.read(&mut buffer).map_err(|_| AdapterError::Io)?;
        if count == 0 { break; }
        if let Some(index) = buffer[..count].iter().position(|byte| *byte == b'\n') { return Ok(at + index as u64 + 1); }
        at += count as u64;
    }
    Ok(end)
}

pub(crate) fn absolute(path: &Path) -> Result<PathBuf, AdapterError> {
    let path = if path.is_absolute() { path.to_owned() } else {
        std::env::current_dir().map_err(|_| AdapterError::Io)?.join(path)
    };
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AdapterError::InvalidPayload);
    }
    Ok(path)
}

pub(crate) fn rollout_name(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name|
        name.starts_with("rollout-") && name.ends_with(".jsonl") && name.len() > "rollout-.jsonl".len())
}

fn validate_rollout_path(path: &Path) -> Result<(), AdapterError> {
    if !rollout_name(path) || path.components().any(|part| part.as_os_str() == "tool-results") {
        return Err(AdapterError::InvalidPayload);
    }
    Ok(())
}

pub(crate) fn reject_symlinks(path: &Path) -> Result<(), AdapterError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() { return Err(AdapterError::InvalidPayload); }
                #[cfg(windows)] {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        return Err(AdapterError::InvalidPayload);
                    }
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err(AdapterError::Io),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn open_readonly(path: &Path) -> Result<File, AdapterError> {
    use std::{ffi::CString, os::{fd::{AsRawFd, FromRawFd}, unix::ffi::OsStrExt}};
    // Walk each component relative to an already opened directory descriptor.
    // O_NOFOLLOW on every open prevents symlink replacement races on Unix.
    let mut directory = File::open("/").map_err(|_| AdapterError::Io)?;
    let parts: Vec<_> = path.components().filter_map(|c| if let Component::Normal(s) = c { Some(s) } else { None }).collect();
    for (index, part) in parts.iter().enumerate() {
        let name = CString::new(part.as_bytes()).map_err(|_| AdapterError::InvalidPayload)?;
        let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
            | if index + 1 < parts.len() { libc::O_DIRECTORY } else { 0 };
        // SAFETY: directory owns a live fd and name is a nul-terminated component.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 { return Err(AdapterError::Io); }
        // SAFETY: openat returned a new owned descriptor, transferred exactly once.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(windows)]
fn open_readonly(path: &Path) -> Result<File, AdapterError> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_SHARE_DELETE};
    reject_symlinks(path)?;
    let file = OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(|_| AdapterError::Io)?;
    if file.metadata().map_err(|_| AdapterError::Io)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(AdapterError::InvalidPayload);
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_readonly(_path: &Path) -> Result<File, AdapterError> { Err(AdapterError::Unsupported) }

#[cfg(unix)]
fn file_identity(file: &File) -> Result<FileIdentity, AdapterError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| AdapterError::Io)?;
    Ok(FileIdentity { device: metadata.dev(), file: metadata.ino() })
}

#[cfg(windows)]
fn file_identity(file: &File) -> Result<FileIdentity, AdapterError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: file owns a live HANDLE and info is writable for the duration of the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 { return Err(AdapterError::Io); }
    Ok(FileIdentity { device: u64::from(info.dwVolumeSerialNumber),
        file: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow) })
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> Result<FileIdentity, AdapterError> { Err(AdapterError::Unsupported) }
