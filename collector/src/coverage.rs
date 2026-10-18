//! The small file that lets "Alerts on" survive a restart (`coverage.json` in the data folder).
//! Ids and times only, never content; written by the collector alone, like `pending-alerts.json`.
use busyholm_contracts::common::Tool;
use serde::{Deserialize, Serialize};

/// A hook event that has not arrived for this many ms after a log or registry turn start counts as a miss.
pub const HOOK_GRACE_MS: u64 = 30_000;
/// This many misses in a row (no hook event in between) end "verified".
pub const MISS_LIMIT: u8 = 3;
/// At most one entry per connector, and a Snapshot carries at most 16 connectors.
pub const MAX_ENTRIES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageEntry {
    pub tool: Tool,
    /// The connector (salted hash, 32 lowercase hex characters).
    pub root_id: String,
    /// When the hook event that proved delivery arrived (ms since the Unix epoch).
    pub verified_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoverageFile {
    pub schema_version: u8,
    /// `std::env::consts::OS` when written: a data folder copied to another OS proves nothing there.
    pub os: String,
    pub entries: Vec<CoverageEntry>,
}
impl CoverageFile {
    pub fn empty() -> Self {
        Self { schema_version: 1, os: std::env::consts::OS.to_string(), entries: Vec::new() }
    }
}
