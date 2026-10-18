//! Optional JSON-lines log for the acceptance tests (`--test-log` or `BUSYHOLM_TEST_LOG`).
//! Records window geometry, levels, click-through toggles and visibility. Never contains snapshot,
//! moment or settings content (SPEC 5.7): counts and geometry only.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static LOG: OnceLock<Mutex<File>> = OnceLock::new();

pub fn init(path: Option<PathBuf>) {
    let path = path.or_else(|| std::env::var_os("BUSYHOLM_TEST_LOG").filter(|v| !v.is_empty()).map(PathBuf::from));
    if let Some(p) = path {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(f) = OpenOptions::new().create(true).append(true).open(&p) {
            let _ = LOG.set(Mutex::new(f));
        }
    }
}

pub fn enabled() -> bool {
    LOG.get().is_some()
}

pub fn log(event: &str, data: serde_json::Value) {
    let Some(f) = LOG.get() else { return };
    let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let line = serde_json::json!({ "t": t, "event": event, "data": data });
    if let Ok(mut f) = f.lock() {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}
