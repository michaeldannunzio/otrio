/**
 * Bob joins a human's game.
 *
 * Not a test — a persistent headless player so a human short of people can start
 * a match. Joins by code, readies up, then plays a legal move whenever it is his
 * turn, driving the flat board (`[data-cell]`) because it is real DOM with stable
 * attributes, unlike the canvas.
 *
 *   node e2e/join-as-bob.mjs <ROOM_CODE> [name] [baseURL]
 */
import { chromium } from '@playwright/test';

const CODE = (process.argv[2] ?? '').toUpperCase();
const NAME = process.argv[3] ?? 'Bob';
const BASE = process.argv[4] ?? 'http://127.0.0.1:5173';
const SIZES = ['small', 'medium', 'large'];

if (!CODE) {
  console.error('usage: node e2e/join-as-bob.mjs <ROOM_CODE> [name] [baseURL]');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => {
  if (m.type() === 'error') log('[page error]', m.text().slice(0, 200));
});

log(`opening ${BASE}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

await page.getByLabel('Your name').fill(NAME);
await page.getByRole('button', { name: 'Join with a code' }).click();
await page.getByLabel('Room code').fill(CODE);
await page.getByRole('button', { name: 'Join room' }).click();

await page.getByRole('heading', { name: 'Waiting room' }).waitFor({ timeout: 15000 });
log(`joined ${CODE} as ${NAME}`);

await page.getByRole('button', { name: /I'm ready/ }).click();
log('ready — waiting for the host to start');

/** Read the flat board: for each cell, which sizes are already filled. */
const readBoard = () =>
  page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 9; i++) {
      const btn = document.querySelector(`[data-cell="${i}"]`);
      const filled = btn
        ? Array.from(btn.querySelectorAll('.o-tcell__ring'))
            .map((r) => r.getAttribute('data-size'))
            .filter(Boolean)
        : [];
      out.push({ index: i, filled, disabled: btn?.getAttribute('aria-disabled') === 'true' });
    }
    return out;
  });

const myTurn = () =>
  page
    .getByRole('status')
    .first()
    .textContent()
    .then((t) => /your turn/i.test(t ?? ''))
    .catch(() => false);

let played = 0;
for (;;) {
  if (page.isClosed()) break;

  // Game over?
  const over = await page
    .getByRole('heading', { name: /wins|draw|tie/i })
    .isVisible()
    .catch(() => false);
  if (over) {
    const text = await page.getByRole('heading', { name: /wins|draw|tie/i }).textContent();
    log(`game over — ${text?.trim()}`);
    await page.screenshot({ path: 'e2e/screenshots/bob-game-over.png' });
    break;
  }

  if (await myTurn()) {
    const board = await readBoard();
    // Prefer a cell that already has pieces (blocking / nesting) over an empty one.
    const candidates = board
      .filter((c) => !c.disabled && c.filled.length < 3)
      .sort((a, b) => b.filled.length - a.filled.length);

    let placedThisTurn = false;
    for (const cell of candidates) {
      for (const size of SIZES) {
        if (cell.filled.includes(size)) continue;
        try {
          await page.getByRole('radio', { name: new RegExp(`^${size},`, 'i') }).click({ timeout: 2000 });
          const btn = page.locator(`[data-cell="${cell.index}"]`);
          if ((await btn.getAttribute('aria-disabled')) === 'true') continue;
          await btn.click({ timeout: 2000 });
          played++;
          log(`placed ${size} in cell ${cell.index} (move ${played})`);
          placedThisTurn = true;
          break;
        } catch {
          /* that size/cell was not legal after all — try the next */
        }
      }
      if (placedThisTurn) break;
    }
    if (!placedThisTurn) log('my turn but found no legal move — waiting');
    await page.waitForTimeout(1200);
  } else {
    await page.waitForTimeout(900);
  }
}

await page.screenshot({ path: 'e2e/screenshots/bob-final.png' }).catch(() => {});
log('done');
await browser.close();
