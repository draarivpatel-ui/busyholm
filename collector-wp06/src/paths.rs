//! Per-OS default locations. Pure functions of a home directory and environment values,
//! so they test on any host.
use std::path::{Path, PathBuf};

/// OpenCode's data folder: `$XDG_DATA_HOME/opencode` when that is an absolute path, else
/// `<home>/.local/share/opencode` (the same shape on macOS, Linux and, per the docs, Windows
/// under the user profile).
pub fn opencode_data_dir(home: &Path, xdg_data_home: Option<&str>) -> PathBuf {
    match xdg_data_home {
        Some(x) if !x.is_empty() && Path::new(x).is_absolute() => Path::new(x).join("opencode"),
        _ => home.join(".local").join("share").join("opencode"),
    }
}

/// OpenCode's database file inside the data folder.
pub fn opencode_db(data_dir: &Path) -> PathBuf {
    data_dir.join("opencode.db")
}

/// The Antigravity CLI root, `<home>/.gemini/antigravity-cli`, on every OS.
pub fn agy_root(home: &Path) -> PathBuf {
    home.join(".gemini").join("antigravity-cli")
}

/// Candidate OpenCode database files, most specific first; the poller uses the first that
/// exists. `get` reads an environment variable. `OPENCODE_DB` (an absolute path) overrides
/// everything; then the XDG or home based default; and `%APPDATA%\opencode` last, because
/// one OpenCode release note placed the Windows database there while the docs and source say
/// the user profile (the research could not settle it).
pub fn opencode_db_candidates(home: &Path, get: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = get("OPENCODE_DB").filter(|p| Path::new(p).is_absolute()) {
        out.push(PathBuf::from(p));
    }
    out.push(opencode_db(&opencode_data_dir(home, get("XDG_DATA_HOME").as_deref())));
    if let Some(a) = get("APPDATA").filter(|a| !a.is_empty()) {
        out.push(opencode_db(&Path::new(&a).join("opencode")));
    }
    out.dedup();
    out
}
