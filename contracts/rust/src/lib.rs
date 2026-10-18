//! Busyholm contract types.
//!
//! This crate holds the Rust serde representation of every Busyholm data
//! contract: the structural layer only (field names, enums, required versus
//! optional versus nullable, and `const` versions). The JSON Schemas in
//! `contracts/schemas` are the source of truth, and the shared fixtures in
//! `fixtures/contracts` are the oracle that every implementation (this crate
//! and the TypeScript side) must agree on.

pub mod agent_event;
pub mod check;
pub mod choices;
pub mod common;
pub mod hit_rects;
pub mod install_manifest;
pub mod ledger;
pub mod moment;
pub mod pending_alerts;
pub mod settings;
pub mod snapshot;
pub mod validate;
pub mod world;

pub use agent_event::AgentEvent;
pub use choices::Choices;
pub use hit_rects::HitRects;
pub use install_manifest::InstallManifest;
pub use ledger::Ledger;
pub use moment::Moment;
pub use pending_alerts::PendingAlerts;
pub use settings::Settings;
pub use snapshot::Snapshot;
pub use world::World;
pub use validate::{from_json, from_value, ContractError, Validate};
