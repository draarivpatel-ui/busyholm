/** ambient.html (WP-02 page contract): the fullscreen ambient view; any key, click or 8 px move exits. */
import { startPage } from './glue.ts';
import { mountNeedsYouCard } from './card.ts';

const { r, now } = startPage('ambient');
mountNeedsYouCard(r, now);
// WP-12's guard (contracts/CHANGES.md): input in the first 600 ms does not count (a cursor still
// travelling from the tray), and auto-repeat of the shortcut's held key does not count for 1.5 s.
const opened = performance.now();
const settled = () => performance.now() - opened >= 600;
let origin: [number, number] | null = null;
const exit = () => void window.__TAURI__?.core.invoke('bh_ambient_exit').catch(() => undefined);
addEventListener('keydown', (e) => {
  e.preventDefault();
  if (!settled() || (e.repeat && performance.now() - opened < 1500)) return;
  exit();
});
addEventListener('mousedown', (e) => {
  e.preventDefault();
  if (settled()) exit();
});
addEventListener('mousemove', (e) => {
  if (!settled()) return;
  if (!origin) origin = [e.screenX, e.screenY];
  else if (Math.hypot(e.screenX - origin[0], e.screenY - origin[1]) > 8) exit();
});
