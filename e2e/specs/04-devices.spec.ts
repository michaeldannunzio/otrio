import { devices, expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';

import { OtrioApp } from '../support/app';
import { captureAndAnalyse } from '../support/pixels';

/**
 * Four screens, from a small phone to a desktop.
 *
 * What device emulation is: a viewport, a device pixel ratio, a touch event
 * model and a user-agent string. That is a fair proxy for layout, for reach and
 * for whether anything is clipped, and those are the questions asked here.
 *
 * What it is not: a phone. It does not model GPU throughput, thermal
 * throttling, Safari's layout quirks, iOS safe-area behaviour with the URL bar
 * in motion, `navigator.vibrate`, the Web Share sheet, or how a real
 * `100dvh` behaves while a toolbar slides away. None of those can be concluded
 * from a green run in this file, and one of them — the dynamic viewport — is
 * precisely what the shell depends on. Put this on a real handset before
 * believing the layout.
 */

interface Profile {
  name: string;
  context: Parameters<Browser['newContext']>[0];
  /** Smallest side of a primary control that a thumb must hit, in CSS pixels. */
  minTarget: number;
}

const PROFILES: Profile[] = [
  { name: 'small-phone-360', context: { ...devices['Galaxy S5'] }, minTarget: 40 },
  { name: 'large-phone-412', context: { ...devices['Pixel 7'] }, minTarget: 44 },
  { name: 'tablet-810', context: { ...devices['iPad (gen 7)'] }, minTarget: 44 },
  {
    name: 'desktop-1920',
    context: { viewport: { width: 1920, height: 1080 } },
    minTarget: 32,
  },
];

interface Geometry {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; clientWidth: number };
  canvas: { x: number; y: number; width: number; height: number } | null;
  hudTop: { y: number; height: number } | null;
  hudBottom: { y: number; height: number } | null;
  shell: { y: number; height: number } | null;
  sizeTargets: Array<{ width: number; height: number }>;
  cellTargets: Array<{ width: number; height: number }>;
  offscreen: string[];
  /** The height chain from `.app-shell` up to `<html>`, for diagnosing a collapse. */
  chain: Array<{ node: string; height: number; css: string; minHeight: string; display: string }>;
}

async function measure(app: OtrioApp): Promise<Geometry> {
  return app.page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const all = (sel: string) =>
      Array.from(document.querySelectorAll(sel)).map((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });

    /* Anything interactive that has ended up outside the viewport. A control a
       thumb cannot reach is the same as a control that is not there. */
    const offscreen: string[] = [];
    const interactive = document.querySelectorAll(
      '.app-hud-top button, .app-hud-bottom button, .o-size, .o-pcard',
    );
    for (const el of Array.from(interactive)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (
        r.right <= 0 ||
        r.bottom <= 0 ||
        r.left >= window.innerWidth ||
        r.top >= window.innerHeight
      ) {
        offscreen.push(el.getAttribute('aria-label') ?? el.className);
      }
    }

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      canvas: box('.app-canvas canvas'),
      hudTop: (() => {
        const b = box('.app-hud-top');
        return b ? { y: b.y, height: b.height } : null;
      })(),
      hudBottom: (() => {
        const b = box('.app-hud-bottom');
        return b ? { y: b.y, height: b.height } : null;
      })(),
      shell: (() => {
        const b = box('.app-shell');
        return b ? { y: b.y, height: b.height } : null;
      })(),
      sizeTargets: all('.o-size'),
      cellTargets: all('.o-tcell'),
      offscreen,
      chain: (() => {
        const rows: Array<{
          node: string;
          height: number;
          css: string;
          minHeight: string;
          display: string;
        }> = [];
        let node: Element | null = document.querySelector('.app-shell');
        while (node) {
          const s = getComputedStyle(node);
          rows.push({
            node: `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(/\s+/).join('.')}` : ''}`,
            height: Math.round(node.getBoundingClientRect().height),
            css: s.height,
            minHeight: s.minHeight,
            display: s.display,
          });
          node = node.parentElement;
        }
        return rows;
      })(),
    };
  });
}

for (const profile of PROFILES) {
  test(`${profile.name}: the board fits and the controls are reachable`, async ({ browser }) => {
    const hostCtx = await browser.newContext(profile.context);
    const guestCtx = await browser.newContext(profile.context);
    const host = await OtrioApp.open(hostCtx, 'Ada');
    const guest = await OtrioApp.open(guestCtx, 'Grace');

    try {
      const code = await host.createRoom(2);
      await guest.joinRoom(code);
      await host.markReady();
      await guest.markReady();
      await host.startGame();
      await host.expectInGame();
      await host.waitForBoard();
      await host.page.waitForTimeout(2_000);

      const geometry = await measure(host);
      test.info().annotations.push({ type: 'geometry', description: JSON.stringify(geometry) });

      const { path, stats } = await captureAndAnalyse(host.page, `10-device-${profile.name}`);
      test.info().annotations.push({ type: 'screenshot', description: path });
      test.info().annotations.push({ type: 'pixels', description: JSON.stringify(stats) });

      /* ---- the canvas gets the whole screen ---- */
      expect(geometry.canvas, 'no canvas at this size').not.toBeNull();
      if (geometry.canvas) {
        expect(Math.round(geometry.canvas.width)).toBe(geometry.viewport.width);
        expect(Math.round(geometry.canvas.height)).toBe(geometry.viewport.height);
      }

      /* ---- nothing runs off the side, and nothing is off screen ---- */
      expect(
        geometry.document.scrollWidth,
        'the page scrolls sideways at this width',
      ).toBeLessThanOrEqual(geometry.document.clientWidth + 1);
      expect(geometry.offscreen, 'controls have been pushed off the screen').toEqual([]);

      /* ---- the board actually drew something, at every size ---- */
      expect(stats.subject).not.toBeNull();
      expect(stats.subjectRatio).toBeGreaterThan(0.1);

      /* ---- targets are big enough to hit ---- */
      expect(geometry.sizeTargets.length).toBe(3);
      for (const target of geometry.sizeTargets) {
        expect(Math.min(target.width, target.height)).toBeGreaterThanOrEqual(profile.minTarget);
      }
      /* ---- the interface layer covers the screen it is laid out against ----
       *
       * `.app-shell` is the grid the HUD lives in, and `.app-stage` inside it
       * uses `justify-content: space-between` to push the turn banner to the top
       * and the size picker to the bottom. That only works if the shell is as
       * tall as the viewport. If it collapses to its content height the two
       * stack against each other at the top, and the size picker leaves the
       * thumb zone it was designed for. */
      expect(geometry.shell, 'no shell').not.toBeNull();
      if (geometry.shell) {
        expect(
          Math.round(geometry.shell.height),
          'the HUD shell is not full height, so the bottom bar cannot sit at the bottom',
        ).toBeGreaterThanOrEqual(geometry.viewport.height - 2);
      }

      /* ---- the size picker is where a thumb is ---- */
      expect(geometry.hudBottom, 'no bottom HUD').not.toBeNull();
      if (geometry.hudBottom) {
        expect(
          geometry.hudBottom.y,
          'the bottom HUD is in the top half of the screen',
        ).toBeGreaterThan(geometry.viewport.height / 2);
      }

    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
}
