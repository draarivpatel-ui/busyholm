/**
 * The needs-you card over the ambient scene (SPEC 6.4: "a quiet corner card shows needs-you").
 * Per waiting agent: a small portrait of its resident, the tool, why it waits (permission or a
 * question) and for how long. Never a project name, prompt or any other content.
 */
import { tok, css, mix } from '../../../art/src/color.ts';
import { FONTS, SCARVES } from '../../../art/src/tokens.ts';
import { Paper } from '../../../art/src/paper.ts';
import { drawResident, posesFor } from '../../../art/src/residents.ts';
import type { Renderer, WaitingAgent, Tool } from '../api.ts';

const TOOL_NAME: Record<Tool, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
  cursor: 'Cursor',
  aider: 'Aider',
  other: 'An agent',
};

export function waitedFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/**
 * Sizes of the card for a view this many CSS px wide. The base is 19 px for the title on a small window;
 * on a wide view everything scales so that the title is still at least 9.5 px, the second line 8 px and
 * the "more" line 7 px when the whole frame is shown 460 px wide (a store thumbnail). Never above 3x.
 */
export function cardMetrics(viewW: number): { k: number; title: number; sub: number; more: number; portrait: number; minW: number; maxW: number } {
  const k = Math.min(3, Math.max(1, (9.6 / 19) * (viewW / 460)));
  const thumb = viewW / 460;
  return {
    k,
    title: 19 * k,
    sub: Math.max(14 * k, 8.1 * thumb),
    more: Math.max(13 * k, 7.1 * thumb),
    portrait: 46 * k,
    minW: 260 * k,
    maxW: 360 * k,
  };
}

const portraits = new Map<string, HTMLCanvasElement>();

function portrait(a: WaitingAgent, size: number): HTMLCanvasElement {
  const key = `${a.species}|${a.scarf}|${Math.round(size)}`;
  const hit = portraits.get(key);
  if (hit) return copyCanvas(hit);
  const css = Math.round(size);
  const dpr = Math.min(2, devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = css * dpr;
  c.height = css * dpr;
  c.style.width = c.style.height = `${css}px`;
  const g = c.getContext('2d')!;
  const k = 1.45 * (css / 46) * dpr;
  const pose = posesFor(a.species)['turn-0'];
  g.setTransform(k, 0, 0, k, (css * dpr) / 2, css * dpr - 3 * dpr);
  drawResident(new Paper(g, k, 101), a.species, pose, 'base');
  // the scarf overlay, tinted with the instance colour
  const s = document.createElement('canvas');
  s.width = c.width;
  s.height = c.height;
  const sg = s.getContext('2d')!;
  sg.setTransform(k, 0, 0, k, (css * dpr) / 2, css * dpr - 3 * dpr);
  drawResident(new Paper(sg, k, 101), a.species, pose, 'scarf');
  sg.setTransform(1, 0, 0, 1, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = cssOf(SCARVES[a.scarf % SCARVES.length]);
  sg.fillRect(0, 0, s.width, s.height);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(s, 0, 0);
  portraits.set(key, c);
  return copyCanvas(c);
}

/** cloneNode() does not copy a canvas's pixels, so copy them. */
function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.style.width = src.style.width;
  c.style.height = src.style.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}

function cssOf(t: Parameters<typeof tok>[0], a = 1): string {
  return css(tok(t), a);
}

/** Mount the card; it refreshes once a second while anyone waits and hides itself otherwise. */
export function mountNeedsYouCard(r: Renderer, now: () => number, stepped = false): void {
  const card = document.createElement('div');
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  let m = cardMetrics(innerWidth);
  Object.assign(card.style, {
    position: 'fixed',
    left: `${40 * m.k}px`,
    top: `${40 * m.k}px`,
    minWidth: `${m.minW}px`,
    maxWidth: `${m.maxW}px`,
    padding: `${14 * m.k}px ${18 * m.k}px ${14 * m.k}px ${14 * m.k}px`,
    borderRadius: `${14 * m.k}px`,
    background: cssOf('cream', 0.94),
    color: cssOf('ink'),
    boxShadow: `0 ${10 * m.k}px ${30 * m.k}px ${cssOf('ink', 0.28)}, 0 1px 0 ${cssOf('maskWhite', 0.6)} inset`,
    fontFamily: FONTS.ui,
    display: 'none',
    opacity: '0',
    transition: stepped ? 'none' : 'opacity 400ms ease',
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(card);
  const rows = document.createElement('div');
  card.appendChild(rows);
  let shownIds = '';

  const render = () => {
    const list = r.waiting();
    if (!list.length) {
      card.style.opacity = '0';
      if (stepped) card.style.display = 'none';
      else
        setTimeout(() => {
          if (!r.waiting().length) card.style.display = 'none';
        }, 420);
      shownIds = '';
      return;
    }
    card.style.display = 'block';
    if (stepped) card.style.opacity = '1';
    else requestAnimationFrame(() => (card.style.opacity = '1'));
    const ids = list.map((a) => a.id).join(',');
    const head = list.slice(0, 3);
    if (ids !== shownIds) {
      shownIds = ids;
      rows.replaceChildren();
      for (const a of head) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: `${12 * m.k}px`, padding: `${4 * m.k}px 0`, borderLeft: `${4 * m.k}px solid ${cssOf('alertFlag')}`, paddingLeft: `${10 * m.k}px`, margin: `${4 * m.k}px 0` });
        row.appendChild(portrait(a, m.portrait));
        const text = document.createElement('div');
        const title = document.createElement('div');
        title.textContent = `${TOOL_NAME[a.tool]}${a.ordinal > 1 ? ` ${a.ordinal}` : ''} needs you`;
        Object.assign(title.style, { fontFamily: FONTS.display, fontWeight: '600', fontSize: `${m.title}px`, lineHeight: '1.2' });
        const sub = document.createElement('div');
        sub.dataset.since = String(a.since);
        sub.dataset.reason = a.reason === 'question' ? 'has a question' : 'wants permission';
        Object.assign(sub.style, { fontSize: `${m.sub}px`, color: css(mix(tok('ink'), tok('cream'), 0.35)), fontVariantNumeric: 'tabular-nums', marginTop: `${2 * m.k}px` });
        text.append(title, sub);
        row.appendChild(text);
        rows.appendChild(row);
      }
      if (list.length > head.length) {
        const more = document.createElement('div');
        more.textContent = `+${list.length - head.length} more waiting`;
        Object.assign(more.style, { fontSize: `${m.more}px`, marginTop: `${6 * m.k}px`, paddingLeft: `${14 * m.k}px`, color: css(mix(tok('ink'), tok('cream'), 0.35)) });
        rows.appendChild(more);
      }
    }
    for (const el of rows.querySelectorAll<HTMLElement>('[data-since]')) el.textContent = `${el.dataset.reason} · ${waitedFor(now() - Number(el.dataset.since))}`;
  };
  // the card follows the window size (live ambient windows can be resized, a capture sets its size once)
  addEventListener('resize', () => {
    const next = cardMetrics(innerWidth);
    if (next.k === m.k && next.sub === m.sub) return;
    m = next;
    Object.assign(card.style, {
      left: `${40 * m.k}px`,
      top: `${40 * m.k}px`,
      minWidth: `${m.minW}px`,
      maxWidth: `${m.maxW}px`,
      padding: `${14 * m.k}px ${18 * m.k}px ${14 * m.k}px ${14 * m.k}px`,
      borderRadius: `${14 * m.k}px`,
    });
    shownIds = '';
    render();
  });
  render();
  if (!stepped) setInterval(render, 1000);
  (window as unknown as { __bhCard: () => void }).__bhCard = render;
}
