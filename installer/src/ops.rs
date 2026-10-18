//! The edits that put Busyholm's entries into a hooks-shaped JSON document (Claude `settings.json`,
//! Codex `hooks.json`) and take exactly those entries out again.
//!
//! Ownership: every entry carries `--owner <tag>` in the shim's arguments (an `args` item pair for exec
//! form, a word pair in the command string for shell form). Disconnect finds entries by that tag, never by
//! position, never by "looks like busyholm-hook", and never by restoring an old copy of the file.

use crate::j::{canonical_json, Style, J};
use crate::span::{self, Arr, Doc, Edit, Node, Obj};
use crate::InstallError;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::Path;

/// One entry the install adds (or finds already added).
#[derive(Debug, Clone)]
pub struct OwnedDraft {
    pub event: Option<String>,
    pub pointer: String,
    /// SHA-256 of the canonical text of the value Busyholm inserted.
    pub sha256: String,
    pub replaced_sha256: Option<String>,
}

/// What an install pass wants changed, in the coordinates of the parsed document.
#[derive(Debug, Default)]
pub struct Changes {
    pub edits: Vec<Edit>,
    /// New top-level members, inserted together after the last one.
    pub root_new: Vec<(String, J)>,
    /// Top-level members to remove (indices).
    pub root_remove: BTreeSet<usize>,
    pub owned: Vec<OwnedDraft>,
    /// Entries already present and unchanged (an idempotent re-install).
    pub unchanged: usize,
    /// How many of our entries a removal pass found.
    pub removed: usize,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Does this handler / status line value carry our owner tag?
pub fn value_is_ours(v: &Value, tag: &str) -> bool {
    let pair = |words: &[&str]| words.windows(2).any(|w| w[0] == "--owner" && w[1] == tag);
    if let Some(args) = v.get("args").and_then(Value::as_array) {
        let words: Vec<&str> = args.iter().filter_map(Value::as_str).collect();
        if pair(&words) {
            return true;
        }
    }
    if let Some(cmd) = v.get("command").and_then(Value::as_str) {
        let words: Vec<&str> = cmd.split_whitespace().map(|w| w.trim_matches(|c| c == '\'' || c == '"' || c == ';')).collect();
        if pair(&words) {
            return true;
        }
    }
    false
}

fn node_value(src: &str, n: &Node) -> Option<Value> {
    serde_json::from_str(&src[n.start()..n.end()]).ok()
}

fn handler_is_ours(src: &str, n: &Node, tag: &str) -> bool {
    node_value(src, n).is_some_and(|v| value_is_ours(&v, tag))
}

/// Handlers (inside one matcher group) that are ours: `(group handlers array, indices)`.
fn group_handlers<'a>(group: &'a Node) -> Option<&'a Arr> {
    group.as_obj()?.last("hooks")?.1.value.as_arr()
}

fn group_has_ours(src: &str, group: &Node, tag: &str) -> bool {
    group_handlers(group).is_some_and(|h| h.items.iter().any(|n| handler_is_ours(src, n, tag)))
}

/// The state of the file before the install, as far as container creation is concerned.
pub enum Before<'a> {
    /// No backup to consult: never remove a container.
    Unknown,
    /// The file did not exist: every container was created by us.
    Missing,
    Doc(&'a str, &'a Doc),
}

impl Before<'_> {
    fn node_at(&self, path: &[&str]) -> Option<Option<&Node>> {
        // Some(None) = confirmed absent, None = cannot tell, Some(Some(n)) = present
        match self {
            Before::Unknown => None,
            Before::Missing => Some(None),
            Before::Doc(_, d) => {
                let mut obj: &Obj = &d.root;
                for (i, k) in path.iter().enumerate() {
                    match obj.last(k) {
                        None => return Some(None),
                        Some((_, m)) => {
                            if i + 1 == path.len() {
                                return Some(Some(&m.value));
                            }
                            match m.value.as_obj() {
                                Some(o) => obj = o,
                                None => return None,
                            }
                        }
                    }
                }
                None
            }
        }
    }

    /// Was the container at `path` created by the install? (false when unknown)
    fn created(&self, path: &[&str]) -> bool {
        matches!(self.node_at(path), Some(None))
    }

    /// The text inside the container at `path` if it was present and empty before the install.
    fn empty_interior(&self, path: &[&str]) -> Option<&str> {
        let Before::Doc(src, _) = self else { return None };
        let node = self.node_at(path)??;
        match node {
            Node::Obj(o) if o.members.is_empty() => {
                let (a, b) = o.interior();
                Some(&src[a..b])
            }
            Node::Arr(a) if a.items.is_empty() => {
                let (x, y) = a.interior();
                Some(&src[x..y])
            }
            _ => None,
        }
    }

    pub fn root_interior(&self) -> Option<&str> {
        let Before::Doc(src, d) = self else { return None };
        if d.root.members.is_empty() {
            let (a, b) = d.root.interior();
            Some(&src[a..b])
        } else {
            None
        }
    }
}

/// A duplicate key at a level we edit makes "the" `hooks` ambiguous (`JSON.parse` keeps the last, the earlier
/// one is shadowed), so we neither install into such a file nor remove from it: the caller refuses with this
/// message and the file stays as it is.
pub fn duplicate_keys(doc: &Doc, check_hooks: bool, check_status: bool, events: &[&str]) -> Option<String> {
    let count = |o: &Obj, k: &str| o.members.iter().filter(|m| m.key == k).count();
    let msg = |k: &str| format!("the file has a duplicate \"{k}\" key (more than one), so which one counts is ambiguous; remove the extra one by hand first");
    if check_hooks {
        if count(&doc.root, "hooks") > 1 {
            return Some(msg("hooks"));
        }
        if let Some(h) = doc.root.last("hooks").and_then(|(_, m)| m.value.as_obj()) {
            for ev in events {
                if count(h, ev) > 1 {
                    return Some(msg(ev));
                }
            }
        }
    }
    if check_status && count(&doc.root, "statusLine") > 1 {
        return Some(msg("statusLine"));
    }
    None
}

// ---------------------------------------------------------------------------------------------
// hooks: install
// ---------------------------------------------------------------------------------------------

fn canonical_hash(j: &J) -> String {
    sha256_hex(canonical_json(&j.to_value()).as_bytes())
}

/// Add one matcher group per event, once. `groups` are `(event, group)`.
pub fn install_hooks(src: &str, doc: &Doc, st: &Style, tag: &str, groups: &[(String, J)], path_for_errors: &Path) -> Result<Changes, InstallError> {
    let wrong = |detail: String| InstallError::WrongShape { path: path_for_errors.to_path_buf(), detail };
    let mut ch = Changes::default();
    let hooks_member = doc.root.last("hooks");
    let Some((_, hooks_member)) = hooks_member else {
        let obj = J::Obj(groups.iter().map(|(ev, g)| (ev.clone(), J::Arr(vec![g.clone()]))).collect());
        for (ev, g) in groups {
            ch.owned.push(OwnedDraft { event: Some(ev.clone()), pointer: format!("/hooks/{ev}/0"), sha256: canonical_hash(g), replaced_sha256: None });
        }
        ch.root_new.push(("hooks".to_string(), obj));
        return Ok(ch);
    };
    let Some(hooks) = hooks_member.value.as_obj() else {
        return Err(wrong("\"hooks\" is not an object".to_string()));
    };
    let mut new_members: Vec<(String, J)> = Vec::new();
    for (ev, group) in groups {
        let new_hash = canonical_hash(group);
        match hooks.last(ev) {
            None => {
                ch.owned.push(OwnedDraft { event: Some(ev.clone()), pointer: format!("/hooks/{ev}/0"), sha256: new_hash, replaced_sha256: None });
                new_members.push((ev.clone(), J::Arr(vec![group.clone()])));
            }
            Some((_, m)) => {
                let Some(arr) = m.value.as_arr() else {
                    return Err(wrong(format!("hooks.{ev} is not an array")));
                };
                // already ours?
                let found = arr.items.iter().enumerate().find(|(_, g)| group_has_ours(src, g, tag));
                match found {
                    Some((i, g)) => {
                        let existing = node_value(src, g).map(|v| sha256_hex(canonical_json(&v).as_bytes()));
                        let sole = group_handlers(g).is_some_and(|h| h.items.len() == 1);
                        if existing.as_deref() == Some(new_hash.as_str()) || !sole {
                            ch.unchanged += 1;
                            ch.owned.push(OwnedDraft { event: Some(ev.clone()), pointer: format!("/hooks/{ev}/{i}"), sha256: existing.unwrap_or(new_hash), replaced_sha256: None });
                        } else {
                            // our entry exists but differs (a new shim path, say): replace exactly that group
                            let text = match span::own_line_indent(src, g.start()) {
                                Some(ind) => group.render(st, ind),
                                None => group.render_inline(),
                            };
                            ch.edits.push(Edit { start: g.start(), end: g.end(), text });
                            ch.owned.push(OwnedDraft { event: Some(ev.clone()), pointer: format!("/hooks/{ev}/{i}"), sha256: new_hash, replaced_sha256: None });
                        }
                    }
                    None => {
                        ch.owned.push(OwnedDraft { event: Some(ev.clone()), pointer: format!("/hooks/{ev}/{}", arr.items.len()), sha256: new_hash, replaced_sha256: None });
                        ch.edits.push(span::append_items(src, arr, st, std::slice::from_ref(group)));
                    }
                }
            }
        }
    }
    if !new_members.is_empty() {
        ch.edits.push(span::insert_members(src, hooks, st, &new_members));
    }
    Ok(ch)
}

// ---------------------------------------------------------------------------------------------
// hooks: remove
// ---------------------------------------------------------------------------------------------

/// Remove every handler that carries `tag`, and the matcher groups, event arrays and `hooks` object that
/// this leaves empty AND that the install created.
pub fn remove_hooks(src: &str, doc: &Doc, tag: &str, before: &Before) -> Changes {
    let mut ch = Changes::default();
    let Some((hooks_idx, hooks_member)) = doc.root.last("hooks") else { return ch };
    let Some(hooks) = hooks_member.value.as_obj() else { return ch };

    let mut member_remove: BTreeSet<usize> = BTreeSet::new();
    let mut inner: Vec<Edit> = Vec::new();
    for (mi, m) in hooks.members.iter().enumerate() {
        let Some(arr) = m.value.as_arr() else { continue };
        let mut group_remove: BTreeSet<usize> = BTreeSet::new();
        let mut group_edits: Vec<Edit> = Vec::new();
        let mut removed_here = 0;
        for (gi, g) in arr.items.iter().enumerate() {
            let Some(handlers) = group_handlers(g) else { continue };
            let ours: BTreeSet<usize> = handlers.items.iter().enumerate().filter(|(_, h)| handler_is_ours(src, h, tag)).map(|(i, _)| i).collect();
            if ours.is_empty() {
                continue;
            }
            removed_here += ours.len();
            if ours.len() == handlers.items.len() {
                group_remove.insert(gi);
            } else {
                group_edits.extend(span::remove_spans(&span::item_spans(handlers), &ours, handlers.interior(), None));
            }
        }
        if removed_here == 0 {
            continue;
        }
        ch.removed += removed_here;
        if group_remove.len() == arr.items.len() && before.created(&["hooks", &m.key]) {
            member_remove.insert(mi);
            continue;
        }
        let restore = if group_remove.len() == arr.items.len() { before.empty_interior(&["hooks", &m.key]) } else { None };
        inner.extend(span::remove_spans(&span::item_spans(arr), &group_remove, arr.interior(), restore));
        inner.extend(group_edits);
    }
    if ch.removed == 0 {
        return ch;
    }
    if !member_remove.is_empty() && member_remove.len() == hooks.members.len() {
        // everything inside `hooks` was ours and we created `hooks` (or it stays as an empty object)
        if before.created(&["hooks"]) {
            ch.root_remove.insert(hooks_idx);
            return ch;
        }
        let restore = before.empty_interior(&["hooks"]);
        ch.edits.extend(span::remove_spans(&span::member_spans(hooks), &member_remove, hooks.interior(), restore));
        return ch;
    }
    if !member_remove.is_empty() {
        ch.edits.extend(span::remove_spans(&span::member_spans(hooks), &member_remove, hooks.interior(), None));
    }
    ch.edits.extend(inner);
    ch
}

// ---------------------------------------------------------------------------------------------
// status line
// ---------------------------------------------------------------------------------------------

pub struct StatusInstall {
    pub changes: Changes,
    /// The exact text of the prior value, when there was one (to be saved as `<sha>.bak`).
    pub replaced_text: Option<String>,
}

/// Wrap the status line. `make_command(replaced)` builds the shim command line; `replaced` is `(sha, command)`
/// of the prior value's exact text and command string, or `None` when there was none.
pub fn install_statusline(src: &str, doc: &Doc, st: &Style, tag: &str, make_command: &dyn Fn(Option<(&str, &str)>) -> String, path_for_errors: &Path) -> Result<StatusInstall, InstallError> {
    let unsupported = |detail: &str| InstallError::StatusLineUnsupported { path: path_for_errors.to_path_buf(), detail: detail.to_string() };
    let mut ch = Changes::default();
    let Some((idx, member)) = doc.root.last("statusLine") else {
        let value = J::Obj(vec![("type".into(), J::Str("command".into())), ("command".into(), J::Str(make_command(None)))]);
        ch.owned.push(OwnedDraft { event: None, pointer: "/statusLine".into(), sha256: canonical_hash(&value), replaced_sha256: None });
        ch.root_new.push(("statusLine".to_string(), value));
        return Ok(StatusInstall { changes: ch, replaced_text: None });
    };
    let _ = idx;
    let text = &src[member.value.start()..member.value.end()];
    let current: Value = serde_json::from_str(text).map_err(|_| unsupported("the current statusLine is not readable JSON"))?;
    if value_is_ours(&current, tag) {
        ch.unchanged += 1;
        ch.owned.push(OwnedDraft { event: None, pointer: "/statusLine".into(), sha256: sha256_hex(canonical_json(&current).as_bytes()), replaced_sha256: None });
        return Ok(StatusInstall { changes: ch, replaced_text: None });
    }
    let obj = member.value.as_obj().ok_or_else(|| unsupported("the current statusLine is not an object"))?;
    let kind = current.get("type").and_then(Value::as_str);
    let command = current.get("command").and_then(Value::as_str).unwrap_or("");
    if kind != Some("command") || command.trim().is_empty() {
        return Err(unsupported("only a statusLine of type \"command\" with a command can be wrapped without losing it"));
    }
    let replaced_sha = sha256_hex(text.as_bytes());
    let new_command = make_command(Some((&replaced_sha, command)));
    // keep every other key of the user's status line (padding, refreshInterval, ...) exactly as written
    let value = J::Obj(
        obj.members
            .iter()
            .map(|m| {
                if m.key == "command" {
                    (m.key.clone(), J::Str(new_command.clone()))
                } else {
                    (m.key.clone(), J::Raw(src[m.value.start()..m.value.end()].to_string()))
                }
            })
            .collect(),
    );
    let rendered = match span::own_line_indent(src, member.key_start) {
        Some(ind) => value.render(st, ind),
        None => value.render_inline(),
    };
    ch.edits.push(Edit { start: member.value.start(), end: member.value.end(), text: rendered });
    ch.owned.push(OwnedDraft { event: None, pointer: "/statusLine".into(), sha256: canonical_hash(&value), replaced_sha256: Some(replaced_sha) });
    Ok(StatusInstall { changes: ch, replaced_text: Some(text.to_string()) })
}

/// Take our status line out. `replaced` is the exact text of the value it replaced, if any; `owned_sha` is the hash
/// of the value we wrote. If the value is still exactly what we wrote, the old one goes back byte for byte. If
/// someone edited it since (a changed `refreshInterval`, say), only the `command` goes back and their edit stays.
pub fn remove_statusline(src: &str, doc: &Doc, tag: &str, replaced: Option<&str>, owned_sha: Option<&str>) -> Changes {
    let mut ch = Changes::default();
    let Some((idx, member)) = doc.root.last("statusLine") else { return ch };
    let current = node_value(src, &member.value);
    if !current.as_ref().is_some_and(|v| value_is_ours(v, tag)) {
        return ch;
    }
    ch.removed = 1;
    let Some(text) = replaced else {
        ch.root_remove.insert(idx);
        return ch;
    };
    let unchanged = owned_sha.is_none() || current.as_ref().is_some_and(|v| Some(sha256_hex(canonical_json(v).as_bytes()).as_str()) == owned_sha);
    if !unchanged {
        let old_cmd = serde_json::from_str::<Value>(text).ok().and_then(|v| v.get("command").and_then(Value::as_str).map(str::to_string));
        let cmd_member = member.value.as_obj().and_then(|o| o.last("command"));
        if let (Some(cmd), Some((_, m))) = (old_cmd, cmd_member) {
            ch.edits.push(Edit { start: m.value.start(), end: m.value.end(), text: crate::j::quote(&cmd) });
            return ch;
        }
    }
    ch.edits.push(Edit { start: member.value.start(), end: member.value.end(), text: text.to_string() });
    ch
}
