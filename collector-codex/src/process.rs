use std::path::Path;
use collector::{AdapterContext, AdapterError};
use collector::contracts::{AgentEvent, Validate, agent_event::{EventKind, EventSource}, common::{Confidence, Host, Tool}};
use crate::decode::{base, Session};

/// A matched process contains no argv, path or raw session id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessMatch { pub pid: u32, pub started_at: u64, pub host: Host }

/// The scanner supplies executable metadata and the known app-server daemon pid.
/// Subcommands cannot be distinguished by executable alone. Never inspect argv.
pub fn match_process(name: &str, executable: &Path, pid: u32, started_at: u64, daemon_pid: Option<u32>) -> Option<ProcessMatch> {
    if pid == 0 || daemon_pid == Some(pid) { return None; }
    // Handle synthetic Windows paths on any test host too.
    let path = executable.to_str()?;
    let basename = path.rsplit(['/', '\\']).next()?;
    let name = name.rsplit(['/', '\\']).next()?;
    if !matches!(name, "codex" | "codex.exe") || !matches!(basename, "codex" | "codex.exe") { return None; }
    let host = if path.contains("/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/") {
        Host::Desktop
    } else { Host::Cli };
    Some(ProcessMatch { pid, started_at, host })
}

/// Process presence is inferred, separate from a rollout's session identity.
pub fn process_event(process: ProcessMatch, up: bool, root_id: &str, ctx: &AdapterContext) -> Result<AgentEvent, AdapterError> {
    let session = Session { instance: ctx.instance(Tool::Codex, &format!("process:{}:{}",process.pid,process.started_at)),
        parent: None, host: process.host, root_id: root_id.into(), account_id: None, session_id: ctx.instance(Tool::Codex, &format!("process:{}:{}",process.pid,process.started_at)) };
    let mut event = base(&session, if up { EventKind::ProcessUp } else { EventKind::ProcessDown }, EventSource::Process, ctx, None);
    event.confidence = Confidence::Inferred;
    event.session_id = None;
    event.validate().map_err(|_| AdapterError::InvalidPayload)?;
    Ok(event)
}
