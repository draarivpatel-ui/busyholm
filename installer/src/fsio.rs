//! Small, careful file helpers: refuse symlinks and non-files, cap sizes, write atomically.

use crate::InstallError;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Largest file the installer will read (settings files are KBs; this only stops a pathological one).
pub const MAX_READ: u64 = 64 * 1024 * 1024;

fn io(path: &Path, source: std::io::Error) -> InstallError {
    InstallError::Io { path: path.to_path_buf(), source }
}

/// Read a regular file. `Ok(None)` when it does not exist. A symlink or other non-file is refused.
pub fn read_regular(path: &Path) -> Result<Option<Vec<u8>>, InstallError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io(path, e)),
    };
    if meta.file_type().is_symlink() {
        return Err(InstallError::Symlink { path: path.to_path_buf() });
    }
    if !meta.is_file() {
        return Err(InstallError::NotRegularFile { path: path.to_path_buf() });
    }
    if meta.len() > MAX_READ {
        return Err(InstallError::TooLarge { path: path.to_path_buf() });
    }
    fs::read(path).map(Some).map_err(|e| io(path, e))
}

#[cfg(unix)]
pub fn mode_of(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).ok().map(|m| m.permissions().mode() & 0o7777)
}
#[cfg(not(unix))]
pub fn mode_of(_path: &Path) -> Option<u32> {
    None
}

fn temp_sibling(path: &Path) -> PathBuf {
    let mut rnd = [0u8; 6];
    let _ = getrandom::getrandom(&mut rnd);
    let suffix: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.busyholm-{suffix}.tmp"))
}

/// Write `bytes` to `path` through a temp file in the same folder and a rename. `mode` is applied on unix.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), InstallError> {
    let tmp = temp_sibling(path);
    let result = (|| -> std::io::Result<()> {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // created with the final mode, so a 0600 file is never briefly readable by others
            opts.mode(mode);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(io(path, e));
    }
    Ok(())
}

pub fn ensure_dir(path: &Path) -> Result<(), InstallError> {
    fs::create_dir_all(path).map_err(|e| io(path, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Busyholm's own folders are private; folders that already existed are left alone by create_dir_all.
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn remove_file(path: &Path) -> Result<(), InstallError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(path, e)),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    crate::ops::sha256_hex(bytes)
}

/// One word for a POSIX shell (the status line and Codex hook commands run through `sh -c`):
/// kept as is when it needs no quoting, else single-quoted with each `'` written as `'\''`.
pub fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./:=@%+,-".contains(&b)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}
