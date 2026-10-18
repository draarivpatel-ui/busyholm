/**
 * Three-week time-lapse progression generator and overlay (WP-B1).
 * Generates day-by-day World states from founding camp to village using grow().
 */
import type { World } from '../../../contracts/ts/src/types.ts';
import { PROFILES, profileLedger } from '../../grow/sim/profiles.ts';
import { simulateWithShop, type SimDay } from '../../grow/sim/simulate.ts';

export interface TimelapseDay {
  n: number;
  day: string;
  world: World;
  newStructures: string[];
}

export function generateThreeWeekTimelapseDays(seed = 42): TimelapseDay[] {
  // 23 days with the typical usage profile takes the island from founding camp to full village
  const TOTAL_DAYS = 23;
  const ledger = profileLedger(PROFILES.typical!, TOTAL_DAYS, { seed });
  const { run } = simulateWithShop(ledger, TOTAL_DAYS);

  const out: TimelapseDay[] = [];
  let prevStages = new Map<string, number>();

  for (const simDay of run) {
    const newStructures: string[] = [];
    for (const s of simDay.world.structures) {
      const oldStage = prevStages.get(s.id) ?? 0;
      if (s.stage > oldStage && s.stage > 0) {
        newStructures.push(s.id);
      }
      prevStages.set(s.id, s.stage);
    }
    out.push({
      n: simDay.n,
      day: simDay.day,
      world: simDay.world,
      newStructures,
    });
  }

  return out;
}

export function getTimelapseDayAt(
  days: readonly TimelapseDay[],
  elapsedMs: number,
  durationMs: number
): TimelapseDay {
  if (!days.length) throw new Error('timelapse days cannot be empty');
  const u = Math.max(0, Math.min(1, elapsedMs / durationMs));
  // Advance from Day 1 through Day 22 over the first 80% of the shot, then hold Day 23 (Village) for the final 1.2 s
  if (u >= 0.8) return days[days.length - 1]!;
  const idx = Math.min(days.length - 2, Math.floor((u / 0.8) * (days.length - 1)));
  return days[Math.max(0, idx)]!;
}

/** Draws the Fraunces date and turn-count stamp in the upper corner during time-lapse. */
export function drawTimelapseStamp(
  ctx: CanvasRenderingContext2D,
  day: TimelapseDay,
  width = 1920,
  height = 1080
): void {
  ctx.save();

  const pad = 36;
  const cardW = 340;
  const cardH = 96;
  const x = Math.round((width - cardW) / 2);
  const y = pad;

  // Paper backing badge
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#F7EEDC'; // cream paper token
  ctx.beginPath();
  ctx.roundRect(x, y, cardW, cardH, 8);
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#2B2A33'; // ink token
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, cardW, cardH, 8);
  ctx.stroke();

  // Tier capitalization
  const tierName = day.world.tier.charAt(0).toUpperCase() + day.world.tier.slice(1);
  const completedStructures = day.world.structures.filter((s) => s.status === 'complete').length;

  // Title: "Day N: Tier"
  ctx.fillStyle = '#2B2A33';
  ctx.font = 'bold 24px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`Day ${day.n}: ${tierName}`, x + 20, y + 16);

  // Subtitle: turns and structures
  ctx.fillStyle = '#78664F';
  ctx.font = '14px Georgia, serif';
  ctx.fillText(`${day.day}  *  ${day.world.stats.lifetime_turns} turns  *  ${completedStructures} buildings`, x + 20, y + 54);

  ctx.restore();
}
