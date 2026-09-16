import type { Page } from '@playwright/test';

/**
 * A game link you can cut, from inside the page.
 *
 * Two approaches were tried before this one, and both lie:
 *
 *  - `context.setOffline(true)` does not tear down an already-established
 *    WebSocket to 127.0.0.1. Measured here: pings kept flowing and neither end
 *    ever noticed.
 *  - `context.routeWebSocket` + `WebSocketRoute.close()` closes *one side*.
 *    Closing the page side leaves the proxy's own connection to the server
 *    open, so the server sees a healthy client, never starts the reconnect
 *    grace and never tells the other players anything. The dropped client shows
 *    its banner while the survivor plays on — which reads as a server bug and
 *    is entirely the harness.
 *
 * So this wraps `window.WebSocket` instead. Cutting closes the real socket, so
 * the server gets a real close frame and starts its real 45s grace; and while
 * severed, new game sockets are pointed at a dead port so the client's own
 * reconnect backoff runs against a genuine connection failure.
 *
 * Only sockets to the game server are touched. Vite's HMR socket is on another
 * port and must keep working, or the page never loads.
 */

declare global {
  interface Window {
    __otrioLink?: { offline: boolean; opened: number; live: WebSocket[] };
  }
}

/** Serialised into the page, so it must be self-contained. */
function installLink(gamePort: string): void {
  const Native = window.WebSocket;
  const state = { offline: false, opened: 0, live: [] as WebSocket[] };
  window.__otrioLink = state;

  // Port 9 is discard; nothing listens, so the connection is refused at once —
  // which is what "the network is gone" looks like to a browser.
  const DEAD = 'ws://127.0.0.1:9/otrio-severed';

  const patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const target = String(url);
    const isGame = target.includes(`:${gamePort}`);
    const socket =
      protocols === undefined
        ? new Native(isGame && state.offline ? DEAD : target)
        : new Native(isGame && state.offline ? DEAD : target, protocols);
    if (isGame && !state.offline) {
      state.opened += 1;
      state.live.push(socket);
      socket.addEventListener('close', () => {
        state.live = state.live.filter((s) => s !== socket);
      });
    }
    return socket;
  } as unknown as typeof WebSocket;

  patched.prototype = Native.prototype;
  Object.defineProperties(patched, {
    CONNECTING: { value: Native.CONNECTING },
    OPEN: { value: Native.OPEN },
    CLOSING: { value: Native.CLOSING },
    CLOSED: { value: Native.CLOSED },
  });
  window.WebSocket = patched;
}

export class SeverableLink {
  private constructor(private readonly page: Page) {}

  /** Must be installed before the page navigates. */
  static async install(page: Page, gamePort = '8787'): Promise<SeverableLink> {
    await page.addInitScript(installLink, gamePort);
    return new SeverableLink(page);
  }

  /** How many game sockets the page has opened. Reconnects increment it. */
  async connectionCount(): Promise<number> {
    return this.page.evaluate(() => window.__otrioLink?.opened ?? 0);
  }

  async cut(): Promise<void> {
    await this.page.evaluate(() => {
      const state = window.__otrioLink;
      if (!state) return;
      state.offline = true;
      /* 4999, not 1000: the transport treats 1008 and 4000-4099 (except 4004)
         as fatal and stops retrying. A drop should be recoverable. */
      for (const socket of state.live) socket.close(4999, 'e2e severed');
      state.live = [];
    });
  }

  /** Let the client's own backoff find its way home. */
  async heal(): Promise<void> {
    await this.page.evaluate(() => {
      if (window.__otrioLink) window.__otrioLink.offline = false;
    });
  }
}
