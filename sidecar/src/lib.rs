//! The live collector: the WP-03 service wired to the real adapters.
//!
//! `collector` (WP-03) cannot depend on the adapters (they depend on it), so this crate is where the
//! `AdapterRouter` is assembled: Claude Code (WP-04) and Codex (WP-05). The shim POSTs the allowlisted hook
//! body with `X-Busyholm-Agent`; the router sends it to that adapter's `map_hook`. The same router is
//! rebuilt from at start and polled by the service loop, so registry, transcript, rollout and process
//! signals flow into the same state machine as the hooks.
use collector::{adapter_context, Adapter, AdapterContext, AdapterError, AdapterRouter, Clock, CollectorOutput, EventBus, HookMapper, ServiceConfig};
use collector::contracts::{common::Tool, AgentEvent};
use collector_claude::adapter::{ClaudeAdapter, ClaudeConfig};
use collector_claude::fsx::Fsx;
use collector_codex::CodexAdapter;
use collector_wp06::ProcessSource;
use std::{io, path::{Path, PathBuf}, sync::Arc, time::SystemTime};

/// A process start time (ms since the epoch) the way `ps -o lstart` prints it in local time, which is what Claude
/// Code writes as `procStart` in its session registry.
pub fn lstart(start_ms: u64) -> String {
    use chrono::{Local, TimeZone};
    let seconds = (start_ms / 1000).min(253_402_300_799) as i64;
    Local.timestamp_opt(seconds, 0).single().map(|t| t.format("%a %b %e %H:%M:%S %Y").to_string()).unwrap_or_default()
}

/// How often a fresh snapshot is taken when nothing in the registry changed (SPEC 5.6).
const SCAN_MS: u64 = 5_000;
/// Registry files (`<pid>.json`) and their modification times; nothing inside them is read here.
type Listing = Vec<(String, Option<SystemTime>)>;
fn registry_listing(dir: &Path) -> Listing {
    let mut out: Listing = std::fs::read_dir(dir).map(|d| d.flatten().filter_map(|e| {
        let name = e.file_name().to_str()?.to_owned();
        let pid = name.strip_suffix(".json")?;
        (!pid.is_empty() && pid.len() <= 10 && pid.bytes().all(|b| b.is_ascii_digit())).then_some(())?;
        Some((name, e.metadata().ok().and_then(|m| m.modified().ok())))
    }).take(256).collect()).unwrap_or_default();
    out.sort();
    out
}

/// The Claude adapter plus the process scanner (review r1 H5): process snapshots give the adapter positive
/// evidence that a session's process is gone, so a killed agent's alert does not stay forever.
///
/// Once the adapter has a snapshot it treats every registry process missing from it as dead, so a snapshot older
/// than a registry entry would mark a session that just started as a crash leftover for good. The snapshot is
/// therefore refreshed every 5 s AND whenever the registry folder's listing changed (a file added, removed or
/// rewritten), always before the adapter reads the registry in the same poll. A failed snapshot is never evidence:
/// the previous one stays, and if the registry changed meanwhile the adapter's poll is skipped until a scan works.
pub struct ClaudeWithProcesses {
    inner: ClaudeAdapter,
    source: Option<Box<dyn ProcessSource>>,
    registry: PathBuf,
    scanned_at: Option<u64>,
    listing: Listing,
}

/// The Claude adapter for `cfg`, fed by `source` (`None`: no process evidence, every registry process counts as alive).
pub fn claude_adapter(cfg: ClaudeConfig, source: Option<Box<dyn ProcessSource>>) -> ClaudeWithProcesses {
    let registry = cfg.root.join("sessions");
    ClaudeWithProcesses { inner: ClaudeAdapter::new(cfg, Fsx::real()), source, registry, scanned_at: None, listing: Vec::new() }
}

impl ClaudeWithProcesses {
    /// Hands the adapter a fresh snapshot when one is due. False when the adapter must not read the registry now.
    fn refresh(&mut self, ctx: &AdapterContext, force: bool) -> bool {
        let Some(source) = self.source.as_mut() else { return true };
        let listing = registry_listing(&self.registry);
        let now = ctx.clock.monotonic_ms();
        let changed = listing != self.listing;
        if !force && !changed && self.scanned_at.is_some_and(|at| now.saturating_sub(at) < SCAN_MS) { return true; }
        // No registered session: the filtered snapshot would be empty anyway, so skip the process scan (it is most of
        // the idle CPU cost).
        if listing.is_empty() {
            self.inner.core_mut().set_processes(Vec::new());
            self.scanned_at = Some(now);
            self.listing = listing;
            return true;
        }
        match source.snapshot() {
            Ok(procs) => {
                // Only processes this root's registry names: they are what the evidence is about, and a Claude
                // process of another config folder (or one not registered yet) must not become a resident here.
                let pids: Vec<&str> = listing.iter().filter_map(|(name, _)| name.strip_suffix(".json")).collect();
                let procs = procs.into_iter().filter(|p| pids.contains(&p.pid.to_string().as_str())).map(|p| collector_claude::process::ProcInfo { pid: p.pid, start: lstart(p.start_ms), exe: p.path.unwrap_or_default() }).collect();
                self.inner.core_mut().set_processes(procs);
                self.scanned_at = Some(now);
                self.listing = listing;
                true
            }
            // No snapshot yet: the adapter still assumes alive, which is safe. With an old one, a changed registry
            // must wait for a scan that works.
            Err(_) => self.scanned_at.is_none() || !changed,
        }
    }
}

impl Adapter for ClaudeWithProcesses {
    fn tool(&self) -> Tool { Tool::Claude }
    fn map_hook(&mut self, body: &[u8], ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> { self.inner.map_hook(body, ctx) }
    fn rebuild(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        self.refresh(ctx, true);
        self.inner.rebuild(ctx)
    }
    fn poll(&mut self, ctx: &AdapterContext) -> Result<Vec<AgentEvent>, AdapterError> {
        if !self.refresh(ctx, false) { return Ok(Vec::new()); }
        self.inner.poll(ctx)
    }
}

/// The OS process list, where Claude Code's registry `procStart` format is verified to match ours: macOS
/// (`ps -o lstart`, checked by `h5_lstart_matches_ps_for_this_process`). Elsewhere the format is unverified and a
/// mismatch would end every live session, so no snapshot is supplied and processes count as alive (as before).
pub fn system_process_source() -> Option<Box<dyn ProcessSource>> {
    if cfg!(target_os = "macos") { Some(collector_wp06::procscan::system_source()) } else { None }
}

/// Where the agents keep their data. `None` skips that adapter (its hooks are then rejected with 400).
#[derive(Clone, Debug, Default)]
pub struct Roots {
    pub claude: Option<PathBuf>,
    /// The Codex SESSIONS folder (`<CODEX_HOME or ~/.codex>/sessions`), not the Codex home itself.
    pub codex_sessions: Option<PathBuf>,
}

impl Roots {
    /// `CLAUDE_CONFIG_DIR` else `~/.claude`; `CODEX_HOME` else `~/.codex`, plus `sessions`.
    pub fn from_environment() -> Roots {
        let claude = ClaudeConfig::from_environment().map(|c| c.root);
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
        let codex_home = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".codex")));
        Roots { claude, codex_sessions: codex_home.map(|h| h.join("sessions")) }
    }
}

/// Registers the adapters whose roots exist. A root that cannot be watched leaves that adapter out; it never
/// stops the others. Claude hooks only need the data root to exist; Codex watches the sessions folder when it
/// exists, and otherwise maps hooks and starts watching once the folder is created.
pub fn build_router(ctx: collector::AdapterContext, roots: &Roots) -> AdapterRouter {
    let mut router = AdapterRouter::new(ctx);
    if let Some(root) = &roots.claude {
        let _ = router.register(Box::new(claude_adapter(ClaudeConfig { root: root.clone() }, system_process_source())));
    }
    if let Some(root) = &roots.codex_sessions {
        // A missing sessions folder still gets a provisional connector that maps hooks and attaches the rollout
        // watch when the folder appears, with the same root_id (review r1 M4).
        if let Ok(adapter) = CodexAdapter::watch_or_wait(root) {
            let _ = router.register(Box::new(adapter));
        }
    }
    router
}

/// Runs the service until `bus` receives a shutdown. Blocks. The receiver and the service loop share one router.
pub fn run(
    data_dir: PathBuf, seed: u32, roots: &Roots, clock: Arc<dyn Clock>, bus: EventBus,
    output: impl FnMut(CollectorOutput) -> io::Result<()>,
) -> io::Result<()> {
    let ctx = adapter_context(&data_dir, clock.clone())?;
    let router = Arc::new(build_router(ctx, roots));
    let mapper: Arc<dyn HookMapper> = router.clone();
    let mut config = ServiceConfig::new(data_dir);
    config.seed = seed;
    config.router = Some(router);
    collector::run_service(config, bus, clock, mapper, output)
}
