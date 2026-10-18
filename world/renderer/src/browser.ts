/**
 * Browser entry: registers the canvas view, then re-exports the renderer.
 * Pages bundle this file (classic IIFE bundles, so they also open from file:// for captures).
 */
import { registerViewFactory } from './renderer.ts';
import { CanvasView } from './draw/view.ts';

registerViewFactory((canvas, xf, opts) => new CanvasView(canvas, xf, opts));

export * from './index.ts';
