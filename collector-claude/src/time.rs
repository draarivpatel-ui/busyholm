//! ISO-8601 timestamp parsing for transcript records (std only).

/// Parse `YYYY-MM-DDTHH:MM:SS(.fff)?Z` into milliseconds since the Unix epoch.
/// Anything else (offsets, bad digits, out of range) is `None`.
pub fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || *b.last()? != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    let mut ms = 0i64;
    if b[19] == b'.' {
        let frac = s.get(20..b.len() - 1)?;
        if frac.is_empty() || !frac.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let padded: String = frac.chars().chain("000".chars()).take(3).collect();
        ms = padded.parse().ok()?;
    } else if b.len() != 20 {
        return None;
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    let total = ((days * 24 + h) * 60 + mi) * 60 + sec;
    let out = total.checked_mul(1000)?.checked_add(ms)?;
    u64::try_from(out).ok()
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Source epoch seconds to milliseconds. A value already in milliseconds (>= 1e11)
/// is passed through. Non-finite or negative values are `None`.
pub fn epoch_to_ms(v: f64) -> Option<u64> {
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    let ms = if v >= 1e11 { v } else { v * 1000.0 };
    if ms > 9.0e15 {
        return None;
    }
    Some(ms.round() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_dates() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-12T12:00:01.000Z"), Some(1_791_806_401_000));
        assert_eq!(parse_iso_ms("2026-10-12T12:00:01.5Z"), Some(1_791_806_401_500));
        assert_eq!(parse_iso_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
    }

    #[test]
    fn rejects_bad_shapes() {
        for s in ["", "2026-10-12", "2026-10-12T12:00:01+01:00", "2026-13-12T12:00:01Z", "2026-10-12T12:00:01.Z", "xxxx-10-12T12:00:01Z"] {
            assert_eq!(parse_iso_ms(s), None, "{s}");
        }
    }

    #[test]
    fn epoch_units() {
        assert_eq!(epoch_to_ms(1_791_817_200.0), Some(1_791_817_200_000));
        assert_eq!(epoch_to_ms(1_791_817_200_000.0), Some(1_791_817_200_000));
        assert_eq!(epoch_to_ms(-1.0), None);
        assert_eq!(epoch_to_ms(f64::NAN), None);
    }
}
