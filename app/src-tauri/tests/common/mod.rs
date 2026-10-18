//! Shared helpers for the integration tests (not a test target itself: included with `mod common`).
#![allow(dead_code)]
use std::path::PathBuf;

use busyholm_contracts::{Moment, Snapshot};

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contracts")
}

fn load_valid<T: serde::de::DeserializeOwned + busyholm_contracts::Validate>(sub: &str) -> Vec<T> {
    let dir = fixtures_dir().join(sub).join("valid");
    let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false) && !p.ends_with("manifest.json")).collect();
    names.sort();
    names.iter().filter_map(|p| busyholm_contracts::from_json::<T>(&std::fs::read_to_string(p).unwrap()).ok()).collect()
}

/// Valid Snapshot v2 fixtures that the current Rust contract types accept.
pub fn snapshots() -> Vec<Snapshot> { load_valid("snapshot.v2") }
pub fn moments() -> Vec<Moment> { load_valid("moment.v1") }

pub fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("busyholm-wp02-{tag}-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir_all(&d).unwrap();
    d
}
