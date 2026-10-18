export interface EndCardCounts {
  activeDays: number;
  turns: number;
  buildings: number;
  tools: number;
}

const KEYS = ['activeDays', 'turns', 'buildings', 'tools'] as const;

export function endCardLines(counts: EndCardCounts): string[] {
  if (!counts || typeof counts !== 'object' || Object.keys(counts).sort().join(',') !== [...KEYS].sort().join(',')) {
    throw new TypeError('end card accepts exactly four numeric counts');
  }
  for (const key of KEYS) if (!Number.isInteger(counts[key]) || counts[key] < 0 || counts[key] > 1_000_000_000) {
    throw new RangeError(`invalid end-card count: ${key}`);
  }
  return ['Busyholm', 'Demo', `${counts.activeDays} active days`, `${counts.turns} completed turns`,
    `${counts.buildings} buildings`, `${counts.tools} tools`];
}

export function drawEndCard(ctx: CanvasRenderingContext2D, counts: EndCardCounts, width = 1920, height = 1080): void {
  const lines = endCardLines(counts);
  const s = Math.min(width / 1920, height / 1080);
  ctx.save();
  ctx.fillStyle = '#F2E5C9'; ctx.fillRect(0, 0, width, height);
  // Fixed paper flecks, independent of runtime randomness and fonts.
  ctx.fillStyle = '#8269420a';
  for (let n = 0; n < 600; n++) ctx.fillRect((n * 127 % 1920) * width / 1920, (n * 59 % 1080) * height / 1080, s, s);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#312D2A'; ctx.font = `${106 * s}px Georgia, serif`;
  ctx.fillText(lines[0]!, width / 2, height * 0.29);
  ctx.fillStyle = '#A25D3D'; ctx.font = `${24 * s}px Georgia, serif`;
  ctx.fillText(lines[1]!, width / 2, height * 0.39);
  ctx.fillStyle = '#78664F'; ctx.fillRect(width * 0.35, height * 0.445, width * 0.30, s);
  ctx.fillStyle = '#312D2A'; ctx.font = `${34 * s}px Georgia, serif`;
  for (let n = 2; n < lines.length; n++) ctx.fillText(lines[n]!, width / 2, height * (0.53 + (n - 2) * 0.08));
  ctx.restore();
}
