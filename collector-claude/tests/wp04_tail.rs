//! WP-04 acceptance 2 (offset resume, replaced file, partial line, oversize) and 3 (U+2028).
mod common;
use common::*;

use std::io::Write;

use collector_claude::fsx::Fsx;
use collector_claude::tailer::{tail_step, Start, TailState, BACKFILL_BYTES, MAX_LINE};

fn step(path: &std::path::Path, st: &mut TailState, start: Start) -> (Vec<Vec<u8>>, collector_claude::tailer::TailOutcome) {
    let mut lines = Vec::new();
    let out = tail_step(&Fsx::real(), path, st, start, &mut |l| lines.push(l.to_vec())).unwrap();
    (lines, out)
}

fn append(path: &std::path::Path, bytes: &[u8]) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    f.write_all(bytes).unwrap();
}

#[test]
fn resumes_from_the_saved_offset_and_never_rereads() {
    let s = Scratch::new("resume");
    let p = s.join("t.jsonl");
    append(&p, b"{\"a\":1}\n{\"a\":2}\n");
    let mut st = TailState::default();
    let (l1, o1) = step(&p, &mut st, Start::FromBeginning);
    assert_eq!(l1, vec![b"{\"a\":1}".to_vec(), b"{\"a\":2}".to_vec()]);
    assert_eq!(o1.lines, 2);
    assert_eq!(st.offset, 16);

    let (l2, _) = step(&p, &mut st, Start::FromBeginning);
    assert!(l2.is_empty(), "nothing new, nothing re-read");

    append(&p, b"{\"a\":3}\n");
    let (l3, _) = step(&p, &mut st, Start::FromBeginning);
    assert_eq!(l3, vec![b"{\"a\":3}".to_vec()]);

    // A fresh state restored from the saved offset (an app restart) sees only new data.
    let mut restored = TailState { id: st.id, offset: st.offset, skipping: false };
    append(&p, b"{\"a\":4}\n");
    let (l4, _) = step(&p, &mut restored, Start::FromBeginning);
    assert_eq!(l4, vec![b"{\"a\":4}".to_vec()]);
}

#[test]
fn a_replaced_file_restarts_at_byte_zero() {
    let s = Scratch::new("replace");
    let p = s.join("t.jsonl");
    append(&p, b"{\"old\":1}\n{\"old\":2}\n{\"old\":3}\n");
    let mut st = TailState::default();
    step(&p, &mut st, Start::FromBeginning);
    let first_id = st.id;

    // Replace by rename: new inode, same path, different (here smaller and larger) content.
    let tmp = s.join("t.jsonl.new");
    append(&tmp, b"{\"new\":1}\n");
    std::fs::rename(&tmp, &p).unwrap();
    let (lines, out) = step(&p, &mut st, Start::FromBeginning);
    assert!(out.reset, "identity change must be reported");
    assert_eq!(lines, vec![b"{\"new\":1}".to_vec()]);
    assert_ne!(st.id, first_id);

    // Replace by a LARGER file under a new inode: still detected (size alone would miss it).
    let tmp = s.join("t2.new");
    append(&tmp, b"{\"x\":1}\n{\"x\":2}\n{\"x\":3}\n{\"x\":4}\n{\"x\":5}\n");
    std::fs::rename(&tmp, &p).unwrap();
    let (lines, out) = step(&p, &mut st, Start::FromBeginning);
    assert!(out.reset);
    assert_eq!(lines.len(), 5);
}

#[test]
fn truncation_in_place_restarts_at_byte_zero() {
    let s = Scratch::new("trunc");
    let p = s.join("t.jsonl");
    append(&p, b"{\"a\":1}\n{\"a\":2}\n");
    let mut st = TailState::default();
    step(&p, &mut st, Start::FromBeginning);
    std::fs::write(&p, b"{\"b\":1}\n").unwrap(); // same inode, shorter
    let (lines, out) = step(&p, &mut st, Start::FromBeginning);
    assert!(out.reset);
    assert_eq!(lines, vec![b"{\"b\":1}".to_vec()]);
}

#[test]
fn a_partial_last_line_waits_for_its_newline() {
    let s = Scratch::new("partial");
    let p = s.join("t.jsonl");
    append(&p, b"{\"a\":1}\n{\"a\":");
    let mut st = TailState::default();
    let (l1, o1) = step(&p, &mut st, Start::FromBeginning);
    assert_eq!(l1, vec![b"{\"a\":1}".to_vec()]);
    assert!(o1.partial_pending);
    assert_eq!(st.offset, 8, "offset stops at the start of the unfinished line");

    append(&p, b"2}\n");
    let (l2, o2) = step(&p, &mut st, Start::FromBeginning);
    assert_eq!(l2, vec![b"{\"a\":2}".to_vec()]);
    assert!(!o2.partial_pending);
}

#[test]
fn the_truncated_tail_fixture_yields_complete_lines_only() {
    let mut st = TailState::default();
    let (lines, out) = step(&fixture("claude/transcript/transcript-truncated-tail.jsonl"), &mut st, Start::FromBeginning);
    assert_eq!(lines.len(), 2);
    assert!(out.partial_pending);
    for l in &lines {
        serde_json::from_slice::<serde_json::Value>(l).expect("complete lines parse");
    }
}

#[test]
fn lines_over_one_mebibyte_are_skipped_and_counted_once() {
    let s = Scratch::new("big");
    let p = s.join("t.jsonl");
    let mut data = Vec::new();
    data.extend_from_slice(b"{\"before\":1}\n");
    data.extend_from_slice(b"{\"pad\":\"");
    data.extend(std::iter::repeat(b'x').take(MAX_LINE + 4096));
    data.extend_from_slice(b"\"}\n");
    data.extend_from_slice(b"{\"after\":1}\n");
    std::fs::write(&p, &data).unwrap();

    let mut st = TailState::default();
    let (lines, out) = step(&p, &mut st, Start::FromBeginning);
    assert_eq!(lines, vec![b"{\"before\":1}".to_vec(), b"{\"after\":1}".to_vec()]);
    assert_eq!(out.skipped_oversize, 1);
    assert_eq!(st.offset, data.len() as u64);
}

#[test]
fn an_oversize_line_still_being_written_is_skipped_across_polls() {
    let s = Scratch::new("big-live");
    let p = s.join("t.jsonl");
    append(&p, b"{\"ok\":1}\n");
    append(&p, b"{\"pad\":\"");
    append(&p, &vec![b'y'; MAX_LINE + 10]); // no newline yet
    let mut st = TailState::default();
    let (l1, o1) = step(&p, &mut st, Start::FromBeginning);
    assert_eq!(l1, vec![b"{\"ok\":1}".to_vec()]);
    assert_eq!(o1.skipped_oversize, 1);
    assert!(st.skipping);

    append(&p, &vec![b'y'; 5000]); // more of the same line
    let (l2, o2) = step(&p, &mut st, Start::FromBeginning);
    assert!(l2.is_empty());
    assert_eq!(o2.skipped_oversize, 0, "one oversize line is counted once, not per poll");

    append(&p, b"\"}\n{\"next\":1}\n");
    let (l3, _) = step(&p, &mut st, Start::FromBeginning);
    assert_eq!(l3, vec![b"{\"next\":1}".to_vec()]);
    assert!(!st.skipping);
}

#[test]
fn first_attach_reads_only_the_last_64_kib_aligned_to_a_line() {
    let s = Scratch::new("backfill");
    let p = s.join("t.jsonl");
    let mut data = Vec::new();
    let mut n = 0;
    while (data.len() as u64) < BACKFILL_BYTES * 3 {
        data.extend_from_slice(format!("{{\"n\":{n},\"pad\":\"{}\"}}\n", "z".repeat(50)).as_bytes());
        n += 1;
    }
    std::fs::write(&p, &data).unwrap();
    let mut st = TailState::default();
    let (lines, _) = step(&p, &mut st, Start::Tail(BACKFILL_BYTES));
    assert!(!lines.is_empty() && (lines.len() as u64) * 60 <= BACKFILL_BYTES + 120);
    for l in &lines {
        serde_json::from_slice::<serde_json::Value>(l).expect("no half line at the cut");
    }
    let last: serde_json::Value = serde_json::from_slice(lines.last().unwrap()).unwrap();
    assert_eq!(last["n"], n - 1);
}

#[test]
fn symlinked_and_missing_files_are_not_followed() {
    let s = Scratch::new("symlink");
    let real = s.join("real.jsonl");
    append(&real, b"{\"a\":1}\n");
    let link = s.join("link.jsonl");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let mut st = TailState::default();
        let r = tail_step(&Fsx::real(), &link, &mut st, Start::FromBeginning, &mut |_| {});
        assert!(r.is_err(), "a symlink is refused, never followed");
    }
    let mut st = TailState::default();
    assert!(tail_step(&Fsx::real(), &s.join("missing.jsonl"), &mut st, Start::FromBeginning, &mut |_| {}).is_err());
}

#[test]
fn u2028_inside_a_json_string_does_not_split_a_record() {
    let path = fixture("claude/transcript/transcript-u2028.jsonl");
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(raw.contains('\u{2028}'), "the fixture really holds a raw U+2028");
    // The discriminating check: a splitter that also breaks on U+2028 (as JavaScript's
    // readline does) cuts a record into pieces that are not JSON.
    let naive_bad = raw.split(|c| c == '\n' || c == '\u{2028}' || c == '\u{2029}')
        .filter(|p| !p.is_empty())
        .any(|p| serde_json::from_str::<serde_json::Value>(p).is_err());
    assert!(naive_bad, "a U+2028-splitting reader would corrupt this file");

    let mut st = TailState::default();
    let (lines, _) = step(&path, &mut st, Start::FromBeginning);
    assert_eq!(lines.len(), 2);
    for l in &lines {
        serde_json::from_slice::<serde_json::Value>(l).expect("each record is whole");
    }
}
