# What the Claude adapter reads (for the `busyholm-hook` shim, WP-07)

The adapter works from exactly these fields. The shim should send these and nothing else
(an allowlist, so a field nobody has thought of yet is dropped too). Every other key of the
hook JSON, including every content field, can be removed before transport; the adapter's
output is identical with or without them (tests/wp04_core.rs checks this on all 38 hook
fixtures). Types: strings unless noted; ids are at most 256 characters.

## Hook bodies (`hook_event_name` present)

| Field | Used for | Notes |
|---|---|---|
| `hook_event_name` | which event | required. 13 mapped names plus 4 ignored (`PreCompact`, `PostCompact`, `TaskCreated`, `TaskCompleted`); anything else is counted as drift |
| `session_id` | instance, session_id | required for the 13 mapped events; hashed on arrival |
| `agent_id` | child instance (parent = session) | present on any hook fired inside a subagent; required on `SubagentStart` and `SubagentStop` |
| `prompt_id` or `turn_id` | turn_id | `turn_id` wins when both are sent |
| `tool_use_id` or `request_id` | request_id | `request_id` wins; only kept on `needs_permission`, `needs_answer`, `answered`, `tool_end` |
| `tool_name` | activity (shell, edit, read, web, delegate, other) and the `AskUserQuestion` check | the NAME only, never the input |
| `notification_type` | `Notification` mapping | closed vocabulary |
| `source` | `SessionStart` only | `compact` produces no event |
| `reason` | `SessionEnd` only | closed vocabulary (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`). On `PermissionDenied` it is free text: do not send |
| `error` | `StopFailure` only | closed vocabulary (`rate_limit`, `overloaded`, ...). On `PostToolUseFailure` it is free text: do not send |
| `is_interrupt` (boolean) | `PostToolUseFailure` interruption | optional |

A body with only `hook_event_name` and `session_id` already maps (activity becomes `other`).

## Status line bodies (no `hook_event_name`, has `session_id`)

| Field | Used for |
|---|---|
| `session_id` | instance |
| `rate_limits.five_hour.used_percentage` (number 0 to 100), `rate_limits.five_hour.resets_at` (epoch seconds) | the `5h` usage sample |
| `rate_limits.seven_day.used_percentage`, `rate_limits.seven_day.resets_at` | the `weekly` usage sample |

A window without both numbers yields no sample (never 0%). The rest of the status line input
(cost, context window, model, workspace, paths) is not read.

## Not from the shim

`root_id` comes from the Claude data root the adapter instance watches (`CLAUDE_CONFIG_DIR`,
else `~/.claude`; extra roots are separate adapter instances). `account_id` is the salted hash
of the registry's owner account id, learned from `sessions/<pid>.json`; it is attached to later
hook, log and status line events of the same session, and is null until the registry is read.
