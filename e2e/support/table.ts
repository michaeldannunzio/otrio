import { readFileSync } from 'node:fs';
import type { Browser } from '@playwright/test';

import { OtrioApp, type OpenOptions } from './app';

/**
 * A room with everyone in it.
 *
 * One browser *context* per player, never one page in one context: contexts are
 * the storage boundary, and `loadOrCreateIdentity()` persists the player id
 * under `otrio.identity.v1`. Share a context and the second tab reconnects as
 * the first player instead of taking a second seat, which looks like a server
 * bug and is not one.
 */

export interface Table {
  code: string;
  host: OtrioApp;
  apps: OtrioApp[];
  close(): Promise<void>;
}

export interface TableOptions extends OpenOptions {
  /** Seat count for the room. Defaults to the number of names. */
  seats?: 2 | 3 | 4;
  /** Stop in the lobby instead of starting the game. */
  lobbyOnly?: boolean;
}

export async function openTable(
  browser: Browser,
  names: string[],
  options: TableOptions = {},
): Promise<Table> {
  const seats = options.seats ?? (names.length as 2 | 3 | 4);
  const apps: OtrioApp[] = [];

  const close = async () => {
    for (const app of apps) await app.close().catch(() => undefined);
  };

  try {
    const host = await OtrioApp.open(await browser.newContext(), names[0], options);
    apps.push(host);
    const code = await host.createRoom(seats);

    for (const name of names.slice(1)) {
      const guest = await OtrioApp.open(await browser.newContext(), name, options);
      apps.push(guest);
      await guest.joinRoom(code);
    }

    for (const app of apps) await app.markReady();

    if (!options.lobbyOnly) {
      await host.startGame();
      for (const app of apps) {
        await app.expectInGame();
      }
    }

    return { code, host, apps, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/* -------------------------------------------------------------------------- *
 * Load
 * -------------------------------------------------------------------------- */

/**
 * This machine powers off hard when load ramps fast, and four browser contexts
 * are the heaviest thing in this suite. Sampling it is cheap, and the number is
 * the only way anyone can tell whether the ceiling is close.
 */
export function loadAverage(): { one: number; five: number; fifteen: number } {
  const [one, five, fifteen] = readFileSync('/proc/loadavg', 'utf8').split(/\s+/).map(Number);
  return { one, five, fifteen };
}

export function reportLoad(label: string): number {
  const { one, five, fifteen } = loadAverage();
  process.stdout.write(`    load[${label}] 1m=${one} 5m=${five} 15m=${fifteen}\n`);
  return one;
}
