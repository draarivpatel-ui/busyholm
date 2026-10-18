//! Settings v1 store (SPEC 6.8, 6.9): `settings.json` in the app data folder. The core is the only
//! writer; every write is atomic (temp file, then rename) and validated against the contract.
//! Defaults follow the Settings v1 schema descriptions and SPEC Revision 1 (ambient is manual,
//! so `ambient.idle_minutes` is null; autostart is off).
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use busyholm_contracts::settings::*;
use busyholm_contracts::{Settings, Validate};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadNote {
    Created,
    Loaded,
    ReplacedCorrupt,
}

pub fn defaults() -> Settings {
    Settings {
        schema_version: Default::default(),
        strip: StripSettings {
            enabled: true,
            display: StripDisplay::Auto {},
            height: 112,
            layer_mode: LayerMode::OnTop,
            hover_fade: true,
            show_over_fullscreen: false,
        },
        sky: SkySettings { mode: SkyMode::UsageAndClock, hemisphere: Hemisphere::North },
        sound: SoundSettings { bell: true, volume: 0.7, quiet_hours: None },
        notifications: NotificationSettings { needs_you: true, renotify: true, long_turn: true, errors: true },
        ambient: AmbientSettings { idle_minutes: None, shortcut: None },
        agents: AgentsSettings { species: BTreeMap::new() },
        privacy: PrivacySettings { project_names: false, history_backfill: false },
        other: OtherSettings { launch_at_login: false, reduced_motion: ReducedMotion::FollowOs },
        updates: UpdateSettings { check: false },
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Settings,
}

/// Writes `bytes` to `path` atomically: a temp file in the same folder, fsync, then rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create folder: {e}"))?;
    let tmp = dir.join(format!(".{}.tmp-{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("file"), std::process::id()));
    let r = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r.map_err(|e| format!("write {}: {e}", path.display()))
}

fn encode(s: &Settings) -> Result<Vec<u8>, String> {
    let mut v = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    v.push(b'\n');
    Ok(v)
}

impl SettingsStore {
    pub fn load(dir: &Path) -> Result<(SettingsStore, LoadNote), String> {
        let path = dir.join("settings.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => match busyholm_contracts::from_json::<Settings>(&text) {
                Ok(s) => Ok((SettingsStore { path, current: s }, LoadNote::Loaded)),
                Err(_) => {
                    // Keep the bad file for inspection; never delete user data.
                    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                    let aside = dir.join(format!("settings.json.corrupt-{ts}"));
                    std::fs::rename(&path, &aside).map_err(|e| format!("move corrupt settings aside: {e}"))?;
                    let s = defaults();
                    write_atomic(&path, &encode(&s)?)?;
                    Ok((SettingsStore { path, current: s }, LoadNote::ReplacedCorrupt))
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let s = defaults();
                write_atomic(&path, &encode(&s)?)?;
                Ok((SettingsStore { path, current: s }, LoadNote::Created))
            }
            Err(e) => Err(format!("read {}: {e}", path.display())),
        }
    }

    pub fn get(&self) -> &Settings {
        &self.current
    }

    pub fn set(&mut self, s: Settings) -> Result<(), String> {
        s.validate().map_err(|e| e.to_string())?;
        write_atomic(&self.path, &encode(&s)?)?;
        self.current = s;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn reset_in_memory(&mut self) -> Settings {
        self.current = defaults();
        self.current.clone()
    }
}
