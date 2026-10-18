//! Hand-written building blocks for semantic validation: numeric ranges, string
//! lengths and patterns, item counts, uniqueness and JSON Pointer paths.
//!
//! Every pattern mirrors the `pattern` keyword of the JSON Schemas exactly (the
//! schemas use ECMAScript regular expressions); no regex engine is involved.

use crate::validate::ContractError;

/// Result of one check.
pub type Check = Result<(), ContractError>;

/// Earliest valid millisecond timestamp (2000-01-01T00:00:00Z).
pub const MS_MIN: u64 = 946_684_800_000;
/// Latest valid millisecond timestamp (2100-01-01T00:00:00Z).
pub const MS_MAX: u64 = 4_102_444_800_000;

/// Builds a [`ContractError`].
pub fn fail(path: &str, message: impl Into<String>) -> ContractError {
    ContractError { path: path.to_string(), message: message.into() }
}

/// Appends an object key to a JSON Pointer (escaping `~` and `/`).
pub fn child(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// Appends an array index to a JSON Pointer.
pub fn at(path: &str, index: usize) -> String {
    format!("{path}/{index}")
}

/// Fails with `message` at `path` unless `ok`.
pub fn ensure(ok: bool, path: &str, message: impl Into<String>) -> Check {
    if ok {
        Ok(())
    } else {
        Err(fail(path, message))
    }
}

/// A millisecond timestamp in the 2000-01-01 to 2100-01-01 range.
pub fn ms(path: &str, v: u64) -> Check {
    ensure(
        (MS_MIN..=MS_MAX).contains(&v),
        path,
        format!("must be milliseconds between {MS_MIN} and {MS_MAX}, got {v}"),
    )
}

/// An optional millisecond timestamp.
pub fn opt_ms(path: &str, v: Option<u64>) -> Check {
    v.map_or(Ok(()), |v| ms(path, v))
}

/// An integer within `min..=max`.
pub fn int_range(path: &str, v: u64, min: u64, max: u64) -> Check {
    ensure(
        (min..=max).contains(&v),
        path,
        format!("must be an integer from {min} to {max}, got {v}"),
    )
}

/// A number within `min..=max` (both inclusive).
pub fn num_range(path: &str, v: f64, min: f64, max: f64) -> Check {
    ensure(
        v >= min && v <= max,
        path,
        format!("must be a number from {min} to {max}, got {v}"),
    )
}

/// A number with `exclusiveMinimum` `min_excl` and `maximum` `max`.
pub fn num_pos_max(path: &str, v: f64, min_excl: f64, max: f64) -> Check {
    ensure(
        v > min_excl && v <= max,
        path,
        format!("must be a number greater than {min_excl} and at most {max}, got {v}"),
    )
}

/// String length in Unicode code points within `min..=max`.
pub fn chars(path: &str, s: &str, min: usize, max: usize) -> Check {
    let n = s.chars().count();
    ensure(
        (min..=max).contains(&n),
        path,
        format!("length must be {min} to {max} characters, got {n}"),
    )
}

/// Array length at most `max`.
pub fn max_items(path: &str, len: usize, max: usize) -> Check {
    ensure(len <= max, path, format!("must have at most {max} items, got {len}"))
}

/// Array length within `min..=max`.
pub fn items_range(path: &str, len: usize, min: usize, max: usize) -> Check {
    ensure(
        (min..=max).contains(&len),
        path,
        format!("must have {min} to {max} items, got {len}"),
    )
}

/// `uniqueItems`: no two items are equal.
pub fn unique_items<T: PartialEq>(path: &str, items: &[T]) -> Check {
    for (j, b) in items.iter().enumerate() {
        if items[..j].contains(b) {
            return Err(fail(&at(path, j), "duplicate item in a list that must be unique"));
        }
    }
    Ok(())
}

/// The custom `x-unique-by` keyword: the key built by `key` must be unique across `items`.
pub fn unique_by<'a, T, K: PartialEq>(
    path: &str,
    items: &'a [T],
    name: &str,
    key: impl Fn(&'a T) -> K,
) -> Check {
    let keys: Vec<K> = items.iter().map(key).collect();
    for j in 1..keys.len() {
        if keys[..j].contains(&keys[j]) {
            return Err(fail(&at(path, j), format!("duplicate {name}; must be unique across the array")));
        }
    }
    Ok(())
}

/// A property that must be present exactly when `wanted` (the condition `cond`
/// holds). `path` is the containing object.
pub fn presence(path: &str, key: &str, present: bool, wanted: bool, cond: &str) -> Check {
    match (present, wanted) {
        (false, true) => Err(fail(path, format!("\"{key}\" is required when {cond}"))),
        (true, false) => Err(fail(&child(path, key), format!("\"{key}\" is not allowed unless {cond}"))),
        _ => Ok(()),
    }
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^[0-9a-f]{32}$`
pub fn is_instance(s: &str) -> bool {
    is_lower_hex(s, 32)
}

/// `^[0-9a-f]{64}$`
pub fn is_sha256(s: &str) -> bool {
    is_lower_hex(s, 64)
}

/// `^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$` (shape only: 2026-02-30 passes).
pub fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let d = |i: usize| b[i].is_ascii_digit();
    if !(d(0) && d(1) && d(2) && d(3) && d(5) && d(6) && d(8) && d(9)) {
        return false;
    }
    let month = (b[5] - b'0') * 10 + (b[6] - b'0');
    let day = (b[8] - b'0') * 10 + (b[9] - b'0');
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// `^([01][0-9]|2[0-3]):[0-5][0-9]$`
pub fn is_hhmm(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' {
        return false;
    }
    let d = |i: usize| b[i].is_ascii_digit();
    if !(d(0) && d(1) && d(3) && d(4)) {
        return false;
    }
    let hour = (b[0] - b'0') * 10 + (b[1] - b'0');
    let minute = (b[3] - b'0') * 10 + (b[4] - b'0');
    hour <= 23 && minute <= 59
}

fn is_slug(s: &str, min: usize, max: usize, extra: &[u8]) -> bool {
    let b = s.as_bytes();
    (min..=max).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || extra.contains(c))
}

/// `^[a-z][a-z0-9_]{1,31}$`
pub fn is_decoration_id(s: &str) -> bool {
    is_slug(s, 2, 32, b"_")
}

/// `^[a-z][a-z0-9_-]{1,47}$`
pub fn is_entry_id(s: &str) -> bool {
    is_slug(s, 2, 48, b"_-")
}

/// `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`
pub fn is_semver(s: &str) -> bool {
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let pre_ok = pre.is_none_or(|p| {
        !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
    });
    core_ok && pre_ok
}

/// `^[a-z0-9]{16,32}$`
pub fn is_owner_tag(s: &str) -> bool {
    (16..=32).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// `^[A-Za-z][A-Za-z0-9_.]{0,63}$`
pub fn is_event_name(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=64).contains(&b.len())
        && b[0].is_ascii_alphabetic()
        && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'.')
}

/// `^(/[^/]*)+$`: a non-empty string that starts with `/`.
pub fn is_json_pointer(s: &str) -> bool {
    s.starts_with('/')
}

/// True when the string has none of U+0000 to U+001F or U+007F.
pub fn no_controls(s: &str) -> bool {
    !s.chars().any(|c| c <= '\u{1F}' || c == '\u{7F}')
}

/// `^(/|[A-Za-z]:\\)[^\u0000-\u001F\u007F]*$`
pub fn is_abs_path(s: &str) -> bool {
    let b = s.as_bytes();
    let prefix = s.starts_with('/')
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\');
    prefix && no_controls(s)
}

/// `^[^/\\\u0000-\u001F\u007F]+$`
pub fn is_project_label(s: &str) -> bool {
    !s.is_empty() && !s.contains('/') && !s.contains('\\') && no_controls(s)
}

/// `^[^\u0000-\u001F\u007F]+$`
pub fn is_display_name(s: &str) -> bool {
    !s.is_empty() && no_controls(s)
}

/// `^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$`
pub fn is_accelerator(s: &str) -> bool {
    s.split('+').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Applies a pattern predicate, reporting `what` on failure.
pub fn pattern(path: &str, s: &str, ok: fn(&str) -> bool, what: &str) -> Check {
    ensure(ok(s), path, format!("must match {what}"))
}

/// A salted instance id: 32 lowercase hex characters.
pub fn instance(path: &str, s: &str) -> Check {
    pattern(path, s, is_instance, "^[0-9a-f]{32}$")
}

/// An optional instance id.
pub fn opt_instance(path: &str, s: Option<&String>) -> Check {
    s.map_or(Ok(()), |s| instance(path, s))
}

/// A local calendar day, `YYYY-MM-DD`.
pub fn day(path: &str, s: &str) -> Check {
    pattern(path, s, is_day, "a YYYY-MM-DD day")
}

/// A SHA-256 hex digest: 64 lowercase hex characters.
pub fn sha256(path: &str, s: &str) -> Check {
    pattern(path, s, is_sha256, "^[0-9a-f]{64}$")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_and_sha() {
        assert!(is_instance("0123456789abcdef0123456789abcdef"));
        assert!(!is_instance("0123456789abcdef0123456789abcde")); // 31
        assert!(!is_instance("0123456789abcdef0123456789abcdef0")); // 33
        assert!(!is_instance("0123456789ABCDEF0123456789abcdef")); // uppercase
        assert!(!is_instance("0123456789abcdeg0123456789abcdef")); // non-hex
        assert!(!is_instance("123e4567-e89b-12d3-a456-426614174000")); // uuid
        assert!(!is_instance(""));
        assert!(is_sha256(&"a".repeat(64)));
        assert!(!is_sha256(&"a".repeat(63)));
        assert!(!is_sha256(&"a".repeat(65)));
        assert!(!is_sha256(&"A".repeat(64)));
    }

    #[test]
    fn days() {
        assert!(is_day("2026-10-12"));
        assert!(is_day("2026-02-30")); // shape only
        assert!(is_day("0000-01-01"));
        assert!(is_day("9999-12-31"));
        assert!(!is_day("2026-00-10"));
        assert!(!is_day("2026-13-10"));
        assert!(!is_day("2026-10-00"));
        assert!(!is_day("2026-10-32"));
        assert!(!is_day("2026-1-12"));
        assert!(!is_day("26-10-12"));
        assert!(!is_day("2026/10/12"));
        assert!(!is_day("2026-10-12 "));
        assert!(!is_day("2026-10-1a"));
        assert!(!is_day(""));
        // multi-byte characters must not panic or pass
        assert!(!is_day("2026-10-1\u{e9}"));
    }

    #[test]
    fn times() {
        assert!(is_hhmm("00:00"));
        assert!(is_hhmm("23:59"));
        assert!(is_hhmm("07:30"));
        assert!(!is_hhmm("24:00"));
        assert!(!is_hhmm("12:60"));
        assert!(!is_hhmm("7:30"));
        assert!(!is_hhmm("07:3"));
        assert!(!is_hhmm("07-30"));
        assert!(!is_hhmm("07:30:00"));
        assert!(!is_hhmm(""));
    }

    #[test]
    fn slugs() {
        assert!(is_decoration_id("ab"));
        assert!(is_decoration_id(&format!("a{}", "b".repeat(31)))); // 32 chars
        assert!(!is_decoration_id(&format!("a{}", "b".repeat(32)))); // 33 chars
        assert!(!is_decoration_id("a")); // too short
        assert!(!is_decoration_id("1a"));
        assert!(!is_decoration_id("_a"));
        assert!(!is_decoration_id("Ab"));
        assert!(!is_decoration_id("a-b")); // hyphen not allowed here
        assert!(is_decoration_id("lantern_01"));
        assert!(!is_decoration_id(""));

        assert!(is_entry_id("ab"));
        assert!(is_entry_id("claude-hooks"));
        assert!(is_entry_id(&format!("a{}", "b".repeat(47)))); // 48
        assert!(!is_entry_id(&format!("a{}", "b".repeat(48)))); // 49
        assert!(!is_entry_id("a"));
        assert!(!is_entry_id("-a"));
        assert!(!is_entry_id("aB"));
        assert!(!is_entry_id(""));
    }

    #[test]
    fn semver() {
        assert!(is_semver("0.1.0"));
        assert!(is_semver("10.20.30"));
        assert!(is_semver("1.2.3-beta.1"));
        assert!(is_semver("1.2.3-RC1"));
        assert!(!is_semver("1.2"));
        assert!(!is_semver("1.2.3.4"));
        assert!(!is_semver("1.2.x"));
        assert!(!is_semver("1..3"));
        assert!(!is_semver("v1.2.3"));
        assert!(!is_semver("1.2.3-"));
        assert!(!is_semver("1.2.3-rc-1")); // only one hyphen group
        assert!(!is_semver("1.2.3+build"));
        assert!(!is_semver(""));
    }

    #[test]
    fn owner_tag_and_event_name() {
        assert!(is_owner_tag(&"a".repeat(16)));
        assert!(is_owner_tag(&"a1".repeat(16))); // 32
        assert!(!is_owner_tag(&"a".repeat(15)));
        assert!(!is_owner_tag(&"a".repeat(33)));
        assert!(!is_owner_tag(&format!("{}A", "a".repeat(16))));
        assert!(!is_owner_tag(&format!("{}-", "a".repeat(16))));
        assert!(is_event_name("PermissionRequest"));
        assert!(is_event_name("a"));
        assert!(is_event_name("Pre.Tool_Use2"));
        assert!(is_event_name(&format!("A{}", "b".repeat(63)))); // 64
        assert!(!is_event_name(&format!("A{}", "b".repeat(64)))); // 65
        assert!(!is_event_name(""));
        assert!(!is_event_name("1Event"));
        assert!(!is_event_name("_Event"));
        assert!(!is_event_name("Pre-Tool"));
        assert!(!is_event_name("Pre Tool"));
    }

    #[test]
    fn pointers_and_paths() {
        assert!(is_json_pointer("/"));
        assert!(is_json_pointer("/hooks/Stop"));
        assert!(is_json_pointer("//"));
        assert!(!is_json_pointer(""));
        assert!(!is_json_pointer("hooks"));

        assert!(is_abs_path("/"));
        assert!(is_abs_path("/Users/x/.claude/settings.json"));
        assert!(is_abs_path("C:\\Users\\x"));
        assert!(is_abs_path("z:\\"));
        assert!(!is_abs_path("C:/Users"));
        assert!(!is_abs_path("C:"));
        assert!(!is_abs_path("relative/path"));
        assert!(!is_abs_path("/tab\there"));
        assert!(!is_abs_path("/nul\u{0}"));
        assert!(!is_abs_path("/del\u{7f}"));
        assert!(!is_abs_path(""));
        assert!(is_abs_path("/caf\u{e9}"));
    }

    #[test]
    fn labels_names_accelerators() {
        assert!(is_project_label("busyholm"));
        assert!(is_project_label("my project"));
        assert!(is_project_label("caf\u{e9}"));
        assert!(!is_project_label(""));
        assert!(!is_project_label("a/b"));
        assert!(!is_project_label("a\\b"));
        assert!(!is_project_label("a\nb"));
        assert!(!is_project_label("a\u{7f}"));
        assert!(is_project_label("a\u{80}")); // C1 controls are allowed by the pattern

        assert!(is_display_name("Studio Display"));
        assert!(is_display_name("a/b\\c"));
        assert!(!is_display_name(""));
        assert!(!is_display_name("a\u{1f}"));
        assert!(!is_display_name("a\u{0}"));

        assert!(is_accelerator("A"));
        assert!(is_accelerator("CommandOrControl+Shift+B"));
        assert!(!is_accelerator(""));
        assert!(!is_accelerator("+A"));
        assert!(!is_accelerator("A+"));
        assert!(!is_accelerator("A++B"));
        assert!(!is_accelerator("A B"));
        assert!(!is_accelerator("A-B"));
    }

    #[test]
    fn ranges_and_lengths() {
        assert!(ms("", MS_MIN).is_ok());
        assert!(ms("", MS_MAX).is_ok());
        assert!(ms("", MS_MIN - 1).is_err());
        assert!(ms("", MS_MAX + 1).is_err());
        assert!(ms("", 1_760_270_400).is_err()); // seconds
        assert!(num_range("", 0.0, 0.0, 100.0).is_ok());
        assert!(num_range("", 100.0, 0.0, 100.0).is_ok());
        assert!(num_range("", 100.0001, 0.0, 100.0).is_err());
        assert!(num_range("", -0.0001, 0.0, 100.0).is_err());
        assert!(num_pos_max("", 0.0, 0.0, 10.0).is_err());
        assert!(num_pos_max("", 0.0001, 0.0, 10.0).is_ok());
        assert!(num_pos_max("", 10.0, 0.0, 10.0).is_ok());
        assert!(num_pos_max("", 10.5, 0.0, 10.0).is_err());
        // code points, not bytes or UTF-16 units
        assert!(chars("", &"\u{1F600}".repeat(3), 1, 3).is_ok());
        assert!(chars("", &"\u{1F600}".repeat(4), 1, 3).is_err());
        assert!(chars("", "", 1, 3).is_err());
    }

    #[test]
    fn uniqueness_and_pointers() {
        assert!(unique_items("", &[1, 2, 3]).is_ok());
        assert_eq!(unique_items("/o", &[1, 2, 1]).unwrap_err().path, "/o/2");
        let items = [("a", 1), ("b", 1), ("a", 2)];
        assert!(unique_by("", &items, "pair", |i| (i.0, i.1)).is_ok());
        assert_eq!(unique_by("/x", &items, "tool", |i| i.0).unwrap_err().path, "/x/2");
        assert_eq!(child("", "a/b~c"), "/a~1b~0c");
        assert_eq!(at("/agents", 3), "/agents/3");
    }
}
