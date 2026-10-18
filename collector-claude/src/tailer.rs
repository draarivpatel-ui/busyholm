//! Transcript tail follower: byte offset, replaced-file detection, partial last line,
//! oversize skip, LF-only splitting (a `readJsonl`-style reader with a start offset).
//!
//! Splitting on byte 0x0A only matters: U+2028 and U+2029 may appear raw inside JSON
//! strings, and a reader that also breaks on them (JavaScript's `readline`) corrupts records.

use std::io;
use std::path::Path;

use crate::fsx::{FileId, Fsx};

/// Lines longer than this are skipped, not truncated and kept.
pub const MAX_LINE: usize = 1 << 20;
/// First attach to an existing file reads only its last 64 KiB.
pub const BACKFILL_BYTES: u64 = 64 * 1024;
const CHUNK: usize = 256 * 1024;
/// Upper bound of bytes consumed per step, so one poll stays bounded.
const BUDGET: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct TailState {
    pub id: Option<FileId>,
    /// Offset of the first byte not yet delivered (start of the pending partial line).
    pub offset: u64,
    /// Inside an oversize line: discard bytes until the next LF.
    pub skipping: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Start {
    FromBeginning,
    /// Begin this many bytes before the end, aligned to the next line start.
    Tail(u64),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TailOutcome {
    /// The file was replaced or truncated and reading restarted at byte 0.
    pub reset: bool,
    pub lines: u32,
    pub skipped_oversize: u32,
    /// Bytes of an unfinished last line are waiting for the next step.
    pub partial_pending: bool,
}

/// Delivers every complete line since the last step to `on_line` (without the LF).
/// A missing file or a symlink is an error; the caller stops tracking it.
pub fn tail_step(
    fsx: &Fsx,
    path: &Path,
    state: &mut TailState,
    start: Start,
    on_line: &mut dyn FnMut(&[u8]),
) -> io::Result<TailOutcome> {
    let meta = fsx.metadata(path)?;
    let mut out = TailOutcome::default();

    match state.id {
        None => {
            state.id = Some(meta.id);
            if let (Start::Tail(n), 0) = (start, state.offset) {
                let off = meta.len.saturating_sub(n);
                if off > 0 {
                    let prev = fsx.read_at(path, off - 1, 1)?;
                    state.skipping = prev.first() != Some(&b'\n');
                }
                state.offset = off;
            }
        }
        Some(id) if id != meta.id || meta.len < state.offset => {
            state.id = Some(meta.id);
            state.offset = 0;
            state.skipping = false;
            out.reset = true;
        }
        Some(_) => {}
    }

    let end = meta.len.min(state.offset.saturating_add(BUDGET));
    let mut pos = state.offset;
    let mut line: Vec<u8> = Vec::new();
    let mut line_start = state.offset;

    while pos < end {
        let want = CHUNK.min((end - pos) as usize);
        let chunk = fsx.read_at(path, pos, want)?;
        if chunk.is_empty() {
            break;
        }
        let mut i = 0;
        while i < chunk.len() {
            match chunk[i..].iter().position(|b| *b == b'\n') {
                Some(k) => {
                    if state.skipping {
                        state.skipping = false;
                    } else {
                        line.extend_from_slice(&chunk[i..i + k]);
                        if line.len() > MAX_LINE {
                            out.skipped_oversize += 1;
                        } else if !line.is_empty() {
                            on_line(&line);
                            out.lines += 1;
                        }
                    }
                    line.clear();
                    i += k + 1;
                    line_start = pos + i as u64;
                    state.offset = line_start;
                }
                None => {
                    if !state.skipping {
                        line.extend_from_slice(&chunk[i..]);
                        if line.len() > MAX_LINE {
                            out.skipped_oversize += 1;
                            state.skipping = true;
                            line.clear();
                        }
                    }
                    i = chunk.len();
                }
            }
        }
        pos += chunk.len() as u64;
    }

    if state.skipping {
        state.offset = pos;
    } else if line.is_empty() {
        state.offset = pos.max(line_start);
    } else {
        state.offset = line_start;
        out.partial_pending = true;
    }
    Ok(out)
}
