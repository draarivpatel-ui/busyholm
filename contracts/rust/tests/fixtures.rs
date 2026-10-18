//! Shared-oracle tests: every valid fixture must be accepted (and round-trip
//! to the same JSON), every invalid fixture must be rejected.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use busyholm_contracts::{
    from_json, AgentEvent, Choices, HitRects, InstallManifest, Ledger, Moment, PendingAlerts, Settings, Snapshot,
    Validate, World,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/contracts")
}

/// Structural equality, comparing numbers numerically.
fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn json_files(dir: &Path) -> BTreeSet<String> {
    match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".json"))
            .collect(),
        Err(_) => BTreeSet::new(),
    }
}

fn manifest_keys(m: &Value, section: &str) -> BTreeSet<String> {
    m.get(section)
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

fn run<T: DeserializeOwned + Serialize + Validate>(dir_name: &str) {
    let dir = fixtures_root().join(dir_name);
    assert!(
        dir.is_dir(),
        "fixture directory is missing: {} (expected fixtures/contracts/{dir_name})",
        dir.display()
    );
    let manifest_text = fs::read_to_string(dir.join("manifest.json"))
        .unwrap_or_else(|e| panic!("cannot read {dir_name}/manifest.json: {e}"));
    let manifest: Value = serde_json::from_str(&manifest_text)
        .unwrap_or_else(|e| panic!("{dir_name}/manifest.json is not JSON: {e}"));

    let mut failures: Vec<String> = Vec::new();

    let valid_keys = manifest_keys(&manifest, "valid");
    let invalid_keys = manifest_keys(&manifest, "invalid");
    let valid_files = json_files(&dir.join("valid"));
    let invalid_files = json_files(&dir.join("invalid"));

    if valid_files.len() < 30 {
        failures.push(format!("only {} valid fixtures (need at least 30)", valid_files.len()));
    }
    if invalid_files.len() < 30 {
        failures.push(format!("only {} invalid fixtures (need at least 30)", invalid_files.len()));
    }
    if valid_files != valid_keys {
        failures.push(format!(
            "valid/ files differ from manifest keys: only on disk {:?}, only in manifest {:?}",
            valid_files.difference(&valid_keys).collect::<Vec<_>>(),
            valid_keys.difference(&valid_files).collect::<Vec<_>>()
        ));
    }
    if invalid_files != invalid_keys {
        failures.push(format!(
            "invalid/ files differ from manifest keys: only on disk {:?}, only in manifest {:?}",
            invalid_files.difference(&invalid_keys).collect::<Vec<_>>(),
            invalid_keys.difference(&invalid_files).collect::<Vec<_>>()
        ));
    }

    for name in &valid_files {
        let text = match fs::read_to_string(dir.join("valid").join(name)) {
            Ok(t) => t,
            Err(e) => {
                failures.push(format!("valid/{name}: cannot read: {e}"));
                continue;
            }
        };
        let original: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                failures.push(format!("valid/{name}: fixture is not JSON: {e}"));
                continue;
            }
        };
        match from_json::<T>(&text) {
            Err(e) => failures.push(format!("valid/{name}: rejected but should be accepted: {e}")),
            Ok(parsed) => match serde_json::to_value(&parsed) {
                Err(e) => failures.push(format!("valid/{name}: re-serialize failed: {e}")),
                Ok(back) => {
                    if !json_eq(&original, &back) {
                        failures.push(format!(
                            "valid/{name}: does not round-trip. original: {original} re-serialized: {back}"
                        ));
                    }
                }
            },
        }
    }

    for name in &invalid_files {
        let note = manifest["invalid"][name.as_str()]["note"].as_str().unwrap_or("(no note)");
        let text = match fs::read_to_string(dir.join("invalid").join(name)) {
            Ok(t) => t,
            Err(e) => {
                failures.push(format!("invalid/{name}: cannot read: {e}"));
                continue;
            }
        };
        if from_json::<T>(&text).is_ok() {
            failures.push(format!("invalid/{name}: accepted but should be rejected: {note}"));
        }
    }

    for f in &failures {
        eprintln!("{dir_name}: {f}");
    }
    assert!(
        failures.is_empty(),
        "{dir_name}: {} fixture problem(s), listed above",
        failures.len()
    );
}

#[test]
fn agent_event_v1_fixtures() {
    run::<AgentEvent>("agent-event.v1");
}

#[test]
fn snapshot_v2_fixtures() {
    run::<Snapshot>("snapshot.v2");
}

#[test]
fn moment_v1_fixtures() {
    run::<Moment>("moment.v1");
}

#[test]
fn ledger_v1_fixtures() {
    run::<Ledger>("ledger.v1");
}

#[test]
fn choices_v1_fixtures() {
    run::<Choices>("choices.v1");
}

#[test]
fn world_v1_fixtures() {
    run::<World>("world.v1");
}

#[test]
fn hit_rects_v1_fixtures() {
    run::<HitRects>("hit-rects.v1");
}

#[test]
fn settings_v1_fixtures() {
    run::<Settings>("settings.v1");
}

#[test]
fn install_manifest_v1_fixtures() {
    run::<InstallManifest>("install-manifest.v1");
}

#[test]
fn pending_alerts_v1_fixtures() {
    run::<PendingAlerts>("pending-alerts.v1");
}
