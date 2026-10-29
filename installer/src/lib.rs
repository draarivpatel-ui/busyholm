//! Busyholm hook installer and uninstaller (WP-07).
//!
//! * Edits only the spans it owns: a targeted JSON span editor ([`span`]), with a design borrowed from status line settings editors. Nothing is re-serialised, so key order, indentation, line endings and BOM stay.
//! * Records ownership of every entry it inserts in InstallManifest v1 (`owned`, found again by the
//!   per-install `--owner <tag>` and a hash). Disconnect removes ONLY those entries and never restores a
//!   whole-file backup over a file that changed later (SPEC Revision 1). The original is kept for recovery.
//! * Always plans first: a [`Plan`] holds the exact edits and a unified diff, and writes nothing.
//!   [`Installer::apply`] refuses if a file changed since the plan was made.
//!
//! Paths come from a [`Layout`]; only [`Layout::from_env_with`] looks at environment variables
//! (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`), and it takes them as a closure
//! so tests never read the real environment. Tests use temp folders only.

pub mod diff;
pub mod fsio;
pub mod j;
pub mod ops;
pub mod span;

use busyholm_contracts::common::{Tool, Version};
use busyholm_contracts::install_manifest::{After, Before as ManifestBefore, InstallAction, InstallState, InstallTarget, InstallTool, ManifestEntry, OwnedEntry};
pub use busyholm_contracts::install_manifest::InstallManifest;
use busyholm_contracts::Validate;
pub use j::canonical_json;
use j::{Style, J};
use ops::{Before, Changes};
use serde_json::Value;
pub use span::Edit;
use span::{Doc, Parsed};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum InstallError {
    InvalidJson { path: PathBuf, detail: String },
    WrongShape { path: PathBuf, detail: String },
    NotUtf8 { path: PathBuf },
    ChangedSincePreview { path: PathBuf },
    Symlink { path: PathBuf },
    NotRegularFile { path: PathBuf },
    TooLarge { path: PathBuf },
    Io { path: PathBuf, source: std::io::Error },
    StatusLineUnsupported { path: PathBuf, detail: String },
    BackupMissing { what: String },
    Manifest { detail: String },
    ToolNotFound { dir: PathBuf },
    PluginSource { detail: String },
    Foreign { path: PathBuf, detail: String },
    Verify { path: PathBuf, detail: String },
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use InstallError::*;
        match self {
            InvalidJson { path, detail } => write!(f, "{} is not valid JSON ({detail}); nothing was changed", path.display()),
            WrongShape { path, detail } => write!(f, "{} has an unexpected shape ({detail}); nothing was changed", path.display()),
            NotUtf8 { path } => write!(f, "{} is not valid UTF-8; nothing was changed", path.display()),
            ChangedSincePreview { path } => write!(f, "{} changed after the preview; nothing was written", path.display()),
            Symlink { path } => write!(f, "{} is a symbolic link; point Busyholm at the real file instead", path.display()),
            NotRegularFile { path } => write!(f, "{} is not a regular file", path.display()),
            TooLarge { path } => write!(f, "{} is unusually large; nothing was changed", path.display()),
            Io { path, source } => write!(f, "{}: {source}", path.display()),
            StatusLineUnsupported { path, detail } => write!(f, "{}: {detail}", path.display()),
            BackupMissing { what } => write!(f, "the saved copy of {what} is missing"),
            Manifest { detail } => write!(f, "install manifest: {detail}"),
            ToolNotFound { dir } => write!(f, "{} does not exist; is the tool installed?", dir.display()),
            PluginSource { detail } => write!(f, "plugin source: {detail}"),
            Foreign { path, detail } => write!(f, "{}: {detail}", path.display()),
            Verify { path, detail } => write!(f, "internal check failed for {} ({detail}); nothing was written", path.display()),
        }
    }
}
impl std::error::Error for InstallError {}

// ---------------------------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Layout {
    /// Busyholm's app data folder (SPEC 6.8).
    pub data_dir: PathBuf,
    pub claude_dir: PathBuf,
    pub codex_dir: PathBuf,
    pub opencode_dir: PathBuf,
}

fn absolute_env(get: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<PathBuf> {
    get(key).map(PathBuf::from).filter(|p| p.is_absolute())
}

impl Layout {
    /// Resolve the agents' folders. A relative or empty override is ignored.
    pub fn from_env_with(home: &Path, data_dir: PathBuf, get: &dyn Fn(&str) -> Option<String>) -> Layout {
        let claude_dir = absolute_env(get, "CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
        let codex_dir = absolute_env(get, "CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
        let opencode_dir = absolute_env(get, "OPENCODE_CONFIG_DIR")
            .or_else(|| absolute_env(get, "XDG_CONFIG_HOME").map(|x| x.join("opencode")))
            .unwrap_or_else(|| home.join(".config").join("opencode"));
        Layout { data_dir, claude_dir, codex_dir, opencode_dir }
    }

    /// The default app data folder for this OS (SPEC 6.8).
    pub fn default_data_dir(home: &Path, get: &dyn Fn(&str) -> Option<String>) -> PathBuf {
        if cfg!(target_os = "macos") {
            home.join("Library").join("Application Support").join("Busyholm")
        } else if cfg!(windows) {
            absolute_env(get, "APPDATA").unwrap_or_else(|| home.join("AppData").join("Roaming")).join("Busyholm")
        } else {
            absolute_env(get, "XDG_DATA_HOME").unwrap_or_else(|| home.join(".local").join("share")).join("busyholm")
        }
    }

    pub fn claude_settings(&self) -> PathBuf {
        self.claude_dir.join("settings.json")
    }
    pub fn codex_hooks(&self) -> PathBuf {
        self.codex_dir.join("hooks.json")
    }
    /// Never read or written by the installer; exposed so tests can prove that.
    pub fn codex_config(&self) -> PathBuf {
        self.codex_dir.join("config.toml")
    }
    pub fn opencode_plugin(&self) -> PathBuf {
        self.opencode_dir.join("plugins").join("busyholm.js")
    }
    pub fn shim_path(&self) -> PathBuf {
        self.data_dir.join("bin").join(if cfg!(windows) { "busyholm-hook.exe" } else { "busyholm-hook" })
    }
    pub fn runtime_path(&self) -> PathBuf {
        self.data_dir.join("runtime.json")
    }
    pub fn manifest_path(&self) -> PathBuf {
        self.data_dir.join("install-manifest.json")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups").join("install")
    }
    fn backup_path(&self, sha: &str) -> PathBuf {
        self.backups_dir().join(format!("{sha}.bak"))
    }
}

// ---------------------------------------------------------------------------------------------
// public plan types
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Component {
    ClaudeHooks,
    ClaudeStatusline,
    CodexHooks,
    OpencodePlugin,
}

impl Component {
    fn target(self) -> InstallTarget {
        match self {
            Component::ClaudeHooks => InstallTarget::ClaudeHooks,
            Component::ClaudeStatusline => InstallTarget::ClaudeStatusline,
            Component::CodexHooks => InstallTarget::CodexHooks,
            Component::OpencodePlugin => InstallTarget::OpencodePlugin,
        }
    }
}

/// Files the installer copies from (the built shim, the OpenCode plugin source text).
#[derive(Debug, Clone)]
pub struct Sources {
    pub shim_binary: PathBuf,
    pub opencode_plugin: String,
}

#[derive(Debug, Clone)]
pub struct FilePlan {
    pub path: PathBuf,
    /// The first target this file serves in the plan.
    pub target: InstallTarget,
    /// The exact unified diff of what will be written.
    pub diff: String,
    /// Byte intervals of the OLD file in which edits may fall (the target span).
    pub allowed: Vec<(usize, usize)>,
    /// The edits, in old-file coordinates, sorted and disjoint. Empty for files created or deleted whole.
    pub edits: Vec<Edit>,
    /// The file after the plan; `None` means the file is deleted.
    pub new: Option<Vec<u8>>,
    /// Something worth telling the user (a file left in place, for example).
    pub note: Option<String>,
    old: Option<Vec<u8>>,
    mode: u32,
    backups: Vec<(String, Vec<u8>)>,
    manifest_after: InstallManifest,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub files: Vec<FilePlan>,
    /// Notes that do not belong to one file.
    pub notes: Vec<String>,
    /// Install plans record ownership BEFORE touching a file; disconnect plans drop it AFTER.
    install: bool,
    manifest_before: InstallManifest,
    pub manifest_final: InstallManifest,
}

impl Plan {
    /// The whole preview: every file's diff, in order.
    pub fn diff_text(&self) -> String {
        let mut out = String::new();
        for f in &self.files {
            out.push_str(&format!("# {}\n", f.path.display()));
            if let Some(n) = &f.note {
                out.push_str(&format!("# note: {n}\n"));
            }
            out.push_str(&f.diff);
            if !f.diff.ends_with('\n') {
                out.push('\n');
            }
            out.push('\n');
        }
        for n in &self.notes {
            out.push_str(&format!("# note: {n}\n"));
        }
        out
    }
    /// Nothing to write and nothing to record.
    pub fn is_noop(&self) -> bool {
        self.files.is_empty() && self.manifest_before == self.manifest_final
    }
}

// ---------------------------------------------------------------------------------------------
// the installer
// ---------------------------------------------------------------------------------------------

pub struct Installer {
    pub layout: Layout,
    clock: Box<dyn Fn() -> u64>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn random_tag() -> String {
    let mut b = [0u8; 12];
    getrandom::getrandom(&mut b).expect("system randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn io_err(path: &Path, source: std::io::Error) -> InstallError {
    InstallError::Io { path: path.to_path_buf(), source }
}

const CLAUDE_EVENTS: [&str; 13] = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
    "PermissionDenied", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop",
];
const CODEX_EVENTS: [&str; 10] = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "Interrupt",
    "SubagentStart", "SubagentStop",
];

/// Every event name we may edit (Claude's 13 plus Codex's `Interrupt`): duplicate keys among these are refused.
const ALL_EVENTS: [&str; 14] = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
    "PermissionDenied", "Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "Interrupt",
];

/// What one config-file component contributes.
enum Spec {
    Hooks { id: &'static str, tool: InstallTool, target: InstallTarget, state: InstallState, groups: Vec<(String, J)> },
    Status { id: &'static str },
}

impl Installer {
    pub fn new(layout: Layout) -> Installer {
        Installer { layout, clock: Box::new(now_ms) }
    }
    pub fn with_clock(mut self, clock: Box<dyn Fn() -> u64>) -> Installer {
        self.clock = clock;
        self
    }

    // ----- manifest ---------------------------------------------------------------------------

    fn empty_manifest(&self) -> InstallManifest {
        InstallManifest { schema_version: Version, app_version: env!("CARGO_PKG_VERSION").to_string(), owner_tag: None, entries: Vec::new() }
    }

    /// The manifest on disk, or an empty one when there is none. A corrupt manifest is an error: it is never
    /// silently replaced.
    pub fn load_manifest(&self) -> Result<InstallManifest, InstallError> {
        let p = self.layout.manifest_path();
        match fsio::read_regular(&p)? {
            None => Ok(self.empty_manifest()),
            Some(bytes) => {
                let text = String::from_utf8(bytes).map_err(|_| InstallError::Manifest { detail: "not UTF-8".into() })?;
                busyholm_contracts::from_json::<InstallManifest>(&text).map_err(|e| InstallError::Manifest { detail: e.to_string() })
            }
        }
    }

    fn save_manifest(&self, m: &InstallManifest) -> Result<(), InstallError> {
        m.validate().map_err(|e| InstallError::Manifest { detail: format!("refusing to write an invalid manifest: {e}") })?;
        if m.entries.is_empty() && m.owner_tag.is_none() {
            return fsio::remove_file(&self.layout.manifest_path());
        }
        let mut text = serde_json::to_string_pretty(m).map_err(|e| InstallError::Manifest { detail: e.to_string() })?;
        text.push('\n');
        fsio::ensure_dir(&self.layout.data_dir)?;
        fsio::write_atomic(&self.layout.manifest_path(), text.as_bytes(), 0o600)
    }

    // ----- shared helpers ---------------------------------------------------------------------

    fn hook_args(&self, agent: &str, tag: &str) -> Vec<String> {
        vec![
            "hook".into(),
            "--agent".into(),
            agent.into(),
            "--runtime".into(),
            path_string(&self.layout.runtime_path()),
            "--owner".into(),
            tag.into(),
        ]
    }

    /// Claude Code: exec form (no shell), asynchronous so a hook can never slow or steer the agent.
    fn claude_groups(&self, tag: &str) -> Vec<(String, J)> {
        let shim = path_string(&self.layout.shim_path());
        CLAUDE_EVENTS
            .iter()
            .map(|ev| {
                let handler = J::Obj(vec![
                    ("type".into(), J::Str("command".into())),
                    ("command".into(), J::Str(shim.clone())),
                    ("args".into(), J::Arr(self.hook_args("claude", tag).into_iter().map(J::Str).collect())),
                    ("async".into(), J::Bool(true)),
                    ("timeout".into(), J::Num("2".into())),
                ]);
                (ev.to_string(), J::Obj(vec![("hooks".into(), J::Arr(vec![handler]))]))
            })
            .collect()
    }

    /// Codex: shell form (Codex has no `args` field), so every word is quoted. Codex trusts hooks by hash, so
    /// this text is deterministic for a given install.
    fn codex_groups(&self, tag: &str) -> Vec<(String, J)> {
        let shim = fsio::shell_quote(&path_string(&self.layout.shim_path()));
        let rest = self.hook_args("codex", tag).iter().map(|w| fsio::shell_quote(w)).collect::<Vec<_>>().join(" ");
        CODEX_EVENTS
            .iter()
            .map(|ev| {
                let short = matches!(*ev, "SessionEnd" | "Interrupt");
                let handler = J::Obj(vec![
                    ("type".into(), J::Str("command".into())),
                    ("command".into(), J::Str(format!("{shim} {rest}"))),
                    ("async".into(), J::Bool(true)),
                    ("timeout".into(), J::Num(if short { "3" } else { "5" }.into())),
                ]);
                (ev.to_string(), J::Obj(vec![("hooks".into(), J::Arr(vec![handler]))]))
            })
            .collect()
    }

    fn statusline_command(&self, tag: &str, replaced: Option<(&str, &str)>) -> String {
        let shim = fsio::shell_quote(&path_string(&self.layout.shim_path()));
        let mut parts = vec![
            shim.clone(),
            "statusline".to_string(),
            "--runtime".to_string(),
            fsio::shell_quote(&path_string(&self.layout.runtime_path())),
        ];
        if let Some((sha, cmd)) = replaced {
            parts.push("--prev-file".into());
            parts.push(fsio::shell_quote(&path_string(&self.layout.backup_path(sha))));
            parts.push("--prev-cmd".into());
            parts.push(fsio::shell_quote(cmd));
        }
        parts.push("--owner".into());
        parts.push(tag.to_string());
        let call = parts.join(" ");
        match replaced {
            Some((_, cmd)) => format!("if [ -x {shim} ]; then {call}; else eval {}; fi", fsio::shell_quote(cmd)),
            None => format!("if [ -x {shim} ]; then {call}; fi"),
        }
    }

    fn make_entry(
        &self,
        id: &str,
        tool: Option<InstallTool>,
        target: InstallTarget,
        path: &Path,
        action: InstallAction,
        state: InstallState,
        before: &Option<Vec<u8>>,
        after: &[u8],
        owned: Option<Vec<OwnedEntry>>,
    ) -> ManifestEntry {
        ManifestEntry {
            id: id.to_string(),
            tool,
            target,
            path: path_string(path),
            action,
            state,
            installed_at: (self.clock)(),
            before: ManifestBefore {
                existed: before.is_some(),
                sha256: before.as_ref().map(|b| fsio::sha256_hex(b)),
                bytes: before.as_ref().map(|b| b.len() as u32),
            },
            after: After { sha256: fsio::sha256_hex(after), bytes: after.len() as u32 },
            owned,
        }
    }

    // ----- install ----------------------------------------------------------------------------

    /// Plan an install. Writes nothing.
    pub fn plan_install(&self, comps: &[Component], sources: &Sources) -> Result<Plan, InstallError> {
        let manifest_before = self.load_manifest()?;
        let mut m = manifest_before.clone();
        let tag = m.owner_tag.clone().unwrap_or_else(random_tag);
        m.owner_tag = Some(tag.clone());
        let mut files: Vec<FilePlan> = Vec::new();
        let mut notes = Vec::new();

        if !comps.is_empty() {
            self.plan_shim(&mut m, sources, &mut files)?;
        }
        let want = |c: Component| comps.contains(&c);

        let mut claude: Vec<Spec> = Vec::new();
        if want(Component::ClaudeHooks) {
            claude.push(Spec::Hooks {
                id: "claude-hooks",
                tool: InstallTool::Claude,
                target: InstallTarget::ClaudeHooks,
                state: InstallState::Installed,
                groups: self.claude_groups(&tag),
            });
        }
        if want(Component::ClaudeStatusline) {
            claude.push(Spec::Status { id: "claude-statusline" });
        }
        if !claude.is_empty() {
            self.plan_config_install(&mut m, &tag, &self.layout.claude_settings(), &self.layout.claude_dir, claude, &mut files)?;
        }
        if want(Component::CodexHooks) {
            let spec = Spec::Hooks {
                id: "codex-hooks",
                tool: InstallTool::Codex,
                target: InstallTarget::CodexHooks,
                state: InstallState::PendingReview,
                groups: self.codex_groups(&tag),
            };
            self.plan_config_install(&mut m, &tag, &self.layout.codex_hooks(), &self.layout.codex_dir, vec![spec], &mut files)?;
        }
        if want(Component::OpencodePlugin) {
            self.plan_plugin_install(&mut m, sources, &mut files, &mut notes)?;
        }
        if m.entries.is_empty() {
            m.owner_tag = manifest_before.owner_tag.clone();
        }
        Ok(Plan { files, notes, install: true, manifest_before, manifest_final: m })
    }

    fn plan_shim(&self, m: &mut InstallManifest, sources: &Sources, files: &mut Vec<FilePlan>) -> Result<(), InstallError> {
        let bytes = fsio::read_regular(&sources.shim_binary)?.ok_or_else(|| InstallError::Foreign { path: sources.shim_binary.clone(), detail: "the busyholm-hook binary to install does not exist".into() })?;
        let target = self.layout.shim_path();
        let old = fsio::read_regular(&target)?;
        let known = m.entries.iter().any(|e| e.target == InstallTarget::ShimBinary);
        if old.as_deref() == Some(bytes.as_slice()) && known {
            return Ok(());
        }
        let first = m.entries.iter().find(|e| e.target == InstallTarget::ShimBinary).cloned();
        let mut entry = self.make_entry("shim-binary", None, InstallTarget::ShimBinary, &target, InstallAction::CreateFile, InstallState::Installed, &None, &bytes, None);
        if let Some(f) = first {
            entry.before = f.before;
        }
        upsert(m, entry);
        let diff = format!(
            "--- /dev/null\n+++ {}\n@@ binary file: busyholm-hook ({} bytes, sha256 {}) @@\n",
            target.display(),
            bytes.len(),
            fsio::sha256_hex(&bytes)
        );
        files.push(FilePlan {
            path: target,
            target: InstallTarget::ShimBinary,
            diff,
            allowed: Vec::new(),
            edits: Vec::new(),
            new: Some(bytes),
            note: None,
            old,
            mode: 0o755,
            backups: Vec::new(),
            manifest_after: m.clone(),
        });
        Ok(())
    }

    fn plan_config_install(
        &self,
        m: &mut InstallManifest,
        tag: &str,
        path: &Path,
        parent: &Path,
        specs: Vec<Spec>,
        files: &mut Vec<FilePlan>,
    ) -> Result<(), InstallError> {
        if !parent.is_dir() {
            return Err(InstallError::ToolNotFound { dir: parent.to_path_buf() });
        }
        let old = fsio::read_regular(path)?;
        let input = Input::read(path, old.as_deref())?;
        let doc = &input.doc;
        let st = input.style();
        let src = input.text.as_str();

        // each component's changes
        let mut parts: Vec<(&Spec, Changes, Option<String>)> = Vec::new();
        for spec in &specs {
            let (hooks, status) = (matches!(spec, Spec::Hooks { .. }), matches!(spec, Spec::Status { .. }));
            if let Some(detail) = ops::duplicate_keys(doc, hooks, status, &ALL_EVENTS) {
                return Err(InstallError::WrongShape { path: path.to_path_buf(), detail });
            }
            match spec {
                Spec::Hooks { groups, .. } => {
                    let ch = ops::install_hooks(src, doc, &st, tag, groups, path)?;
                    parts.push((spec, ch, None));
                }
                Spec::Status { .. } => {
                    let make = |replaced: Option<(&str, &str)>| self.statusline_command(tag, replaced);
                    let si = ops::install_statusline(src, doc, &st, tag, &make, path)?;
                    parts.push((spec, si.changes, si.replaced_text));
                }
            }
        }
        let changed: Vec<bool> = parts.iter().map(|(_, c, _)| !c.edits.is_empty() || !c.root_new.is_empty()).collect();
        let owned_missing: Vec<bool> = parts
            .iter()
            .map(|(s, _, _)| {
                let id = match s { Spec::Hooks { id, .. } | Spec::Status { id } => *id };
                !m.entries.iter().any(|e| e.id == id)
            })
            .collect();
        if !changed.iter().any(|c| *c) && !owned_missing.iter().any(|c| *c) {
            return Ok(()); // already installed, nothing to do
        }

        // combine
        let mut all = Changes::default();
        for (i, (_, ch, _)) in parts.iter().enumerate() {
            if changed[i] {
                all.edits.extend(ch.edits.clone());
                all.root_new.extend(ch.root_new.clone());
            }
        }
        let (edits, new_text) = input.finish_install(&all, &st, path)?;
        let new_bytes = new_text.into_bytes();

        // verify by running the removal on the result and comparing with the original
        if !edits.is_empty() {
            self.verify_install(path, &input, &new_bytes, tag, &parts)?;
        }

        let mut backups = Vec::new();
        if let Some(o) = &old {
            backups.push((fsio::sha256_hex(o), input.before_backup()));
        }
        for (_, _, replaced) in &parts {
            if let Some(t) = replaced {
                backups.push((fsio::sha256_hex(t.as_bytes()), t.clone().into_bytes()));
            }
        }

        // manifest entries
        let mut first_target = None;
        for (i, (spec, ch, _)) in parts.iter().enumerate() {
            let (id, tool, target, state) = match spec {
                Spec::Hooks { id, tool, target, state, .. } => (*id, Some(*tool), *target, *state),
                Spec::Status { id } => (*id, Some(InstallTool::Claude), InstallTarget::ClaudeStatusline, InstallState::Installed),
            };
            first_target.get_or_insert(target);
            if !changed[i] && !owned_missing[i] {
                continue;
            }
            let owned: Vec<OwnedEntry> = ch
                .owned
                .iter()
                .map(|d| OwnedEntry { event: d.event.clone(), pointer: d.pointer.clone(), sha256: d.sha256.clone(), replaced_sha256: d.replaced_sha256.clone() })
                .collect();
            let action = if old.is_some() { InstallAction::EditSpan } else { InstallAction::CreateFile };
            let mut entry = self.make_entry(id, tool, target, path, action, state, &old, &new_bytes, Some(owned));
            // Every entry on one file shares the file as the user first had it (missing, empty, or with its own
            // bytes): the first entry's `before` and `action`, so the LAST disconnect can restore it exactly even
            // when the components were installed and removed one at a time.
            let path_str = path_string(path);
            let origin = m
                .entries
                .iter()
                .filter(|e| e.path == path_str)
                .min_by_key(|e| e.installed_at)
                .map(|e| (e.before.clone(), e.action));
            if let Some((before, action)) = origin {
                entry.before = before;
                entry.action = action;
            }
            upsert(m, entry);
        }

        let allowed = input.allowed_install(&all);
        let diff = input.diff(path, &edits, &new_bytes);
        let mut summary = Vec::new();
        for (i, (spec, ch, _)) in parts.iter().enumerate() {
            if !changed[i] {
                continue;
            }
            match spec {
                Spec::Hooks { .. } => {
                    let events: Vec<&str> = ch.owned.iter().filter_map(|d| d.event.as_deref()).collect();
                    summary.push(format!("adds Busyholm hooks for {} events ({}), each running busyholm-hook", events.len(), events.join(", ")));
                }
                Spec::Status { .. } => summary.push(if ch.owned.iter().any(|d| d.replaced_sha256.is_some()) {
                    "wraps your status line: your own command still runs and its output is passed through unchanged".to_string()
                } else {
                    "adds a status line that only reports your usage numbers to Busyholm".to_string()
                }),
            }
        }
        files.push(FilePlan {
            path: path.to_path_buf(),
            target: first_target.unwrap_or(InstallTarget::ClaudeHooks),
            diff,
            allowed,
            edits,
            new: Some(new_bytes),
            note: Some(summary.join("; ")),
            old,
            mode: input.write_mode(path),
            backups,
            manifest_after: m.clone(),
        });
        Ok(())
    }

    fn verify_install(&self, path: &Path, input: &Input, new_bytes: &[u8], tag: &str, parts: &[(&Spec, Changes, Option<String>)]) -> Result<(), InstallError> {
        let fail = |detail: &str| InstallError::Verify { path: path.to_path_buf(), detail: detail.to_string() };
        let new_text = String::from_utf8(new_bytes.to_vec()).map_err(|_| fail("result is not UTF-8"))?;
        let Parsed::Doc(ndoc) = span::parse(&new_text).map_err(|_| fail("result is not valid JSON"))? else { return Err(fail("result is empty")) };
        // removal on the result must give back the original document
        let before = input.as_before();
        let mut ch = Changes::default();
        for (spec, _, replaced) in parts {
            match spec {
                Spec::Hooks { .. } => {
                    let c = ops::remove_hooks(&new_text, &ndoc, tag, &before);
                    ch.edits.extend(c.edits);
                    ch.root_remove.extend(c.root_remove);
                }
                Spec::Status { .. } => {
                    let c = ops::remove_statusline(&new_text, &ndoc, tag, replaced.as_deref(), None);
                    ch.edits.extend(c.edits);
                    ch.root_remove.extend(c.root_remove);
                }
            }
        }
        let mut edits = ch.edits;
        if !ch.root_remove.is_empty() {
            edits.extend(span::remove_spans(&span::member_spans(&ndoc.root), &ch.root_remove, ndoc.root.interior(), before.root_interior()));
        }
        span::sort_and_check(&mut edits).map_err(|e| fail(&e))?;
        let back = span::apply(&new_text, &edits);
        let (a, b) = (parse_value(&back), input.value());
        if a.is_none() || a != b {
            return Err(fail("removing our entries from the result does not give back the original document"));
        }
        Ok(())
    }

    fn plan_plugin_install(&self, m: &mut InstallManifest, sources: &Sources, files: &mut Vec<FilePlan>, notes: &mut Vec<String>) -> Result<(), InstallError> {
        let path = self.layout.opencode_plugin();
        if !self.layout.opencode_dir.is_dir() {
            return Err(InstallError::ToolNotFound { dir: self.layout.opencode_dir.clone() });
        }
        let needle = "const RUNTIME_FILE_OVERRIDE = null;";
        if sources.opencode_plugin.matches(needle).count() != 1 {
            return Err(InstallError::PluginSource { detail: format!("expected exactly one `{needle}` line to set the runtime file path") });
        }
        let runtime = serde_json::to_string(&path_string(&self.layout.runtime_path())).expect("string");
        let text = sources.opencode_plugin.replacen(needle, &format!("const RUNTIME_FILE_OVERRIDE = {runtime};"), 1);
        let bytes = text.into_bytes();
        let old = fsio::read_regular(&path)?;
        let entry = m.entries.iter().find(|e| e.target == InstallTarget::OpencodePlugin).cloned();
        match (&old, &entry) {
            (Some(o), _) if *o == bytes && entry.is_some() => return Ok(()),
            (Some(o), Some(e)) if fsio::sha256_hex(o) != e.after.sha256 => {
                notes.push(format!("{} was edited after install and is left as it is", path.display()));
                return Ok(());
            }
            (Some(_), None) => {
                return Err(InstallError::Foreign { path, detail: "a file that Busyholm did not write is already here; it is left alone".into() });
            }
            _ => {}
        }
        let mut new_entry = self.make_entry("opencode-plugin", Some(InstallTool::Opencode), InstallTarget::OpencodePlugin, &path, InstallAction::CreateFile, InstallState::Installed, &None, &bytes, None);
        if let Some(e) = entry {
            new_entry.before = e.before;
        }
        upsert(m, new_entry);
        let diff = diff::whole(&path_string(&path), old.as_deref().map(|b| String::from_utf8_lossy(b)).as_deref(), Some(&String::from_utf8_lossy(&bytes)));
        files.push(FilePlan {
            path,
            target: InstallTarget::OpencodePlugin,
            diff,
            allowed: Vec::new(),
            edits: Vec::new(),
            new: Some(bytes),
            note: None,
            old,
            mode: 0o644,
            backups: Vec::new(),
            manifest_after: m.clone(),
        });
        Ok(())
    }

    // ----- disconnect -------------------------------------------------------------------------

    /// Plan a disconnect of `comps` (empty means everything in the manifest). Removes only entries we own.
    pub fn plan_disconnect(&self, comps: &[Component]) -> Result<Plan, InstallError> {
        let manifest_before = self.load_manifest()?;
        let mut m = manifest_before.clone();
        let mut files: Vec<FilePlan> = Vec::new();
        let mut notes = Vec::new();
        let tag = m.owner_tag.clone().unwrap_or_default();
        let selected = |e: &ManifestEntry| {
            e.target != InstallTarget::ShimBinary && (comps.is_empty() || comps.iter().any(|c| c.target() == e.target))
        };

        // config files, grouped by path
        let mut paths: Vec<String> = Vec::new();
        for e in m.entries.iter().filter(|e| selected(e) && matches!(e.target, InstallTarget::ClaudeHooks | InstallTarget::ClaudeStatusline | InstallTarget::CodexHooks)) {
            if !paths.contains(&e.path) {
                paths.push(e.path.clone());
            }
        }
        for p in paths {
            let all_here: Vec<ManifestEntry> = m.entries.iter().filter(|e| e.path == p).cloned().collect();
            let sel_here: Vec<ManifestEntry> = all_here.iter().filter(|e| selected(e)).cloned().collect();
            let all_selected = all_here.len() == sel_here.len();
            let outcome = self.plan_config_remove(Path::new(&p), &tag, &sel_here, all_selected)?;
            match outcome {
                Outcome::Skipped(note) => notes.push(note),
                Outcome::Dropped(note) => {
                    notes.extend(note);
                    m.entries.retain(|e| !(e.path == p && selected(e)));
                }
                Outcome::Plan(mut fp, kept) => {
                    m.entries.retain(|e| !(e.path == p && selected(e)) || kept.contains(&e.id));
                    fp.manifest_after = m.clone();
                    files.push(fp);
                }
            }
        }

        // the OpenCode plugin
        for e in m.entries.clone().iter().filter(|e| selected(e) && e.target == InstallTarget::OpencodePlugin) {
            let path = PathBuf::from(&e.path);
            let old = fsio::read_regular(&path)?;
            match old {
                None => {}
                Some(bytes) if fsio::sha256_hex(&bytes) == e.after.sha256 => {
                    let diff = diff::whole(&e.path, Some(&String::from_utf8_lossy(&bytes)), None);
                    m.entries.retain(|x| x.id != e.id);
                    files.push(FilePlan { path, target: InstallTarget::OpencodePlugin, diff, allowed: vec![], edits: vec![], new: None, note: None, old: Some(bytes), mode: 0o644, backups: vec![], manifest_after: m.clone() });
                    continue;
                }
                Some(_) => notes.push(format!("{} was edited after install; it is left in place", e.path)),
            }
            m.entries.retain(|x| x.id != e.id);
        }

        // the shim goes when nothing else needs it
        if m.entries.iter().all(|e| e.target == InstallTarget::ShimBinary) {
            if let Some(e) = m.entries.first().cloned() {
                if is_symlink_entry(&self.layout.data_dir.join("bin")) {
                    return Err(InstallError::Symlink { path: self.layout.data_dir.join("bin") });
                }
                let path = PathBuf::from(&e.path);
                if let Some(bytes) = fsio::read_regular(&path)? {
                    if fsio::sha256_hex(&bytes) == e.after.sha256 {
                        m.entries.clear();
                        let diff = format!("--- {}\n+++ /dev/null\n@@ binary file removed @@\n", e.path);
                        files.push(FilePlan { path, target: InstallTarget::ShimBinary, diff, allowed: vec![], edits: vec![], new: None, note: None, old: Some(bytes), mode: 0o755, backups: vec![], manifest_after: m.clone() });
                    } else {
                        notes.push(format!("{} was replaced after install; it is left in place", e.path));
                        m.entries.clear();
                    }
                } else {
                    m.entries.clear();
                }
            }
        }
        if m.entries.is_empty() {
            m.owner_tag = None;
        }
        Ok(Plan { files, notes, install: false, manifest_before, manifest_final: m })
    }

    fn plan_config_remove(&self, path: &Path, tag: &str, entries: &[ManifestEntry], all_selected: bool) -> Result<Outcome, InstallError> {
        let Some(old) = fsio::read_regular(path)? else {
            return Ok(Outcome::Dropped(Some(format!("{} is already gone", path.display()))));
        };
        // the entry that came first describes the file as the user had it
        let mut ordered: Vec<&ManifestEntry> = entries.iter().collect();
        ordered.sort_by_key(|e| e.installed_at);
        let earliest = ordered[0];
        // A file we created is deleted only when removing our entries leaves it empty (below): a later entry's
        // recorded hash can already include keys the user added between two consents.
        let created_by_us = earliest.action == InstallAction::CreateFile;

        let text = match String::from_utf8(old.clone()) {
            Ok(t) => t,
            Err(_) => return Ok(Outcome::Skipped(format!("{} is not UTF-8 now; left alone, nothing was removed", path.display()))),
        };
        let doc = match span::parse(&text) {
            Ok(Parsed::Doc(d)) => d,
            Ok(Parsed::Empty { .. }) => return Ok(Outcome::Dropped(Some(format!("{} is empty now; nothing of ours is in it", path.display())))),
            Err(_) => return Ok(Outcome::Skipped(format!("{} is not valid JSON now; left alone, nothing was removed", path.display()))),
        };
        let wants_hooks = entries.iter().any(|e| matches!(e.target, InstallTarget::ClaudeHooks | InstallTarget::CodexHooks));
        let wants_status = entries.iter().any(|e| e.target == InstallTarget::ClaudeStatusline);
        if let Some(detail) = ops::duplicate_keys(&doc, wants_hooks, wants_status, &ALL_EVENTS) {
            return Ok(Outcome::Skipped(format!("{}: {detail}. Nothing was removed and nothing was forgotten; run disconnect again afterwards.", path.display())));
        }

        // the file before the first install, from the kept copy (for "did we create this container")
        let before_text: Option<String>;
        let before_doc: Option<Doc>;
        let mut before_blank: Option<Vec<u8>> = None;
        let before = if !earliest.before.existed {
            before_text = None;
            before_doc = None;
            Before::Missing
        } else {
            let bak = earliest.before.sha256.as_deref().and_then(|s| fsio::read_regular(&self.layout.backup_path(s)).ok().flatten());
            match bak.as_ref().and_then(|b| String::from_utf8(b.clone()).ok()) {
                Some(t) => match span::parse(&t) {
                    Ok(Parsed::Doc(d)) => {
                        before_text = Some(t);
                        before_doc = Some(d);
                        Before::Doc(before_text.as_deref().unwrap(), before_doc.as_ref().unwrap())
                    }
                    Ok(Parsed::Empty { .. }) => {
                        before_blank = bak;
                        before_text = None;
                        before_doc = None;
                        Before::Missing
                    }
                    Err(_) => {
                        before_text = None;
                        before_doc = None;
                        Before::Unknown
                    }
                },
                None => {
                    before_text = None;
                    before_doc = None;
                    Before::Unknown
                }
            }
        };
        let _ = (&before_text, &before_doc);

        let mut all = Changes::default();
        let (mut hooks_sel, mut status_sel) = (false, false);
        let mut kept: Vec<String> = Vec::new();
        let mut kept_notes: Vec<String> = Vec::new();
        for e in entries {
            match e.target {
                InstallTarget::ClaudeHooks | InstallTarget::CodexHooks => {
                    hooks_sel = true;
                    let c = ops::remove_hooks(&text, &doc, tag, &before);
                    all.removed += c.removed;
                    all.edits.extend(c.edits);
                    all.root_remove.extend(c.root_remove);
                }
                InstallTarget::ClaudeStatusline => {
                    let owned = e.owned.as_ref().and_then(|o| o.first());
                    let replaced = match owned.and_then(|o| o.replaced_sha256.clone()) {
                        Some(sha) => match fsio::read_regular(&self.layout.backup_path(&sha))?.and_then(|b| String::from_utf8(b).ok()) {
                            Some(t) => Some(t),
                            None => {
                                // never block the other disconnects on a lost copy: leave this one in place and say so
                                kept.push(e.id.clone());
                                kept_notes.push("the saved copy of your previous status line is missing, so the Busyholm status line was left in place and its entry kept".to_string());
                                continue;
                            }
                        },
                        None => None,
                    };
                    status_sel = true;
                    let c = ops::remove_statusline(&text, &doc, tag, replaced.as_deref(), owned.map(|o| o.sha256.as_str()));
                    all.removed += c.removed;
                    all.edits.extend(c.edits);
                    all.root_remove.extend(c.root_remove);
                }
                _ => {}
            }
        }
        if all.removed == 0 && !kept.is_empty() {
            return Ok(Outcome::Skipped(format!("{}: {}", path.display(), kept_notes.join("; "))));
        }
        if all.removed == 0 {
            return Ok(Outcome::Dropped(Some(format!("nothing of ours was found in {}; it was not touched", path.display()))));
        }
        let mut edits = all.edits.clone();
        if !all.root_remove.is_empty() {
            let restore = if all.root_remove.len() == doc.root.members.len() { before.root_interior() } else { None };
            edits.extend(span::remove_spans(&span::member_spans(&doc.root), &all.root_remove, doc.root.interior(), restore));
        }
        span::sort_and_check(&mut edits).map_err(|e| InstallError::Verify { path: path.to_path_buf(), detail: e })?;
        let mut new_text = span::apply(&text, &edits);

        // the root may now be empty
        let root_empty = matches!(span::parse(&new_text), Ok(Parsed::Doc(ref d)) if d.root.members.is_empty());
        let mut note = None;
        if root_empty && all_selected {
            if created_by_us {
                let diff = diff::whole(&path_string(path), Some(&text), None);
                return Ok(Outcome::Plan(FilePlan { path: path.to_path_buf(), target: earliest.target, diff, allowed: vec![], edits: vec![], new: None, note: Some("created by Busyholm and nothing else is in it now: deleted".into()), old: Some(old), mode: 0o644, backups: vec![], manifest_after: self.empty_manifest() }, Vec::new()));
            }
            if let Some(blank) = before_blank {
                // the file was empty before the install: put the same empty bytes back
                new_text = String::from_utf8_lossy(&blank).to_string();
                edits = vec![Edit { start: 0, end: text.len(), text: new_text.clone() }];
                note = Some("the file was empty before Busyholm and is empty again".into());
            }
        }

        // check: only the selected parts changed, and everything else is as the file has it now
        verify_removal(path, &text, &new_text, tag, hooks_sel, status_sel)?;

        let new_bytes = new_text.into_bytes();
        let allowed: Vec<(usize, usize)> = {
            let mut a = Vec::new();
            if let Some((_, m)) = doc.root.last("hooks") {
                a.push((m.key_start, m.value.end()));
            }
            if let Some((_, m)) = doc.root.last("statusLine") {
                a.push((m.key_start, m.value.end()));
            }
            // removing a root member also removes the separator before it
            a.push((0, text.len()));
            a
        };
        let diff = diff::unified(&path_string(path), &text, &String::from_utf8_lossy(&new_bytes), &edits);
        let mode = fsio::mode_of(path).unwrap_or(0o644);
        let note = match (note, kept_notes.is_empty()) {
            (n, true) => n,
            (Some(n), false) => Some(format!("{n}; {}", kept_notes.join("; "))),
            (None, false) => Some(kept_notes.join("; ")),
        };
        Ok(Outcome::Plan(FilePlan { path: path.to_path_buf(), target: earliest.target, diff, allowed, edits, new: Some(new_bytes), note, old: Some(old), mode, backups: vec![], manifest_after: self.empty_manifest() }, kept))
    }

    // ----- apply ------------------------------------------------------------------------------

    /// Write a plan. Every file is re-read first and must still be exactly what the plan saw.
    pub fn apply(&self, plan: &Plan) -> Result<InstallManifest, InstallError> {
        if self.load_manifest()? != plan.manifest_before {
            return Err(InstallError::ChangedSincePreview { path: self.layout.manifest_path() });
        }
        for f in &plan.files {
            let now = fsio::read_regular(&f.path)?;
            if now != f.old {
                return Err(InstallError::ChangedSincePreview { path: f.path.clone() });
            }
        }
        for f in &plan.files {
            for (sha, bytes) in &f.backups {
                let p = self.layout.backup_path(sha);
                if fsio::read_regular(&p)?.as_deref() != Some(bytes.as_slice()) {
                    if let Some(dir) = p.parent() {
                        fsio::ensure_dir(&self.layout.data_dir)?;
                        std::fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
                    }
                    fsio::write_atomic(&p, bytes, 0o600)?;
                }
            }
        }
        for f in &plan.files {
            if plan.install {
                // ownership is recorded first: a crash can leave a record without an edit (harmless),
                // never an edit without a record
                self.save_manifest(&f.manifest_after)?;
            }
            match &f.new {
                Some(bytes) => {
                    if let Some(dir) = f.path.parent() {
                        if f.target == InstallTarget::ShimBinary {
                            fsio::ensure_dir(&self.layout.data_dir)?;
                            std::fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
                        } else if f.target == InstallTarget::OpencodePlugin {
                            std::fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
                        }
                    }
                    fsio::write_atomic(&f.path, bytes, f.mode)?;
                }
                None => {
                    fsio::remove_file(&f.path)?;
                    if f.target == InstallTarget::ShimBinary {
                        if let Some(dir) = f.path.parent() {
                            let _ = std::fs::remove_dir(dir);
                        }
                    }
                }
            }
            if !plan.install {
                self.save_manifest(&f.manifest_after)?;
            }
        }
        if plan.manifest_final != plan.manifest_before || !plan.files.is_empty() {
            self.save_manifest(&plan.manifest_final)?;
        }
        self.prune_backups(&plan.manifest_final)?;
        Ok(plan.manifest_final.clone())
    }

    fn prune_backups(&self, m: &InstallManifest) -> Result<(), InstallError> {
        if !is_real_dir(&self.layout.data_dir) || !is_real_dir(&self.layout.data_dir.join("backups")) {
            return Ok(());
        }
        let bdir = self.layout.backups_dir();
        if !is_real_dir(&bdir) {
            return Ok(());
        }
        let Ok(rd) = std::fs::read_dir(&bdir) else { return Ok(()) };
        let mut keep = BTreeSet::new();
        for e in &m.entries {
            if let Some(sha) = &e.before.sha256 {
                keep.insert(format!("{sha}.bak"));
            }
            if let Some(owned) = &e.owned {
                for o in owned {
                    if let Some(sha) = &o.replaced_sha256 {
                        keep.insert(format!("{sha}.bak"));
                    }
                }
            }
        }
        for entry in rd.flatten() {
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if is_known_install_backup_file(&name) && !keep.contains(&name) {
                fsio::remove_file(&p)?;
            }
        }
        if keep.is_empty() {
            let _ = std::fs::remove_dir(&bdir);
            if let Some(parent) = bdir.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
        Ok(())
    }

    /// Check that `self.layout.data_dir`, if present, is a real directory and that none of its known
    /// subdirectories (`bin`, `backups`, `backups/install`, `logs`) or `install-manifest.json` is a symlink.
    pub fn check_data_dir(&self) -> Result<bool, InstallError> {
        match std::fs::symlink_metadata(&self.layout.data_dir) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(InstallError::Symlink { path: self.layout.data_dir.clone() });
                }
                if !meta.file_type().is_dir() {
                    return Err(InstallError::NotRegularFile { path: self.layout.data_dir.clone() });
                }
                for p in [
                    self.layout.manifest_path(),
                    self.layout.data_dir.join("bin"),
                    self.layout.data_dir.join("backups"),
                    self.layout.backups_dir(),
                    self.layout.data_dir.join("logs"),
                ] {
                    if is_symlink_entry(&p) {
                        return Err(InstallError::Symlink { path: p });
                    }
                }
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(io_err(&self.layout.data_dir, e)),
        }
    }

    /// Disconnect everything Busyholm installed first, then remove only Busyholm's own known files and folders
    /// inside `self.layout.data_dir`, remove `self.layout.data_dir` only if it is empty (`std::fs::remove_dir`),
    /// and return (and report) any foreign files left behind. Refuses when `data_dir` or any of its known
    /// subdirectories (`bin`, `backups`, `backups/install`, `logs`) is a symlink or not a directory, and never
    /// follows a symlink anywhere in this path.
    pub fn delete_everything(&self) -> Result<Vec<PathBuf>, InstallError> {
        self.check_data_dir()?;
        let plan = self.plan_disconnect(&[])?;
        if !plan.manifest_final.entries.is_empty() {
            return Err(InstallError::Manifest {
                detail: if plan.notes.is_empty() {
                    "some connected entries could not be removed; the data folder was kept".into()
                } else {
                    plan.notes.join("; ")
                },
            });
        }
        self.apply(&plan)?;
        if !self.check_data_dir()? {
            return Ok(Vec::new());
        }

        let mut foreign = Vec::new();
        let data_dir = &self.layout.data_dir;

        // 1. Clean `bin/` (`installer/src/lib.rs:130`, `installer/src/fsio.rs:49`).
        clean_known_subdir(&data_dir.join("bin"), is_known_bin_file, &[], &mut foreign)?;

        // 2. Clean `backups/` and `backups/install/` (`installer/src/lib.rs:139,142`, `collector/src/service.rs:39-63`).
        let backups_dir = data_dir.join("backups");
        match std::fs::symlink_metadata(&backups_dir) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(InstallError::Symlink { path: backups_dir });
            }
            Ok(meta) if meta.file_type().is_dir() => {
                clean_known_subdir(&backups_dir.join("install"), is_known_install_backup_file, &[], &mut foreign)?;
                clean_known_subdir(&backups_dir, is_known_rolling_backup_file, &["install"], &mut foreign)?;
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err(&backups_dir, e)),
        }

        // 3. Clean `logs/` (`app.log`).
        clean_known_subdir(&data_dir.join("logs"), is_known_log_file, &[], &mut foreign)?;

        // 4. Clean `data_dir` top-level files and symlinks (`SPEC.md` 6.8, `collector/src/service.rs`, `collector/src/receiver.rs`,
        // `collector/src/private_io.rs`, `installer/src/lib.rs`, `app/src-tauri/src/settings.rs`, `app/src-tauri/src/onboarding.rs`,
        // `app/src-tauri/src/world_inputs.rs`).
        let rd = std::fs::read_dir(data_dir).map_err(|e| io_err(data_dir, e))?;
        for entry in rd {
            let entry = entry.map_err(|e| io_err(data_dir, e))?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = std::fs::symlink_metadata(&path).map_err(|e| io_err(&path, e))?;
            let ft = meta.file_type();
            if (ft.is_file() || ft.is_symlink()) && is_known_top_file(&name) {
                fsio::remove_file(&path)?;
            } else if ft.is_dir() && matches!(name.as_str(), "bin" | "backups" | "logs") {
                let _ = std::fs::remove_dir(&path);
            } else {
                foreign.push(path);
            }
        }

        foreign.sort();
        match std::fs::remove_dir(data_dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) if !foreign.is_empty() => {}
            Err(_) => foreign.push(data_dir.to_path_buf()),
        }
        if !foreign.is_empty() {
            let list: Vec<String> = foreign.iter().map(|p| p.display().to_string()).collect();
            eprintln!("installer: left {} foreign file(s) in {}: {}", foreign.len(), data_dir.display(), list.join(", "));
        }
        Ok(foreign)
    }

    /// Refresh the installed `busyholm-hook` binary in the app's data folder when at least one
    /// component is connected and the bundled binary differs from the installed copy (P2-8).
    pub fn refresh_shim(&self, sources: &Sources) -> Result<bool, InstallError> {
        let mut m = self.load_manifest()?;
        if !m.entries.iter().any(|e| e.target != InstallTarget::ShimBinary) {
            return Ok(false);
        }
        let bytes = fsio::read_regular(&sources.shim_binary)?.ok_or_else(|| InstallError::Foreign {
            path: sources.shim_binary.clone(),
            detail: "the busyholm-hook binary to install does not exist".into(),
        })?;
        let target = self.layout.shim_path();
        let old = fsio::read_regular(&target)?;
        let known = m.entries.iter().any(|e| e.target == InstallTarget::ShimBinary);
        if old.as_deref() == Some(bytes.as_slice()) && known {
            return Ok(false);
        }
        let first = m.entries.iter().find(|e| e.target == InstallTarget::ShimBinary).cloned();
        let mut entry = self.make_entry(
            "shim-binary",
            None,
            InstallTarget::ShimBinary,
            &target,
            InstallAction::CreateFile,
            InstallState::Installed,
            &None,
            &bytes,
            None,
        );
        if let Some(f) = first {
            entry.before = f.before;
        }
        upsert(&mut m, entry);
        if let Some(dir) = target.parent() {
            fsio::ensure_dir(&self.layout.data_dir)?;
            std::fs::create_dir_all(dir).map_err(|e| io_err(dir, e))?;
        }
        self.save_manifest(&m)?;
        fsio::write_atomic(&target, &bytes, 0o755)?;
        Ok(true)
    }
}

enum Outcome {
    /// Nothing is written; the entries stay in the manifest (the file could not be handled safely).
    Skipped(String),
    /// Nothing to write; the entries are dropped from the manifest.
    Dropped(Option<String>),
    /// A file plan, plus the ids of selected entries that stay in the manifest.
    Plan(FilePlan, Vec<String>),
}

fn upsert(m: &mut InstallManifest, entry: ManifestEntry) {
    match m.entries.iter().position(|e| e.id == entry.id) {
        Some(i) => m.entries[i] = entry,
        None => m.entries.push(entry),
    }
}

fn parse_value(text: &str) -> Option<Value> {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    if body.trim().is_empty() {
        return Some(serde_json::json!({}));
    }
    serde_json::from_str(body).ok()
}

/// The file as the installer sees it: real text, a document to edit, and how to turn edits into bytes.
struct Input {
    path: PathBuf,
    /// The text edits are expressed against (the real text, or `{}` for a missing or blank file).
    text: String,
    doc: Doc,
    blank: bool,
    existed: bool,
    bom: usize,
    old_len: usize,
    nl: &'static str,
    real: Option<String>,
}

impl Input {
    fn read(path: &Path, old: Option<&[u8]>) -> Result<Input, InstallError> {
        let Some(bytes) = old else {
            let Parsed::Doc(doc) = span::parse("{}").expect("literal") else { unreachable!() };
            return Ok(Input { path: path.to_path_buf(), text: "{}".into(), doc, blank: true, existed: false, bom: 0, old_len: 0, nl: "\n", real: None });
        };
        let text = std::str::from_utf8(bytes).map_err(|_| InstallError::NotUtf8 { path: path.to_path_buf() })?.to_string();
        match span::parse(&text) {
            Ok(Parsed::Doc(doc)) => {
                let bom = doc.bom;
                Ok(Input { path: path.to_path_buf(), real: Some(text.clone()), text, doc, blank: false, existed: true, bom, old_len: bytes.len(), nl: "\n" })
            }
            Ok(Parsed::Empty { bom }) => {
                let Parsed::Doc(doc) = span::parse("{}").expect("literal") else { unreachable!() };
                let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
                Ok(Input { path: path.to_path_buf(), text: "{}".into(), doc, blank: true, existed: true, bom, old_len: bytes.len(), nl, real: Some(text) })
            }
            Err(span::SpanError::Invalid(detail)) => Err(InstallError::InvalidJson { path: path.to_path_buf(), detail }),
            Err(span::SpanError::NotObject) => Err(InstallError::WrongShape { path: path.to_path_buf(), detail: "the top level is not a JSON object".into() }),
        }
    }

    fn style(&self) -> Style {
        if self.blank {
            Style { nl: self.nl, unit: "  ".into(), compact: false }
        } else {
            span::detect_style(&self.text, Some(&self.doc.root))
        }
    }

    /// The original document as a value (a missing or blank file is `{}`).
    fn value(&self) -> Option<Value> {
        match &self.real {
            Some(t) => parse_value(t),
            None => Some(serde_json::json!({})),
        }
    }

    fn as_before(&self) -> Before<'_> {
        match &self.real {
            Some(t) if !self.blank => Before::Doc(t.as_str(), &self.doc),
            _ => Before::Missing,
        }
    }

    /// The scrubbed container state needed by `Before` on disconnect: only whether root, `hooks` and our event
    /// keys existed before the install and any empty-container whitespace inside `{}` or `[]`. Never holds user
    /// settings keys, values, secrets, paths or hook commands.
    fn before_backup(&self) -> Vec<u8> {
        if self.blank {
            return self.real.as_deref().unwrap_or("").as_bytes().to_vec();
        }
        if self.doc.root.members.is_empty() {
            return self.text.as_bytes().to_vec();
        }
        let Some((_, hooks_mem)) = self.doc.root.last("hooks") else {
            return b"{\"_\":0}".to_vec();
        };
        match &hooks_mem.value {
            span::Node::Obj(h) if h.members.is_empty() => {
                let (a, b) = h.interior();
                format!("{{\"hooks\":{{{}}}}}", &self.text[a..b]).into_bytes()
            }
            span::Node::Obj(h) => {
                let mut parts = Vec::new();
                for m in &h.members {
                    if ALL_EVENTS.contains(&m.key.as_str()) {
                        let val = match &m.value {
                            span::Node::Arr(arr) if arr.items.is_empty() => {
                                let (a, b) = arr.interior();
                                format!("[{}]", &self.text[a..b])
                            }
                            span::Node::Obj(obj) if obj.members.is_empty() => {
                                let (a, b) = obj.interior();
                                format!("{{{}}}", &self.text[a..b])
                            }
                            _ => "[0]".to_string(),
                        };
                        parts.push(format!("{}:{val}", j::quote(&m.key)));
                    }
                }
                if parts.is_empty() {
                    parts.push("\"_\":0".to_string());
                }
                format!("{{\"hooks\":{{{}}}}}", parts.join(",")).into_bytes()
            }
            _ => b"{\"hooks\":0}".to_vec(),
        }
    }

    /// Turn the combined changes into edits against the real bytes and the resulting text.
    fn finish_install(&self, all: &Changes, st: &Style, _path: &Path) -> Result<(Vec<Edit>, String), InstallError> {
        let mut edits = all.edits.clone();
        if !all.root_new.is_empty() {
            edits.push(span::insert_members(&self.text, &self.doc.root, st, &all.root_new));
        }
        span::sort_and_check(&mut edits).map_err(|e| InstallError::Verify { path: self.path.clone(), detail: e })?;
        let result = span::apply(&self.text, &edits);
        if self.blank {
            let bom_text = if self.bom == 3 { "\u{feff}" } else { "" };
            let full = format!("{bom_text}{result}{}", self.nl);
            let real_edit = Edit { start: if self.existed { self.bom } else { 0 }, end: self.old_len, text: format!("{result}{}", self.nl) };
            return Ok((vec![real_edit], full));
        }
        Ok((edits, result))
    }

    fn allowed_install(&self, all: &Changes) -> Vec<(usize, usize)> {
        if self.blank {
            return vec![(0, self.old_len)];
        }
        let mut a = Vec::new();
        if let Some((_, m)) = self.doc.root.last("hooks") {
            a.push((m.key_start, m.value.end()));
        }
        if let Some((_, m)) = self.doc.root.last("statusLine") {
            a.push((m.key_start, m.value.end()));
        }
        if !all.root_new.is_empty() {
            match self.doc.root.members.last() {
                Some(l) => a.push((l.value.end(), l.value.end())),
                None => a.push(self.doc.root.interior()),
            }
        }
        a
    }

    fn diff(&self, path: &Path, edits: &[Edit], new_bytes: &[u8]) -> String {
        let new_text = String::from_utf8_lossy(new_bytes);
        if !self.existed {
            return diff::whole(&path_string(path), None, Some(&new_text));
        }
        if self.blank {
            return diff::whole(&path_string(path), self.real.as_deref(), Some(&new_text));
        }
        diff::unified(&path_string(path), &self.text, &new_text, edits)
    }

    fn write_mode(&self, path: &Path) -> u32 {
        fsio::mode_of(path).unwrap_or(0o644)
    }
}

/// After a removal: other top-level keys unchanged, none of our entries left, and every event array equals
/// the old one minus our handlers.
fn verify_removal(path: &Path, old_text: &str, new_text: &str, tag: &str, hooks_sel: bool, status_sel: bool) -> Result<(), InstallError> {
    let fail = |d: &str| InstallError::Verify { path: path.to_path_buf(), detail: d.to_string() };
    let (Some(old), Some(new)) = (parse_value(old_text), parse_value(new_text)) else { return Err(fail("a document could not be read back")) };
    if !matches!(span::parse(new_text), Ok(Parsed::Doc(_)) | Ok(Parsed::Empty { .. })) {
        return Err(fail("the result is not valid JSON"));
    }
    let (Some(o), Some(n)) = (old.as_object(), new.as_object()) else { return Err(fail("not an object")) };
    for (k, v) in o {
        let ours_key = (k == "hooks" && hooks_sel) || (k == "statusLine" && status_sel);
        if !ours_key && n.get(k) != Some(v) {
            return Err(fail(&format!("key {k} changed")));
        }
    }
    if n.keys().any(|k| !o.contains_key(k)) {
        return Err(fail("a new key appeared"));
    }
    if status_sel {
        if let Some(sl) = n.get("statusLine") {
            if ops::value_is_ours(sl, tag) {
                return Err(fail("our status line is still there"));
            }
        }
    }
    if hooks_sel {
        let empty = serde_json::Map::new();
        let old_h = o.get("hooks").and_then(Value::as_object).unwrap_or(&empty);
        let new_h = n.get("hooks").and_then(Value::as_object).unwrap_or(&empty);
        if new_h.keys().any(|k| !old_h.contains_key(k)) {
            return Err(fail("a hooks event appeared"));
        }
        for (ev, groups) in old_h {
            let Some(groups) = groups.as_array() else {
                if new_h.get(ev) != Some(groups) {
                    return Err(fail("a non-array event changed"));
                }
                continue;
            };
            let mut expected: Vec<Value> = Vec::new();
            for g in groups {
                match g.get("hooks").and_then(Value::as_array) {
                    Some(hs) => {
                        let kept: Vec<Value> = hs.iter().filter(|h| !ops::value_is_ours(h, tag)).cloned().collect();
                        if kept.len() == hs.len() {
                            expected.push(g.clone());
                        } else if !kept.is_empty() {
                            let mut g2 = g.clone();
                            g2["hooks"] = Value::Array(kept);
                            expected.push(g2);
                        }
                    }
                    None => expected.push(g.clone()),
                }
            }
            let got: Vec<Value> = new_h.get(ev).and_then(Value::as_array).cloned().unwrap_or_default();
            if got != expected {
                return Err(fail(&format!("event {ev} is not the old list minus our handlers")));
            }
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn _tool_type_check(_: Tool, _: BTreeSet<u8>) {}

fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_dir())
}

fn is_symlink_entry(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Known top-level files written inside `data_dir`:
/// - `collector/src/service.rs`: `ledger.json`, `ledger.json.corrupt`, `pending-alerts.json`,
///   `pending-alerts.json.corrupt`, `coverage.json`, `coverage.json.corrupt`, `runtime.json`
/// - `collector/src/receiver.rs`: `receiver-keys.json`
/// - `collector/src/private_io.rs`: `salt`, `.busyholm-<pid>-<hex>.tmp`
/// - `installer/src/lib.rs` & `fsio.rs`: `install-manifest.json`, `.<name>.busyholm-<hex>.tmp`
/// - `app/src-tauri/src/settings.rs`: `settings.json`, `settings.json.corrupt-<ts>`, `.settings.json.tmp-<pid>`
/// - `app/src-tauri/src/onboarding.rs`: `onboarding.json`, `.onboarding.json.tmp-<pid>`
/// - `app/src-tauri/src/world_inputs.rs` & `SPEC.md` 6.8: `choices.json`, `choices.json.corrupt`,
///   `demo-ledger.json`, `demo-ledger.json.corrupt`
const KNOWN_TOP_FILES: &[&str] = &[
    "ledger.json",
    "ledger.json.corrupt",
    "pending-alerts.json",
    "pending-alerts.json.corrupt",
    "coverage.json",
    "coverage.json.corrupt",
    "runtime.json",
    "receiver-keys.json",
    "salt",
    "install-manifest.json",
    "settings.json",
    "onboarding.json",
    "choices.json",
    "choices.json.corrupt",
    "demo-ledger.json",
    "demo-ledger.json.corrupt",
];

fn is_known_top_file(name: &str) -> bool {
    if KNOWN_TOP_FILES.contains(&name) {
        return true;
    }
    if let Some(rest) = name.strip_prefix("settings.json.corrupt-") {
        return !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(rest) = name.strip_prefix(".settings.json.tmp-").or_else(|| name.strip_prefix(".onboarding.json.tmp-")) {
        return !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit());
    }
    is_collector_temp(name) || is_installer_temp(name)
}

fn is_collector_temp(name: &str) -> bool {
    name.starts_with(".busyholm-") && name.ends_with(".tmp")
}

fn is_installer_temp(name: &str) -> bool {
    name.starts_with('.') && name.contains(".busyholm-") && name.ends_with(".tmp")
}

fn is_known_bin_file(name: &str) -> bool {
    matches!(name, "busyholm-hook" | "busyholm-hook.exe") || is_installer_temp(name)
}

fn is_known_install_backup_file(name: &str) -> bool {
    name.strip_suffix(".bak")
        .is_some_and(|sha| sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_dated_json(name: &str, prefix: &str) -> bool {
    let Some(rest) = name.strip_prefix(prefix).and_then(|s| s.strip_suffix(".json")) else {
        return false;
    };
    let b = rest.as_bytes();
    b.len() == 10 && [0, 1, 2, 3, 5, 6, 8, 9].iter().all(|&i| b[i].is_ascii_digit()) && b[4] == b'-' && b[7] == b'-'
}

fn is_known_rolling_backup_file(name: &str) -> bool {
    is_dated_json(name, "ledger-")
        || is_dated_json(name, "choices-")
        || is_dated_json(name, "settings-")
        || is_collector_temp(name)
        || is_installer_temp(name)
}

fn is_known_log_file(name: &str) -> bool {
    name == "app.log"
}

fn clean_known_subdir(
    dir: &Path,
    is_known_file: fn(&str) -> bool,
    known_subdirs: &[&str],
    foreign: &mut Vec<PathBuf>,
) -> Result<(), InstallError> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err(InstallError::Symlink { path: dir.to_path_buf() });
            }
            if !meta.file_type().is_dir() {
                return Ok(());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err(dir, e)),
    }
    let rd = std::fs::read_dir(dir).map_err(|e| io_err(dir, e))?;
    for entry in rd {
        let entry = entry.map_err(|e| io_err(dir, e))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| io_err(&path, e))?;
        let ft = meta.file_type();
        if (ft.is_file() || ft.is_symlink()) && is_known_file(&name) {
            fsio::remove_file(&path)?;
        } else if ft.is_dir() && known_subdirs.contains(&name.as_str()) {
            let _ = std::fs::remove_dir(&path);
        } else {
            foreign.push(path);
        }
    }
    let _ = std::fs::remove_dir(dir);
    Ok(())
}
