//! `busyholm-sidecar --data-dir <dir> [--seed <n>] [--claude-root <dir>] [--codex-sessions <dir>]`
//! One JSON object per stdout line (snapshots, moments, the final ledger). stdin takes normalised AgentEvent
//! lines (the same as the plain `collector` sidecar); hooks arrive over the loopback receiver.
use collector::{stdio, Clock, EventBus, HookMapper, NormalizedMapper, SystemClock};
use sidecar::Roots;
use std::{io::{self, Write}, path::PathBuf, sync::Arc, thread};

fn run() -> io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let (mut dir, mut seed, mut roots) = (None, 0u32, Roots::from_environment());
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--data-dir") => dir = args.next().map(PathBuf::from),
            Some("--seed") => seed = args.next().and_then(|v| v.to_str().and_then(|s| s.parse().ok())).ok_or(io::ErrorKind::InvalidInput)?,
            Some("--claude-root") => roots.claude = args.next().map(PathBuf::from),
            Some("--codex-sessions") => roots.codex_sessions = args.next().map(PathBuf::from),
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        }
    }
    let dir = match dir { Some(d) => d, None => stdio::default_data_dir()? };
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let bus = EventBus::bounded(4096);
    let sender = bus.sender();
    let stdin_mapper: Arc<dyn HookMapper> = Arc::new(NormalizedMapper { clock: clock.clone() });
    thread::spawn(move || stdio::input(io::stdin().lock(), sender, stdin_mapper));
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    sidecar::run(dir, seed, &roots, clock, bus, |output| {
        serde_json::to_writer(&mut stdout, &output).map_err(|_| io::ErrorKind::InvalidData)?;
        stdout.write_all(b"\n")?;
        stdout.flush()
    })
}

fn main() {
    if run().is_err() {
        eprintln!("collector: service_failed");
        std::process::exit(1);
    }
}
