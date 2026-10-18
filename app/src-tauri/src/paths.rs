//! The app data folder of SPEC 6.8 (not Tauri's identifier-derived folder). The full app and the
//! Steam demo share it.
use std::path::PathBuf;

use crate::geometry::Os;

/// `~/Library/Application Support/Busyholm`, `%APPDATA%\Busyholm` or `$XDG_DATA_HOME/busyholm`
/// (falling back to `~/.local/share/busyholm`).
pub fn data_dir_for(os: Os, home: Option<PathBuf>, appdata: Option<PathBuf>, xdg_data_home: Option<PathBuf>) -> Option<PathBuf> {
    match os {
        Os::MacOs => home.map(|h| h.join("Library").join("Application Support").join("Busyholm")),
        Os::Windows => appdata.map(|a| a.join("Busyholm")),
        Os::Linux => xdg_data_home
            .filter(|p| p.is_absolute())
            .map(|x| x.join("busyholm"))
            .or_else(|| home.map(|h| h.join(".local").join("share").join("busyholm"))),
    }
}

/// The data folder for this run: an explicit override (flag or `BUSYHOLM_DATA_DIR`) wins.
pub fn data_dir(override_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(d) = override_dir {
        return Some(d);
    }
    if let Some(d) = std::env::var_os("BUSYHOLM_DATA_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(d));
    }
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    data_dir_for(Os::current(), env("HOME").or_else(|| env("USERPROFILE")), env("APPDATA"), env("XDG_DATA_HOME"))
}
