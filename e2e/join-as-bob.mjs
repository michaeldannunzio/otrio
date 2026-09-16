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

/**
 * Persistent profile, deliberately. Identity lives in localStorage, so a fresh
 * browser is a fresh player -- restarting Bob without this abandons his seat and
 * the room refuses him back once the game has started. With it, a restart inside
 * the reconnect grace reclaims the same seat.
 */
const PROFILE = '/tmp/claude-1000/-home-sentinel-projects/8bd5e4a6-084d-421e-b7fa-42e6fdb3fdd5/scratchpad/bob-profile';
const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  viewport: { width: 1280, height: 900 },
});
const page = browser.pages()[0] ?? (await browser.newPage());
page.on('console', (m) => {
  if (m.type() === 'error') log('[page error]', m.text().slice(0, 200));
});

log(`opening ${BASE}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });

/**
 * Three possible landings, because the profile persists: already in the game,
 * already in the lobby, or the home screen. Resuming is the normal case after a
 * restart -- filling the name form then would race a screen that is about to
 * unmount, which is how this failed before.
 */
const where = async () => {
  if ((await page.locator('[data-cell]').count().catch(() => 0)) > 0) return 'game';
  if (await page.getByRole('heading', { name: 'Waiting room' }).isVisible().catch(() => false)) return 'lobby';
  if (await page.getByLabel('Your name').isVisible().catch(() => false)) return 'home';
  return 'unknown';
};

let at = 'unknown';
for (let i = 0; i < 40; i++) {
  at = await where();
  if (at !== 'unknown') break;
  await page.waitForTimeout(400);
}
log(`landed on: ${at}`);

if (at === 'home') {
  await page.getByLabel('Your name').fill(NAME);
  await page.getByRole('button', { name: 'Join with a code' }).click();
  await page.getByLabel('Room code').fill(CODE);
  await page.getByRole('button', { name: 'Join room' }).click();
  for (let i = 0; i < 60; i++) {
    at = await where();
    if (at === 'lobby' || at === 'game') break;
    await page.waitForTimeout(500);
  }
}

if (at !== 'lobby' && at !== 'game') {
  await page.screenshot({ path: 'e2e/screenshots/bob-join-failed.png' });
  const err = await page.locator('[role=alert], .o-field__error, .o-banner').allTextContents().catch(() => []);
  log('JOIN FAILED:', JSON.stringify(err.slice(0, 3)));
  await browser.close();
  process.exit(1);
}

const inLobby = at === 'lobby';
log(`joined ${CODE} as ${NAME} — ${at}`);

if (inLobby) {
  await page.getByRole('button', { name: /I'm ready/ }).click();
  log('ready — waiting for the host to start');
} else {
  log('game already in progress — resuming');
}

/**
 * Read the flat board from each cell's accessible name, not from its inner
 * markup. The name is a full sentence the UI guarantees for screen readers --
 * "top left. small red, Bob, medium free, large free." -- so it is the most
 * stable thing on the element. Reading `.o-tcell__ring` instead silently
 * reported every cell as empty, which made a successful move look like a
 * failed one.
 */
const readBoard = () =>
  page.locator('[data-cell]').evaluateAll((nodes) =>
    nodes
      .map((n) => {
        const label = (n.getAttribute('aria-label') ?? '').toLowerCase();
        const filled = ['small', 'medium', 'large'].filter(
          (sz) => label.includes(sz) && !label.includes(`${sz} free`),
        );
        return {
          index: Number(n.getAttribute('data-cell')),
          filled,
          disabled: n.getAttribute('aria-disabled') === 'true',
        };
      })
      .sort((a, b) => a.index - b.index),
  );

const myTurn = async () => {
  const enabled = await page
    .locator('[data-cell]:not([aria-disabled="true"])')
    .count()
    .catch(() => 0);
  if (enabled > 0) return true;
  const texts = await page.getByRole('status').allTextContents().catch(() => []);
  return texts.some((t) => /your turn/i.test(t));
};

let lastSeen = '';
const debugState = async () => {
  const texts = await page.getByRole('status').allTextContents().catch(() => []);
  const enabled = await page.locator('[data-cell]:not([aria-disabled="true"])').count().catch(() => 0);
  const line = `status=${JSON.stringify(texts.slice(0, 3))} enabledCells=${enabled}`;
  if (line !== lastSeen) { log(line); lastSeen = line; }
};

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

    // Arm the size with the keyboard rather than by matching a radio's accessible
    // name -- the flat board documents 1/2/3 itself, and a key press cannot drift
    // the way a label can.
    const SIZE_KEY = { small: '1', medium: '2', large: '3' };

    for (const cell of candidates) {
      for (const size of SIZES) {
        if (cell.filled.includes(size)) continue;
        const btn = page.locator(`[data-cell="${cell.index}"]`);
        try {
          await btn.focus({ timeout: 1500 });
          await page.keyboard.press(SIZE_KEY[size]);
          await page.waitForTimeout(150);
          if ((await btn.getAttribute('aria-disabled')) === 'true') continue;
          await btn.press('Enter', { timeout: 1500 });
          await page.waitForTimeout(400);
          const after = await readBoard();
          if (after[cell.index].filled.includes(size)) {
            played++;
            log(`placed ${size} in cell ${cell.index} (move ${played})`);
            placedThisTurn = true;
            break;
          }
        } catch (e) {
          /* not legal after all, or the control moved -- try the next */
        }
      }
      if (placedThisTurn) break;
    }

    if (!placedThisTurn) {
      const radios = await page.getByRole('radio').allTextContents().catch(() => []);
      const names = await page.locator('[data-cell]').evaluateAll(
        (ns) => ns.slice(0, 3).map((n) => `${n.getAttribute('data-cell')}:${n.getAttribute('aria-disabled')}:${(n.getAttribute('aria-label') ?? '').slice(0, 50)}`),
      ).catch(() => []);
      log('DIAG radios:', JSON.stringify(radios.slice(0, 5)));
      log('DIAG cells:', JSON.stringify(names));
    }
    if (!placedThisTurn) log('my turn but found no legal move — waiting');
    await page.waitForTimeout(1200);
  } else {
    await debugState();
    await page.waitForTimeout(900);
  }
}

await page.screenshot({ path: 'e2e/screenshots/bob-final.png' }).catch(() => {});
log('done');
await browser.close();
