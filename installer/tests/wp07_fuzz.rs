//! Generated documents: random shapes, random formatting, random pre-existing hooks. For each one the
//! invariants of WP-07 must hold; this catches span-editor bugs that hand-written fixtures miss.
//! The generator is a fixed-seed xorshift, so a failure reproduces exactly.

mod common;

use busyholm_contracts::install_manifest::InstallTarget;
use busyholm_installer::Component;
use common::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

#[derive(Clone)]
struct Fmt {
    unit: String,
    nl: &'static str,
    compact: bool,
    space_after_colon: bool,
}

fn scalar(r: &mut Rng) -> String {
    match r.below(7) {
        0 => "true".into(),
        1 => "null".into(),
        2 => format!("{}", r.below(1000)),
        3 => "-1.5e3".into(),
        4 => format!("\"s{}\"", r.below(100)),
        5 => "\"{ \\\"hooks\\\": [ ] } // not a comment\"".into(),
        _ => "\"caf\\u00e9 \u{2603}\"".into(),
    }
}

fn gen_value(r: &mut Rng, f: &Fmt, depth: usize, indent: &str) -> String {
    if depth == 0 || r.chance(55) {
        return scalar(r);
    }
    let inner = format!("{indent}{}", f.unit);
    if r.chance(50) {
        let n = r.below(4) as usize;
        if n == 0 {
            return if r.chance(50) { "{}".into() } else { format!("{{{}{indent}}}", f.nl) };
        }
        let items: Vec<String> = (0..n).map(|i| format!("\"k{i}\"{}{}", if f.space_after_colon { ": " } else { ":" }, gen_value(r, f, depth - 1, &inner))).collect();
        join(items, f, indent, '{', '}')
    } else {
        let n = r.below(4) as usize;
        if n == 0 {
            return "[]".into();
        }
        let items: Vec<String> = (0..n).map(|_| gen_value(r, f, depth - 1, &inner)).collect();
        join(items, f, indent, '[', ']')
    }
}

fn join(items: Vec<String>, f: &Fmt, indent: &str, open: char, close: char) -> String {
    if f.compact {
        return format!("{open}{}{close}", items.join(","));
    }
    let inner = format!("{indent}{}", f.unit);
    let body = items.iter().map(|i| format!("{inner}{i}")).collect::<Vec<_>>().join(&format!(",{}", f.nl));
    format!("{open}{nl}{body}{nl}{indent}{close}", nl = f.nl)
}

fn handler(r: &mut Rng) -> String {
    let kind = r.below(3);
    match kind {
        0 => format!("{{\"type\":\"command\",\"command\":\"/usr/bin/user-hook-{}.sh\",\"timeout\":{}}}", r.below(50), r.below(9) + 1),
        1 => "{\"type\":\"command\",\"command\":\"${CLAUDE_PLUGIN_ROOT}/hooks/x.sh\",\"async\":true}".into(),
        _ => "{\"type\":\"http\",\"url\":\"http://localhost:9/x\"}".into(),
    }
}

fn gen_doc(r: &mut Rng) -> Vec<u8> {
    let f = Fmt {
        unit: match r.below(3) { 0 => "  ".into(), 1 => "    ".into(), _ => "\t".into() },
        nl: if r.chance(25) { "\r\n" } else { "\n" },
        compact: r.chance(15),
        space_after_colon: r.chance(80),
    };
    let colon = if f.space_after_colon { ": " } else { ":" };
    let mut members: Vec<String> = Vec::new();
    for i in 0..r.below(4) {
        members.push(format!("\"setting{i}\"{colon}{}", gen_value(r, &f, 3, &f.unit)));
    }
    if r.chance(50) {
        // a hooks object with some of our event names and some foreign ones
        let mut events: Vec<String> = Vec::new();
        for ev in ["Stop", "SessionStart", "PermissionRequest", "PreToolUse", "Elicitation", "Notification"] {
            if r.chance(40) {
                let n = r.below(3) as usize;
                let groups: Vec<String> = (0..n)
                    .map(|_| {
                        let hs: Vec<String> = (0..(r.below(2) + 1)).map(|_| handler(r)).collect();
                        let matcher = if r.chance(40) { "\"matcher\":\"Bash\"," } else { "" };
                        format!("{{{matcher}\"hooks\":[{}]}}", hs.join(","))
                    })
                    .collect();
                let arr = if groups.is_empty() { "[]".to_string() } else { join(groups, &f, &format!("{0}{0}", f.unit), '[', ']') };
                events.push(format!("\"{ev}\"{colon}{arr}"));
            }
        }
        let hooks = if events.is_empty() {
            if r.chance(50) { "{}".to_string() } else { format!("{{{}}}", f.nl) }
        } else {
            join(events, &f, &f.unit, '{', '}')
        };
        let pos = r.below(members.len() as u64 + 1) as usize;
        members.insert(pos, format!("\"hooks\"{colon}{hooks}"));
    }
    if r.chance(25) {
        let pos = r.below(members.len() as u64 + 1) as usize;
        members.insert(pos, format!("\"statusLine\"{colon}{{\"type\":\"command\",\"command\":\"~/s{}.sh\"{}}}", r.below(9), if r.chance(50) { ",\"padding\":1" } else { "" }));
    }
    let body = if members.is_empty() {
        if r.chance(50) { "{}".to_string() } else { format!("{{{}}}", f.nl) }
    } else {
        join(members, &f, "", '{', '}')
    };
    let mut s = String::new();
    if r.chance(15) {
        s.push_str(&format!("{}{}", f.nl, f.nl));
    }
    s.push_str(&body);
    if r.chance(70) {
        s.push_str(f.nl);
    }
    let mut bytes = s.into_bytes();
    if r.chance(10) {
        let mut b = BOM.to_vec();
        b.extend(bytes);
        bytes = b;
    }
    bytes
}

#[test]
fn generated_documents_obey_every_wp07_invariant() {
    let mut r = Rng(0x9E3779B97F4A7C15);
    for case in 0..500 {
        let original = gen_doc(&mut r);
        let ctx = format!("case {case}:\n{}", String::from_utf8_lossy(&original));
        let sb = sandbox();
        sb.write_settings(&original);
        let with_status = r.chance(40);
        let comps: Vec<Component> = if with_status { vec![Component::ClaudeHooks, Component::ClaudeStatusline] } else { vec![Component::ClaudeHooks] };
        let inst = sb.installer();
        let plan = match inst.plan_install(&comps, &sb.sources) {
            Ok(p) => p,
            Err(e) => panic!("{ctx}\nplan failed: {e}"),
        };
        let fp = file_plan(&plan, InstallTarget::ClaudeHooks);
        assert_edits_inside_target_span(fp, &original);
        inst.apply(&plan).unwrap_or_else(|e| panic!("{ctx}\napply failed: {e}"));
        let after = sb.read_settings();
        let (vb, va) = (parse(&original), parse(&after));
        let tag = tag_of(&sb);
        assert_eq!(count_ours(&va, &tag), 13, "{ctx}");
        for (k, v) in vb.as_object().unwrap().iter().filter(|(k, _)| *k != "hooks" && !(with_status && *k == "statusLine")) {
            assert_eq!(&va[k], v, "{ctx}\nkey {k}");
        }
        assert_eq!(after.starts_with(BOM), original.starts_with(BOM), "{ctx}");
        assert!(inst.plan_install(&comps, &sb.sources).unwrap().is_noop(), "{ctx}\nsecond install must be a no-op");
        sb.disconnect(&[]);
        assert_eq!(sha(&sb.read_settings()), sha(&original), "{ctx}\nresult after install:\n{}\nafter disconnect:\n{}", String::from_utf8_lossy(&after), String::from_utf8_lossy(&sb.read_settings()));
    }
}
