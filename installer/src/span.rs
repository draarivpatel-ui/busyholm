//! A targeted JSON span editor.
//!
//! The file is parsed ONCE, strictly (`serde_json`), to prove it is valid JSON. A second, offset-tracking
//! scan then records where every object member and array item starts and ends. Edits are expressed as
//! byte-range replacements of the original text, so every byte outside the edited spans stays exactly as it
//! was: key order, indentation, line endings, BOM, odd spacing. Nothing is re-serialised.

use crate::j::{quote, Style, J};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

#[derive(Debug, Clone)]
pub enum Node {
    Obj(Obj),
    Arr(Arr),
    Scalar { start: usize, end: usize },
}

#[derive(Debug, Clone)]
pub struct Obj {
    pub start: usize,
    pub end: usize,
    pub members: Vec<Member>,
}

#[derive(Debug, Clone)]
pub struct Member {
    pub key: String,
    pub key_start: usize,
    pub value: Node,
}

#[derive(Debug, Clone)]
pub struct Arr {
    pub start: usize,
    pub end: usize,
    pub items: Vec<Node>,
}

impl Node {
    pub fn start(&self) -> usize {
        match self {
            Node::Obj(o) => o.start,
            Node::Arr(a) => a.start,
            Node::Scalar { start, .. } => *start,
        }
    }
    pub fn end(&self) -> usize {
        match self {
            Node::Obj(o) => o.end,
            Node::Arr(a) => a.end,
            Node::Scalar { end, .. } => *end,
        }
    }
    pub fn as_obj(&self) -> Option<&Obj> {
        if let Node::Obj(o) = self { Some(o) } else { None }
    }
    pub fn as_arr(&self) -> Option<&Arr> {
        if let Node::Arr(a) = self { Some(a) } else { None }
    }
}

impl Obj {
    /// The last member with this key (what `JSON.parse` keeps), with its index.
    pub fn last(&self, key: &str) -> Option<(usize, &Member)> {
        self.members.iter().enumerate().rev().find(|(_, m)| m.key == key)
    }
    pub fn interior(&self) -> (usize, usize) {
        (self.start + 1, self.end - 1)
    }
}
impl Arr {
    pub fn interior(&self) -> (usize, usize) {
        (self.start + 1, self.end - 1)
    }
}

#[derive(Debug)]
pub enum SpanError {
    /// Not strict JSON (comments, trailing commas, truncation, ...).
    Invalid(String),
    /// Valid JSON whose top level is not an object.
    NotObject,
}

#[derive(Debug)]
pub enum Parsed {
    /// Zero bytes or only whitespace (after an optional BOM): nothing of the user's is in the file.
    Empty { bom: usize },
    Doc(Doc),
}

#[derive(Debug)]
pub struct Doc {
    pub bom: usize,
    pub root: Obj,
}

pub fn parse(src: &str) -> Result<Parsed, SpanError> {
    let bom = if src.starts_with('\u{feff}') { 3 } else { 0 };
    let body = &src[bom..];
    if body.trim_matches(|c| c == ' ' || c == '\t' || c == '\r' || c == '\n').is_empty() {
        return Ok(Parsed::Empty { bom });
    }
    // The same parser the removal checks use: a file it cannot read (lone surrogates, numbers out of range,
    // nesting over its limit) is refused up front, never installed into and then stuck.
    serde_json::from_str::<serde_json::Value>(body).map_err(|e| SpanError::Invalid(e.to_string()))?;
    let b = src.as_bytes();
    let mut i = skip_ws(b, bom);
    if b.get(i) != Some(&b'{') {
        return Err(SpanError::NotObject);
    }
    let (node, _) = scan_value(src, b, &mut i).map_err(SpanError::Invalid)?;
    match node {
        Node::Obj(root) => Ok(Parsed::Doc(Doc { bom, root })),
        _ => Err(SpanError::NotObject),
    }
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    i
}

fn scan_string(b: &[u8], mut i: usize) -> Result<usize, String> {
    // b[i] == '"'
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err("unterminated string".into())
}

/// Scan one value starting at `*pos` (whitespace already skipped); leaves `*pos` just after it.
fn scan_value(src: &str, b: &[u8], pos: &mut usize) -> Result<(Node, usize), String> {
    let start = *pos;
    match b.get(start) {
        Some(b'{') => {
            let mut members = Vec::new();
            let mut i = skip_ws(b, start + 1);
            if b.get(i) == Some(&b'}') {
                *pos = i + 1;
                return Ok((Node::Obj(Obj { start, end: i + 1, members }), i + 1));
            }
            loop {
                if b.get(i) != Some(&b'"') {
                    return Err("object key expected".into());
                }
                let key_start = i;
                let key_end = scan_string(b, i)?;
                let key: String = serde_json::from_str(&src[key_start..key_end]).map_err(|e| e.to_string())?;
                i = skip_ws(b, key_end);
                if b.get(i) != Some(&b':') {
                    return Err("colon expected".into());
                }
                i = skip_ws(b, i + 1);
                let mut p = i;
                let (value, _) = scan_value(src, b, &mut p)?;
                i = skip_ws(b, p);
                members.push(Member { key, key_start, value });
                match b.get(i) {
                    Some(b',') => i = skip_ws(b, i + 1),
                    Some(b'}') => {
                        *pos = i + 1;
                        return Ok((Node::Obj(Obj { start, end: i + 1, members }), i + 1));
                    }
                    _ => return Err("comma or brace expected".into()),
                }
            }
        }
        Some(b'[') => {
            let mut items = Vec::new();
            let mut i = skip_ws(b, start + 1);
            if b.get(i) == Some(&b']') {
                *pos = i + 1;
                return Ok((Node::Arr(Arr { start, end: i + 1, items }), i + 1));
            }
            loop {
                let mut p = i;
                let (value, _) = scan_value(src, b, &mut p)?;
                items.push(value);
                i = skip_ws(b, p);
                match b.get(i) {
                    Some(b',') => i = skip_ws(b, i + 1),
                    Some(b']') => {
                        *pos = i + 1;
                        return Ok((Node::Arr(Arr { start, end: i + 1, items }), i + 1));
                    }
                    _ => return Err("comma or bracket expected".into()),
                }
            }
        }
        Some(b'"') => {
            let end = scan_string(b, start)?;
            *pos = end;
            Ok((Node::Scalar { start, end }, end))
        }
        Some(_) => {
            let mut i = start;
            while i < b.len() && !matches!(b[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                i += 1;
            }
            if i == start {
                return Err("value expected".into());
            }
            *pos = i;
            Ok((Node::Scalar { start, end: i }, i))
        }
        None => Err("value expected".into()),
    }
}

// ---------------------------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------------------------

/// The whitespace at the start of the line containing `pos`.
pub fn line_indent(src: &str, pos: usize) -> &str {
    let line_start = src[..pos].rfind('\n').map_or(0, |i| i + 1);
    let rest = &src[line_start..];
    let n = rest.bytes().take_while(|&c| c == b' ' || c == b'\t').count();
    &rest[..n]
}

/// The indent of the line holding `pos` if nothing but whitespace precedes `pos` on it.
pub fn own_line_indent(src: &str, pos: usize) -> Option<&str> {
    let line_start = src[..pos].rfind('\n').map_or(0, |i| i + 1);
    let lead = &src[line_start..pos];
    if lead.bytes().all(|c| c == b' ' || c == b'\t') && line_start > 0 {
        Some(lead)
    } else {
        None
    }
}

pub fn detect_style(src: &str, root: Option<&Obj>) -> Style {
    let compact = !src.contains('\n');
    let nl = match src.find('\n') {
        Some(i) if i > 0 && src.as_bytes()[i - 1] == b'\r' => "\r\n",
        _ => "\n",
    };
    let mut unit = "  ".to_string();
    if let Some(root) = root {
        for m in &root.members {
            if let Some(ind) = own_line_indent(src, m.key_start) {
                if !ind.is_empty() {
                    unit = ind.to_string();
                    break;
                }
            }
        }
    }
    Style { nl, unit, compact }
}

// ---------------------------------------------------------------------------------------------
// edits
// ---------------------------------------------------------------------------------------------

/// Append members to an object (after its last member, or into an empty object).
pub fn insert_members(src: &str, obj: &Obj, st: &Style, members: &[(String, J)]) -> Edit {
    let (open_end, close) = obj.interior();
    if st.compact {
        let text = members.iter().map(|(k, v)| format!("{}:{}", quote(k), v.render_min())).collect::<Vec<_>>().join(",");
        return match obj.members.last() {
            Some(l) => Edit { start: l.value.end(), end: l.value.end(), text: format!(",{text}") },
            None => Edit { start: open_end, end: close, text },
        };
    }
    match obj.members.last() {
        Some(last) => {
            let at = last.value.end();
            if let Some(ind) = own_line_indent(src, last.key_start) {
                let text: String = members.iter().map(|(k, v)| format!(",{}{ind}{}: {}", st.nl, quote(k), v.render(st, ind))).collect();
                Edit { start: at, end: at, text }
            } else {
                let text: String = members.iter().map(|(k, v)| format!(", {}: {}", quote(k), v.render_inline())).collect();
                Edit { start: at, end: at, text }
            }
        }
        None => {
            let parent = line_indent(src, obj.start);
            let child = format!("{parent}{}", st.unit);
            let body = members.iter().map(|(k, v)| format!("{child}{}: {}", quote(k), v.render(st, &child))).collect::<Vec<_>>().join(&format!(",{}", st.nl));
            Edit { start: open_end, end: close, text: format!("{nl}{body}{nl}{parent}", nl = st.nl) }
        }
    }
}

/// Append items to an array.
pub fn append_items(src: &str, arr: &Arr, st: &Style, items: &[J]) -> Edit {
    let (open_end, close) = arr.interior();
    if st.compact {
        let text = items.iter().map(J::render_min).collect::<Vec<_>>().join(",");
        return match arr.items.last() {
            Some(l) => Edit { start: l.end(), end: l.end(), text: format!(",{text}") },
            None => Edit { start: open_end, end: close, text },
        };
    }
    match arr.items.last() {
        Some(last) => {
            let at = last.end();
            if let Some(ind) = own_line_indent(src, last.start()) {
                let text: String = items.iter().map(|v| format!(",{}{ind}{}", st.nl, v.render(st, ind))).collect();
                Edit { start: at, end: at, text }
            } else {
                let text: String = items.iter().map(|v| format!(", {}", v.render_inline())).collect();
                Edit { start: at, end: at, text }
            }
        }
        None => {
            let parent = line_indent(src, arr.start);
            let child = format!("{parent}{}", st.unit);
            let body = items.iter().map(|v| format!("{child}{}", v.render(st, &child))).collect::<Vec<_>>().join(&format!(",{}", st.nl));
            Edit { start: open_end, end: close, text: format!("{nl}{body}{nl}{parent}", nl = st.nl) }
        }
    }
}

/// Remove the elements at `remove` (indices into `spans`, each `(start, end)` of one element).
/// `interior` is the container's inside; when every element goes, it is replaced by `restore` (default empty).
/// The comma and whitespace that joined a removed element to its neighbour go with it, which is exactly
/// the inverse of `insert_members` / `append_items`.
pub fn remove_spans(spans: &[(usize, usize)], remove: &BTreeSet<usize>, interior: (usize, usize), restore: Option<&str>) -> Vec<Edit> {
    if remove.is_empty() {
        return Vec::new();
    }
    if remove.len() == spans.len() {
        return vec![Edit { start: interior.0, end: interior.1, text: restore.unwrap_or("").to_string() }];
    }
    let first_kept = (0..spans.len()).find(|i| !remove.contains(i)).expect("at least one kept");
    let mut edits = Vec::new();
    for &i in remove {
        if i > first_kept {
            edits.push(Edit { start: spans[i - 1].1, end: spans[i].1, text: String::new() });
        } else {
            edits.push(Edit { start: spans[i].0, end: spans[i + 1].0, text: String::new() });
        }
    }
    edits
}

pub fn member_spans(o: &Obj) -> Vec<(usize, usize)> {
    o.members.iter().map(|m| (m.key_start, m.value.end())).collect()
}

pub fn item_spans(a: &Arr) -> Vec<(usize, usize)> {
    a.items.iter().map(|n| (n.start(), n.end())).collect()
}

/// Apply sorted, non-overlapping edits.
pub fn apply(src: &str, edits: &[Edit]) -> String {
    let mut out = String::with_capacity(src.len() + edits.iter().map(|e| e.text.len()).sum::<usize>());
    let mut at = 0;
    for e in edits {
        assert!(e.start >= at && e.end >= e.start && e.end <= src.len(), "edits must be sorted, disjoint and in range");
        out.push_str(&src[at..e.start]);
        out.push_str(&e.text);
        at = e.end;
    }
    out.push_str(&src[at..]);
    out
}

pub fn sort_and_check(edits: &mut [Edit]) -> Result<(), String> {
    edits.sort_by_key(|e| (e.start, e.end));
    for w in edits.windows(2) {
        if w[1].start < w[0].end {
            return Err("overlapping edits".into());
        }
    }
    Ok(())
}
