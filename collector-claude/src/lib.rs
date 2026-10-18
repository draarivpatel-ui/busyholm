//! Busyholm Claude Code adapter (WP-04).
//!
//! Pure mappers (`hooks`, `statusline`, `registry`, `transcript`, `process`) turn the
//! allowlisted fields of each Claude source into AgentEvent v1 values. Raw content is
//! never materialised: payloads are parsed into structs that name only the allowed
//! fields, and every id is hashed on the way in. `adapter` wires the mappers, the
//! dedup rules and the file watchers to the collector's `Adapter` trait.
//!
//! Every file-system touch goes through `fsx`, the only module allowed to use `std::fs`.

pub mod adapter;
pub mod dedup;
pub mod env;
pub mod fsx;
pub mod hooks;
pub mod pending;
pub mod process;
pub mod registry;
pub mod statusline;
pub mod tailer;
pub mod time;
pub mod transcript;

pub use adapter::{ClaudeAdapter, ClaudeConfig};
pub use env::Env;
pub use pending::PendingEvent;

/// Why a payload was refused. Closed on purpose: no payload text, path or parser
/// message is ever attached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MapError {
    NotJson,
    NotObject,
    TooLarge,
    MissingField,
}
