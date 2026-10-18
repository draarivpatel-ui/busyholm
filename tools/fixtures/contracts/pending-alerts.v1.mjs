// PendingAlerts v1 fixtures (contracts/schemas/pending-alerts.v1.schema.json).
import { T0, MIN, HOUR, MS_MIN, MS_MAX, hid, edit, fx, DELETE } from "../lib.mjs";

const TOOLS = ["claude", "codex", "opencode", "antigravity", "gemini", "cursor", "aider", "other"];
const HOSTS = ["cli", "desktop", "vscode", "sdk", "ide", "other"];
const REQUIRED_ALERT_FIELDS = [
  "agent",
  "tool",
  "host",
  "root_id",
  "account_id",
  "session_id",
  "request_id",
  "reason",
  "since",
  "last_confirmed_at",
];

// A raw UUID is the shape the schema must reject; it is written out on purpose.
const RAW_UUID = "6f1c0a2e-1b2c-4d3e-8f9a-0b1c2d3e4f5a";

const A = hid("pending-agent-a");
const B = hid("pending-agent-b");
const ROOT = hid("pending-root-a");
const ACCOUNT = hid("pending-account-a");
const SESSION = hid("pending-session-a");
const REQUEST = hid("pending-request-a");

function alert(over = {}) {
  return {
    agent: A,
    tool: "claude",
    host: "cli",
    root_id: ROOT,
    account_id: ACCOUNT,
    session_id: SESSION,
    request_id: REQUEST,
    reason: "permission",
    since: T0 - 2 * MIN,
    last_confirmed_at: T0 - MIN,
    ...over,
  };
}

// A second agent that differs from the first in every key field, unless overridden.
function other(over = {}) {
  return alert({
    agent: B,
    session_id: hid("pending-session-b"),
    request_id: hid("pending-request-b"),
    ...over,
  });
}

function file(alerts = [alert()], over = {}) {
  return {
    schema_version: 1,
    privacy: { containsText: false },
    saved_at: T0,
    alerts,
    ...over,
  };
}

export function valid() {
  return [
    fx("empty-alerts", "No agent waits on the user, so the alerts array is empty.", file([])),
    fx("one-alert-permission", "One alert with reason permission and every optional id set.", file()),
    fx("one-alert-question", "One alert with reason question and every optional id set.", file([alert({ reason: "question" })])),
    fx("one-of-each-reason", "Two alerts for two agents, one permission and one question.", file([alert(), other({ reason: "question" })])),
    ...TOOLS.map((tool) => fx(`tool-${tool}`, `One alert from the ${tool} tool.`, file([alert({ tool, agent: hid(`pending-tool-${tool}`) })]))),
    ...HOSTS.map((host) => fx(`host-${host}`, `One alert from the ${host} host.`, file([alert({ host, agent: hid(`pending-host-${host}`) })]))),
    fx("account-id-null", "account_id is null when the source gave no account.", file([alert({ account_id: null })])),
    fx("session-id-null", "session_id is null when the source gave no session.", file([alert({ session_id: null })])),
    fx("request-id-null", "request_id is null, so the agent itself is the key.", file([alert({ request_id: null })])),
    fx("all-optional-ids-null", "account_id, session_id and request_id are all null on a question alert.", file([alert({ reason: "question", account_id: null, session_id: null, request_id: null })])),
    fx("max-alerts-64", "64 alerts for distinct agents, the maximum array length.", file(Array.from({ length: 64 }, (_, i) => alert({
      agent: hid(`max-${i}`),
      tool: TOOLS[i % TOOLS.length],
      host: HOSTS[i % HOSTS.length],
      reason: i % 2 ? "question" : "permission",
    })))),
    fx("shared-root-id", "Two agents under one root_id, since root_id is not a uniqueness key.", file([alert(), other()])),
    fx("shared-session-id", "Two agents sharing a session_id, which is allowed because only agent must be unique.", file([alert(), other({ session_id: SESSION })])),
    fx("shared-request-id", "Two agents sharing a request_id, which is allowed because only agent must be unique.", file([alert(), other({ request_id: REQUEST })])),
    fx("shared-account-id", "Two agents sharing an account_id under different roots, which is allowed because only agent must be unique.", file([alert(), other({ account_id: ACCOUNT, root_id: hid("pending-root-second") })])),
    fx("identical-except-agent", "Two alerts identical in every field except agent, which is the only key.", file([alert(), alert({ agent: B })])),
    fx("since-equals-last-confirmed", "since equal to last_confirmed_at is allowed.", file([alert({ since: T0 - MIN, last_confirmed_at: T0 - MIN })])),
    fx("since-earlier-than-confirmed", "since is an hour before last_confirmed_at, the usual case after a fresh confirmation.", file([alert({ since: T0 - HOUR, last_confirmed_at: T0 - MIN })])),
    fx("timestamps-at-ms-min", "saved_at, since and last_confirmed_at all exactly at the legal minimum.", file([alert({ since: MS_MIN, last_confirmed_at: MS_MIN })], { saved_at: MS_MIN })),
    fx("timestamps-at-ms-max", "saved_at, since and last_confirmed_at all exactly at the legal maximum.", file([alert({ since: MS_MAX, last_confirmed_at: MS_MAX })], { saved_at: MS_MAX })),
    fx("since-at-ms-min", "since alone at the legal minimum.", file([alert({ since: MS_MIN })])),
    fx("last-confirmed-at-ms-max", "last_confirmed_at alone at the legal maximum.", file([alert({ last_confirmed_at: MS_MAX })])),
    fx("saved-at-ms-max", "saved_at alone at the legal maximum.", file([alert()], { saved_at: MS_MAX })),
    fx("other-tool-and-host", "One alert using the other tool and the other host together.", file([alert({ tool: "other", host: "other" })])),
  ];
}

export function invalid() {
  const base = file();
  const tooMany = Array.from({ length: 65 }, (_, i) => alert({ agent: hid(`over-${i}`) }));
  return [
    // Root shape and top-level fields.
    fx("root-array", "The root must be an object, not an array.", [base], ""),
    fx("root-null", "The root must be an object, not null.", null, ""),
    fx("root-string", "The root must be an object, not a string.", "pending-alerts", ""),
    fx("missing-schema-version", "schema_version is required.", edit(base, { schema_version: DELETE }), ""),
    fx("missing-privacy", "privacy is required.", edit(base, { privacy: DELETE }), ""),
    fx("missing-saved-at", "saved_at is required.", edit(base, { saved_at: DELETE }), ""),
    fx("missing-alerts", "alerts is required, even when it is empty.", edit(base, { alerts: DELETE }), ""),
    fx("unknown-top-level-field", "An unknown top-level field is rejected.", edit(base, { source: "core" }), ""),
    fx("schema-version-2", "schema_version must be 1, so version 2 is rejected.", edit(base, { schema_version: 2 }), "/schema_version"),
    fx("schema-version-string", "schema_version must be the number 1, not the string 1.", edit(base, { schema_version: "1" }), "/schema_version"),

    // Privacy block.
    fx("privacy-contains-text-true", "privacy.containsText must be false because the file holds no text.", edit(base, { "privacy.containsText": true }), "/privacy/containsText"),
    fx("privacy-missing-contains-text", "privacy requires containsText.", edit(base, { "privacy.containsText": DELETE }), "/privacy"),
    fx("privacy-unknown-field", "privacy allows only containsText.", edit(base, { "privacy.note": "none" }), "/privacy"),

    // saved_at range and type.
    fx("saved-at-seconds", "saved_at in seconds is below the millisecond range.", edit(base, { saved_at: 1791806400 }), "/saved_at"),
    fx("saved-at-string", "saved_at must be an integer, not an ISO date string.", edit(base, { saved_at: "2026-10-12T12:00:00Z" }), "/saved_at"),
    fx("saved-at-below-min", "saved_at one millisecond below 2000-01-01 UTC is rejected.", edit(base, { saved_at: MS_MIN - 1 }), "/saved_at"),
    fx("saved-at-above-max", "saved_at one millisecond above 2100-01-01 UTC is rejected.", edit(base, { saved_at: MS_MAX + 1 }), "/saved_at"),

    // alerts array shape.
    fx("alerts-not-array", "alerts must be an array.", edit(base, { alerts: {} }), "/alerts"),
    fx("too-many-alerts", "At most 64 alerts, so 65 is rejected.", edit(base, { alerts: tooMany }), "/alerts"),
    fx("alert-null-entry", "Each alert must be an object, not null.", edit(base, { "alerts.0": null }), "/alerts/0"),

    // Required alert fields, one fixture each.
    ...REQUIRED_ALERT_FIELDS.map((field) =>
      fx(`alert-missing-${field.replace(/_/g, "-")}`, `${field} is required on every alert.`, edit(base, { [`alerts.0.${field}`]: DELETE }), "/alerts/0"),
    ),

    // Unknown alert fields that would leak content or paths.
    fx("alert-leaked-prompt", "A prompt field is rejected as unknown on an alert.", edit(base, { "alerts.0.prompt": "fix the bug" }), "/alerts/0"),
    fx("alert-leaked-cwd", "A cwd field is rejected as unknown on an alert.", edit(base, { "alerts.0.cwd": "/example/project" }), "/alerts/0"),
    fx("alert-leaked-title", "A title field is rejected as unknown on an alert.", edit(base, { "alerts.0.title": "Approve the deploy?" }), "/alerts/0"),

    // Enums.
    fx("tool-gemini-cli", "tool must be one of the listed values, and gemini-cli is not one.", edit(base, { "alerts.0.tool": "gemini-cli" }), "/alerts/0/tool"),
    fx("host-terminal", "host must be one of the listed values, and terminal is not one.", edit(base, { "alerts.0.host": "terminal" }), "/alerts/0/host"),
    fx("reason-waiting", "reason is permission or question, and waiting is not a reason.", edit(base, { "alerts.0.reason": "waiting" }), "/alerts/0/reason"),

    // Id shapes: raw UUIDs, uppercase hex, null where not nullable, wrong length.
    fx("agent-raw-uuid", "A raw UUID is not a salted 32-character hex id.", edit(base, { "alerts.0.agent": RAW_UUID }), "/alerts/0/agent"),
    fx("agent-uppercase", "Ids are lowercase hex, so an uppercase agent is rejected.", edit(base, { "alerts.0.agent": hid("pending-agent-a").toUpperCase() }), "/alerts/0/agent"),
    fx("root-id-raw-uuid", "A raw UUID is not a salted 32-character hex id.", edit(base, { "alerts.0.root_id": RAW_UUID }), "/alerts/0/root_id"),
    fx("root-id-uppercase", "Ids are lowercase hex, so an uppercase root_id is rejected.", edit(base, { "alerts.0.root_id": ROOT.toUpperCase() }), "/alerts/0/root_id"),
    fx("root-id-null", "root_id is not nullable.", edit(base, { "alerts.0.root_id": null }), "/alerts/0/root_id"),
    fx("account-id-raw-uuid", "A raw UUID is not a salted 32-character hex id.", edit(base, { "alerts.0.account_id": RAW_UUID }), "/alerts/0/account_id"),
    fx("account-id-uppercase", "Ids are lowercase hex, so an uppercase account_id is rejected.", edit(base, { "alerts.0.account_id": ACCOUNT.toUpperCase() }), "/alerts/0/account_id"),
    fx("session-id-raw-uuid", "A raw UUID is not a salted 32-character hex id.", edit(base, { "alerts.0.session_id": RAW_UUID }), "/alerts/0/session_id"),
    fx("session-id-uppercase", "Ids are lowercase hex, so an uppercase session_id is rejected.", edit(base, { "alerts.0.session_id": SESSION.toUpperCase() }), "/alerts/0/session_id"),
    fx("request-id-raw-uuid", "A raw UUID is not a salted 32-character hex id.", edit(base, { "alerts.0.request_id": RAW_UUID }), "/alerts/0/request_id"),
    fx("request-id-uppercase", "Ids are lowercase hex, so an uppercase request_id is rejected.", edit(base, { "alerts.0.request_id": REQUEST.toUpperCase() }), "/alerts/0/request_id"),
    fx("request-id-too-short", "An id must be exactly 32 hex characters, and this one has 31.", edit(base, { "alerts.0.request_id": REQUEST.slice(0, 31) }), "/alerts/0/request_id"),

    // Timestamps: seconds, strings, and values outside the legal range.
    fx("since-seconds", "since in seconds is below the millisecond range.", edit(base, { "alerts.0.since": 1791806400 }), "/alerts/0/since"),
    fx("last-confirmed-seconds", "last_confirmed_at in seconds is below the millisecond range.", edit(base, { "alerts.0.last_confirmed_at": 1791806400 }), "/alerts/0/last_confirmed_at"),
    fx("since-string", "since must be an integer, not an ISO date string.", edit(base, { "alerts.0.since": "2026-10-12T11:58:00Z" }), "/alerts/0/since"),
    fx("since-below-min", "since one millisecond below 2000-01-01 UTC is rejected.", edit(base, { "alerts.0.since": MS_MIN - 1 }), "/alerts/0/since"),
    fx("since-above-max", "since one millisecond above 2100-01-01 UTC is rejected.", edit(base, { "alerts.0.since": MS_MAX + 1 }), "/alerts/0/since"),
    fx("last-confirmed-below-min", "last_confirmed_at one millisecond below 2000-01-01 UTC is rejected.", edit(base, { "alerts.0.last_confirmed_at": MS_MIN - 1 }), "/alerts/0/last_confirmed_at"),
    fx("last-confirmed-above-max", "last_confirmed_at one millisecond above 2100-01-01 UTC is rejected.", edit(base, { "alerts.0.last_confirmed_at": MS_MAX + 1 }), "/alerts/0/last_confirmed_at"),

    // Agent uniqueness (x-unique-by): the second alert repeats the first agent.
    fx("duplicate-agent", "Two alerts for the same agent break the agent uniqueness rule.", file([alert(), alert({ reason: "question" })]), "/alerts/1"),
    fx("duplicate-agent-other-tool", "The same agent under a different tool and host is still a duplicate.", file([alert(), alert({ tool: "codex", host: "desktop" })]), "/alerts/1"),
  ];
}
