//! Settings v1: `settings.json` in the app data folder (SPEC 6.9).
//!
//! Every group is required so a settings file is always complete.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{nullable, Hhmm, Species, Tool, Version};

/// Which display the strip appears on. Internally tagged on `mode`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum StripDisplay {
    /// The display with the Dock or taskbar, else the primary (default).
    Auto {},
    /// A specific display by its OS name.
    Named {
        /// 1 to 128 characters, no control characters.
        name: String,
    },
}

/// Where the strip sits relative to other windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LayerMode {
    OnTop,
    BehindWindows,
    /// Exists only on Windows, X11 and layer-shell compositors; elsewhere falls back to `on_top`.
    ReserveSpace,
}

/// What drives the sky.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkyMode {
    UsageAndClock,
    ClockOnly,
}

/// Which hemisphere's seasons to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hemisphere {
    North,
    South,
}

/// Reduced-motion preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReducedMotion {
    FollowOs,
    Always,
}

/// The strip window settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StripSettings {
    /// Default true.
    pub enabled: bool,
    pub display: StripDisplay,
    /// Logical pixels, 72 to 160; default 112.
    pub height: u8,
    /// Default `on_top`.
    pub layer_mode: LayerMode,
    /// Default true.
    pub hover_fade: bool,
    /// Default false.
    pub show_over_fullscreen: bool,
}

/// Sky settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SkySettings {
    /// Default `usage_and_clock`.
    pub mode: SkyMode,
    /// Default `north`.
    pub hemisphere: Hemisphere,
}

/// Local-time quiet hours; the range may cross midnight.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuietHours {
    /// `HH:MM`.
    pub start: Hhmm,
    /// `HH:MM`.
    pub end: Hhmm,
}

/// Sound settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SoundSettings {
    /// Default true.
    pub bell: bool,
    /// 0 to 1.
    pub volume: f64,
    /// Null means off (default).
    #[serde(deserialize_with = "nullable")]
    pub quiet_hours: Option<QuietHours>,
}

/// Notification toggles (all default true; durations are fixed by SPEC 6.9).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationSettings {
    pub needs_you: bool,
    pub renotify: bool,
    pub long_turn: bool,
    pub errors: bool,
}

/// Ambient mode settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AmbientSettings {
    /// Minutes without input before ambient mode starts (5 to 60); null means off.
    #[serde(deserialize_with = "nullable")]
    pub idle_minutes: Option<u8>,
    /// Global shortcut accelerator such as `CommandOrControl+Shift+B`; null means none.
    #[serde(deserialize_with = "nullable")]
    pub shortcut: Option<String>,
}

/// Per-agent settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentsSettings {
    /// Species overrides per tool; a tool not listed uses the SPEC 4.2 default.
    pub species: BTreeMap<Tool, Species>,
}

/// Privacy settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivacySettings {
    /// Default false.
    pub project_names: bool,
    /// Default false.
    pub history_backfill: bool,
}

/// Miscellaneous settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OtherSettings {
    pub launch_at_login: bool,
    /// Default `follow_os`.
    pub reduced_motion: ReducedMotion,
}

/// Update settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateSettings {
    /// Direct-download builds only. Default false.
    pub check: bool,
}

/// The settings file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    pub strip: StripSettings,
    pub sky: SkySettings,
    pub sound: SoundSettings,
    pub notifications: NotificationSettings,
    pub ambient: AmbientSettings,
    pub agents: AgentsSettings,
    pub privacy: PrivacySettings,
    pub other: OtherSettings,
    pub updates: UpdateSettings,
}

impl Validate for Settings {
    fn validate(&self) -> Result<(), ContractError> {
        if let StripDisplay::Named { name } = &self.strip.display {
            check::chars("/strip/display/name", name, 1, 128)?;
            check::pattern(
                "/strip/display/name",
                name,
                check::is_display_name,
                "a name with no control characters",
            )?;
        }
        check::int_range("/strip/height", u64::from(self.strip.height), 72, 160)?;
        check::num_range("/sound/volume", self.sound.volume, 0.0, 1.0)?;
        if let Some(q) = &self.sound.quiet_hours {
            check::pattern("/sound/quiet_hours/start", &q.start, check::is_hhmm, "HH:MM")?;
            check::pattern("/sound/quiet_hours/end", &q.end, check::is_hhmm, "HH:MM")?;
        }
        if let Some(m) = self.ambient.idle_minutes {
            check::int_range("/ambient/idle_minutes", u64::from(m), 5, 60)?;
        }
        if let Some(s) = &self.ambient.shortcut {
            check::chars("/ambient/shortcut", s, 1, 64)?;
            check::pattern(
                "/ambient/shortcut",
                s,
                check::is_accelerator,
                "an accelerator such as CommandOrControl+Shift+B",
            )?;
        }
        Ok(())
    }
}
