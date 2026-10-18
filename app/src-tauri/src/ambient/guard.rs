//! Native exit guard (WP-12, SPEC 6.4): the backstop that ends an ambient scene on a key, a click
//! or a mouse move over 8 px even if the page never loads or hangs, so the user can never be stuck
//! behind a fullscreen window. Pure: the caller polls the cursor and the idle clock and passes
//! the readings with a monotonic time in seconds.
//!
//! Detection rules, all derived from two cheap readings that need no permission on any OS:
//! - Move: the cursor is more than `move_px` from where it was when the guard armed.
//! - Key or click: the idle clock was reset since the previous sample (an input after the previous
//!   poll leaves `idle < dt`) while the cursor did not move. A nudged mouse also resets the idle
//!   clock, but it moves the cursor, so it is not mistaken for a key press; a click that comes with
//!   a movement is left to the page's own handler and the 8 px rule.
//! - The first `GRACE_S` after opening are ignored, so the key combo or tray click that opened the
//!   scene (its key-up, the mouse settling) does not close it again.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    Moved,
    Input,
}

/// Input in this long after the scene opened is the gesture that opened it.
pub const GRACE_S: f64 = 0.6;
/// Idle-clock slack for quantised clocks (1 ms on X11, 15 ms ticks on Windows). It must stay far
/// below the poll period: an input in the first `SLACK_S` after a poll would otherwise be missed for
/// good, because by the next poll the idle clock has grown past `dt` again.
const SLACK_S: f64 = 0.002;
/// A cursor that changed by less than this since the last sample did not move.
const STILL_PX: f64 = 0.5;

#[derive(Debug)]
pub struct ExitGuard {
    opened_at: f64,
    move_px: f64,
    base: Option<(f64, f64)>,
    last: Option<(f64, (f64, f64))>,
}

impl ExitGuard {
    /// `move_px` is in whatever unit the cursor readings use (8 CSS px times the display scale).
    pub fn new(opened_at: f64, move_px: f64) -> Self {
        ExitGuard { opened_at, move_px, base: None, last: None }
    }

    pub fn observe(&mut self, t: f64, cursor: Option<(f64, f64)>, idle: Option<f64>) -> Option<ExitReason> {
        if t - self.opened_at < GRACE_S {
            return None;
        }
        let c = cursor?;
        let Some(base) = self.base else {
            self.base = Some(c);
            self.last = Some((t, c));
            return None;
        };
        let moved = ((c.0 - base.0).powi(2) + (c.1 - base.1).powi(2)).sqrt();
        if moved > self.move_px {
            return Some(ExitReason::Moved);
        }
        let prev = self.last.replace((t, c));
        if let (Some((pt, pc)), Some(idle)) = (prev, idle) {
            let still = ((c.0 - pc.0).powi(2) + (c.1 - pc.1).powi(2)).sqrt() < STILL_PX;
            if still && idle + SLACK_S < t - pt {
                return Some(ExitReason::Input);
            }
        }
        None
    }
}
