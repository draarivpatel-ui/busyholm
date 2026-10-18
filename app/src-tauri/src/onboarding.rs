//! First-run onboarding state (WP-11): `onboarding.json` in the app data folder, written by the
//! core only (SPEC 6.11 single writer), atomically (temp file, fsync, rename). Its absence means
//! the user has not finished onboarding yet. Holds a time and a version, nothing else.
use std::io::Write;
use std::path::{Path, PathBuf};

pub const FILE: &str = "onboarding.json";

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

/// True when onboarding was finished (or skipped) on this install.
pub fn is_done(data_dir: &Path) -> bool {
    match std::fs::read(path(data_dir)) {
        Ok(b) => serde_json::from_slice::<serde_json::Value>(&b).ok().and_then(|v| v.get("done_at").and_then(|t| t.as_u64())).is_some(),
        Err(_) => false,
    }
}

/// Record that onboarding is finished. `now_ms` is the wall-clock time.
pub fn mark_done(data_dir: &Path, now_ms: u64) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "schema_version": 1, "done_at": now_ms }).to_string();
    let target = path(data_dir);
    let tmp = data_dir.join(format!(".{FILE}.tmp-{}", std::process::id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, &target)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        // A counter as well as the time: two tests can start within the clock's resolution.
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("bh-onboarding-{}-{}-{n}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn absent_means_not_done_then_done_after_mark() {
        let d = temp();
        assert!(!is_done(&d));
        mark_done(&d, 1_791_826_800_000).unwrap();
        assert!(is_done(&d));
        let left: Vec<_> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left.len(), 1, "no temp file left behind: {left:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_corrupt_file_counts_as_not_done() {
        let d = temp();
        std::fs::write(path(&d), b"{not json").unwrap();
        assert!(!is_done(&d));
        let _ = std::fs::remove_dir_all(&d);
    }
}
