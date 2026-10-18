//! Busyholm collector core and the stable WP-04/05/06 adapter boundary.
pub mod adapter;
pub mod bus;
pub mod clock;
pub mod core;
pub mod coverage;
pub mod receiver;
pub mod usage;
pub mod ledger;
pub mod private_io;
pub mod service;
pub mod stdio;

pub use adapter::{Adapter, AdapterContext, AdapterError, IdentityHasher};
pub use bus::{CollectorInput, CollectorOutput, EventBus, EventSender, SendError, Waker};
pub use busyholm_contracts as contracts;
pub use clock::{Clock, FakeClock, SystemClock};
pub use core::{Collector, CoreError};
pub use coverage::{CoverageEntry, CoverageFile};
pub use receiver::{AdapterRouter, HookMapper, NormalizedMapper, Receiver, ReceiverCredentials, RuntimeInfo};
pub use usage::UsageStore;
pub use service::{adapter_context, run_service, ServiceConfig};
