use std::sync::Arc;
use busyholm_contracts::{AgentEvent, common::{InstanceId, Tool}};
use crate::Clock;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Errors are closed classes. Never attach a payload, path or parser message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterError { InvalidPayload, Unsupported, Io, Unavailable }

/// Per-install key, shared by all adapters. Never serialize or log this object.
#[derive(Clone)]
pub struct IdentityHasher { salt: [u8; 32] }
impl IdentityHasher {
    pub fn new(salt: [u8; 32]) -> Self { Self { salt } }
    /// First 16 bytes of HMAC-SHA256(salt, agent + ":" + raw_id), lowercase hex.
    pub fn instance(&self, tool: Tool, raw_id: &str) -> InstanceId {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.salt).expect("fixed size HMAC key");
        let tool = match tool {
            Tool::Claude => "claude", Tool::Codex => "codex", Tool::Opencode => "opencode",
            Tool::Antigravity => "antigravity", Tool::Gemini => "gemini", Tool::Cursor => "cursor",
            Tool::Aider => "aider", Tool::Other => "other",
        };
        mac.update(tool.as_bytes()); mac.update(b":"); mac.update(raw_id.as_bytes());
        mac.finalize().into_bytes()[..16].iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[derive(Clone)]
pub struct AdapterContext {
    pub clock: Arc<dyn Clock>,
    pub identities: IdentityHasher,
}
impl AdapterContext {
    pub fn now_ms(&self) -> u64 { self.clock.now_ms() }
    pub fn instance(&self, tool: Tool, raw_id: &str) -> InstanceId {
        self.identities.instance(tool, raw_id)
    }
}

/// Synchronous adapter boundary. Only normalized, validated AgentEvents leave it.
/// Raw content must be discarded in these methods before queueing or logging.
/// Adapters own their watchers/tail offsets; poll must be bounded and nonblocking.
pub trait Adapter: Send {
    fn tool(&self) -> Tool;
    fn map_hook(&mut self, _body: &[u8], _ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        Err(AdapterError::Unsupported)
    }
    /// Registry, recent tail and process scan. Does not earn historical ledger counts.
    fn rebuild(&mut self, _ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        Ok(Vec::new())
    }
    fn poll(&mut self, _ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        Ok(Vec::new())
    }
    /// The service hands every adapter a waker before its first rebuild. An adapter with file notices calls
    /// `wake()` when one arrives, so the service polls it at once instead of at the next period (review r1 M5).
    fn set_waker(&mut self, _waker: crate::Waker) {}
}
