/**
 * Busyholm world renderer (WP-10): public entry for Node (headless) and for bundling.
 * Browser pages import ./browser.ts, which also registers the canvas view.
 */
export type * from './api.ts';
export { createRenderer, registerViewFactory, type View, type ViewFactory } from './renderer.ts';
export { VirtualTime, realClock, realScheduler } from './clock.ts';
