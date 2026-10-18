//! The preview: a unified diff built from the exact edits that will be applied, so what is shown is
//! what is written. Hunks are derived from the edits (not from a generic line diff), so a 10 MiB file
//! with a few small edits previews instantly.

use crate::span::Edit;

fn line_starts(s: &str) -> Vec<usize> {
    let mut v = vec![0];
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            v.push(i + 1);
        }
    }
    v
}

/// Index of the line containing byte `pos`.
fn line_of(starts: &[usize], pos: usize) -> usize {
    match starts.binary_search(&pos) {
        Ok(i) => i,
        Err(i) => i - 1,
    }
}

/// Lines `from..=to` (clamped), without line ends; a phantom empty last line is skipped.
fn lines_of<'a>(s: &'a str, starts: &[usize], from: usize, to: usize) -> Vec<&'a str> {
    let mut out = Vec::new();
    if starts.is_empty() {
        return out;
    }
    for l in from..=to.min(starts.len() - 1) {
        let a = starts[l];
        if a >= s.len() && !(l == 0 && s.is_empty()) {
            continue;
        }
        let b = if l + 1 < starts.len() { starts[l + 1] } else { s.len() };
        out.push(s[a..b].trim_end_matches('\n').trim_end_matches('\r'));
    }
    out
}

struct Hunk {
    old_from: usize,
    old_to: usize,
    new_from: usize,
    new_to: usize,
}

const CTX: usize = 2;

/// `edits` are in `old` coordinates and sorted; `new` is `old` with them applied.
pub fn unified(label: &str, old: &str, new: &str, edits: &[Edit]) -> String {
    if edits.is_empty() {
        return String::new();
    }
    let (os, ns) = (line_starts(old), line_starts(new));
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut delta: isize = 0;
    for e in edits {
        let new_start = (e.start as isize + delta) as usize;
        let new_end = new_start + e.text.len();
        let h = Hunk { old_from: line_of(&os, e.start), old_to: line_of(&os, e.end), new_from: line_of(&ns, new_start), new_to: line_of(&ns, new_end) };
        delta += e.text.len() as isize - (e.end - e.start) as isize;
        match hunks.last_mut() {
            Some(prev) if h.old_from <= prev.old_to + 1 => {
                prev.old_to = prev.old_to.max(h.old_to);
                prev.new_to = prev.new_to.max(h.new_to);
            }
            _ => hunks.push(h),
        }
    }

    let mut groups: Vec<Vec<&Hunk>> = Vec::new();
    for h in &hunks {
        match groups.last_mut() {
            Some(g) if h.old_from <= g[g.len() - 1].old_to + 2 * CTX + 1 => g.push(h),
            _ => groups.push(vec![h]),
        }
    }
    let mut out = format!("--- {label}\n+++ {label}\n");
    for g in groups {
        let (first, last) = (g[0], g[g.len() - 1]);
        let ctx_from = first.old_from.saturating_sub(CTX);
        let ctx_to = last.old_to + CTX;
        let new_ctx_from = first.new_from.saturating_sub(first.old_from - ctx_from);
        let mut body = String::new();
        let (mut old_n, mut new_n) = (0usize, 0usize);
        let mut cursor = ctx_from;
        let context = |body: &mut String, from: usize, to: usize, old_n: &mut usize, new_n: &mut usize| {
            for l in lines_of(old, &os, from, to) {
                body.push_str(&format!(" {l}\n"));
                *old_n += 1;
                *new_n += 1;
            }
        };
        for h in &g {
            if h.old_from > cursor {
                context(&mut body, cursor, h.old_from - 1, &mut old_n, &mut new_n);
            }
            let (a, b) = (lines_of(old, &os, h.old_from, h.old_to), lines_of(new, &ns, h.new_from, h.new_to));
            for (op, l) in line_diff(&a, &b) {
                body.push_str(&format!("{op}{l}\n"));
                match op {
                    ' ' => {
                        old_n += 1;
                        new_n += 1;
                    }
                    '-' => old_n += 1,
                    _ => new_n += 1,
                }
            }
            cursor = h.old_to + 1;
        }
        context(&mut body, cursor, ctx_to, &mut old_n, &mut new_n);
        out.push_str(&format!("@@ -{},{} +{},{} @@\n{body}", ctx_from + 1, old_n, new_ctx_from + 1, new_n));
    }
    out
}

/// Lines of a hunk as context / removed / added, by longest common subsequence (hunks are small; a huge one
/// falls back to "all removed, all added").
fn line_diff<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(char, &'a str)> {
    if a.len().saturating_mul(b.len()) > 4_000_000 {
        return a.iter().map(|l| ('-', *l)).chain(b.iter().map(|l| ('+', *l))).collect();
    }
    let (n, m) = (a.len(), b.len());
    let mut t = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            t[i][j] = if a[i] == b[j] { t[i + 1][j + 1] + 1 } else { t[i + 1][j].max(t[i][j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    while i < n && j < m {
        if a[i] == b[j] {
            out.push((' ', a[i]));
            i += 1;
            j += 1;
        } else if t[i + 1][j] >= t[i][j + 1] {
            out.push(('-', a[i]));
            i += 1;
        } else {
            out.push(('+', b[j]));
            j += 1;
        }
    }
    out.extend(a[i..].iter().map(|l| ('-', *l)));
    out.extend(b[j..].iter().map(|l| ('+', *l)));
    out
}

/// A whole-file diff: a file created, deleted or replaced wholesale.
pub fn whole(label: &str, old: Option<&str>, new: Option<&str>) -> String {
    let mut out = String::new();
    match (old, new) {
        (None, Some(n)) => {
            let ls: Vec<&str> = n.lines().collect();
            out.push_str(&format!("--- /dev/null\n+++ {label}\n@@ -0,0 +1,{} @@\n", ls.len()));
            for l in ls {
                out.push_str(&format!("+{l}\n"));
            }
        }
        (Some(o), None) => {
            let ls: Vec<&str> = o.lines().collect();
            out.push_str(&format!("--- {label}\n+++ /dev/null\n@@ -1,{} +0,0 @@\n", ls.len()));
            for l in ls {
                out.push_str(&format!("-{l}\n"));
            }
        }
        (Some(o), Some(n)) => {
            out.push_str(&format!("--- {label}\n+++ {label}\n@@ whole file replaced @@\n"));
            for l in o.lines() {
                out.push_str(&format!("-{l}\n"));
            }
            for l in n.lines() {
                out.push_str(&format!("+{l}\n"));
            }
        }
        _ => {}
    }
    out
}
