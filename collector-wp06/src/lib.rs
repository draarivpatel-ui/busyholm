//! Busyholm WP-06: OpenCode and Antigravity (`agy`) adapters and the cross-platform
//! process scanner. Every mapper turns an allowlisted slice of a source into
//! AgentEvent v1 and discards the rest at the edge (SPEC 5.7).
//!
//! The mappers are pure over an [`Identity`] (so they test without the collector's hasher)
//! and a millisecond clock value; the `*Adapter` types are thin wrappers that implement the
//! collector's [`collector::Adapter`] trait.

pub mod agy;
pub mod build;
pub mod ident;
pub mod opencode_wire;
#[cfg(feature = "opencode-poll")]
pub mod opencode_poll;
pub mod paths;
pub mod procscan;

pub use agy::{AgyAdapter, AgyConfig, AgyReader, AgyState};
pub use ident::{process_raw, sha256_hex, Identity};
pub use opencode_wire::{map_wire, OpenCodeAdapter};
#[cfg(feature = "opencode-poll")]
pub use opencode_poll::{OpenCodePoller, PollConfig};
pub use procscan::{ProcInfo, ProcessScanner, ProcessSource, ProcessTracker};
