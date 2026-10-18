// Privacy canary helpers (SPEC 5.7 rule 10), shared by the fixture generator and
// the scanner. The needle list itself lives in fixtures/privacy/canaries.json.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CANARIES_PATH = join(here, "..", "..", "fixtures", "privacy", "canaries.json");
export const CANARIES = JSON.parse(readFileSync(CANARIES_PATH, "utf8"));

const counters = new Map();

/**
 * A text canary for a content field: BHCANARY_<agent>_<field>_<n>.
 * agent and field name the source, so a leak says where it came from.
 */
export function marker(agent, field) {
  const key = `${agent}_${field}`.replace(/[^A-Za-z0-9]+/g, "_");
  const n = (counters.get(key) ?? 0) + 1;
  counters.set(key, n);
  return `${CANARIES.marker_prefix}_${key}_${n}`;
}

/** A UUID-shaped canary for a raw id field, so adapters that check UUID shape still accept it. */
export function canaryId(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffffffff) throw new Error("canaryId: n out of range");
  return `${CANARIES.id_prefix}${n.toString(16).padStart(12, "0")}`;
}

/** Resets the marker counters (the generator calls it so output is deterministic). */
export function resetMarkers() {
  counters.clear();
}

/**
 * The base64 characters that are fully determined by `bytes` when they start at
 * byte offset `shift` (0, 1 or 2) inside a longer base64-encoded buffer.
 */
function base64Core(bytes, shift) {
  const enc = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64").replace(/=+$/, "");
  const first = Math.ceil((8 * shift) / 6);
  const last = Math.floor((8 * (shift + bytes.length)) / 6);
  return enc.slice(first, last);
}

function utf16be(s) {
  const le = Buffer.from(s, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

/**
 * Every byte pattern to search for: for each needle, in lower and upper case,
 * as UTF-8, UTF-16LE, UTF-16BE, hex (both cases) and base64 (3 alignments,
 * standard and URL-safe). Returns [{ needle, encoding, bytes }].
 */
export function searchPatterns(needles = CANARIES.needles) {
  const out = [];
  const seen = new Set();
  const add = (needle, encoding, bytes) => {
    if (bytes.length < 6) return;
    const key = bytes.toString("latin1");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ needle: needle.name, encoding, bytes });
  };
  for (const needle of needles) {
    for (const value of new Set([needle.value, needle.value.toLowerCase(), needle.value.toUpperCase()])) {
      const utf8 = Buffer.from(value, "utf8");
      add(needle, "utf8", utf8);
      add(needle, "utf16le", Buffer.from(value, "utf16le"));
      add(needle, "utf16be", utf16be(value));
      add(needle, "hex", Buffer.from(utf8.toString("hex"), "latin1"));
      add(needle, "hex-upper", Buffer.from(utf8.toString("hex").toUpperCase(), "latin1"));
      for (let shift = 0; shift < 3; shift++) {
        const core = base64Core(utf8, shift);
        add(needle, `base64+${shift}`, Buffer.from(core, "latin1"));
        add(needle, `base64url+${shift}`, Buffer.from(core.replace(/\+/g, "-").replace(/\//g, "_"), "latin1"));
      }
    }
  }
  return out;
}

/**
 * Case-insensitive search of ASCII text (file names, or raw content as latin1)
 * for any needle. Returns the matched needle names.
 */
export function textHits(text, needles = CANARIES.needles) {
  const lower = text.toLowerCase();
  return needles.filter((n) => lower.includes(n.value.toLowerCase())).map((n) => n.name);
}
