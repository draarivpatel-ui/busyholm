//! Identity derivation shared by the three sources.
use collector::AdapterContext;
use busyholm_contracts::common::{InstanceId, Tool};
use sha2::{Digest, Sha256};

/// Maps a raw session or process key to the salted instance id. The collector's
/// [`AdapterContext`] implements it; tests use a fake with the same output shape.
pub trait Identity {
    fn instance(&self, tool: Tool, raw: &str) -> InstanceId;
}

impl Identity for AdapterContext {
    fn instance(&self, tool: Tool, raw: &str) -> InstanceId {
        AdapterContext::instance(self, tool, raw)
    }
}

/// Lowercase hex SHA-256.
pub fn sha256_hex(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    let mut out = String::with_capacity(64);
    for b in d {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// The raw key for a process identity (pid plus start time). The process scanner and the
/// agy reader both use it, so a log can be bound to the process that wrote it.
pub fn process_raw(pid: u32, start_ms: u64) -> String {
    format!("proc:{pid}:{start_ms}")
}
