import { useEffect } from 'react';

import {
  buzz,
  getTransport,
  playerBySeat,
  switchToHostedBackend,
  ui,
  useTransportHolder,
} from '../../store';
import { CELL_NAME, describeError, describeWireError, describeWin, SIZE_LABEL } from '../lib/copy';

/**
 * Turns transport events into things a player can see and hear.
 *
 * Mounted once at the root. Everything here is *decoration*: the protocol is
 * explicit that a client which ignored every event would still render a correct
 * board, because a state snapshot always accompanies the change. So nothing in
 * this file is allowed to be load-bearing, and dropping an event must never
 * leave the UI wrong -- only quieter.
 *
 * Centralising it has one concrete payoff: a move rejected by the referee is
 * announced the same way whether the player tapped the 3D board, the flat
 * board, or a keyboard shortcut. The scene layer does not have to own a toast
 * system, and `actions.ts` does not have to carry copy.
 *
 * The rule for what gets spoken: connection *changes* are worth a line,
 * connection *states* are not. Otherwise a flaky café Wi-Fi turns the live
 * region into a metronome and the player switches their screen reader off,
 * which costs them the announcements that actually mattered.
 */
export function useNarration(): void {
  const transport = useTransportHolder((s) => s.transport);

  useEffect(() => {
    if (!transport) return;
    const off: Array<() => void> = [];

    off.push(
      transport.on('playerJoined', ({ player }) => {
        ui.announce(`${player.name} joined.`);
        ui.toast({ tone: 'info', title: `${player.name} joined`, timeout: 3000 });
      }),
    );

    off.push(
      transport.on('playerLeft', ({ name, permanent }) => {
        // "Left" and "dropped out" are different events to a player waiting for
        // their turn, and conflating them is how a room sits confused.
        if (permanent) {
          ui.announce(`${name} left the game.`);
          ui.toast({
            tone: 'warning',
            title: `${name} left`,
            detail: 'Their rings stay on the board. Play carries on without them.',
            timeout: 6000,
            key: `left-${name}`,
          });
        } else {
          ui.announce(`${name} lost connection. Their seat is being held.`);
          ui.toast({
            tone: 'info',
            title: `${name} dropped out`,
            detail: 'Their seat is held while they reconnect.',
            timeout: 6000,
            key: `left-${name}`,
          });
        }
      }),
    );

    off.push(
      transport.on('playerReconnected', ({ name }) => {
        ui.announce(`${name} is back.`);
        ui.toast({ tone: 'success', title: `${name} is back`, timeout: 3000, key: `left-${name}` });
      }),
    );

    off.push(
      transport.on('hostChanged', ({ name }) => {
        // On a peer-to-peer backend this is a referee migration: the device
        // running the rules just changed. Worth saying plainly, because there is
        // usually a visible pause either side of it.
        ui.announce(`${name} is now running the game.`);
        ui.toast({
          tone: 'info',
          title: `${name} is now running the game`,
          detail: 'Play continues from where it left off.',
          timeout: 6000,
          key: 'host',
        });
      }),
    );

    off.push(
      transport.on('gameStarted', () => {
        ui.announce('The game has started.', 'assertive');
        buzz(20);
      }),
    );

    off.push(
      transport.on('gameEnded', ({ reason, winner, line }) => {
        // The result overlay does the detailed announcing; this only covers the
        // endings that are not a win or a draw, which it would otherwise miss.
        if (reason === 'win' && winner !== null) {
          const room = getTransport()?.getSnapshot().room ?? null;
          const name = playerBySeat(room, winner)?.name ?? 'Someone';
          ui.announce(describeWin(line, name), 'assertive');
        }
      }),
    );

    off.push(
      transport.on('moveApplied', ({ seat, move }) => {
        const snapshot = getTransport()?.getSnapshot();
        const room = snapshot?.room ?? null;
        const name = playerBySeat(room, seat)?.name ?? 'Someone';
        const mine = snapshot?.seat === seat;
        if (mine) buzz(8);
        // Polite and terse: this fires on every single turn, so it has to be
        // short enough not to still be speaking when the next one lands.
        ui.announce(
          `${mine ? 'You' : name} played ${SIZE_LABEL[move.size].toLowerCase()} in the ${CELL_NAME[move.cell] ?? `space ${move.cell + 1}`}.`,
        );
      }),
    );

    off.push(
      transport.on('moveRejected', ({ error }) => {
        const copy = describeError(error.code);
        ui.toast({ tone: 'warning', title: copy.title, detail: copy.detail, timeout: 5000, key: 'move' });
        ui.announce(`${copy.title}. ${copy.detail}`, 'assertive');
        buzz([10, 40, 10]);
      }),
    );

    off.push(
      transport.on('roomClosed', () => {
        ui.announce('The room has closed.', 'assertive');
        ui.toast({
          tone: 'warning',
          title: 'The room closed',
          detail: 'Everyone left, or the host ended it.',
          timeout: null,
          key: 'room',
        });
      }),
    );

    off.push(
      transport.on('statusChanged', ({ status, previous }) => {
        // Only the transitions people care about. The banner already shows the
        // current state continuously, so this is purely the "it changed" cue.
        if (status === 'connected' && previous === 'reconnecting') {
          ui.announce('Back online.');
          ui.toast({ tone: 'success', title: 'Back online', timeout: 2500, key: 'link' });
        } else if (status === 'reconnecting' && previous === 'connected') {
          ui.announce('Connection lost. Reconnecting.');
        } else if (status === 'failed') {
          ui.announce('Could not get back to the game.', 'assertive');
        }
      }),
    );

    off.push(
      transport.on('error', (error) => {
        const copy = describeWireError(error);
        const peerFailure =
          error.code === 'PEER_UNREACHABLE' || error.code === 'SIGNALING_FAILED';
        ui.toast({
          tone: error.code === 'PROTOCOL_MISMATCH' ? 'danger' : 'warning',
          title: copy.title,
          detail: copy.detail,
          technical: copy.technical,
          // A fatal error must not time out from under the player, and neither
          // should one carrying an action they might want to read first.
          timeout: peerFailure || !copy.retry ? null : 6000,
          key: `err-${error.code}`,
          action:
            error.code === 'PROTOCOL_MISMATCH'
              ? { label: 'Reload', run: () => window.location.reload() }
              : peerFailure
                ? { label: 'Use hosted', run: () => void switchToHostedBackend() }
                : undefined,
        });
      }),
    );

    return () => {
      for (const unsubscribe of off) unsubscribe();
    };
  }, [transport]);
}
