/**
 * B2 art direction exploration tests.
 * Verifies:
 * 1. Opt-in variant parameter accepts 'default', 'deeper_papercut' (A), 'seasonal_richness' (B), 'evening_warmth' (C).
 * 2. Default rendering (variant omitted or 'default') is byte-identical and produces identical signatures.
 * 3. Each exploration variant produces distinct, non-default rendering signatures.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from '../src/index.ts';
import type { ArtVariant, RendererOptions } from '../src/api.ts';
import { hamlet, snapshot } from './helpers.ts';

function make(variant?: ArtVariant) {
  const opts: RendererOptions = {
    surface: 'strip',
    width: 1440,
    height: 120,
    dpr: 2,
    scheduler: 'manual',
    debug: true,
    date: () => new Date(2026, 9, 12, 17, 20, 0),
    variant,
  };
  const r = createRenderer(opts);
  r.setWorld(hamlet());
  r.setSnapshot(snapshot([]));
  r.advance(1000);
  return r;
}

describe('B2 variant parameter and default byte-identical behavior', () => {
  test('variant parameter is recognized and defaults to default', () => {
    const r1 = make();
    const r2 = make('default');
    assert.equal(r1.variant, 'default');
    assert.equal(r2.variant, 'default');
    r1.destroy();
    r2.destroy();
  });

  test('default rendering without variant vs variant=default produces identical debug frames', () => {
    const r1 = make();
    const r2 = make('default');
    const log1 = r1.debugLog();
    const log2 = r2.debugLog();
    assert.ok(log1.length > 0, 'frames drawn for r1');
    assert.equal(log1.length, log2.length, 'equal frame counts');
    for (let i = 0; i < log1.length; i++) {
      assert.deepEqual(log1[i].sky, log2[i].sky);
      assert.deepEqual(log1[i].flag, log2[i].flag);
      assert.equal(log1[i].mode, log2[i].mode);
    }
    r1.destroy();
    r2.destroy();
  });

  test('variants A, B, C are distinct and expose their normalized variant name', () => {
    const rA = make('deeper_papercut');
    const rB = make('seasonal_richness');
    const rC = make('evening_warmth');

    assert.equal(rA.variant, 'deeper_papercut');
    assert.equal(rB.variant, 'seasonal_richness');
    assert.equal(rC.variant, 'evening_warmth');

    rA.destroy();
    rB.destroy();
    rC.destroy();
  });

  test('variant aliases A, B, C map to canonical variant names', () => {
    const rA = make('A');
    const rB = make('B');
    const rC = make('C');

    assert.equal(rA.variant, 'deeper_papercut');
    assert.equal(rB.variant, 'seasonal_richness');
    assert.equal(rC.variant, 'evening_warmth');

    rA.destroy();
    rB.destroy();
    rC.destroy();
  });

  test('headless Chrome renders default byte-identical and variants distinctly', async () => {
    const { loadPlaywright } = await import('../../../tools/lib/playwright.mjs');
    const path = await import('node:path');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const captureHtml = path.join(repoRoot, 'world', 'dist', 'capture.html');

    const pw = await loadPlaywright();
    const browser = await pw.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 120 }, deviceScaleFactor: 1 });
      const captureUrl = (qs: string) => `${pathToFileURL(captureHtml).href}?${qs}`;

      const renderCanvas = async (qs: string, advanceMs: number): Promise<Buffer> => {
        await page.goto(captureUrl(qs));
        await page.waitForFunction(() => !!(window as unknown as { __bh?: unknown }).__bh, { timeout: 15000 });
        await page.evaluate(() => (window as unknown as { __bh: { ready: Promise<void> } }).__bh.ready);
        await page.evaluate((ms) => (window as unknown as { __bh: { advance(n: number): void } }).__bh.advance(ms), advanceMs);
        return (await page.locator('canvas#world').screenshot()) as Buffer;
      };

      // 1. Strip view at t=2000 ms: default vs no-variant
      const bufNoVar = await renderCanvas('view=strip1440&mode=step', 2000);
      const bufDefault = await renderCanvas('view=strip1440&mode=step&variant=default', 2000);
      assert.equal(Buffer.compare(bufNoVar, bufDefault), 0, 'strip default rendering is 100% byte-identical');

      // 2. Strip view at t=2000 ms: variants are distinct
      const bufA = await renderCanvas('view=strip1440&mode=step&variant=deeper_papercut', 2000);
      const bufB = await renderCanvas('view=strip1440&mode=step&variant=seasonal_richness', 2000);
      const bufC = await renderCanvas('view=strip1440&mode=step&variant=evening_warmth', 2000);
      assert.notEqual(Buffer.compare(bufA, bufDefault), 0, 'variant A is distinct from default');
      assert.notEqual(Buffer.compare(bufB, bufDefault), 0, 'variant B is distinct from default');
      assert.notEqual(Buffer.compare(bufC, bufDefault), 0, 'variant C is distinct from default');

      // 3. Ambient view at t=2000 ms: default vs no-variant
      const pageAmb = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const renderAmbient = async (qs: string, advanceMs: number): Promise<Buffer> => {
        await pageAmb.goto(captureUrl(qs));
        await pageAmb.waitForFunction(() => !!(window as unknown as { __bh?: unknown }).__bh, { timeout: 15000 });
        await pageAmb.evaluate(() => (window as unknown as { __bh: { ready: Promise<void> } }).__bh.ready);
        await pageAmb.evaluate((ms) => (window as unknown as { __bh: { advance(n: number): void } }).__bh.advance(ms), advanceMs);
        return (await pageAmb.locator('canvas#world').screenshot()) as Buffer;
      };

      const bufAmbNoVar = await renderAmbient('view=ambient&mode=step', 2000);
      const bufAmbDefault = await renderAmbient('view=ambient&mode=step&variant=default', 2000);
      assert.equal(Buffer.compare(bufAmbNoVar, bufAmbDefault), 0, 'ambient default rendering is 100% byte-identical');

      const bufAmbA = await renderAmbient('view=ambient&mode=step&variant=deeper_papercut', 2000);
      assert.notEqual(Buffer.compare(bufAmbA, bufAmbDefault), 0, 'ambient variant A is distinct from default');

      await pageAmb.close();
      await page.close();
    } finally {
      await browser.close();
    }
  });
});
