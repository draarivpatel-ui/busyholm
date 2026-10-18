#![allow(dead_code)]
//! Shared helpers for the WP-04 acceptance tests.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use busyholm_contracts::common::{Host, InstanceId};
use busyholm_contracts::{AgentEvent, Validate};
use collector_claude::Env;

pub const NOW: u64 = 1_791_806_500_000; // 2026-10-12T12:01:40Z, just after the fixtures

/// Deterministic stand-in for the collector's HMAC (the real one is WP-03's).
pub fn test_id(raw: &str) -> InstanceId {
    let mut a = DefaultHasher::new();
    ("busyholm-test-salt", raw).hash(&mut a);
    let mut b = DefaultHasher::new();
    ("busyholm-test-salt-2", raw).hash(&mut b);
    format!("{:016x}{:016x}", a.finish(), b.finish())
}

pub fn scoped(scope: &str, raw: &str) -> String {
    test_id(&format!("{scope}:{raw}"))
}

pub fn root_id() -> String {
    scoped("root", "test-root")
}

pub fn no_host(_: &InstanceId) -> Option<Host> {
    None
}
pub fn no_account(_: &InstanceId) -> Option<String> {
    None
}

pub fn with_env<R>(now: u64, f: impl FnOnce(&Env) -> R) -> R {
    let root = root_id();
    let env = Env {
        now_ms: now,
        id: &test_id,
        host_of: &no_host,
        account_of: &no_account,
        root_id: &root,
    };
    f(&env)
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

pub fn fixture(rel: &str) -> PathBuf {
    repo_root().join("fixtures/agent-inputs").join(rel)
}

pub fn read_fixture(rel: &str) -> Vec<u8> {
    std::fs::read(fixture(rel)).unwrap_or_else(|e| panic!("fixture {rel}: {e}"))
}

fn name_of<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).unwrap().as_str().unwrap().to_string()
}

/// One-line summary of an event for golden tables:
/// `kind/source/confidence[;act=..][;err=..][;notif=..][;stop=..][;end=..][;child]`
pub fn summ(e: &AgentEvent) -> String {
    let mut s = format!("{}/{}/{}", name_of(&e.kind), name_of(&e.source), name_of(&e.confidence));
    if let Some(d) = &e.detail {
        if let Some(a) = &d.activity {
            s += &format!(";act={}", name_of(a));
        }
        if let Some(a) = &d.error_class {
            s += &format!(";err={}", name_of(a));
        }
        if let Some(a) = &d.notification {
            s += &format!(";notif={}", name_of(a));
        }
        if let Some(a) = &d.stop_reason {
            s += &format!(";stop={}", name_of(a));
        }
        if let Some(a) = &d.end_reason {
            s += &format!(";end={}", name_of(a));
        }
    }
    if e.parent.is_some() {
        s += ";child";
    }
    s
}

pub fn summs(events: &[AgentEvent]) -> Vec<String> {
    events.iter().map(summ).collect()
}

/// Every event must be a valid AgentEvent v1 (the contract's own semantic checks).
pub fn assert_valid(events: &[AgentEvent]) {
    for e in events {
        e.validate().unwrap_or_else(|err| panic!("invalid event {e:?}: {err:?}"));
    }
}

/// A unique scratch folder, removed on drop.
pub struct Scratch(pub PathBuf);

static COUNTER: AtomicU64 = AtomicU64::new(0);

impl Scratch {
    pub fn new(tag: &str) -> Scratch {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("bh-wp04-{tag}-{}-{n}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Scratch(p)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
    pub fn join(&self, rel: &str) -> PathBuf {
        let p = self.0.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        p
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
