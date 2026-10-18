// Settings v1 fixtures (contracts/schemas/settings.v1.schema.json).
import { edit, fx, DELETE } from "../lib.mjs";

const SPECIES = ["beaver", "otter", "frog", "hare", "mole", "heron", "hedgehog"];
const TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];
// Exactly 128 characters: "Écran " (six characters) repeated 21 times, then "Dy".
const NAME_128 = "Écran ".repeat(21) + "Dy";

/** Every documented default at once. The schema gives no default for volume or launch_at_login; 1 and false are used. */
function base() {
  return {
    schema_version: 1,
    strip: {
      enabled: true,
      display: { mode: "auto" },
      height: 112,
      layer_mode: "on_top",
      hover_fade: true,
      show_over_fullscreen: false,
    },
    sky: { mode: "usage_and_clock", hemisphere: "north" },
    sound: { bell: true, volume: 1, quiet_hours: null },
    notifications: { needs_you: true, renotify: true, long_turn: true, errors: true },
    ambient: { idle_minutes: 15, shortcut: null },
    agents: { species: {} },
    privacy: { project_names: false, history_backfill: false },
    other: { launch_at_login: false, reduced_motion: "follow_os" },
    updates: { check: false },
  };
}

/** A copy of the defaults with the given dotted-path edits applied. */
const v = (over) => edit(base(), over);

export function valid() {
  return [
    fx("defaults-full", "Every documented default at once, which is what the app writes on first run.", base()),

    fx("display-named-one-char", "A named display whose name is a single character.", v({ "strip.display": { mode: "named", name: "D" } })),
    fx("display-named-128-chars", "A named display whose name is exactly 128 characters, with non-ASCII letters.", v({ "strip.display": { mode: "named", name: NAME_128 } })),
    fx("display-named-spaces", "A named display with spaces and non-ASCII letters in a shorter name.", v({ "strip.display": { mode: "named", name: "Bureau principal Été" } })),

    fx("strip-disabled", "The strip turned off, with its other settings kept.", v({ "strip.enabled": false })),
    fx("strip-height-72", "The smallest strip height.", v({ "strip.height": 72 })),
    fx("strip-height-160", "The largest strip height.", v({ "strip.height": 160 })),
    fx("layer-mode-behind-windows", "layer_mode set to behind_windows.", v({ "strip.layer_mode": "behind_windows" })),
    fx("layer-mode-reserve-space", "layer_mode set to reserve_space.", v({ "strip.layer_mode": "reserve_space" })),
    fx("hover-fade-off", "hover_fade turned off.", v({ "strip.hover_fade": false })),
    fx("show-over-fullscreen-on", "show_over_fullscreen turned on.", v({ "strip.show_over_fullscreen": true })),

    fx("sky-clock-only", "The sky shows only the clock.", v({ "sky.mode": "clock_only" })),
    fx("sky-hemisphere-south", "The southern hemisphere for the sky.", v({ "sky.hemisphere": "south" })),

    fx("volume-zero", "Volume at 0, the quietest bell.", v({ "sound.volume": 0 })),
    fx("volume-one-bell-off", "Volume at 1 with the bell turned off.", v({ "sound.bell": false })),
    fx("volume-fractional", "A fractional volume of 0.25.", v({ "sound.volume": 0.25 })),
    fx("quiet-hours-daytime", "A quiet range inside one day.", v({ "sound.quiet_hours": { start: "09:00", end: "17:30" } })),
    fx("quiet-hours-cross-midnight", "A quiet range that crosses midnight.", v({ "sound.quiet_hours": { start: "22:00", end: "07:00" } })),
    fx("quiet-hours-full-day-bounds", "The widest clock values, 00:00 to 23:59.", v({ "sound.quiet_hours": { start: "00:00", end: "23:59" } })),

    fx("idle-minutes-5", "Ambient mode after 5 idle minutes, the minimum.", v({ "ambient.idle_minutes": 5 })),
    fx("idle-minutes-60", "Ambient mode after 60 idle minutes, the maximum.", v({ "ambient.idle_minutes": 60 })),
    fx("idle-minutes-off", "Ambient mode off, with idle_minutes null.", v({ "ambient.idle_minutes": null })),
    fx("shortcut-cmd-shift-b", "A three-part accelerator with CommandOrControl.", v({ "ambient.shortcut": "CommandOrControl+Shift+B" })),
    fx("shortcut-alt-f12", "A two-part accelerator with a function key.", v({ "ambient.shortcut": "Alt+F12" })),
    fx("shortcut-f9", "A single-key accelerator.", v({ "ambient.shortcut": "F9" })),
    fx("shortcut-64-chars", "An accelerator of exactly 64 characters.", v({ "ambient.shortcut": "A".repeat(64) })),

    fx("species-full-map", "Every tool has a species override.", v({ "agents.species": { claude: "beaver", codex: "otter", opencode: "frog", antigravity: "hare", gemini: "mole", cursor: "heron", aider: "hedgehog", other: "beaver" } })),
    ...SPECIES.map((s) => fx(`species-value-${s}`, `The species ${s} is used as an override for claude and gemini.`, v({ "agents.species": { claude: s, gemini: s } }))),
    ...TOOLS.map((t) => fx(`species-key-${t}`, `A single species override keyed by the tool ${t}.`, v({ "agents.species": { [t]: "otter" } }))),

    fx("notifications-needs-you-off", "The needs_you notification turned off.", v({ "notifications.needs_you": false })),
    fx("notifications-renotify-off", "The re-notify reminder turned off.", v({ "notifications.renotify": false })),
    fx("notifications-long-turn-off", "The long turn notification turned off.", v({ "notifications.long_turn": false })),
    fx("notifications-errors-off", "The error notification turned off.", v({ "notifications.errors": false })),
    fx("notifications-all-off", "All four notification flags off.", v({ notifications: { needs_you: false, renotify: false, long_turn: false, errors: false } })),

    fx("privacy-project-names-on", "Project names shown as the last folder segment only.", v({ "privacy.project_names": true })),
    fx("privacy-history-backfill-on", "History backfill turned on.", v({ "privacy.history_backfill": true })),

    fx("launch-at-login-on", "Launch at login turned on.", v({ "other.launch_at_login": true })),
    fx("reduced-motion-always", "Reduced motion forced on regardless of the OS setting.", v({ "other.reduced_motion": "always" })),

    fx("updates-check-on", "The direct-download update check turned on.", v({ "updates.check": true })),
  ];
}

export function invalid() {
  const b = base();
  return [
    fx("root-array", "The root must be an object, not an array.", [b], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "settings", ""),

    ...["schema_version", "strip", "sky", "sound", "notifications", "ambient", "agents", "privacy", "other", "updates"].map((g) =>
      fx(`missing-${g.replace(/_/g, "-")}`, `The top-level group ${g} is required.`, edit(b, { [g]: DELETE }), ""),
    ),

    fx("unknown-root-field", "An unknown top-level field is rejected.", edit(b, { telemetry: true }), ""),
    fx("unknown-strip-field", "An unknown field in strip is rejected.", edit(b, { "strip.opacity": 0.5 }), "/strip"),
    fx("unknown-display-field", "An unknown field in the auto display object is rejected.", edit(b, { "strip.display": { mode: "auto", index: 2 } }), "/strip/display"),
    fx("unknown-sky-field", "An unknown field in sky is rejected.", edit(b, { "sky.theme": "dark" }), "/sky"),
    fx("unknown-sound-field", "An unknown field in sound is rejected.", edit(b, { "sound.device": "built-in" }), "/sound"),
    fx("unknown-quiet-hours-field", "An unknown field inside a quiet_hours range is rejected.", edit(b, { "sound.quiet_hours": { start: "09:00", end: "10:00", days: "mon" } }), "/sound/quiet_hours"),
    fx("unknown-notifications-field", "An unknown field in notifications is rejected.", edit(b, { "notifications.sound": true }), "/notifications"),
    fx("unknown-ambient-field", "An unknown field in ambient is rejected.", edit(b, { "ambient.screensaver": true }), "/ambient"),
    fx("unknown-agents-field", "An unknown field in agents is rejected.", edit(b, { "agents.default": "beaver" }), "/agents"),
    fx("unknown-privacy-field", "An unknown field in privacy is rejected.", edit(b, { "privacy.share_prompts": true }), "/privacy"),
    fx("unknown-other-field", "An unknown field in other is rejected.", edit(b, { "other.theme": "dark" }), "/other"),
    fx("unknown-updates-field", "An unknown field in updates is rejected.", edit(b, { "updates.channel": "beta" }), "/updates"),

    fx("height-71", "A strip height of 71 is below the minimum of 72.", edit(b, { "strip.height": 71 }), "/strip/height"),
    fx("height-161", "A strip height of 161 is above the maximum of 160.", edit(b, { "strip.height": 161 }), "/strip/height"),
    fx("height-fractional", "A strip height must be a whole number.", edit(b, { "strip.height": 112.5 }), "/strip/height"),
    fx("height-string", "A strip height must be a number, not a string.", edit(b, { "strip.height": "112" }), "/strip/height"),

    fx("volume-minus-tenth", "A volume below 0 is rejected.", edit(b, { "sound.volume": -0.1 }), "/sound/volume"),
    fx("volume-one-and-half", "A volume above 1 is rejected.", edit(b, { "sound.volume": 1.5 }), "/sound/volume"),

    fx("quiet-hours-start-24-00", "The hour 24 is not a valid start time.", edit(b, { "sound.quiet_hours": { start: "24:00", end: "07:00" } }), "/sound/quiet_hours/start"),
    fx("quiet-hours-start-no-leading-zero", "A start time must have two digits for the hour (7:30 is rejected).", edit(b, { "sound.quiet_hours": { start: "7:30", end: "08:00" } }), "/sound/quiet_hours/start"),
    fx("quiet-hours-end-minute-60", "The minute 60 is not a valid end time.", edit(b, { "sound.quiet_hours": { start: "22:00", end: "12:60" } }), "/sound/quiet_hours/end"),
    fx("quiet-hours-missing-end", "A quiet range needs both start and end.", edit(b, { "sound.quiet_hours": { start: "09:00" } }), "/sound/quiet_hours"),

    fx("idle-minutes-4", "Idle minutes of 4 is below the minimum of 5.", edit(b, { "ambient.idle_minutes": 4 }), "/ambient/idle_minutes"),
    fx("idle-minutes-61", "Idle minutes of 61 is above the maximum of 60.", edit(b, { "ambient.idle_minutes": 61 }), "/ambient/idle_minutes"),
    fx("idle-minutes-zero", "Idle minutes of 0 is not an allowed value (use null for off).", edit(b, { "ambient.idle_minutes": 0 }), "/ambient/idle_minutes"),
    fx("idle-minutes-fractional", "Idle minutes must be a whole number.", edit(b, { "ambient.idle_minutes": 10.5 }), "/ambient/idle_minutes"),

    fx("shortcut-with-space", "A shortcut may not contain a space.", edit(b, { "ambient.shortcut": "Command Shift B" }), "/ambient/shortcut"),
    fx("shortcut-empty-string", "An empty shortcut string is rejected (use null for none).", edit(b, { "ambient.shortcut": "" }), "/ambient/shortcut"),
    fx("shortcut-trailing-plus", "A shortcut may not end with a plus sign.", edit(b, { "ambient.shortcut": "Alt+" }), "/ambient/shortcut"),
    fx("shortcut-over-64-chars", "A shortcut of 65 characters is over the limit.", edit(b, { "ambient.shortcut": "A".repeat(65) }), "/ambient/shortcut"),

    fx("display-named-without-name", "A named display must carry a name.", edit(b, { "strip.display": { mode: "named" } }), "/strip/display"),
    fx("display-auto-with-name", "An auto display may not carry a name.", edit(b, { "strip.display": { mode: "auto", name: "Main" } }), "/strip/display"),
    fx("display-unknown-mode", "The display mode must be auto or named.", edit(b, { "strip.display": { mode: "manual" } }), "/strip/display"),
    fx("display-name-empty", "A display name may not be empty.", edit(b, { "strip.display": { mode: "named", name: "" } }), "/strip/display/name"),
    fx("display-name-newline", "A display name may not contain a control character.", edit(b, { "strip.display": { mode: "named", name: "Main\nScreen" } }), "/strip/display/name"),
    fx("display-name-129-chars", "A display name over 128 characters is rejected.", edit(b, { "strip.display": { mode: "named", name: "x".repeat(129) } }), "/strip/display/name"),

    fx("species-unknown-value", "A species must be one of the seven known species.", edit(b, { "agents.species": { claude: "dragon" } }), "/agents/species/claude"),
    fx("species-unknown-tool-key", "A species key must be a known tool.", edit(b, { "agents.species": { vscode: "beaver" } }), "/agents/species"),
    fx("species-key-wrong-case", "Tool keys are lowercase, so Claude is rejected.", edit(b, { "agents.species": { Claude: "otter" } }), "/agents/species"),

    fx("layer-mode-always-on-top", "layer_mode has no always_on_top value; on_top is the name.", edit(b, { "strip.layer_mode": "always_on_top" }), "/strip/layer_mode"),
    fx("reduced-motion-never", "reduced_motion allows only follow_os or always.", edit(b, { "other.reduced_motion": "never" }), "/other/reduced_motion"),
    fx("sky-mode-unknown", "The sky mode must be usage_and_clock or clock_only.", edit(b, { "sky.mode": "full" }), "/sky/mode"),
    fx("hemisphere-unknown", "The hemisphere must be north or south.", edit(b, { "sky.hemisphere": "east" }), "/sky/hemisphere"),
    fx("schema-version-2", "schema_version must be 1 for this contract.", edit(b, { schema_version: 2 }), "/schema_version"),

    fx("strip-enabled-string", "The enabled flag must be a boolean.", edit(b, { "strip.enabled": "yes" }), "/strip/enabled"),
    fx("bell-null", "The bell flag may not be null.", edit(b, { "sound.bell": null }), "/sound/bell"),
    fx("project-names-number", "The project_names flag must be a boolean, not 0 or 1.", edit(b, { "privacy.project_names": 0 }), "/privacy/project_names"),
    fx("updates-check-string", "The update check flag must be a boolean.", edit(b, { "updates.check": "true" }), "/updates/check"),

    fx("strip-missing-height", "height is required in strip.", edit(b, { "strip.height": DELETE }), "/strip"),
    fx("sky-missing-hemisphere", "hemisphere is required in sky.", edit(b, { "sky.hemisphere": DELETE }), "/sky"),
    fx("sound-missing-bell", "bell is required in sound.", edit(b, { "sound.bell": DELETE }), "/sound"),
    fx("notifications-missing-errors", "errors is required in notifications.", edit(b, { "notifications.errors": DELETE }), "/notifications"),
    fx("ambient-missing-shortcut", "shortcut is required in ambient (null when none).", edit(b, { "ambient.shortcut": DELETE }), "/ambient"),
    fx("agents-missing-species", "species is required in agents.", edit(b, { "agents.species": DELETE }), "/agents"),
    fx("privacy-missing-history-backfill", "history_backfill is required in privacy.", edit(b, { "privacy.history_backfill": DELETE }), "/privacy"),
    fx("other-missing-reduced-motion", "reduced_motion is required in other.", edit(b, { "other.reduced_motion": DELETE }), "/other"),
  ];
}
