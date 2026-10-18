// Seasons are not part of World v1 (contracts/CHANGES.md: the renderer takes them from the calendar
// and the hemisphere setting). These pure helpers are the one shared rule for the renderer and the
// decoration shop: v0.1 ships autumn and winter art (SPEC 4.4), spring and summer arrive in v0.2.
import { dayNumber, monthOf } from "./days.ts";
import { DECORATIONS } from "./config.ts";
import type { Season } from "./config.ts";

export type CalendarSeason = "spring" | "summer" | "autumn" | "winter";

/** Meteorological season of a local day: north Dec-Feb winter, Mar-May spring, Jun-Aug summer, Sep-Nov autumn; south shifted by six months. */
export function seasonOf(day: string, hemisphere: "north" | "south"): CalendarSeason {
  const m = monthOf(dayNumber(day));
  const north: CalendarSeason = m === 12 || m <= 2 ? "winter" : m <= 5 ? "spring" : m <= 8 ? "summer" : "autumn";
  if (hemisphere === "north") return north;
  const flip: Record<CalendarSeason, CalendarSeason> = { winter: "summer", spring: "autumn", summer: "winter", autumn: "spring" };
  return flip[north];
}

/** Whether a decoration is shown on this day: non-seasonal items always, seasonal ones only in their season. */
export function decorationInSeason(id: string, day: string, hemisphere: "north" | "south"): boolean {
  const def = DECORATIONS.find((d) => d.id === id);
  if (def === undefined) return false;
  if (def.season === undefined) return true;
  const s: Season = def.season;
  return seasonOf(day, hemisphere) === s;
}
