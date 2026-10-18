//! What a mapper needs from its caller: the clock and the identity hash.

use busyholm_contracts::common::{Host, InstanceId};

/// Per-call environment. The identity function is the collector's salted HMAC
/// (`AdapterContext::instance(Tool::Claude, raw)`); tests pass a local hasher.
pub struct Env<'a> {
    /// Collector clock, milliseconds.
    pub now_ms: u64,
    /// Salted identity hash of a raw id (session, agent, prompt, request, root, account).
    pub id: &'a dyn Fn(&str) -> InstanceId,
    /// Host learned from the registry for an instance, if any.
    pub host_of: &'a dyn Fn(&InstanceId) -> Option<Host>,
    /// Salted account id learned from the registry for an instance, if any.
    pub account_of: &'a dyn Fn(&InstanceId) -> Option<String>,
    /// Salted id of the Claude data root this adapter watches (32 hex characters).
    pub root_id: &'a str,
}

impl<'a> Env<'a> {
    pub fn instance(&self, raw: &str) -> InstanceId {
        (self.id)(raw)
    }
    /// Hash in a separate namespace so a turn, request, root or account id can never
    /// equal a session instance.
    pub fn scoped(&self, scope: &str, raw: &str) -> String {
        (self.id)(&format!("{scope}:{raw}"))
    }
    pub fn host(&self, instance: &InstanceId) -> Host {
        (self.host_of)(instance).unwrap_or(Host::Other)
    }
}

/// Map a Claude `entrypoint` value to a host. Unknown values are `Other`, never guessed.
pub fn host_from_entrypoint(entrypoint: &str) -> Host {
    match entrypoint {
        "cli" => Host::Cli,
        "claude-desktop" => Host::Desktop,
        "claude-vscode" => Host::Vscode,
        e if e.starts_with("sdk") => Host::Sdk,
        _ => Host::Other,
    }
}
