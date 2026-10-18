//! Reading the receiver's runtime file (`runtime.json`: `{ v, port, secret, token }`).
//!
//! The file is written by the app with mode 0600. Anything that does not look right is
//! treated as "receiver absent": the shim then does nothing and exits 0.

use serde_json::Value;
use std::fs;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    pub port: u16,
    pub secret: String,
    pub token: String,
}

fn credential_ok(s: &str) -> bool {
    (8..=256).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Parse the text of a runtime file.
pub fn parse(text: &[u8]) -> Option<Runtime> {
    let v: Value = serde_json::from_slice(text).ok()?;
    let o = v.as_object()?;
    if o.get("v").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let port = o.get("port")?.as_u64()?;
    if !(1024..=65535).contains(&port) {
        return None;
    }
    let secret = o.get("secret")?.as_str()?;
    let token = o.get("token")?.as_str()?;
    if !credential_ok(secret) || !credential_ok(token) {
        return None;
    }
    Some(Runtime { port: port as u16, secret: secret.to_string(), token: token.to_string() })
}

/// What a trusted file is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustedKind {
    /// Readable and writable by its owner only, and the owner is the user running the shim.
    Private,
}

/// The ownership and permission rule for a trusted file (unix): owned by the current user and no group or
/// other permission bits at all.
pub fn owner_and_mode_ok(mode: u32, file_uid: u32, my_uid: u32, kind: TrustedKind) -> bool {
    match kind {
        TrustedKind::Private => file_uid == my_uid && mode & 0o077 == 0,
    }
}

/// Read a small file the shim is about to trust (the runtime file, the saved previous status line).
/// The file is opened FIRST with `O_NOFOLLOW | O_NONBLOCK` and judged by `fstat` on the open handle, so a
/// swap between a check and the open cannot redirect it, and a FIFO or device can never block the open.
/// It must be a regular file of at most `max` bytes, owned by the current user, mode 0600 or stricter.
#[cfg(unix)]
pub fn read_trusted(path: &Path, max: u64) -> Option<Vec<u8>> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path).ok()?;
    let meta = f.metadata().ok()?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if !meta.file_type().is_file() || meta.len() > max || !owner_and_mode_ok(meta.mode() & 0o7777, meta.uid(), me, TrustedKind::Private) {
        return None;
    }
    let mut buf = Vec::new();
    (&mut f).take(max + 1).read_to_end(&mut buf).ok()?;
    if buf.len() as u64 > max {
        None
    } else {
        Some(buf)
    }
}

/// Windows: no owner or mode check is made here (the per-user app data folder is the protection).
#[cfg(not(unix))]
pub fn read_trusted(path: &Path, max: u64) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > max {
        return None;
    }
    let mut buf = Vec::new();
    fs::File::open(path).ok()?.take(max + 1).read_to_end(&mut buf).ok()?;
    if buf.len() as u64 > max {
        None
    } else {
        Some(buf)
    }
}

/// Load the runtime file; anything untrustworthy or malformed means "receiver absent".
pub fn load(path: &Path) -> Option<Runtime> {
    parse(&read_trusted(path, 64 * 1024)?)
}
