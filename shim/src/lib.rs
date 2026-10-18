//! `busyholm-hook` (WP-07): the command shim agents run for their hooks and status line.
//!
//! Contract: stdout and stderr stay empty in hook mode and the exit code is always 0, within
//! 1.2 s, whatever the receiver does. Only allowlisted fields ever leave the process.

pub mod allowlist;
pub mod net;
pub mod run;
pub mod runtime;
