/**
 * Believable desktop environment rendered in pure Canvas 2D (WP-B1).
 * Composed entirely from geometric shapes, gradients, and typography.
 * Zero third-party wallpapers, brand logos, or external images.
 */

export interface DesktopOptions {
  activeBeat?: string;
  terminalText?: string[];
  showAlertBanner?: boolean;
  showTrayPopover?: boolean;
  alertText?: { title: string; subtitle: string };
  stripRect?: { x: number; y: number; w: number; h: number };
}

export interface StripPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function getDesktopStripRect(viewW = 1920, viewH = 1080): StripPlacement {
  const w = 1440;
  const h = 120;
  const x = Math.round((viewW - w) / 2);
  const y = viewH - h - 16;
  return { x, y, w, h };
}

export function drawDesktopBackground(
  ctx: CanvasRenderingContext2D,
  width = 1920,
  height = 1080,
  opts: DesktopOptions = {}
): void {
  ctx.save();

  // 1. Wallpaper: Rich multi-stop gradient with soft geometric wave curves
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0.0, '#1c1b26');
  bgGrad.addColorStop(0.4, '#242335');
  bgGrad.addColorStop(0.8, '#1b2234');
  bgGrad.addColorStop(1.0, '#15141e');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Soft aesthetic curves on wallpaper (pure shapes and opacity)
  ctx.save();
  ctx.fillStyle = 'rgba(111, 166, 182, 0.04)';
  ctx.beginPath();
  ctx.moveTo(0, height * 0.4);
  ctx.bezierCurveTo(width * 0.3, height * 0.2, width * 0.6, height * 0.6, width, height * 0.35);
  ctx.lineTo(width, 0);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(224, 122, 95, 0.03)';
  ctx.beginPath();
  ctx.moveTo(0, height * 0.7);
  ctx.bezierCurveTo(width * 0.4, height * 0.5, width * 0.7, height * 0.85, width, height * 0.6);
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Subtle paper grain flecks
  ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
  for (let i = 0; i < 400; i++) {
    const fx = (i * 197) % width;
    const fy = (i * 139) % height;
    ctx.fillRect(fx, fy, 1.5, 1.5);
  }

  // 2. Top Menu Bar (28 px height)
  ctx.fillStyle = 'rgba(18, 18, 26, 0.88)';
  ctx.fillRect(0, 0, width, 28);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(0, 27, width, 1);

  // Left decorative icon
  ctx.fillStyle = '#E9D6B6';
  ctx.beginPath();
  ctx.arc(18, 14, 5, 0, Math.PI * 2);
  ctx.fill();

  // Menu items
  ctx.fillStyle = 'rgba(235, 235, 245, 0.75)';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const menus = ['Code', 'File', 'Edit', 'Selection', 'View', 'Go', 'Terminal', 'Window', 'Help'];
  let menuX = 36;
  for (const item of menus) {
    ctx.fillText(item, menuX, 14);
    menuX += ctx.measureText(item).width + 16;
  }

  // Busyholm menu bar tray pill on the right
  const trayX = width - 236;
  ctx.fillStyle = opts.showAlertBanner || opts.showTrayPopover ? 'rgba(242, 178, 56, 0.22)' : 'rgba(255, 255, 255, 0.08)';
  drawRoundedRect(ctx, trayX, 4, 82, 20, 6);
  ctx.fill();
  ctx.fillStyle = opts.showAlertBanner || opts.showTrayPopover ? '#F2B238' : '#E9D6B6';
  ctx.fillRect(trayX + 10, 9, 2, 10);
  ctx.fillRect(trayX + 12, 9, 7, 5);
  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(opts.showAlertBanner || opts.showTrayPopover ? '1 needs you' : 'Busyholm', trayX + 23, 14);

  // Right status bar clock
  ctx.textAlign = 'right';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = 'rgba(235, 235, 245, 0.8)';
  ctx.fillText('Mon Oct 12  5:20 PM', width - 20, 14);

  // 3. Left Window: Code Editor (VS Code style)
  const edX = 60;
  const edY = 52;
  const edW = 960;
  const edH = 820;

  // Window shadow
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = '#1e1e2e';
  drawRoundedRect(ctx, edX, edY, edW, edH, 10);
  ctx.fill();
  ctx.restore();

  // Window border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  drawRoundedRect(ctx, edX, edY, edW, edH, 10);
  ctx.stroke();

  // Editor title bar
  ctx.fillStyle = '#181825';
  drawTopRoundedRect(ctx, edX, edY, edW, 38, 10);
  ctx.fill();

  // Window control dots
  drawWindowDots(ctx, edX + 16, edY + 19);

  // Editor tab
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(edX + 80, edY + 6, 160, 32);
  ctx.fillStyle = 'rgba(240, 240, 250, 0.85)';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('island.ts', edX + 104, edY + 22);

  // File icon next to tab name
  ctx.fillStyle = '#6FA6B6';
  ctx.fillRect(edX + 90, edY + 16, 8, 11);

  // Sidebar
  const sbW = 170;
  ctx.fillStyle = '#181825';
  ctx.fillRect(edX, edY + 38, sbW, edH - 38);
  ctx.fillStyle = 'rgba(200, 200, 220, 0.5)';
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('EXPLORER', edX + 16, edY + 56);

  const files = [
    { name: 'src', folder: true },
    { name: 'residents.ts', folder: false },
    { name: 'island.ts', folder: false, active: true },
    { name: 'watermill.ts', folder: false },
    { name: 'weather.ts', folder: false },
    { name: 'contracts', folder: true },
  ];
  let fileY = edY + 78;
  for (const f of files) {
    if (f.active) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(edX, fileY - 9, sbW, 20);
    }
    ctx.fillStyle = f.active ? '#ffffff' : 'rgba(220, 220, 235, 0.7)';
    ctx.fillText(`${f.folder ? 'v ' : '  '}${f.name}`, edX + (f.folder ? 14 : 20), fileY);
    fileY += 22;
  }

  // Code editor lines
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(edX + sbW, edY + 38, edW - sbW, edH - 38);

  const codeLines = [
    { text: "import { createResident } from './residents';", color: '#89b4fa' },
    { text: "import { Watermill, Sawmill } from './structures';", color: '#89b4fa' },
    { text: "import type { AgentTurn, QuotaState, IslandWorld } from './contracts';", color: '#89b4fa' },
    { text: '', color: '#cdd6f4' },
    { text: '// Turns advance building progression on the island', color: '#6c7086' },
    { text: 'export async function advanceTurn(world: IslandWorld, turn: AgentTurn) {', color: '#cba6f7' },
    { text: '  const resident = world.residents.get(turn.tool);', color: '#cdd6f4' },
    { text: '  if (!resident) return;', color: '#f38ba8' },
    { text: '  await resident.cheer({ confetti: true });', color: '#f9e2af' },
    { text: "  world.deliverPlank({ from: 'sawmill', to: 'watermill' });", color: '#a6e3a1' },
    { text: '}', color: '#cba6f7' },
    { text: '', color: '#cdd6f4' },
    { text: 'export function onNeedsYou(world: IslandWorld, tool: string, reason: string) {', color: '#cba6f7' },
    { text: '  const resident = world.residents.get(tool);', color: '#cdd6f4' },
    { text: "  resident?.dashTo('bell_post', { raiseFlag: reason });", color: '#f9e2af' },
    { text: '  world.bellPost.ring();', color: '#89dceb' },
    { text: '}', color: '#cba6f7' },
    { text: '', color: '#cdd6f4' },
    { text: 'export function onUsageLimit(world: IslandWorld, quota: QuotaState) {', color: '#cba6f7' },
    { text: '  world.weather.startShower({ workshop: quota.provider, until: quota.resetsAt });', color: '#89dceb' },
    { text: "  world.residents.get(quota.provider)?.takeRest('willow_tree');", color: '#a6e3a1' },
    { text: '}', color: '#cba6f7' },
    { text: '', color: '#cdd6f4' },
    { text: 'export function updateSkyArc(world: IslandWorld, usedPct: number) {', color: '#cba6f7' },
    { text: '  const phase = Math.min(1, Math.max(0, usedPct / 100));', color: '#cdd6f4' },
    { text: '  world.sky.setWindowPhase(phase);', color: '#89b4fa' },
    { text: '  if (phase > 0.85) world.lanterns.setWarmGlow(true);', color: '#f9e2af' },
    { text: '}', color: '#cba6f7' },
    { text: '', color: '#cdd6f4' },
    { text: 'export const ISLAND_CONFIG = {', color: '#fab387' },
    { text: '  seed: 42,', color: '#a6e3a1' },
    { text: '  stripHeightPx: 112,', color: '#a6e3a1' },
    { text: "  surface: 'strip' as const,", color: '#a6e3a1' },
    { text: "  hemisphere: 'north' as const,", color: '#a6e3a1' },
    { text: '};', color: '#fab387' },
  ];

  ctx.font = '12.5px "SF Mono", Menlo, Consolas, Monaco, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let lineY = edY + 54;
  for (let idx = 0; idx < codeLines.length; idx++) {
    const line = codeLines[idx]!;
    // Line number
    ctx.fillStyle = '#585b70';
    ctx.fillText(String(idx + 1).padStart(2, ' '), edX + sbW + 14, lineY);
    // Line content
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, edX + sbW + 48, lineY);
    lineY += 21.5;
  }

  // 4. Right Window: Terminal (Claude Code / Codex)
  const trX = 1056;
  const trY = 124;
  const trW = 804;
  const trH = 748;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = '#11111b';
  drawRoundedRect(ctx, trX, trY, trW, trH, 10);
  ctx.fill();
  ctx.restore();

  // Terminal border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  drawRoundedRect(ctx, trX, trY, trW, trH, 10);
  ctx.stroke();

  // Terminal title bar
  ctx.fillStyle = '#181825';
  drawTopRoundedRect(ctx, trX, trY, trW, 38, 10);
  ctx.fill();

  drawWindowDots(ctx, trX + 16, trY + 19);

  ctx.fillStyle = 'rgba(235, 235, 245, 0.7)';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Claude Code + Codex - zsh - 120x34', trX + trW / 2, trY + 19);

  // Terminal output text
  ctx.font = '12.5px "SF Mono", Menlo, Consolas, Monaco, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const sessionHistoryLines = [
    { text: 'user@busyholm ~/busyholm % npm test', color: '#a6e3a1' },
    { text: '  ok 1 - contracts schema validation (14ms)', color: '#6c7086' },
    { text: '  ok 2 - deterministic island growth (28ms)', color: '#6c7086' },
    { text: '  ok 3 - privacy guard: zero raw text in ledger (9ms)', color: '#6c7086' },
    { text: '  ok 4 - strip hit-rects publisher (19ms)', color: '#6c7086' },
    { text: '', color: '#cdd6f4' },
    { text: 'user@busyholm ~/busyholm % claude', color: '#a6e3a1' },
    { text: 'Claude Code connected to Busyholm collector (local socket)', color: '#89b4fa' },
    { text: '  [read] world/art/src/structures.ts (412 lines)', color: '#cdd6f4' },
    { text: '  [read] world/renderer/src/model.ts (1177 lines)', color: '#cdd6f4' },
    { text: '  [edit] world/src/watermill.ts (+38 -12)', color: '#a6e3a1' },
    { text: '  [bash] node --test world/renderer/test/Unit.test.ts ... PASS', color: '#89dceb' },
    { text: '', color: '#cdd6f4' },
    { text: 'user@busyholm ~/busyholm % codex --full-auto', color: '#a6e3a1' },
    { text: 'Codex session active (resident: otter at stoneyard)', color: '#89b4fa' },
    { text: '  [read] contracts/ts/src/types.ts', color: '#cdd6f4' },
    { text: '  [edit] ui/tray/src/popover.ts (+24 -4)', color: '#a6e3a1' },
    { text: '', color: '#cdd6f4' },
  ];

  const defaultLines = [
    { text: 'user@busyholm ~/busyholm % claude --continue', color: '#a6e3a1' },
    { text: '> Working: sawing timber for watermill stage 3', color: '#f9e2af' },
    { text: '  [====================>        ] 68% complete', color: '#a6e3a1' },
    { text: '  Executing: cargo test --lib ... passed 18 tests', color: '#89dceb' },
  ];

  const activeTerminalLines = opts.terminalText
    ? opts.terminalText.map((t) => ({
        text: t,
        color: t.startsWith('>') ? '#f9e2af' : t.startsWith('!') ? '#f38ba8' : t.startsWith('user@') ? '#a6e3a1' : '#cdd6f4',
      }))
    : defaultLines;

  const terminalLines = [...sessionHistoryLines, ...activeTerminalLines];

  let termY = trY + 52;
  for (const l of terminalLines) {
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, trX + 22, termY);
    termY += 23;
  }

  // 5. Native OS Notification Banner (Shot 3 alert, positioned cleanly above terminal)
  if (opts.showAlertBanner && !opts.showTrayPopover) {
    const nW = 368;
    const nH = 74;
    const nX = width - nW - 24;
    const nY = 38;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = 'rgba(30, 30, 46, 0.96)';
    drawRoundedRect(ctx, nX, nY, nW, nH, 12);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 176, 0, 0.48)';
    ctx.lineWidth = 1.5;
    drawRoundedRect(ctx, nX, nY, nW, nH, 12);
    ctx.stroke();

    // Alert brass bell / flag badge
    ctx.fillStyle = '#FFB000';
    ctx.beginPath();
    ctx.arc(nX + 32, nY + 37, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(nX + 27, nY + 29, 2.2, 16);
    ctx.fillRect(nX + 29, nY + 29, 9, 6);

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.alertText?.title ?? 'Codex needs you', nX + 58, nY + 17);

    ctx.fillStyle = '#d2d6e8';
    ctx.font = '12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(opts.alertText?.subtitle ?? 'Permission request: Run git push', nX + 58, nY + 39);
  }

  // 6. Tray Popover (when opened from the macOS menu bar icon)
  if (opts.showTrayPopover) {
    drawTrayPopover(ctx, width - 384, 34, 360, 476);
  }

  // 7. Dock placeholder along bottom
  const dockW = 480;
  const dockH = 8;
  const dockX = (width - dockW) / 2;
  const dockY = height - 10;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  drawRoundedRect(ctx, dockX, dockY, dockW, dockH, 4);
  ctx.fill();

  ctx.restore();
}

function drawTrayPopover(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.save();

  // Popover glass card shadow & body
  ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = '#222128';
  drawRoundedRect(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.shadowColor = 'transparent';

  // Header papercut hills banner
  ctx.save();
  drawTopRoundedRect(ctx, x, y, w, 92, 14);
  ctx.clip();
  const hGrad = ctx.createLinearGradient(x, y, x, y + 92);
  hGrad.addColorStop(0, '#5a6065');
  hGrad.addColorStop(0.55, '#3b4144');
  hGrad.addColorStop(1, '#222128');
  ctx.fillStyle = hGrad;
  ctx.fillRect(x, y, w, 92);

  // Subtle hill contour in header
  ctx.fillStyle = 'rgba(42, 48, 46, 0.65)';
  ctx.beginPath();
  ctx.moveTo(x, y + 66);
  ctx.quadraticCurveTo(x + w * 0.35, y + 40, x + w * 0.7, y + 58);
  ctx.quadraticCurveTo(x + w * 0.9, y + 66, x + w, y + 48);
  ctx.lineTo(x + w, y + 92);
  ctx.lineTo(x, y + 92);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Popover border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1.2;
  drawRoundedRect(ctx, x, y, w, h, 14);
  ctx.stroke();

  // Header text: Busyholm + 3 residents + 1 needs you pill
  ctx.fillStyle = '#F7EEDC';
  ctx.font = 'bold 21px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Busyholm', x + 18, y + 16);

  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('3', x + 18, y + 52);
  ctx.fillStyle = '#b9b6c2';
  ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('residents', x + 36, y + 58);

  // "1 needs you" amber pill
  const pillW = 114;
  const pillH = 26;
  const pillX = x + w - pillW - 16;
  const pillY = y + 50;
  ctx.fillStyle = 'rgba(242, 178, 56, 0.14)';
  drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 13);
  ctx.fill();
  ctx.strokeStyle = '#d4942a';
  ctx.lineWidth = 1.2;
  drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 13);
  ctx.stroke();
  ctx.fillStyle = '#f2b238';
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('1 needs you', pillX + 24, pillY + 7);
  ctx.fillRect(pillX + 12, pillY + 7, 1.8, 12);
  ctx.fillRect(pillX + 14, pillY + 7, 6, 4.5);

  // Agents section header
  ctx.fillStyle = '#b9b6c2';
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Agents', x + 18, y + 98);
  ctx.textAlign = 'right';
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('2 working, 1 waiting', x + w - 18, y + 98);
  ctx.textAlign = 'left';

  // Agent Row 1: Codex (Needs your permission)
  const r1Y = y + 120;
  ctx.fillStyle = 'rgba(242, 178, 56, 0.12)';
  drawRoundedRect(ctx, x + 14, r1Y, w - 28, 56, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(212, 148, 42, 0.65)';
  ctx.lineWidth = 1.2;
  drawRoundedRect(ctx, x + 14, r1Y, w - 28, 56, 10);
  ctx.stroke();

  // Avatar circle + flag badge
  ctx.fillStyle = '#383646';
  ctx.beginPath();
  ctx.arc(x + 42, r1Y + 28, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#A2674C';
  ctx.beginPath();
  ctx.arc(x + 42, r1Y + 29, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2b238';
  ctx.beginPath();
  ctx.arc(x + 55, r1Y + 14, 7.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Codex', x + 70, r1Y + 12);
  ctx.fillStyle = '#f2b238';
  ctx.font = '600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Needs your permission', x + 70, r1Y + 32);
  ctx.textAlign = 'right';
  ctx.fillText('now', x + w - 26, r1Y + 22);
  ctx.textAlign = 'left';

  // Agent Row 2: Claude Code (Working, editing)
  const r2Y = y + 186;
  ctx.fillStyle = '#383646';
  ctx.beginPath();
  ctx.arc(x + 42, r2Y + 22, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8F5B3C';
  ctx.beginPath();
  ctx.arc(x + 42, r2Y + 23, 8.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Claude Code', x + 70, r2Y + 7);
  ctx.fillStyle = '#a8a5b5';
  ctx.font = '12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Working, editing', x + 70, r2Y + 26);
  ctx.textAlign = 'right';
  ctx.fillText('4m', x + w - 26, r2Y + 16);
  ctx.textAlign = 'left';

  // Agent Row 3: OpenCode (Working, reading)
  const r3Y = y + 240;
  ctx.fillStyle = '#383646';
  ctx.beginPath();
  ctx.arc(x + 42, r3Y + 22, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5E9254';
  ctx.beginPath();
  ctx.arc(x + 42, r3Y + 23, 8.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('OpenCode', x + 70, r3Y + 7);
  ctx.fillStyle = '#a8a5b5';
  ctx.font = '12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Working, reading', x + 70, r3Y + 26);
  ctx.textAlign = 'right';
  ctx.fillText('9m', x + w - 26, r3Y + 16);
  ctx.textAlign = 'left';

  // Divider
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(x + 14, y + 298, w - 28, 1);

  // Usage section
  ctx.fillStyle = '#b9b6c2';
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Usage', x + 18, y + 310);

  const drawBar = (bx: number, by: number, label: string, pct: number, color: string, reset: string) => {
    ctx.fillStyle = '#b9b6c2';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(label, bx, by);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`${pct}%`, bx + 150, by);
    ctx.textAlign = 'left';

    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    drawRoundedRect(ctx, bx, by + 18, 150, 6, 3);
    ctx.fill();
    ctx.fillStyle = color;
    drawRoundedRect(ctx, bx, by + 18, Math.round(1.5 * pct), 6, 3);
    ctx.fill();

    ctx.fillStyle = '#8e8b99';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(reset, bx, by + 30);
  };

  drawBar(x + 18, y + 334, 'Claude · 5-hour', 55, '#85c896', 'Resets in 2h 18m');
  drawBar(x + 190, y + 334, 'Claude · Weekly', 48, '#e8bd70', 'Resets in 4d 12h');
  drawBar(x + 18, y + 384, 'Codex · 5-hour', 45, '#85c896', 'Resets in 3h 46m');
  drawBar(x + 190, y + 384, 'Codex · Weekly', 48, '#85c896', 'Resets in 4d 12h');

  // Footer
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(x + 14, y + 434, w - 28, 1);
  ctx.fillStyle = '#dcd9e4';
  ctx.font = '600 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('Details', x + 28, y + 448);
  ctx.fillText('Ambient', x + 124, y + 448);
  ctx.fillText('Strip', x + 232, y + 448);
  ctx.fillStyle = 'rgba(133, 200, 150, 0.18)';
  drawRoundedRect(ctx, x + 272, y + 444, 34, 20, 10);
  ctx.fill();
  ctx.fillStyle = '#85c896';
  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText('On', x + 281, y + 448);

  ctx.restore();
}

/** Draws the strip border and background frame on the desktop. */
export function drawStripContainerFrame(
  ctx: CanvasRenderingContext2D,
  rect: StripPlacement
): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#F7EEDC'; // cream paper backing
  drawRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 10);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(43, 42, 51, 0.25)';
  ctx.lineWidth = 1.5;
  drawRoundedRect(ctx, rect.x, rect.y, rect.w, rect.h, 10);
  ctx.stroke();
  ctx.restore();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawTopRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawWindowDots(ctx: CanvasRenderingContext2D, startX: number, centerY: number): void {
  const colors = ['#ff5f56', '#ffbd2e', '#27c93f'];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = colors[i]!;
    ctx.beginPath();
    ctx.arc(startX + i * 16, centerY, 5.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
