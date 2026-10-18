//! InstallManifest v1: `install-manifest.json` in the app data folder (SPEC 6.8, WP-07).
//!
//! Every file the installer created or edited, with what is needed for a
//! byte-exact restore. Local only and never exported: it holds absolute paths
//! and the receiver secret.

use serde::{Deserialize, Serialize};

use crate::check;
use crate::validate::{ContractError, Validate};
use crate::common::{nullable, present, Ms, Sha256Hex, Version};

/// The agents an installer entry can serve (every tool except `other`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallTool {
    Claude,
    Codex,
    Opencode,
    Antigravity,
    Gemini,
    Cursor,
    Aider,
}

/// What an entry is for. `claude_hooks` and `claude_statusline` are separate consents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallTarget {
    ClaudeHooks,
    ClaudeStatusline,
    CodexHooks,
    OpencodePlugin,
    ShimBinary,
    GeminiHooks,
    CursorHooks,
}

/// How the installer touched the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallAction {
    /// A targeted edit of an existing file (backup kept).
    EditSpan,
    /// A file the installer created (restore means delete).
    CreateFile,
}

/// Entry state. `pending_review` means written but not yet trusted inside the agent (Codex /hooks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallState {
    Installed,
    PendingReview,
}

/// The file before the install. When it existed, its exact bytes are kept in the backups folder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Before {
    pub existed: bool,
    /// Null when the file did not exist.
    #[serde(deserialize_with = "nullable")]
    pub sha256: Option<Sha256Hex>,
    /// Null when the file did not exist (max 268435456).
    #[serde(deserialize_with = "nullable")]
    pub bytes: Option<u32>,
}

/// The file right after the install.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct After {
    pub sha256: Sha256Hex,
    /// Max 268435456.
    pub bytes: u32,
}

/// One entry Busyholm inserted or replaced in a config file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedEntry {
    /// The hook event the entry is for (for example `PermissionRequest`); null for a
    /// non-hook value such as `statusLine`.
    #[serde(deserialize_with = "nullable")]
    pub event: Option<String>,
    /// RFC 6901 JSON Pointer to the entry as of install time (a hint).
    pub pointer: String,
    /// Hash of the inserted value's exact text.
    pub sha256: Sha256Hex,
    /// When the entry replaced an existing value, the hash of that value's exact
    /// text; otherwise null.
    #[serde(deserialize_with = "nullable")]
    pub replaced_sha256: Option<Sha256Hex>,
}

/// One file the installer created or edited.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestEntry {
    pub id: String,
    /// The agent this entry serves; null exactly for `shim_binary`.
    #[serde(deserialize_with = "nullable")]
    pub tool: Option<InstallTool>,
    pub target: InstallTarget,
    /// Absolute path (POSIX or Windows drive).
    pub path: String,
    pub action: InstallAction,
    pub state: InstallState,
    pub installed_at: Ms,
    pub before: Before,
    pub after: After,
    /// Present exactly for config files that hold entries (every target except
    /// `opencode_plugin` and `shim_binary`): one item per entry inserted or replaced.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    pub owned: Option<Vec<OwnedEntry>>,
}

/// The install manifest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallManifest {
    /// Schema version, always 1.
    pub schema_version: Version<1>,
    /// Busyholm version that last wrote the manifest (semver).
    pub app_version: String,
    /// Random per-install tag written into every owned hook entry; null only while
    /// `entries` is empty.
    #[serde(deserialize_with = "nullable")]
    pub owner_tag: Option<String>,
    /// At most 64 entries.
    pub entries: Vec<ManifestEntry>,
}

const MAX_BYTES: u64 = 268_435_456;

fn validate_entry(e: &ManifestEntry, path: &str) -> Result<(), ContractError> {
    use InstallTarget::*;
    let field = |name: &str| check::child(path, name);

    check::pattern(&field("id"), &e.id, check::is_entry_id, "^[a-z][a-z0-9_-]{1,47}$")?;
    check::chars(&field("path"), &e.path, 2, 1024)?;
    check::pattern(&field("path"), &e.path, check::is_abs_path, "an absolute POSIX or Windows drive path")?;
    check::ms(&field("installed_at"), e.installed_at)?;

    let bp = field("before");
    if let Some(h) = &e.before.sha256 {
        check::sha256(&check::child(&bp, "sha256"), h)?;
    }
    if let Some(n) = e.before.bytes {
        check::int_range(&check::child(&bp, "bytes"), u64::from(n), 0, MAX_BYTES)?;
    }
    let ap = field("after");
    check::sha256(&check::child(&ap, "sha256"), &e.after.sha256)?;
    check::int_range(&check::child(&ap, "bytes"), u64::from(e.after.bytes), 0, MAX_BYTES)?;

    if let Some(owned) = &e.owned {
        let op = field("owned");
        check::items_range(&op, owned.len(), 1, 64)?;
        for (i, o) in owned.iter().enumerate() {
            let p = check::at(&op, i);
            if let Some(ev) = &o.event {
                check::pattern(&check::child(&p, "event"), ev, check::is_event_name, "^[A-Za-z][A-Za-z0-9_.]{0,63}$")?;
            }
            check::chars(&check::child(&p, "pointer"), &o.pointer, 0, 256)?;
            check::pattern(&check::child(&p, "pointer"), &o.pointer, check::is_json_pointer, "a JSON Pointer such as /hooks/Stop")?;
            check::sha256(&check::child(&p, "sha256"), &o.sha256)?;
            if let Some(h) = &o.replaced_sha256 {
                check::sha256(&check::child(&p, "replaced_sha256"), h)?;
            }
        }
    }

    // before.sha256 and before.bytes are set exactly when the file existed.
    if e.before.existed {
        check::ensure(e.before.sha256.is_some(), &check::child(&bp, "sha256"), "must be set when existed is true")?;
        check::ensure(e.before.bytes.is_some(), &check::child(&bp, "bytes"), "must be set when existed is true")?;
    } else {
        check::ensure(e.before.sha256.is_none(), &check::child(&bp, "sha256"), "must be null when existed is false")?;
        check::ensure(e.before.bytes.is_none(), &check::child(&bp, "bytes"), "must be null when existed is false")?;
    }

    // edit_span: the file existed. create_file: it did not.
    if e.action == InstallAction::EditSpan {
        check::ensure(e.before.existed, &check::child(&bp, "existed"), "must be true when action is edit_span")?;
    } else {
        check::ensure(!e.before.existed, &check::child(&bp, "existed"), "must be false when action is create_file")?;
    }

    // Config files list their owned entries; whole files Busyholm owns do not.
    check::presence(
        path,
        "owned",
        e.owned.is_some(),
        !matches!(e.target, OpencodePlugin | ShimBinary),
        "target is not opencode_plugin or shim_binary",
    )?;

    // Only Codex hooks wait for an in-agent review.
    check::ensure(
        e.target == CodexHooks || e.state == InstallState::Installed,
        &field("state"),
        "must be installed unless target is codex_hooks",
    )?;

    // Tool per target.
    let want_tool = match e.target {
        ClaudeHooks | ClaudeStatusline => Some(InstallTool::Claude),
        CodexHooks => Some(InstallTool::Codex),
        OpencodePlugin => Some(InstallTool::Opencode),
        GeminiHooks => Some(InstallTool::Gemini),
        CursorHooks => Some(InstallTool::Cursor),
        ShimBinary => None,
    };
    match want_tool {
        Some(t) => check::ensure(e.tool == Some(t), &field("tool"), format!("must be {t:?} for this target").to_lowercase())?,
        None => check::ensure(e.tool.is_none(), &field("tool"), "must be null for shim_binary")?,
    }
    if matches!(e.target, OpencodePlugin | ShimBinary) {
        check::ensure(e.action == InstallAction::CreateFile, &field("action"), "must be create_file for this target")?;
    }
    Ok(())
}

impl Validate for InstallManifest {
    fn validate(&self) -> Result<(), ContractError> {
        check::chars("/app_version", &self.app_version, 0, 32)?;
        check::pattern("/app_version", &self.app_version, check::is_semver, "a semantic version such as 0.1.0")?;
        if let Some(tag) = &self.owner_tag {
            check::pattern("/owner_tag", tag, check::is_owner_tag, "^[a-z0-9]{16,32}$")?;
        }
        // owner_tag must be a string once there are entries.
        check::ensure(
            self.entries.is_empty() || self.owner_tag.is_some(),
            "/owner_tag",
            "must be a string when entries is non-empty",
        )?;
        check::max_items("/entries", self.entries.len(), 64)?;
        for (i, e) in self.entries.iter().enumerate() {
            validate_entry(e, &check::at("/entries", i))?;
        }
        check::unique_by("/entries", &self.entries, "id", |e| e.id.as_str())?;
        check::unique_by("/entries", &self.entries, "target and path", |e| (e.target, e.path.as_str()))?;
        Ok(())
    }
}
