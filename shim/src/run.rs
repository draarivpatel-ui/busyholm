//! Argument parsing and the two modes.
//!
//! ```text
//! busyholm-hook hook --agent claude|codex|gemini --runtime <abs runtime.json> [--owner <tag>]
//! busyholm-hook statusline --runtime <abs runtime.json> [--prev-file <abs file>] [--owner <tag>]
//! ```
//!
//! `--owner` is only a marker: the installer writes it so it can find its own entries later.
//!
//! Hook mode never prints, never fails and never outlives `HARD_EXIT`. Status line mode is a
//! transparent wrapper: the previous command's stdout is copied through byte for byte and its
//! exit code is returned; only the rate-limit numbers go to the receiver, from a side thread.

use crate::{allowlist, net, runtime};
use std::io::{Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Network work ends here (measured from process start).
pub const NET_BUDGET: Duration = Duration::from_millis(900);
/// The process exits here at the latest, in hook mode (the contract is 1.2 s).
pub const HARD_EXIT: Duration = Duration::from_millis(1000);
/// After the previous status line command has finished, how long to wait for the usage report to land.
pub const STATUSLINE_GRACE: Duration = Duration::from_millis(250);
/// Largest hook body read from stdin. Bigger bodies are dropped, never truncated and sent.
pub const MAX_STDIN: u64 = 32 * 1024 * 1024;

#[derive(Debug, Default, Clone)]
pub struct Args {
    pub mode: String,
    pub agent: Option<String>,
    pub runtime: Option<PathBuf>,
    pub prev_file: Option<PathBuf>,
    pub prev_cmd: Option<String>,
}

pub fn parse_args(raw: &[String]) -> Args {
    let mut a = Args::default();
    let mut it = raw.iter();
    if let Some(mode) = it.next() {
        a.mode = mode.clone();
    }
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--agent" => a.agent = it.next().cloned(),
            "--runtime" => a.runtime = it.next().map(PathBuf::from),
            "--prev-file" => a.prev_file = it.next().map(PathBuf::from),
            "--prev-cmd" => a.prev_cmd = it.next().cloned(),
            "--owner" => {
                it.next();
            }
            _ => {}
        }
    }
    a
}

fn read_stdin(cap: u64) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    std::io::stdin().lock().take(cap + 1).read_to_end(&mut buf).ok()?;
    if buf.len() as u64 > cap {
        None
    } else {
        Some(buf)
    }
}

fn send(args: &Args, body: &[u8], agent: &str, start: Instant) {
    let Some(path) = args.runtime.as_deref() else { return };
    let Some(rt) = runtime::load(path) else { return };
    let _ = net::post(&rt, agent, body, start + NET_BUDGET);
}

fn hook_work(args: &Args, start: Instant) {
    let Some(agent) = args.agent.as_deref().filter(|a| allowlist::AGENTS.contains(a)) else { return };
    let Some(input) = read_stdin(MAX_STDIN) else { return };
    let Some(body) = allowlist::filter_hook(&input) else { return };
    send(args, &body, agent, start);
}

fn hook_mode(args: Args, start: Instant) -> i32 {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = catch_unwind(AssertUnwindSafe(|| hook_work(&args, start)));
        let _ = tx.send(());
    });
    // Whatever the worker is stuck on (stdin, DNS-free connect, a slow reply), the process
    // ends at HARD_EXIT.
    let _ = rx.recv_timeout(HARD_EXIT.saturating_sub(start.elapsed()));
    0
}

/// The previous status line command, from the saved copy of the value it was configured as.
fn previous_command(path: &PathBuf) -> Option<String> {
    // It is about to be run through a shell, so it gets the same trust checks as the runtime file.
    let buf = runtime::read_trusted(path, 64 * 1024)?;
    let v: serde_json::Value = serde_json::from_slice(&buf).ok()?;
    let o = v.as_object()?;
    if o.get("type").and_then(|t| t.as_str()) != Some("command") {
        return None;
    }
    o.get("command")?.as_str().filter(|c| !c.trim().is_empty()).map(str::to_string)
}

fn shell(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(command);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("sh");
        c.arg("-c").arg(command);
        c
    }
}

/// The exit code to pass on: the command's own, or 128 + signal when it was killed (shell convention).
fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return 128 + sig;
        }
    }
    status.code().unwrap_or(1)
}

/// Run the previous command with the same stdin and pass its stdout through untouched.
fn run_previous(command: &str, input: Vec<u8>) -> i32 {
    let spawned = shell(command).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn();
    let Ok(mut child) = spawned else { return 0 };
    if let Some(mut stdin) = child.stdin.take() {
        // Written from a thread so a large input and a large output cannot deadlock.
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let mut out = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_end(&mut out);
    }
    let code = child.wait().map(exit_code).unwrap_or(0);
    let mut so = std::io::stdout().lock();
    let _ = so.write_all(&out);
    let _ = so.flush();
    code
}

fn statusline_mode(args: Args, start: Instant) -> i32 {
    let mut input = Vec::new();
    let _ = std::io::stdin().lock().read_to_end(&mut input);
    let (done_tx, done_rx) = mpsc::channel();
    {
        let args = args.clone();
        let copy = input.clone();
        thread::spawn(move || {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                if let Some(body) = allowlist::filter_statusline(&copy) {
                    send(&args, &body, "claude", start);
                }
            }));
            let _ = done_tx.send(());
        });
    }
    let prev = args
        .prev_file
        .as_ref()
        .and_then(previous_command)
        .or_else(|| args.prev_cmd.clone().filter(|c| !c.trim().is_empty()));
    let code = match prev {
        Some(cmd) => run_previous(&cmd, input),
        None => 0,
    };
    // A healthy receiver answers in milliseconds. A slow or hung one must not hold up a status line redraw:
    // wait a short grace for the report, then leave (the process exit ends the side thread).
    let _ = done_rx.recv_timeout(STATUSLINE_GRACE);
    code
}

/// Process entry. Never returns.
pub fn main() -> ! {
    let start = Instant::now();
    std::panic::set_hook(Box::new(|_| {}));
    // args_os: an argument that is not valid Unicode must not panic the process.
    let raw: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().to_string()).collect();
    let args = parse_args(&raw);
    let code = catch_unwind(AssertUnwindSafe(|| match args.mode.as_str() {
        "hook" => hook_mode(args.clone(), start),
        "statusline" => statusline_mode(args.clone(), start),
        _ => 0,
    }))
    .unwrap_or(0);
    std::process::exit(code)
}
