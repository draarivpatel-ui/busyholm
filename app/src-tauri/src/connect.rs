//! WP-11: the bridge from the app shell to the WP-07 hook installer (preview, connect, disconnect).
//!
//! The shell never edits an agent's config file itself. It asks a [`Connector`] for a preview (the exact
//! diff, nothing written), shows it, and on consent calls [`Connector::apply`] with the preview's token. That
//! writes EXACTLY the previewed plan: [`busyholm_installer::Installer::apply`] re-reads every file and the
//! install manifest first and refuses if anything changed since, so a file edited between preview and
//! consent is never overwritten.
//!
//! What the installer reads from [`Sources`]: planning an install always reads the shim binary (`shim_binary`,
//! copied into the app's data folder and referenced by absolute path from every hook), so a plan cannot be
//! made without it; the OpenCode plugin text is only used when that plugin is selected. Planning a
//! disconnect reads no source at all, so a build without the helper can still remove an earlier install.
//!
//! Paths shown to the user: only the leading home folder becomes `~`; nothing else about the user's files is
//! printed. The diff text itself is shown exactly as it will be written.

use crate::hooks_link::{reports_from_status, HooksLink};
use busyholm_contracts::install_manifest::{InstallState, InstallTarget};
use busyholm_installer::{Component, FilePlan, InstallError, Installer, Layout, Plan, Sources};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const HELPER_MISSING: &str = "The hook helper is missing from this build, so nothing was connected.";
const STALE: &str = "This preview is out of date, so nothing was changed. Please preview again.";
const NOTHING_CHOSEN: &str = "Choose at least one thing to connect.";

/// The OpenCode plugin source, embedded so a packaged app does not depend on the repository layout.
/// WP-06's file; WP-07's installer rewrites only its `RUNTIME_FILE_OVERRIDE` line.
const EMBEDDED_OPENCODE_PLUGIN: &str = include_str!("../../../collector-wp06/plugin/busyholm.js");

/// One thing the user can connect or disconnect on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    ClaudeHooks,
    ClaudeStatusline,
    CodexHooks,
    OpencodePlugin,
}

/// Whether the v0.1 slice offers the OpenCode plugin (review r1 M6). It does not: the live collector router
/// registers only the Claude and Codex adapters, so every OpenCode POST would be rejected and no session
/// would ever appear. The plugin and installer code stay; flip this when an OpenCode adapter is registered.
pub const OPENCODE_IN_V01: bool = false;
const OPENCODE_UNAVAILABLE: &str = "OpenCode is not supported in this version yet.";

const ALL_PARTS: [Part; 4] = [Part::ClaudeHooks, Part::ClaudeStatusline, Part::CodexHooks, Part::OpencodePlugin];

impl Part {
    fn component(self) -> Component {
        match self {
            Part::ClaudeHooks => Component::ClaudeHooks,
            Part::ClaudeStatusline => Component::ClaudeStatusline,
            Part::CodexHooks => Component::CodexHooks,
            Part::OpencodePlugin => Component::OpencodePlugin,
        }
    }
    fn target(self) -> InstallTarget {
        match self {
            Part::ClaudeHooks => InstallTarget::ClaudeHooks,
            Part::ClaudeStatusline => InstallTarget::ClaudeStatusline,
            Part::CodexHooks => InstallTarget::CodexHooks,
            Part::OpencodePlugin => InstallTarget::OpencodePlugin,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreviewFile {
    /// For display: the home folder is shown as `~`.
    pub path: String,
    /// The exact unified diff of what will be written.
    pub diff: String,
    pub note: Option<String>,
    pub creates: bool,
    pub deletes: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Preview {
    /// Pass this to [`Connector::apply`]. Valid once, and only until the next preview.
    pub token: u64,
    pub files: Vec<PreviewFile>,
    pub notes: Vec<String>,
    /// Nothing to write and nothing to record.
    pub noop: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PartStatus {
    pub part: Part,
    pub connected: bool,
    /// Codex hooks that are installed but not yet trusted inside Codex.
    pub pending_review: bool,
    /// The tool's config folder exists.
    pub available: bool,
    /// Display path of the file this part edits.
    pub path: String,
    /// Set when this build does not offer the part at all (it can still be disconnected if installed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Status {
    /// All four parts, always in the order of [`Part`].
    pub parts: Vec<PartStatus>,
    pub any_connected: bool,
    /// The hook helper that connecting would copy is present.
    pub shim_available: bool,
}

/// Holds a [`Layout`] rather than an [`Installer`]: the installer's clock is not `Send`, and the shell
/// keeps a `Connector` in shared state, so an installer is made for each call.
pub struct Connector {
    layout: Layout,
    sources: Option<Sources>,
    home: PathBuf,
    /// The one previewed plan that [`apply`](Connector::apply) may write: token, plan, and whether it installs.
    pending: Option<(u64, Plan, bool)>,
    last_token: u64,
    /// INT-2: where to tell the collector which tools have our hook entries installed.
    hooks: Option<HooksLink>,
    /// False in the shipping app while [`OPENCODE_IN_V01`] is false: the OpenCode part is shown as unavailable.
    opencode_offered: bool,
}

impl Connector {
    pub fn new(layout: Layout, sources: Option<Sources>, home: PathBuf) -> Self {
        Connector { layout, sources, home, pending: None, last_token: 0, hooks: None, opencode_offered: true }
    }

    /// The connector of the shipping app: like [`Connector::new`], with the OpenCode plugin offered only
    /// when [`OPENCODE_IN_V01`] says so.
    pub fn shipping(layout: Layout, sources: Option<Sources>, home: PathBuf) -> Self {
        let mut c = Connector::new(layout, sources, home);
        c.opencode_offered = OPENCODE_IN_V01;
        c
    }

    /// Report the manifest's hook state to the collector through `link`: see [`Connector::report_hooks`].
    pub fn with_hooks(mut self, link: HooksLink) -> Self {
        self.hooks = Some(link);
        self
    }

    /// Tell the collector what the manifest says about each tool's hooks (INT-2). Called at start and after
    /// every applied plan (connect, disconnect, disconnect all). Sends nothing when the manifest cannot be read.
    pub fn report_hooks(&self) {
        let Some(link) = &self.hooks else { return };
        if let Ok(status) = self.status() {
            link.report(reports_from_status(&status));
        }
    }

    fn layout(&self) -> &Layout {
        &self.layout
    }

    fn installer(&self) -> Installer {
        Installer::new(self.layout.clone())
    }

    fn err(&self, e: InstallError) -> String {
        tilde_text(&self.home, &e.to_string())
    }

    fn display(&self, p: &Path) -> String {
        tilde_path(&self.home, p)
    }

    fn part_path(&self, part: Part) -> PathBuf {
        match part {
            Part::ClaudeHooks | Part::ClaudeStatusline => self.layout().claude_settings(),
            Part::CodexHooks => self.layout().codex_hooks(),
            Part::OpencodePlugin => self.layout().opencode_plugin(),
        }
    }

    fn part_dir(&self, part: Part) -> &Path {
        match part {
            Part::ClaudeHooks | Part::ClaudeStatusline => &self.layout().claude_dir,
            Part::CodexHooks => &self.layout().codex_dir,
            Part::OpencodePlugin => &self.layout().opencode_dir,
        }
    }

    /// What is connected right now, read from the install manifest (never from the agents' files).
    pub fn status(&self) -> Result<Status, String> {
        let manifest = self.installer().load_manifest().map_err(|e| self.err(e))?;
        let parts: Vec<PartStatus> = ALL_PARTS
            .iter()
            .map(|&part| {
                let entry = manifest.entries.iter().find(|e| e.target == part.target());
                PartStatus {
                    part,
                    connected: entry.is_some(),
                    pending_review: entry.is_some_and(|e| e.state == InstallState::PendingReview),
                    available: self.part_dir(part).is_dir() && self.offered(part),
                    path: self.display(&self.part_path(part)),
                    unavailable_reason: (!self.offered(part)).then(|| OPENCODE_UNAVAILABLE.to_string()),
                }
            })
            .collect();
        let any_connected = parts.iter().any(|p| p.connected);
        let shim_available = self.sources.as_ref().is_some_and(|s| s.shim_binary.is_file());
        Ok(Status { parts, any_connected, shim_available })
    }

    /// Plan connecting `parts`. Writes nothing. Keeps the plan under a fresh token, replacing any older one.
    pub fn preview_connect(&mut self, parts: &[Part]) -> Result<Preview, String> {
        if parts.is_empty() {
            return Err(NOTHING_CHOSEN.into());
        }
        // Planning an install reads the shim binary, so without it there is nothing to plan.
        let sources = match &self.sources {
            Some(s) if s.shim_binary.is_file() => s,
            _ => return Err(HELPER_MISSING.into()),
        };
        if parts.iter().any(|p| !self.offered(*p)) {
            return Err(OPENCODE_UNAVAILABLE.into());
        }
        let comps: Vec<Component> = parts.iter().map(|p| p.component()).collect();
        let plan = self.installer().plan_install(&comps, sources).map_err(|e| self.err(e))?;
        Ok(self.keep(plan, true))
    }

    /// Plan disconnecting `parts`; an empty slice means everything Busyholm installed. Writes nothing.
    pub fn preview_disconnect(&mut self, parts: &[Part]) -> Result<Preview, String> {
        let comps: Vec<Component> = parts.iter().map(|p| p.component()).collect();
        let plan = self.installer().plan_disconnect(&comps).map_err(|e| self.err(e))?;
        Ok(self.keep(plan, false))
    }

    /// False for a part this build does not offer to install.
    fn offered(&self, part: Part) -> bool {
        part != Part::OpencodePlugin || self.opencode_offered
    }

    fn keep(&mut self, plan: Plan, install: bool) -> Preview {
        self.last_token += 1;
        let token = self.last_token;
        let preview = Preview {
            token,
            files: plan.files.iter().map(|f| self.preview_file(f)).collect(),
            notes: plan.notes.iter().map(|n| tilde_text(&self.home, n)).collect(),
            noop: plan.is_noop(),
        };
        self.pending = Some((token, plan, install));
        preview
    }

    fn preview_file(&self, f: &FilePlan) -> PreviewFile {
        PreviewFile {
            path: self.display(&f.path),
            diff: f.diff.clone(),
            note: f.note.as_ref().map(|n| tilde_text(&self.home, n)),
            creates: f.new.is_some() && std::fs::symlink_metadata(&f.path).is_err(),
            deletes: f.new.is_none(),
        }
    }

    /// Write exactly the previewed plan. An unknown or stale token, or a file that changed since the preview,
    /// is an error and nothing is written. The token is used up either way.
    pub fn apply(&mut self, token: u64) -> Result<Status, String> {
        let (plan, install) = match self.pending.take() {
            Some((t, plan, install)) if t == token => (plan, install),
            other => {
                // a token that is not the current one must not use up the current preview
                self.pending = other;
                return Err(STALE.into());
            }
        };
        if install && !self.sources.as_ref().is_some_and(|s| s.shim_binary.is_file()) {
            return Err(HELPER_MISSING.into());
        }
        self.installer().apply(&plan).map_err(|e| self.err(e))?;
        // INT-2: connect, disconnect and disconnect all all end here, so the collector always hears.
        self.report_hooks();
        self.status()
    }

    /// Preview disconnecting everything Busyholm installed and apply it in one step.
    pub fn disconnect_all(&mut self) -> Result<Status, String> {
        let pv = self.preview_disconnect(&[])?;
        self.apply(pv.token)
    }

    /// Check that the app data folder, if present, is a real directory and not a symlink or regular file.
    pub fn check_data_dir(&self) -> Result<(), String> {
        self.installer().check_data_dir().map(|_| ()).map_err(|e| self.err(e))
    }

    /// Step 1 of "Delete everything": disconnect all Busyholm hooks and status line entries first,
    /// refusing if any connected entry remains, and detach the collector hooks link without reporting
    /// (so a running collector does not rewrite `coverage.json`).
    pub fn disconnect_for_delete(&mut self) -> Result<(), String> {
        self.pending = None;
        self.check_data_dir()?;
        let plan = self.installer().plan_disconnect(&[]).map_err(|e| self.err(e))?;
        if !plan.manifest_final.entries.is_empty() {
            let detail = if plan.notes.is_empty() {
                "some connected entries could not be removed; the data folder was kept".to_string()
            } else {
                plan.notes.join("; ")
            };
            return Err(self.err(InstallError::Manifest { detail }));
        }
        self.installer().apply(&plan).map_err(|e| self.err(e))?;
        if let Some(h) = &self.hooks {
            h.detach();
        }
        Ok(())
    }

    /// Step 4 of "Delete everything": remove Busyholm's own files in the app data folder after hooks
    /// are disconnected and the collector has stopped without flushing.
    pub fn delete_data_files(&mut self) -> Result<Status, String> {
        self.installer().delete_everything().map_err(|e| self.err(e))?;
        self.status()
    }

    /// Disconnect every Busyholm hook and status line first, then remove Busyholm's files in the app's
    /// data folder (ledger, backups/, coverage.json, logs, settings).
    pub fn delete_everything(&mut self) -> Result<Status, String> {
        self.disconnect_for_delete()?;
        self.delete_data_files()
    }

    /// If any hook or status line is connected and the bundled `busyholm-hook` binary differs from
    /// the copy in the app's data folder, replace the installed copy and update the manifest.
    pub fn refresh_shim(&mut self) -> Result<bool, String> {
        let Some(sources) = &self.sources else { return Ok(false) };
        if !sources.shim_binary.is_file() {
            return Ok(false);
        }
        self.installer().refresh_shim(sources).map_err(|e| self.err(e))
    }
}

/// Real-world construction for the shell (not used by tests, which build a [`Layout`] from temp folders).
pub fn from_env(data_dir: PathBuf, hooks: HooksLink) -> Connector {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
    let layout = Layout::from_env_with(&home, data_dir, &|k| std::env::var(k).ok());
    Connector::shipping(layout, default_sources(), home).with_hooks(hooks)
}

/// Where the built hook shim and the OpenCode plugin source come from. `BUSYHOLM_SHIM` and
/// `BUSYHOLM_OPENCODE_PLUGIN` win; otherwise `busyholm-hook` next to the running executable, and in debug
/// builds the repository's `target/debug` and `target/release`. `None` when no shim binary exists.
pub fn default_sources() -> Option<Sources> {
    let candidates = shim_candidates(std::env::var("BUSYHOLM_SHIM").ok(), std::env::current_exe().ok(), cfg!(debug_assertions));
    let shim_binary = candidates.into_iter().find(|p| p.is_file())?;
    let opencode_plugin = std::env::var("BUSYHOLM_OPENCODE_PLUGIN")
        .ok()
        .filter(|p| !p.is_empty())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| EMBEDDED_OPENCODE_PLUGIN.to_string());
    Some(Sources { shim_binary, opencode_plugin })
}

/// Places to look for the shim, best first. An explicit override is the only candidate: it is never
/// silently replaced by a different binary.
fn shim_candidates(env_override: Option<String>, exe: Option<PathBuf>, debug_build: bool) -> Vec<PathBuf> {
    if let Some(p) = env_override.filter(|p| !p.is_empty()) {
        return vec![PathBuf::from(p)];
    }
    let name = format!("busyholm-hook{}", std::env::consts::EXE_SUFFIX);
    let mut out = Vec::new();
    if let Some(dir) = exe.as_deref().and_then(Path::parent) {
        out.push(dir.join(&name));
    }
    if debug_build {
        #[cfg(any(debug_assertions, test))]
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        #[cfg(not(any(debug_assertions, test)))]
        let repo = Path::new("busyholm");
        out.push(repo.join("target").join("debug").join(&name));
        out.push(repo.join("target").join("release").join(&name));
    }
    out
}

/// `~` for the leading home folder, the path otherwise unchanged.
fn tilde_path(home: &Path, p: &Path) -> String {
    if home.as_os_str().is_empty() {
        return p.to_string_lossy().to_string();
    }
    match p.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")),
        Err(_) => p.to_string_lossy().to_string(),
    }
}

/// Replace the home folder with `~` wherever it starts a path inside a sentence.
fn tilde_text(home: &Path, text: &str) -> String {
    let h = home.to_string_lossy();
    let h = h.trim_end_matches(['/', '\\']);
    if h.is_empty() {
        return text.to_string();
    }
    let path_char = |c: char| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\');
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (i, _) in text.match_indices(h) {
        if i < last {
            continue;
        }
        let before_ok = text[..i].chars().next_back().is_none_or(|c| !path_char(c));
        let after = &text[i + h.len()..];
        let after_ok = after.chars().next().is_none_or(|c| matches!(c, '/' | '\\') || !path_char(c));
        if before_ok && after_ok {
            out.push_str(&text[last..i]);
            out.push('~');
            last = i + h.len();
        }
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_becomes_tilde_only_at_the_start_of_a_path() {
        let home = Path::new("/Users/sam");
        assert_eq!(tilde_path(home, Path::new("/Users/sam/.claude/settings.json")), "~/.claude/settings.json");
        assert_eq!(tilde_path(home, Path::new("/Users/sam")), "~");
        assert_eq!(tilde_path(home, Path::new("/Users/samantha/x")), "/Users/samantha/x", "a longer name is not the home folder");
        assert_eq!(tilde_path(home, Path::new("/tmp/Users/sam/x")), "/tmp/Users/sam/x");
        assert_eq!(tilde_path(Path::new(""), Path::new("/a/b")), "/a/b");
    }

    #[test]
    fn sentences_get_the_same_treatment() {
        let home = Path::new("/Users/sam");
        assert_eq!(
            tilde_text(home, "/Users/sam/.codex does not exist; is the tool installed? (/Users/sam/x, /Users/samantha/y, /opt/Users/sam/z)"),
            "~/.codex does not exist; is the tool installed? (~/x, /Users/samantha/y, /opt/Users/sam/z)"
        );
        assert_eq!(tilde_text(home, "folder /Users/sam"), "folder ~");
        assert_eq!(tilde_text(Path::new("/"), "/etc/x"), "/etc/x", "a root home is left alone");
        assert_eq!(tilde_text(Path::new(""), "/etc/x"), "/etc/x");
    }

    #[test]
    fn shim_lookup_order() {
        let exe = Some(PathBuf::from("/Applications/Busyholm.app/Contents/MacOS/busyholm"));
        let c = shim_candidates(None, exe.clone(), false);
        assert_eq!(c, vec![PathBuf::from(format!("/Applications/Busyholm.app/Contents/MacOS/busyholm-hook{}", std::env::consts::EXE_SUFFIX))]);
        let d = shim_candidates(None, exe.clone(), true);
        assert_eq!(d.len(), 3);
        assert!(d[1].ends_with(format!("target/debug/busyholm-hook{}", std::env::consts::EXE_SUFFIX)));
        assert!(d[2].to_string_lossy().contains("target/release"));
        assert_eq!(shim_candidates(Some("/x/hook".into()), exe.clone(), true), vec![PathBuf::from("/x/hook")], "an override stands alone");
        assert_eq!(shim_candidates(Some(String::new()), exe, false).len(), 1, "an empty override is ignored");
        assert!(shim_candidates(None, None, false).is_empty());
    }

    #[test]
    fn the_embedded_plugin_has_the_line_the_installer_rewrites() {
        assert_eq!(EMBEDDED_OPENCODE_PLUGIN.matches("const RUNTIME_FILE_OVERRIDE = null;").count(), 1);
    }

    #[test]
    fn parts_use_snake_case_on_the_wire() {
        assert_eq!(serde_json::to_string(&Part::OpencodePlugin).unwrap(), "\"opencode_plugin\"");
        assert_eq!(serde_json::from_str::<Part>("\"claude_statusline\"").unwrap(), Part::ClaudeStatusline);
    }
}
