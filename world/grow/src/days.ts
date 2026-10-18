// Pure calendar arithmetic on local days ("YYYY-MM-DD"). Integer maths only, no Date, no time zone,
// so the results are identical in every JavaScript engine.
//
// A day maps to an integer day number (days since 1970-01-01 in the proleptic Gregorian calendar).
// Ledger and Choices days are shape-checked only (contracts/CHANGES.md, convention 9), so an impossible
// date such as 2026-02-30 can reach grow(). It is normalised the way the civil algorithm counts it
// (2026-02-30 becomes day number of 2026-03-02); grow() merges counts that land on the same day number,
// so nothing is dropped.

const DAY_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** Day number (days since 1970-01-01) of a YYYY-MM-DD string. Throws on a malformed string. */
export function dayNumber(day: string): number {
  const m = DAY_RE.exec(day);
  if (m === null) throw new Error(`not a day: ${day}`);
  return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** YYYY-MM-DD string of a day number. */
export function dayString(n: number): string {
  const { y, m, d } = civilFromDays(n);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** ISO weekday of a day number: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(n: number): number {
  // 1970-01-01 was a Thursday (ISO 4).
  return mod(n + 3, 7) + 1;
}

/** Day number of the Monday that starts the ISO week containing day number n. */
export function weekStart(n: number): number {
  return n - (isoWeekday(n) - 1);
}

/** Month (1 to 12) of a day number. */
export function monthOf(n: number): number {
  return civilFromDays(n).m;
}

/** Day number of the UTC calendar day containing an epoch-millisecond instant. */
export function utcDayNumberOfMs(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

function pad(v: number, width: number): string {
  let s = String(v);
  while (s.length < width) s = "0" + s;
  return s;
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

// Howard Hinnant's days_from_civil / civil_from_days, integer only.
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(n: number): { y: number; m: number; d: number } {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y, m, d };
}
