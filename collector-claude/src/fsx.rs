//! The only module that touches the file system or the process environment (a test
//! greps every other source file). Every call is checked against the never-open list
//! (SPEC 5.7 rule 2) and, when a spy is installed, recorded BEFORE that check, so a test
//! can prove the adapter never even tried.

use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

#[derive(Debug, Clone)]
pub struct DirItem {
    pub name: String,
    pub is_file: bool,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct FileMeta {
    pub len: u64,
    pub id: FileId,
    pub mtime_ms: u64,
}

/// Records every path the adapter tries to touch (attempts, before the guard).
#[derive(Clone, Default)]
pub struct Spy(Arc<Mutex<Vec<PathBuf>>>);

impl Spy {
    pub fn paths(&self) -> Vec<PathBuf> {
        self.0.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

#[derive(Clone, Default)]
pub struct Fsx {
    spy: Option<Spy>,
}

/// Files an adapter must never open, judged by name and folder, case-insensitively
/// (macOS and Windows file systems are case-insensitive).
pub fn is_never_open(path: &Path) -> bool {
    if path.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case("tool-results")) {
        return true;
    }
    let name = match path.file_name() {
        Some(n) => n.to_string_lossy().to_lowercase(),
        None => return false,
    };
    name == "auth.json"
        || name == ".credentials.json"
        || name == "history.jsonl"
        || name.ends_with(".key")
        || name.contains("credential")
        || name.contains("oauth-token")
        || name.starts_with("logs_2.sqlite")
        || name.starts_with("queue_1.sqlite")
}

fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "never-open path")
}

fn not_regular() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "not a regular file")
}

fn ms_of(t: io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn id_of(m: &fs::Metadata) -> FileId {
    use std::os::unix::fs::MetadataExt;
    FileId { dev: m.dev(), ino: m.ino() }
}

#[cfg(not(unix))]
fn id_of(m: &fs::Metadata) -> FileId {
    // No inode through std on this platform: the creation time stands in for it.
    FileId { dev: 0, ino: ms_of(m.created()) }
}

fn meta_of(m: &fs::Metadata) -> FileMeta {
    FileMeta { len: m.len(), id: id_of(m), mtime_ms: ms_of(m.modified()) }
}

impl Fsx {
    pub fn real() -> Fsx {
        Fsx { spy: None }
    }
    pub fn with_spy() -> (Fsx, Spy) {
        let spy = Spy::default();
        (Fsx { spy: Some(spy.clone()) }, spy)
    }

    fn enter(&self, path: &Path) -> io::Result<()> {
        if let Some(spy) = &self.spy {
            if let Ok(mut g) = spy.0.lock() {
                g.push(path.to_path_buf());
            }
        }
        if is_never_open(path) {
            return Err(denied());
        }
        Ok(())
    }

    /// Entries of a folder; symlinks are neither files nor folders; never-open names are omitted.
    pub fn read_dir(&self, dir: &Path) -> io::Result<Vec<DirItem>> {
        self.enter(dir)?;
        let mut out = Vec::new();
        for entry in fs::read_dir(dir)? {
            let Ok(entry) = entry else { continue };
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().to_string();
            if is_never_open(&dir.join(&name)) {
                continue;
            }
            out.push(DirItem { name, is_file: ft.is_file(), is_dir: ft.is_dir() });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Metadata without following symlinks; a symlink is refused.
    pub fn metadata(&self, path: &Path) -> io::Result<FileMeta> {
        self.enter(path)?;
        let m = fs::symlink_metadata(path)?;
        if m.file_type().is_symlink() {
            return Err(not_regular());
        }
        Ok(meta_of(&m))
    }

    /// Reads `[offset, offset+len)` of a regular, non-symlink file; fewer bytes at EOF.
    pub fn read_at(&self, path: &Path, offset: u64, len: usize) -> io::Result<Vec<u8>> {
        self.enter(path)?;
        let before = fs::symlink_metadata(path)?;
        if !before.file_type().is_file() {
            return Err(not_regular());
        }
        let mut f = fs::File::open(path)?;
        // The file we opened must be the file we checked (a symlink swapped in between fails here).
        if id_of(&f.metadata()?) != id_of(&before) {
            return Err(not_regular());
        }
        f.seek(SeekFrom::Start(offset))?;
        let mut buf = Vec::with_capacity(len.min(1 << 20));
        f.take(len as u64).read_to_end(&mut buf)?;
        Ok(buf)
    }

    /// Reads a small regular file; larger than `max` is an error.
    pub fn read_small(&self, path: &Path, max: usize) -> io::Result<Vec<u8>> {
        let buf = self.read_at(path, 0, max + 1)?;
        if buf.len() > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "file too large"));
        }
        Ok(buf)
    }
}

/// `CLAUDE_CONFIG_DIR`, if set.
pub fn config_dir_env() -> Option<String> {
    std::env::var("CLAUDE_CONFIG_DIR").ok()
}

/// The user's home folder (`HOME`, or `USERPROFILE` on Windows).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// The canonical form of a data root (symlinks and `..` resolved) so one root has one
/// connector id however it is spelled; the path as given when it cannot be resolved.
pub fn canonical_root(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
