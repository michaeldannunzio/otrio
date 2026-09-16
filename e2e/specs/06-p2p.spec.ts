import { expect, test } from '@playwright/test';

import { OtrioApp } from '../support/app';
import { capture } from '../support/pixels';

/**
 * The peer-to-peer backend.
 *
 * `?net=p2p` is read in `src/main.tsx` and builds `createRtcTransport` instead
 * of the WebSocket one. Two peers then find each other through a signalling
 * relay before any data channel exists, and the referee is an elected host peer
 * rather than the server.
 *
 * Two things have to be true before any of that can be tested, and they fail
 * differently, so they are separated here:
 *
 *   1. A secure context, or `RTCPeerConnection` does not exist at all. Headless
 *      Chromium on http://127.0.0.1 IS a secure context — localhost is on the
 *      trustworthy-origin list — so this is not the blocker people expect.
 *      `docs/WEBRTC.md` and `vite.config.ts` describe an HTTPS dev server for
 *      phones on the LAN, which is a different problem: http://192.168.x.x is
 *      not secure and RTCPeerConnection really is absent there.
 *
 *   2. A signalling relay to exchange offers and ICE candidates.
 *
 * The first test establishes (1) without needing a room. The second attempts a
 * real two-peer game and will only pass once (2) exists.
 */

test.describe('WebRTC peer-to-peer', () => {
  test('a headless page on 127.0.0.1 is a secure context with WebRTC available', async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const app = await OtrioApp.open(ctx, 'Ada', { query: 'net=p2p' });
    try {
      const capabilities = await app.page.evaluate(() => ({
        secure: window.isSecureContext,
        rtc: typeof RTCPeerConnection !== 'undefined',
        dataChannel:
          typeof RTCPeerConnection !== 'undefined' &&
          typeof RTCPeerConnection.prototype.createDataChannel === 'function',
        origin: window.location.origin,
      }));
      test.info().annotations.push({ type: 'webrtc', description: JSON.stringify(capabilities) });

      expect(capabilities.secure, 'http://127.0.0.1 should be a secure context').toBe(true);
      expect(capabilities.rtc, 'RTCPeerConnection is missing').toBe(true);
      expect(capabilities.dataChannel).toBe(true);

      // The transport that a missing WebRTC stack would produce is a hard boot
      // error, not a silent downgrade. Its absence means the P2P backend
      // constructed.
      await expect(
        app.page.getByText(/Networking (failed to start|is not available)/i),
      ).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('the signalling endpoint answers a peer join', async ({ browser }) => {
    /*
     * Before two peers can exchange an SDP offer they have to find each other.
     * `resolveSignalingUrl()` in src/net/signaling.ts dials
     * ws://<host>:8787/signal and sends `{t:'join', room, peer, name}`, expecting
     * `{t:'welcome', ...}` back. This asks the running server that question
     * directly, because a failure here explains every P2P failure downstream and
     * a failure downstream explains nothing.
     */
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto('/');
      const reply = await page.evaluate(async () => {
        const ws = new WebSocket('ws://127.0.0.1:8787/signal');
        return new Promise<{ outcome: string; frame?: string }>((resolve) => {
          const done = setTimeout(() => resolve({ outcome: 'timeout' }), 8_000);
          ws.onopen = () =>
            ws.send(
              JSON.stringify({ t: 'join', room: 'TESTRM', peer: 'e2e-probe', name: 'probe' }),
            );
          ws.onmessage = (event) => {
            clearTimeout(done);
            resolve({ outcome: 'message', frame: String(event.data) });
            ws.close();
          };
          ws.onerror = () => {
            clearTimeout(done);
            resolve({ outcome: 'error' });
          };
          ws.onclose = () => {
            clearTimeout(done);
            resolve({ outcome: 'closed' });
          };
        });
      });
      test.info().annotations.push({ type: 'signal-reply', description: JSON.stringify(reply) });

      expect(
        reply.frame ?? reply.outcome,
        'the /signal endpoint did not answer a signalling join with a welcome',
      ).toContain('"t":"welcome"');
    } finally {
      await ctx.close();
    }
  });

  test('two peers open a room and play over a data channel', async ({ browser }) => {
    test.setTimeout(180_000);
    const hostCtx = await browser.newContext();
    const guestCtx = await browser.newContext();
    const host = await OtrioApp.open(hostCtx, 'Ada', { query: 'net=p2p', pinTextBoard: true });
    const guest = await OtrioApp.open(guestCtx, 'Grace', { query: 'net=p2p', pinTextBoard: true });

    try {
      const code = await host.createRoom(2);
      await guest.joinRoom(code);
      await host.markReady();
      await guest.markReady();
      await host.startGame();
      await host.expectInGame();
      await guest.expectInGame();

      const apps = [host, guest];
      const mover = (await host.isMyTurn()) ? host : guest;
      await mover.place(4, 'large');
      for (const app of apps) await expect.poll(() => app.pieceCount()).toBe(1);

      const shot = await capture(host.page, '14-p2p-game');
      test.info().annotations.push({ type: 'screenshot', description: shot });
    } catch (error) {
      // Make the diagnosis part of the failure rather than something to go and
      // find: the console tells you whether signalling or ICE is the problem.
      test.info().annotations.push({
        type: 'console-host',
        description: host.consoleLog.slice(-25).join('\n'),
      });
      test.info().annotations.push({
        type: 'console-guest',
        description: guest.consoleLog.slice(-25).join('\n'),
      });
      await capture(host.page, '14-p2p-failed-host');
      await capture(guest.page, '14-p2p-failed-guest');
      throw error;
    } finally {
      await hostCtx.close();
      await guestCtx.close();
    }
  });
});
