#![allow(dead_code)]
use busyholm_contracts::{common::Tool, validate::Validate, AgentEvent};
use collector_wp06::{sha256_hex, Identity};

/// Same output shape as the collector's hasher (32 lowercase hex), no secret needed.
pub struct FakeIds;
impl Identity for FakeIds {
    fn instance(&self, tool: Tool, raw: &str) -> String {
        sha256_hex(&format!("{tool:?}:{raw}"))[..32].to_string()
    }
}

pub fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

pub const CANARY_NEEDLES: &[&str] = &["bhcanary", "bca1a700"];

/// Every event must satisfy the AgentEvent v1 contract and carry no canary byte.
pub fn check_events(events: &[AgentEvent]) {
    for e in events {
        e.validate().unwrap_or_else(|err| panic!("contract violation: {err}: {e:?}"));
        let json = serde_json::to_string(e).unwrap().to_lowercase();
        for n in CANARY_NEEDLES {
            assert!(!json.contains(n), "canary {n} leaked into {json}");
        }
    }
}

pub fn kinds(events: &[AgentEvent]) -> Vec<String> {
    events.iter().map(|e| serde_json::to_value(e.kind).unwrap().as_str().unwrap().to_string()).collect()
}
