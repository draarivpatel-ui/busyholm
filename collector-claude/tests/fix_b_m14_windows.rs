//! Native reproduction for M14. Cross-compiling this test does not execute it.
#![cfg(windows)]

mod common;
use common::*;

use std::ffi::c_void;
use std::fs::File;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use collector_claude::fsx::Fsx;
use collector_claude::tailer::{tail_step, Start, TailState};

#[repr(C)]
struct FileTime { low: u32, high: u32 }

#[link(name = "kernel32")]
extern "system" {
    fn SetFileTime(file: *mut c_void, created: *const FileTime, accessed: *const FileTime, modified: *const FileTime) -> i32;
}

fn same_creation_time(path: &Path) {
    let file = File::options().write(true).open(path).unwrap();
    // Windows FILETIME is 100 ns ticks since 1601; the synthetic time is an exact millisecond.
    let ticks = (NOW + 11_644_473_600_000) * 10_000;
    let time = FileTime { low: ticks as u32, high: (ticks >> 32) as u32 };
    // Only the creation timestamp changes. File owns the handle for this whole call.
    let success = unsafe { SetFileTime(file.as_raw_handle(), &time, std::ptr::null(), std::ptr::null()) };
    assert_ne!(success, 0, "{}", std::io::Error::last_os_error());
}

#[test]
fn m14_equal_creation_milliseconds_do_not_make_distinct_files_share_an_identity() {
    let scratch = Scratch::new("fix-b-m14-identities");
    let first = scratch.join("first.jsonl");
    let second = scratch.join("second.jsonl");
    std::fs::write(&first, b"first\n").unwrap();
    std::fs::write(&second, b"second\n").unwrap();
    same_creation_time(&first);
    same_creation_time(&second);
    assert_eq!(std::fs::metadata(&first).unwrap().created().unwrap(), std::fs::metadata(&second).unwrap().created().unwrap(), "the fixture must actually have equal creation times");
    assert_ne!(Fsx::real().metadata(&first).unwrap().id, Fsx::real().metadata(&second).unwrap().id);
}

#[test]
fn m14_a_larger_replacement_with_the_same_creation_time_restarts_from_byte_zero() {
    let scratch = Scratch::new("fix-b-m14-replacement");
    let path = scratch.join("session.jsonl");
    let replacement = scratch.join("replacement.jsonl");
    std::fs::write(&path, b"old-one\nold-two\n").unwrap();
    std::fs::write(&replacement, b"new-one\nnew-two\nnew-three\n").unwrap();
    same_creation_time(&path);
    same_creation_time(&replacement);
    assert_eq!(std::fs::metadata(&path).unwrap().created().unwrap(), std::fs::metadata(&replacement).unwrap().created().unwrap());
    let mut state = TailState::default();
    tail_step(&Fsx::real(), &path, &mut state, Start::FromBeginning, &mut |_| {}).unwrap();
    let old_offset = state.offset;
    std::fs::rename(&replacement, &path).unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() > old_offset, "size alone cannot expose this replacement");
    let mut lines = Vec::new();
    let outcome = tail_step(&Fsx::real(), &path, &mut state, Start::FromBeginning, &mut |line| lines.push(line.to_vec())).unwrap();
    assert!(outcome.reset, "replacement must discard the old offset");
    assert_eq!(lines, vec![b"new-one".to_vec(), b"new-two".to_vec(), b"new-three".to_vec()]);
}
