// InstallManifest v1 fixtures (contracts/schemas/install-manifest.v1.schema.json).
import { T0, MS_MIN, MS_MAX, sha, edit, fx, DELETE } from "../lib.mjs";

const OWNER_TAG = "k3m9p2q7r4t8v5w1"; // 16 characters, the shortest legal owner_tag
const CLAUDE_SETTINGS = "/Users/alex/.claude/settings.json";
const CLAUDE_SETTINGS_WIN = "C:\\Users\\alex\\.claude\\settings.json";

/** Targets whose config file holds Busyholm entries, so each of their entries lists them in owned. */
const OWNED_TARGETS = new Set(["claude_hooks", "claude_statusline", "codex_hooks", "gemini_hooks", "cursor_hooks"]);

/** One owned item: a value Busyholm inserted (with its hook event) or a value it replaced. */
function ownedItem(label, over = {}) {
  return {
    event: "SessionStart",
    pointer: "/hooks/SessionStart/0",
    sha256: sha(`${label}-insert`),
    replaced_sha256: null,
    ...over,
  };
}

/** The owned list a config-file entry carries; opencode_plugin and shim_binary are whole files and carry none. */
const ownedFor = (target, label) => (OWNED_TARGETS.has(target) ? { owned: [ownedItem(label)] } : {});

/** An edit_span entry: a targeted edit of an existing file, with one inserted span and a backup. */
function editSpan(id, tool, target, path, label, state = "installed") {
  return {
    id,
    tool,
    target,
    path,
    action: "edit_span",
    state,
    installed_at: T0,
    before: { existed: true, sha256: sha(`${label}-before`), bytes: 2048 },
    after: { sha256: sha(`${label}-after`), bytes: 2310 },
    ...ownedFor(target, label),
  };
}

/** A create_file entry: the installer created the file, so restore means deleting it. */
function createFile(id, tool, target, path, label, state = "installed") {
  return {
    id,
    tool,
    target,
    path,
    action: "create_file",
    state,
    installed_at: T0,
    before: { existed: false, sha256: null, bytes: null },
    after: { sha256: sha(`${label}-after`), bytes: 640 },
    ...ownedFor(target, label),
  };
}

const manifest = (entries, over = {}) => ({
  schema_version: 1,
  app_version: "0.1.0",
  owner_tag: OWNER_TAG,
  entries,
  ...over,
});

const base = () => manifest([editSpan("claude-hooks", "claude", "claude_hooks", CLAUDE_SETTINGS, "claude-hooks")]);

/** A create_file entry for an OpenCode plugin file number i. */
const plugin = (i) =>
  createFile(`plugin-${i}`, "opencode", "opencode_plugin", `/Users/alex/.config/opencode/plugin/busyholm-${i}.js`, `plugin-${i}`);

export function valid() {
  const v = (over) => edit(base(), over);
  const one = (entry) => manifest([entry]);
  return [
    fx("empty-manifest", "No owner_tag and no entries: the state before anything was installed.", manifest([], { owner_tag: null })),
    fx("claude-hooks-edit-span", "Claude hooks inserted into settings.json by an edit_span with a backup.", base()),
    fx("claude-hooks-create-file", "Claude hooks written to a settings file the installer created.", one(createFile("claude-hooks", "claude", "claude_hooks", CLAUDE_SETTINGS, "claude-create"))),
    fx("claude-statusline-edit-span", "The Claude status line wrap, a separate consent edited into the same settings.json.", one(editSpan("claude-statusline", "claude", "claude_statusline", CLAUDE_SETTINGS, "statusline"))),
    fx("codex-hooks-edit-span-pending", "Codex hooks edited into an existing file and waiting for review in /hooks.", one(editSpan("codex-hooks", "codex", "codex_hooks", "/Users/alex/.codex/config.toml", "codex-pending", "pending_review"))),
    fx("codex-hooks-edit-span-installed", "Codex hooks edited into an existing file and already trusted.", one(editSpan("codex-hooks", "codex", "codex_hooks", "/Users/alex/.codex/config.toml", "codex-installed"))),
    fx("codex-hooks-create-file-pending", "Codex hooks in a file the installer created, waiting for review.", one(createFile("codex-hooks", "codex", "codex_hooks", "/Users/alex/.codex/hooks.json", "codex-create-pending", "pending_review"))),
    fx("codex-hooks-create-file-installed", "Codex hooks in a file the installer created, already trusted.", one(createFile("codex-hooks", "codex", "codex_hooks", "/Users/alex/.codex/hooks.json", "codex-create-installed"))),
    fx("opencode-plugin-create-file", "The OpenCode plugin file created by the installer.", one(plugin(0))),
    fx("gemini-hooks-edit-span", "Gemini hooks inserted into an existing settings file.", one(editSpan("gemini-hooks", "gemini", "gemini_hooks", "/Users/alex/.gemini/settings.json", "gemini"))),
    fx("gemini-hooks-create-file", "Gemini hooks in a settings file the installer created.", one(createFile("gemini-hooks", "gemini", "gemini_hooks", "/Users/alex/.gemini/settings.json", "gemini-create"))),
    fx("cursor-hooks-edit-span", "Cursor hooks inserted into an existing hooks file.", one(editSpan("cursor-hooks", "cursor", "cursor_hooks", "/Users/alex/.cursor/hooks.json", "cursor"))),
    fx("cursor-hooks-create-file", "Cursor hooks in a hooks file the installer created.", one(createFile("cursor-hooks", "cursor", "cursor_hooks", "/Users/alex/.cursor/hooks.json", "cursor-create"))),
    fx("shim-binary-create-file", "The shared shim binary, which has no tool and no owned list.", one(createFile("shim", null, "shim_binary", "/usr/local/bin/busyholm-shim", "shim"))),
    fx("shim-binary-windows-path", "The shim binary at a Windows drive path, with no tool.", one(createFile("shim", null, "shim_binary", "C:\\Program Files\\Busyholm\\busyholm-shim.exe", "shim-win"))),
    fx("windows-drive-claude-hooks", "Claude hooks in settings.json at a Windows drive path.", one(editSpan("claude-hooks", "claude", "claude_hooks", CLAUDE_SETTINGS_WIN, "win-claude"))),
    fx("windows-drive-opencode-plugin", "The OpenCode plugin file at a Windows drive path.", one(createFile("opencode-plugin", "opencode", "opencode_plugin", "C:\\Users\\alex\\AppData\\Roaming\\opencode\\plugin\\busyholm.js", "win-plugin"))),

    fx("app-version-1-2-3-beta-1", "A pre-release app version.", v({ app_version: "1.2.3-beta.1" })),
    fx("app-version-two-digit-parts", "A version with two-digit parts.", v({ app_version: "10.20.30" })),
    fx("app-version-rc-prerelease", "A release-candidate version.", v({ app_version: "0.1.0-rc.2" })),

    fx("before-bytes-zero", "An existing file that was empty before the install.", v({ "entries.0.before.bytes": 0 })),
    fx("before-bytes-max", "An existing file at the 256 MiB size limit.", v({ "entries.0.before.bytes": 268435456 })),
    fx("after-bytes-zero", "A file whose size after the install is 0 bytes.", v({ "entries.0.after.bytes": 0 })),
    fx("after-bytes-max", "A file at the 256 MiB size limit after the install.", v({ "entries.0.after.bytes": 268435456 })),
    fx("installed-at-minimum", "installed_at at the legal minimum (2000-01-01).", v({ "entries.0.installed_at": MS_MIN })),
    fx("installed-at-maximum", "installed_at at the legal maximum (2100-01-01).", v({ "entries.0.installed_at": MS_MAX })),

    fx("owned-64-items", "An entry with the maximum of 64 owned items.", v({
      "entries.0.owned": Array.from({ length: 64 }, (_, i) => ownedItem(`owned-${i}`, { event: "PostToolUse", pointer: `/hooks/PostToolUse/${i}` })),
    })),
    fx("sixty-four-entries", "The maximum of 64 entries.", manifest(Array.from({ length: 64 }, (_, i) => plugin(i)))),
    fx("claude-hooks-and-statusline-same-file", "Two separate consents edit the same settings.json and both are listed.", manifest([
      editSpan("claude-hooks", "claude", "claude_hooks", CLAUDE_SETTINGS, "same-hooks"),
      editSpan("claude-statusline", "claude", "claude_statusline", CLAUDE_SETTINGS, "same-statusline"),
    ])),
    fx("mixed-realistic-manifest", "A realistic set: Claude hooks, Codex pending review, the OpenCode plugin and the shim.", manifest([
      editSpan("claude-hooks", "claude", "claude_hooks", CLAUDE_SETTINGS, "mix-claude"),
      createFile("codex-hooks", "codex", "codex_hooks", "/Users/alex/.codex/hooks.json", "mix-codex", "pending_review"),
      createFile("opencode-plugin", "opencode", "opencode_plugin", "/Users/alex/.config/opencode/plugin/busyholm.js", "mix-plugin"),
      createFile("shim", null, "shim_binary", "/usr/local/bin/busyholm-shim", "mix-shim"),
    ])),

    fx("id-min-length", "An entry id of the minimum two characters.", v({ "entries.0.id": "a1" })),
    fx("id-max-length", "An entry id of the maximum 48 characters.", v({ "entries.0.id": "a" + "b".repeat(47) })),
    fx("path-1024-chars", "An absolute path of exactly 1024 characters.", v({ "entries.0.path": "/" + "a".repeat(1023) })),
    fx("path-non-ascii-spaces", "A POSIX path with spaces and non-ASCII letters in the user folder.", v({ "entries.0.path": "/Users/Zoë Smith/.claude/settings.json" })),
    fx("owned-pointer-root-slash", "An owned pointer of just a slash, which is valid RFC 6901 syntax.", v({ "entries.0.owned.0.pointer": "/" })),
    fx("owned-pointer-escaped-segment", "An owned pointer with an escaped slash segment (~1).", v({ "entries.0.owned.0.pointer": "/hooks/Stop~1Run/0" })),
    fx("owned-pointer-256-chars", "An owned pointer of exactly 256 characters.", v({ "entries.0.owned.0.pointer": "/" + "a".repeat(255) })),

    // r1: owner_tag, owned (replacing edits) and the receiver removal.
    fx("owner-tag-16-chars-alt", "An owner_tag of exactly 16 lowercase characters, the shortest legal length.", v({ owner_tag: "a1b2c3d4e5f6g7h8" })),
    fx("owner-tag-digits-only", "An owner_tag made only of digits, which the pattern allows.", v({ owner_tag: "1234567890123456" })),
    fx("owner-tag-32-chars", "An owner_tag of exactly 32 characters, the longest legal length.", v({ owner_tag: OWNER_TAG + "x6y0z9a2b5c8d1e4" })),
    fx("owned-statusline-wrap-replaced-sha256", "The statusLine wrap: an owned item with a null event that replaced an existing value.", one({
      ...editSpan("claude-statusline", "claude", "claude_statusline", CLAUDE_SETTINGS, "wrap"),
      owned: [ownedItem("wrap", { event: null, pointer: "/statusLine", replaced_sha256: sha("wrap-original") })],
    })),
    fx("codex-hooks-create-file-two-owned", "Codex hooks in a created file with two owned items for two different events.", one({
      ...createFile("codex-hooks", "codex", "codex_hooks", "/Users/alex/.codex/hooks.json", "codex-two-owned"),
      owned: [
        ownedItem("codex-two-a", { event: "PermissionRequest", pointer: "/hooks/PermissionRequest/0" }),
        ownedItem("codex-two-b", { event: "Stop", pointer: "/hooks/Stop/0" }),
      ],
    })),
    fx("owned-two-items-claude-hooks", "Claude hooks with two owned items in one entry, one per hook event.", v({
      "entries.0.owned": [ownedItem("two-a"), ownedItem("two-b", { event: "PostToolUse", pointer: "/hooks/PostToolUse/0" })],
    })),
    fx("owned-event-max-length", "An owned event of the maximum 64 characters.", v({ "entries.0.owned.0.event": "A" + "b".repeat(63) })),
    fx("owned-event-with-dot", "An owned event name containing a dot, which the pattern allows.", v({ "entries.0.owned.0.event": "Stop.Failure" })),
    fx("owned-replaced-value-on-hook-event", "An owned hook item that also replaced an earlier value, so replaced_sha256 is set on a named event.", v({
      "entries.0.owned": [ownedItem("replaced-hook", { event: "Stop", pointer: "/hooks/Stop/0", replaced_sha256: sha("replaced-hook-original") })],
    })),
  ];
}

export function invalid() {
  const b = base();
  const v = (over) => edit(b, over);
  const shim = createFile("shim", null, "shim_binary", "/usr/local/bin/busyholm-shim", "shim");
  const codex = createFile("codex-hooks", "codex", "codex_hooks", "/Users/alex/.codex/hooks.json", "codex-bad");
  const cf = createFile("claude-hooks", "claude", "claude_hooks", CLAUDE_SETTINGS, "cf-base");
  const pluginEditSpan = editSpan("opencode-plugin", "opencode", "opencode_plugin", "/Users/alex/.config/opencode/plugin/busyholm.js", "plugin-edit");
  const shimEditSpan = editSpan("shim", null, "shim_binary", "/usr/local/bin/busyholm-shim", "shim-edit");
  const one = (entry) => manifest([entry]);
  return [
    fx("root-array", "The root must be an object, not an array.", [b], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("leftover-receiver-field", "The receiver field was removed in r1, so a leftover receiver is an unknown root field.", edit(b, { receiver: { port: 45871 } }), ""),
    fx("missing-app-version", "app_version is required.", edit(b, { app_version: DELETE }), ""),
    fx("missing-entries", "entries is required (an empty array when nothing is installed).", edit(b, { entries: DELETE }), ""),
    fx("missing-owner-tag", "owner_tag is required, and null is allowed only with an empty entries array.", edit(b, { owner_tag: DELETE }), ""),
    fx("unknown-root-field", "An unknown top-level field is rejected.", v({ telemetry: true }), ""),
    fx("schema-version-2", "schema_version must be 1 for this contract.", v({ schema_version: 2 }), "/schema_version"),

    fx("owner-tag-null-with-entries", "owner_tag may be null only while entries is empty.", v({ owner_tag: null }), "/owner_tag"),
    fx("owner-tag-uppercase", "owner_tag must be lowercase letters and digits.", v({ owner_tag: OWNER_TAG.toUpperCase() }), "/owner_tag"),
    fx("owner-tag-15-chars", "owner_tag of 15 characters is below the minimum of 16.", v({ owner_tag: OWNER_TAG.slice(0, 15) }), "/owner_tag"),
    fx("owner-tag-33-chars", "owner_tag of 33 characters is above the maximum of 32.", v({ owner_tag: OWNER_TAG + "x6y0z9a2b5c8d1e4a" }), "/owner_tag"),
    fx("owner-tag-with-dash", "owner_tag may not contain a dash.", v({ owner_tag: "k3m9p2q7-4t8v5w1" }), "/owner_tag"),

    fx("app-version-v-prefix", "app_version has no leading v.", v({ app_version: "v0.1.0" }), "/app_version"),
    fx("app-version-two-parts", "app_version needs three numeric parts.", v({ app_version: "0.1" }), "/app_version"),
    fx("app-version-over-32-chars", "app_version over 32 characters is rejected.", v({ app_version: "1.2.3-" + "a".repeat(27) }), "/app_version"),

    fx("entry-id-uppercase", "An entry id must be lowercase.", v({ "entries.0.id": "Claude-hooks" }), "/entries/0/id"),
    fx("entry-id-leading-digit", "An entry id must start with a letter.", v({ "entries.0.id": "1claude" }), "/entries/0/id"),
    fx("entry-id-one-char", "An entry id needs at least two characters.", v({ "entries.0.id": "a" }), "/entries/0/id"),
    fx("entry-id-49-chars", "An entry id over 48 characters is rejected.", v({ "entries.0.id": "a" + "b".repeat(48) }), "/entries/0/id"),

    fx("unknown-target", "target must be one of the defined targets.", v({ "entries.0.target": "vscode_hooks" }), "/entries/0/target"),
    fx("tool-other", "The tool other is not allowed in this contract.", v({ "entries.0.tool": "other" }), "/entries/0/tool"),
    fx("tool-unknown-name", "The tool copilot is not a known agent.", v({ "entries.0.tool": "copilot" }), "/entries/0/tool"),
    fx("claude-hooks-with-codex", "claude_hooks must serve the claude tool.", v({ "entries.0.tool": "codex" }), "/entries/0/tool"),
    fx("shim-binary-with-tool", "shim_binary must have a null tool because several agents share it.", edit(manifest([shim]), { "entries.0.tool": "claude" }), "/entries/0/tool"),
    fx("non-shim-null-tool", "A non-shim target must name its tool, not null.", v({ "entries.0.tool": null }), "/entries/0/tool"),

    fx("opencode-plugin-edit-span", "opencode_plugin must be create_file, not edit_span.", manifest([pluginEditSpan]), "/entries/0/action"),
    fx("shim-binary-edit-span", "shim_binary must be create_file, not edit_span.", manifest([shimEditSpan]), "/entries/0/action"),
    fx("claude-hooks-without-owned", "A claude_hooks entry must list its owned items, and this one does not.", edit(b, { "entries.0.owned": DELETE }), "/entries/0"),
    fx("codex-hooks-create-file-without-owned", "A codex_hooks entry must list its owned items even when the file was created.", edit(manifest([codex]), { "entries.0.owned": DELETE }), "/entries/0"),
    fx("opencode-plugin-with-owned", "opencode_plugin is a whole file Busyholm owns, so it may not carry owned.", one({ ...plugin(0), owned: [ownedItem("plugin-owned")] }), "/entries/0"),
    fx("shim-binary-with-owned", "shim_binary is a whole file Busyholm owns, so it may not carry owned.", one({ ...shim, owned: [ownedItem("shim-owned")] }), "/entries/0"),
    fx("owned-empty-array", "An owned list may not be empty, since a config entry always lists at least one item.", v({ "entries.0.owned": [] }), "/entries/0/owned"),
    fx("owned-missing-replaced-sha256", "An owned item must always carry replaced_sha256, null or a hash.", v({ "entries.0.owned.0.replaced_sha256": DELETE }), "/entries/0/owned/0"),
    fx("owned-item-unknown-key", "An owned item is a closed object, so a note key is rejected.", v({ "entries.0.owned.0.note": "copied from laptop" }), "/entries/0/owned/0"),
    fx("owned-event-with-space", "An owned event must match the identifier pattern, so a space is rejected.", v({ "entries.0.owned.0.event": "Permission Request" }), "/entries/0/owned/0/event"),
    fx("leftover-edits-field", "The edits field was replaced by owned in r1, so a leftover edits key is an unknown entry field.", v({ "entries.0.edits": [{ pointer: "/hooks/SessionStart/0", sha256: sha("old-edit") }] }), "/entries/0"),
    fx("owned-over-64", "An owned list may hold at most 64 items.", v({
      "entries.0.owned": Array.from({ length: 65 }, (_, i) => ownedItem(`over-${i}`, { event: "PostToolUse", pointer: `/hooks/PostToolUse/${i}` })),
    }), "/entries/0/owned"),
    fx("owned-pointer-no-leading-slash", "An owned pointer must start with a slash.", v({ "entries.0.owned.0.pointer": "hooks/SessionStart/0" }), "/entries/0/owned/0/pointer"),
    fx("owned-pointer-257-chars", "An owned pointer over 256 characters is rejected.", v({ "entries.0.owned.0.pointer": "/" + "a".repeat(256) }), "/entries/0/owned/0/pointer"),
    fx("owned-sha256-uppercase", "An owned sha256 must be lowercase hex.", v({ "entries.0.owned.0.sha256": sha("insert-upper").toUpperCase() }), "/entries/0/owned/0/sha256"),

    fx("create-file-before-existed-true", "A create_file needs before.existed false.", edit(b, { "entries.0.action": "create_file" }), "/entries/0/before"),
    fx("edit-span-before-existed-false", "An edit_span needs before.existed true.", v({ "entries.0.before": { existed: false, sha256: null, bytes: null } }), "/entries/0/before"),
    fx("before-existed-true-sha256-null", "A file that existed needs its sha256.", v({ "entries.0.before.sha256": null }), "/entries/0/before/sha256"),
    fx("before-existed-false-sha256-set", "A file that did not exist has a null sha256.", edit(b, { "entries.0.action": "create_file", "entries.0.before": { existed: false, sha256: sha("never-existed"), bytes: null } }), "/entries/0/before/sha256"),
    fx("before-existed-false-bytes-set", "A file that did not exist has null bytes.", edit(b, { "entries.0.action": "create_file", "entries.0.before": { existed: false, sha256: null, bytes: 0 } }), "/entries/0/before/bytes"),

    fx("pending-review-on-claude", "pending_review is only for Codex hooks.", v({ "entries.0.state": "pending_review" }), "/entries/0/state"),
    fx("codex-state-failed", "The state must be installed or pending_review.", edit(manifest([codex]), { "entries.0.state": "failed" }), "/entries/0/state"),

    fx("path-relative", "A path must be absolute, so a relative path is rejected.", v({ "entries.0.path": "Users/alex/.claude/settings.json" }), "/entries/0/path"),
    fx("path-unc", "UNC paths are rejected on purpose.", v({ "entries.0.path": "\\\\server\\share\\.claude\\settings.json" }), "/entries/0/path"),
    fx("path-control-char", "A path may not contain a control character.", v({ "entries.0.path": "/Users/alex\u0007/.claude/settings.json" }), "/entries/0/path"),
    fx("path-over-1024-chars", "A path over 1024 characters is rejected.", v({ "entries.0.path": "/" + "a".repeat(1024) }), "/entries/0/path"),
    fx("path-drive-forward-slash", "A Windows drive path must use a backslash after the drive letter.", v({ "entries.0.path": "C:/Users/alex/.claude/settings.json" }), "/entries/0/path"),

    fx("after-sha256-uppercase", "A sha256 must be lowercase hex.", v({ "entries.0.after.sha256": sha("claude-settings-after").toUpperCase() }), "/entries/0/after/sha256"),
    fx("after-sha256-63-chars", "A sha256 must be exactly 64 characters.", v({ "entries.0.after.sha256": sha("after-63").slice(0, 63) }), "/entries/0/after/sha256"),
    fx("before-sha256-63-chars", "A before sha256 must be exactly 64 characters.", v({ "entries.0.before.sha256": sha("before-63").slice(0, 63) }), "/entries/0/before/sha256"),

    fx("after-missing", "after is required.", edit(b, { "entries.0.after": DELETE }), "/entries/0"),
    fx("after-bytes-negative", "A size in bytes may not be negative.", v({ "entries.0.after.bytes": -1 }), "/entries/0/after/bytes"),

    fx("installed-at-seconds", "installed_at in seconds is below the millisecond range.", v({ "entries.0.installed_at": Math.floor(T0 / 1000) }), "/entries/0/installed_at"),
    fx("installed-at-above-max", "installed_at above 2100-01-01 is rejected.", v({ "entries.0.installed_at": MS_MAX + 1 }), "/entries/0/installed_at"),
    fx("installed-at-iso-string", "installed_at must be an integer, not an ISO string.", v({ "entries.0.installed_at": "2026-10-12T12:00:00Z" }), "/entries/0/installed_at"),

    fx("entries-65", "At most 64 entries.", manifest(Array.from({ length: 65 }, (_, i) => plugin(i))), "/entries"),
    fx("duplicate-entry-id", "Entry ids are unique across the array.", manifest([
      b.entries[0],
      editSpan("claude-hooks", "claude", "claude_statusline", CLAUDE_SETTINGS, "dup-id"),
    ]), "/entries/1"),
    fx("duplicate-target-path", "The same target and path may not appear twice.", manifest([
      b.entries[0],
      editSpan("claude-hooks-copy", "claude", "claude_hooks", CLAUDE_SETTINGS, "dup-path"),
    ]), "/entries/1"),
    fx("entry-unknown-field", "An unknown field in an entry (a note) is rejected.", v({ "entries.0.note": "copied from laptop" }), "/entries/0"),
    fx("entry-missing-before", "before is required.", edit(b, { "entries.0.before": DELETE }), "/entries/0"),
    fx("entry-state-pending", "The state must be installed or pending_review, so the value pending is rejected.", edit(manifest([codex]), { "entries.0.state": "pending" }), "/entries/0/state"),
    fx("entry-action-delete", "The action must be edit_span or create_file.", edit(manifest([cf]), { "entries.0.action": "delete" }), "/entries/0/action"),
  ];
}
