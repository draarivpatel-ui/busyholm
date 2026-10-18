mod common;
use common::*;

use std::fs::{File, FileTimes, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{Duration, UNIX_EPOCH};

use busyholm_contracts::agent_event::EventKind;
use collector_claude::adapter::{ClaudeConfig, ClaudeCore, ACTIVE_MS, DISCOVERY_MS};
use collector_claude::fsx::Fsx;
use serde_json::json;

fn modified(path: &Path, t: u64) {
    File::options().write(true).open(path).unwrap()
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(t))).unwrap();
}

fn append(path: &Path, bytes: &[u8], t: u64) {
    OpenOptions::new().append(true).open(path).unwrap().write_all(bytes).unwrap();
    modified(path, t);
}

#[test]
fn m12_inactive_transcripts_stop_being_polled_between_discovery_passes() {
    let scratch = Scratch::new("fix-b-m12-idle");
    let path = scratch.join("projects/synthetic/session.jsonl");
    std::fs::write(&path, b"not-json\n").unwrap();
    modified(&path, NOW);
    let (fsx, spy) = Fsx::with_spy();
    let mut core = ClaudeCore::new(ClaudeConfig { root: scratch.path().into() }, fsx);
    core.poll(NOW + 1_000, &test_id);
    let stale = NOW + ACTIVE_MS + 2_000;
    core.poll(stale, &test_id);
    let before = spy.paths().len();
    core.poll(stale + 1, &test_id);
    assert!(!spy.paths()[before..].contains(&path), "an inactive tail must no longer incur a stat/read on every poll");
}

#[test]
fn m12_a_retained_resume_offset_preserves_a_partial_line_without_replaying_history() {
    let scratch = Scratch::new("fix-b-m12-resume");
    let path = scratch.join("projects/synthetic/session.jsonl");
    let record = json!({"type":"assistant","sessionId":"session","message":{"stop_reason":"end_turn"}}).to_string();
    let split = record.len() / 2;
    std::fs::write(&path, format!("not-json\n{}", &record[..split])).unwrap();
    modified(&path, NOW);
    let mut core = ClaudeCore::new(ClaudeConfig { root: scratch.path().into() }, Fsx::real());
    assert!(core.poll(NOW + 1_000, &test_id).is_empty());
    assert_eq!(core.stats.bad_lines, 1);
    let stale = NOW + ACTIVE_MS + 2_000;
    core.poll(stale, &test_id);
    let resumed = stale + DISCOVERY_MS;
    append(&path, format!("{}\n", &record[split..]).as_bytes(), resumed);
    let events = core.poll(resumed, &test_id);
    assert_valid(&events);
    assert_eq!(events.iter().filter(|e| e.kind == EventKind::TurnEnd).count(), 1);
    assert_eq!(core.stats.bad_lines, 1, "parking a tail must preserve its complete-line offset");
}

#[test]
fn m12_resume_metadata_is_bounded_and_evicts_the_oldest_inactive_tail() {
    let scratch = Scratch::new("fix-b-m12-cap");
    let paths: Vec<_> = (0..300).map(|n| {
        let path = scratch.join(&format!("projects/synthetic/session-{n:03}.jsonl"));
        std::fs::write(&path, b"not-json\n").unwrap();
        modified(&path, NOW);
        path
    }).collect();
    let mut core = ClaudeCore::new(ClaudeConfig { root: scratch.path().into() }, Fsx::real());
    core.poll(NOW + 1_000, &test_id);
    assert_eq!(core.stats.bad_lines, 300);
    let stale = NOW + ACTIVE_MS + 2_000;
    core.poll(stale, &test_id);
    let resumed = stale + DISCOVERY_MS;
    append(&paths[299], b"{}\n", resumed);
    core.poll(resumed, &test_id);
    assert_eq!(core.stats.bad_lines, 300, "a recent retained offset avoids a replay");
    append(&paths[0], b"{}\n", resumed + DISCOVERY_MS);
    core.poll(resumed + DISCOVERY_MS, &test_id);
    assert_eq!(core.stats.bad_lines, 301, "old inactive resume metadata must be evicted; reattach uses bounded backfill");
}

#[test]
fn m12_a_replacement_while_inactive_resets_the_retained_offset() {
    let scratch = Scratch::new("fix-b-m12-replace");
    let path = scratch.join("projects/synthetic/session.jsonl");
    std::fs::write(&path, b"not-json\n").unwrap();
    modified(&path, NOW);
    let mut core = ClaudeCore::new(ClaudeConfig { root: scratch.path().into() }, Fsx::real());
    core.poll(NOW + 1_000, &test_id);
    let stale = NOW + ACTIVE_MS + 2_000;
    core.poll(stale, &test_id);
    let replacement = scratch.join("replacement.jsonl");
    std::fs::write(&replacement, b"replacement-is-also-not-json\n").unwrap();
    modified(&replacement, stale + DISCOVERY_MS);
    std::fs::rename(&replacement, &path).unwrap();
    core.poll(stale + DISCOVERY_MS, &test_id);
    assert_eq!(core.stats.tail_resets, 1);
    assert_eq!(core.stats.bad_lines, 2);
}
