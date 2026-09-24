/**
 * The single-device backend, driven exactly as the UI will drive it.
 *
 * Every test here goes through the public `Transport` surface — no reaching
 * into the class, no stubbed referee. What is being proved is that one
 * `PeerReferee`, fed synthetic identities, plays real Otrio: if these pass, the
 * rules the hot seat obeys are the same rules the hosted and peer-to-peer
 * backends obey, because they are literally the same code.
 *
 * MOVE GENERATION IS BORROWED, NOT WRITTEN
 * ----------------------------------------
 * A test that picked its own moves would be a second rules implementation, and
 * a second one is exactly what this feature exists not to have. So legal moves
 * come from the engine itself: `rehydrateEngine` (referee.ts) turns the wire
 * `RoomState` back into an `EngineState`, and `legalMoves` (src/game) says what
 * may be played. Both are existing exports with one owner each.
 */

import { describe, expect, it } from 'vitest';

import { createLocalTransport } from './localTransport';
import { rehydrateEngine } from './referee';
import {
  ALL_COLORS,
  isLocalRoomCode,
  isPlausibleRoomCode,
  normalizeRoomCode,
  type Move,
  type PlayerColor,
  type RoomState,
  type Seat,
} from './protocol';
import {
  LOCAL_CAPABILITIES,
  type Identity,
  type LocalSeatNames,
  type Transport,
  type TransportError,
} from './transport';
import { TWO_PLAYER_COLOR_PAIRS, applyMove, legalMoves } from '../game/index.ts';

/* ========================================================================== *
 * Harness
 * ========================================================================== */

/**
 * A fixed identity, so a test never touches `loadOrCreateIdentity` and
 * therefore never touches storage. `name` is deliberately *not* any seat name:
 * seat 0 must be renamed from `seatNames[0]`, and if that ever regresses this
 * string is what shows up in the failure.
 */
function testIdentity(): Identity {
  return {
    playerId: 'device-player-id',
    sessionSecret: 'device-session-secret',
    name: 'PersistedOnlineName',
  };
}

function makeTransport(seatNames: LocalSeatNames): Transport {
  return createLocalTransport({ identity: testIdentity(), seatNames });
}

/** `createRoom` + `startGame`, which is the whole of the UI's opening sequence. */
async function startedGame(seatNames: LocalSeatNames): Promise<Transport> {
  const transport = makeTransport(seatNames);
  await transport.connect();
  await transport.createRoom();
  await transport.startGame();
  return transport;
}

function room(transport: Transport): RoomState {
  const state = transport.getSnapshot().room;
  if (!state) throw new Error('expected a room');
  return state;
}

function game(transport: Transport): NonNullable<RoomState['game']> {
  const snapshot = room(transport).game;
  if (!snapshot) throw new Error('expected a game');
  return snapshot;
}

/**
 * Pick a move that ends the game if one is available, else the first legal one.
 *
 * Win-seeking rather than first-legal because the room code is random, so every
 * run opens on a different seat and a fixed policy would win on some runs and
 * draw on others — a test that is right four times in five is not a test. The
 * lookahead uses the engine's own `applyMove`, so it is still not a second rules
 * implementation.
 */
function chooseMove(state: RoomState): Move {
  const engine = rehydrateEngine(state);
  const options = legalMoves(engine);
  if (options.length === 0) throw new Error('a playing game with no legal move — engine bug');
  for (const candidate of options) {
    if (applyMove(engine, candidate).status === 'won') {
      return { cell: candidate.space, size: candidate.size, color: candidate.player };
    }
  }
  const first = options[0];
  return { cell: first.space, size: first.size, color: first.player };
}

interface TurnRecord {
  readonly seat: Seat;
  readonly colors: readonly PlayerColor[];
  readonly playerId: string;
  readonly isMyTurn: boolean;
  readonly snapshotSeat: Seat | null;
}

/**
 * Play the game out through the transport, recording who was on turn and what
 * the transport claimed about itself at that moment.
 */
async function playToEnd(transport: Transport, maxTurns = 40): Promise<TurnRecord[]> {
  const turns: TurnRecord[] = [];
  for (let i = 0; i < maxTurns; i += 1) {
    const state = room(transport);
    if (state.game === null || state.game.phase !== 'playing') break;
    const snapshot = transport.getSnapshot();
    turns.push({
      seat: state.game.turn,
      colors: state.game.turnColors,
      playerId: snapshot.playerId,
      isMyTurn: snapshot.isMyTurn,
      snapshotSeat: snapshot.seat,
    });
    await transport.sendMove(chooseMove(state));
  }
  return turns;
}

async function rejection(promise: Promise<unknown>): Promise<TransportError> {
  try {
    await promise;
  } catch (err) {
    return err as TransportError;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/* ========================================================================== *
 * The no-lobby room
 * ========================================================================== */

describe('createRoom seats everybody, with no lobby', () => {
  it('seats every configured name, readies them, and leaves seat 0 hosting', async () => {
    const transport = makeTransport(['Ann', 'Ben', 'Cal']);
    const code = await transport.createRoom();

    const state = room(transport);
    expect(state.phase).toBe('lobby');
    expect(state.code).toBe(code);
    expect(state.maxPlayers).toBe(3);
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cal']);
    expect(state.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(state.players[0].isHost).toBe(true);
    expect(state.players.slice(1).every((p) => p.ready)).toBe(true);
    // Seat 0 is exempt in `onStartGame` and `create` leaves it unready; the
    // game starting is the proof that this is fine.
    expect(state.spectators).toEqual([]);
  });

  /**
   * Seat 0 is named from `RefereeHost.name`, so passing the device identity
   * through unchanged would silently name it after the player's persisted
   * *online* name while every other seat took its configured one.
   */
  it('names seat 0 from seatNames[0], not from the device identity', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    await transport.createRoom();
    expect(room(transport).players[0].name).toBe('Ann');
    expect(room(transport).players[0].name).not.toBe(testIdentity().name);
  });

  it('starts without the caller ever touching setReady', async () => {
    const transport = makeTransport(['Ann', 'Ben', 'Cal']);
    await transport.createRoom();
    await expect(transport.startGame()).resolves.toBeUndefined();
    expect(room(transport).phase).toBe('playing');
  });

  it('keeps the turn clock off, so tick() can never auto-play for a thinking player', async () => {
    const transport = await startedGame(['Ann', 'Ben', 'Cal']);
    expect(room(transport).turnDeadline).toBeNull();
  });

  it('exposes LOCAL_CAPABILITIES itself rather than a copy of it', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    expect(transport.capabilities).toBe(LOCAL_CAPABILITIES);
    await transport.createRoom();
    expect(transport.getSnapshot().capabilities).toBe(LOCAL_CAPABILITIES);
  });
});

describe('the local room code', () => {
  /**
   * The suffix is not decoration. `hashSeed(code, seq)` decides who opens, and
   * `seq` at `startGame` is deterministic on one device — so a fixed code would
   * open every game on the same seat, against RULES.md §4.8's "be sure to
   * alternate which player goes first".
   */
  it('differs between two consecutive createRoom calls', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    const first = await transport.createRoom();
    const second = await transport.createRoom();
    expect(first).not.toBe(second);
    expect(isLocalRoomCode(first)).toBe(true);
    expect(isLocalRoomCode(second)).toBe(true);
  });

  it('does not always open on the same seat', async () => {
    const openers = new Set<Seat>();
    for (let i = 0; i < 25; i += 1) {
      const transport = await startedGame(['Ann', 'Ben']);
      openers.add(game(transport).turn);
      transport.dispose();
    }
    // Two seats, 25 independent codes: seeing only one opener would mean the
    // seed is not varying at all.
    expect(openers.size).toBe(2);
  });

  it('is never normalised, and is not mistakable for an online code', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    const code = await transport.createRoom();
    expect(isLocalRoomCode(code)).toBe(true);
    // The trap this guards: normalising folds L->1 and O->0, after which the
    // code is still well formed and no longer recognisable as local.
    expect(isLocalRoomCode(normalizeRoomCode(code))).toBe(false);
    // Pasted into an online join box it fails locally, with no round trip.
    expect(isPlausibleRoomCode(code)).toBe(false);
  });
});

/* ========================================================================== *
 * The hot seat
 * ========================================================================== */

describe('a three-player game, played to a win', () => {
  /**
   * This is also the regression test for the `onJoin` guard at
   * `referee.ts:371`. Before that line accepted an exact code match, seats 1
   * and 2 could not join a 'LOCAL…' room at all and this test could not reach
   * its first move.
   */
  it('rotates the active seat every turn and finishes with a winner', async () => {
    const transport = await startedGame(['Ann', 'Ben', 'Cal']);
    const players = room(transport).players;

    const turns = await playToEnd(transport);
    const final = game(transport);

    expect(final.phase).toBe('finished');
    expect(final.winner).not.toBeNull();
    expect(room(transport).endReason).toBe('win');
    expect(turns.length).toBeGreaterThan(3);

    // The identity the transport reports IS the seat on turn, every turn.
    for (const turn of turns) {
      expect(turn.playerId).toBe(players[turn.seat].playerId);
      expect(turn.snapshotSeat).toBe(turn.seat);
      expect(turn.isMyTurn).toBe(true);
    }

    // Three seats in a fixed cycle: consecutive turns are never the same seat.
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i].seat).not.toBe(turns[i - 1].seat);
    }

    // And the identity really did move — not one id for the whole game.
    expect(new Set(turns.map((t) => t.playerId)).size).toBe(3);
  });

  it('reports the finished game against seat 0, which owns the rematch', async () => {
    const transport = await startedGame(['Ann', 'Ben', 'Cal']);
    await playToEnd(transport);

    const snapshot = transport.getSnapshot();
    const players = room(transport).players;
    // `GameSnapshot.turn` is documented meaningless once finished, so the
    // active seat falls back to seat 0 rather than following it.
    expect(snapshot.playerId).toBe(players[0].playerId);
    expect(snapshot.seat).toBe(0);
    expect(snapshot.isHost).toBe(true);
    expect(snapshot.isMyTurn).toBe(false);
  });

  it('refuses a move once the game is over, with GAME_NOT_ACTIVE', async () => {
    const transport = await startedGame(['Ann', 'Ben', 'Cal']);
    await playToEnd(transport);
    const error = await rejection(transport.sendMove({ cell: 0, size: 'small' }));
    expect(error.code).toBe('GAME_NOT_ACTIVE');
    expect(transport.getSnapshot().pendingMove).toBeNull();
  });
});

/* ========================================================================== *
 * The official two-player game — RULES.md §4.6
 * ========================================================================== */

describe('the official two-player game', () => {
  /**
   * RULES.md §4.6: in a 2-player game a player MUST strictly alternate which of
   * their two colours they play on successive turns. §4.7: colours never
   * combine for a win. The transport does nothing to arrange this — the referee
   * builds the engine config from the seat count — so this test is really
   * asking whether driving the shared referee from one device still produces
   * the printed rule.
   */
  it('gives each of the two seats two colours, on the rulebook pairing', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    const players = room(transport).players;
    const [pairA, pairB] = TWO_PLAYER_COLOR_PAIRS;

    expect(players).toHaveLength(2);
    expect(players[0].colors).toEqual([...pairA]);
    expect(players[1].colors).toEqual([...pairB]);
    // All four colours are in play with only two people at the table.
    expect(game(transport).colorsInPlay).toEqual([...ALL_COLORS]);
  });

  it('alternates the seat every turn and the colour within each seat', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    const players = room(transport).players;
    const turns = await playToEnd(transport);

    expect(turns.length).toBeGreaterThan(4);

    // One colour is due per turn — strict alternation leaves no choice, which
    // is why `Move.color` may be omitted.
    for (const turn of turns) {
      expect(turn.colors).toHaveLength(1);
    }

    // The seat alternates: rotation is [s0, s1, s0, s1].
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i].seat).not.toBe(turns[i - 1].seat);
    }

    // And within one seat, the colour alternates between exactly its two.
    for (const player of players) {
      const mine = turns.filter((t) => t.seat === player.seat).map((t) => t.colors[0]);
      expect(mine.length).toBeGreaterThan(1);
      for (let i = 1; i < mine.length; i += 1) {
        expect(mine[i]).not.toBe(mine[i - 1]);
      }
      expect(new Set(mine).size).toBe(2);
      for (const color of mine) {
        expect(player.colors).toContain(color);
      }
    }

    // The hot seat tracked the seat, not the colour: two identities, not four.
    expect(new Set(turns.map((t) => t.playerId)).size).toBe(2);
  });

  it('wins within a single colour, never across the two a seat holds', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    await playToEnd(transport);
    const final = game(transport);

    if (final.winner === null) {
      // A draw is a legal outcome; there is simply nothing to check about a
      // winning line that does not exist.
      expect(final.isDraw).toBe(true);
      return;
    }
    const line = final.winningLine;
    expect(line).not.toBeNull();
    expect(line!.seat).toBe(final.winner);
    // Every piece in the line is the one colour named on the line.
    expect(final.winnerColor).toBe(line!.color);
  });
});

/* ========================================================================== *
 * The methods that behave differently here
 * ========================================================================== */

describe('method deltas', () => {
  it('rejects joinRoom with UNSUPPORTED, even for the code it just minted', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    const code = await transport.createRoom();

    const bare = await rejection(transport.joinRoom(code));
    expect(bare.code).toBe('UNSUPPORTED');
    // Not ROOM_NOT_FOUND: a retryable-looking rejection invites a retry loop
    // that can never succeed. UNSUPPORTED is not in RETRYABLE_CODES.
    expect(bare.retryable).toBe(false);

    const spectating = await rejection(transport.joinRoom(code, { asSpectator: true }));
    expect(spectating.code).toBe('UNSUPPORTED');

    const nonsense = await rejection(transport.joinRoom('not-a-code'));
    expect(nonsense.code).toBe('UNSUPPORTED');

    // The room it already had is untouched by any of that.
    expect(room(transport).players).toHaveLength(2);
  });

  it('rejects setName with UNSUPPORTED and leaves every seat name alone', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    const error = await rejection(transport.setName('Zoe'));
    expect(error.code).toBe('UNSUPPORTED');
    expect(room(transport).players.map((p) => p.name)).toEqual(['Ann', 'Ben']);
  });

  it('resolves setReady as a no-op', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    await expect(transport.setReady(true)).resolves.toBeUndefined();
    await expect(transport.setReady(false)).resolves.toBeUndefined();
    expect(room(transport).phase).toBe('playing');
  });

  it('resolves resync without changing anything', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    const before = transport.getSnapshot();
    await expect(transport.resync()).resolves.toBeUndefined();
    expect(transport.getSnapshot()).toBe(before);
  });
});

describe('requestRematch', () => {
  it('starts a new game from a single call, with no second player to answer', async () => {
    const transport = await startedGame(['Ann', 'Ben', 'Cal']);
    await playToEnd(transport);
    expect(game(transport).phase).toBe('finished');

    const seatsBefore = room(transport).players.map((p) => p.playerId);
    const seqBefore = room(transport).seq;

    await expect(transport.requestRematch(true)).resolves.toBeUndefined();

    const after = room(transport);
    expect(after.phase).toBe('playing');
    expect(after.game?.phase).toBe('playing');
    expect(after.game?.moveCount).toBe(0);
    expect(after.rematch).toBeNull();
    // Same seats, same code, and `seq` keeps climbing — clients discard
    // anything that does not move it forward.
    expect(after.players.map((p) => p.playerId)).toEqual(seatsBefore);
    expect(after.seq).toBeGreaterThan(seqBefore);

    // The board really is playable again.
    const turns = await playToEnd(transport);
    expect(turns.length).toBeGreaterThan(0);
  });

  it('rejects GAME_NOT_ACTIVE while the game is still running', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    const error = await rejection(transport.requestRematch(true));
    expect(error.code).toBe('GAME_NOT_ACTIVE');
  });

  it('clears the offer on a decline', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    await playToEnd(transport);
    await expect(transport.requestRematch(false)).resolves.toBeUndefined();
    expect(room(transport).rematch).toBeNull();
    expect(room(transport).phase).toBe('finished');
  });
});

/* ========================================================================== *
 * Snapshot discipline — what useSyncExternalStore needs
 * ========================================================================== */

describe('snapshot discipline', () => {
  it('returns an identical reference until something changes', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    expect(transport.getSnapshot()).toBe(transport.getSnapshot());

    await transport.createRoom();
    const seated = transport.getSnapshot();
    expect(transport.getSnapshot()).toBe(seated);

    await transport.startGame();
    expect(transport.getSnapshot()).not.toBe(seated);
  });

  it('notifies once per command, not once per referee message', async () => {
    const transport = makeTransport(['Ann', 'Ben', 'Cal']);
    let notifications = 0;
    transport.subscribe(() => {
      notifications += 1;
    });

    // Seating three players is one join and one setReady per non-host seat,
    // each of which bumps the referee's state: eight messages, one snapshot.
    await transport.createRoom();
    expect(notifications).toBe(1);

    await transport.startGame();
    expect(notifications).toBe(2);

    await transport.sendMove(chooseMove(room(transport)));
    expect(notifications).toBe(3);
  });

  it('lets a subscriber unsubscribe, idempotently', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    let notifications = 0;
    const off = transport.subscribe(() => {
      notifications += 1;
    });
    off();
    off();
    await transport.createRoom();
    expect(notifications).toBe(0);
  });

  it('clears pendingMove by the time sendMove settles', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    await transport.sendMove(chooseMove(room(transport)));
    expect(transport.getSnapshot().pendingMove).toBeNull();
  });
});

/* ========================================================================== *
 * Events
 * ========================================================================== */

describe('events', () => {
  it('emits gameStarted, moveApplied and gameEnded, and isolates a throwing handler', async () => {
    const transport = await startedGame(['Ann', 'Ben', 'Cal']);
    const seen: string[] = [];

    transport.on('moveApplied', () => seen.push('moveApplied'));
    transport.on('gameEnded', () => seen.push('gameEnded'));
    transport.on('moveApplied', () => {
      throw new Error('a badly behaved listener');
    });
    transport.on('moveApplied', () => seen.push('still-called'));

    await playToEnd(transport);

    expect(seen.filter((s) => s === 'moveApplied').length).toBeGreaterThan(0);
    // The throwing handler sits between the two, and did not stop the second.
    expect(seen).toContain('still-called');
    expect(seen).toContain('gameEnded');
  });

  it('emits statusChanged for every transition on connect', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    const transitions: string[] = [];
    transport.on('statusChanged', (e) => transitions.push(`${e.previous}->${e.status}`));

    await transport.connect();
    expect(transitions).toEqual(['idle->connecting', 'connecting->connected']);
    expect(transport.getSnapshot().status).toBe('connected');

    // Idempotent: a second connect is not a second pair of transitions.
    await transport.connect();
    expect(transitions).toHaveLength(2);
  });

  /**
   * Arthur's question, settled without a browser.
   *
   * The contract pins this backend's transitions as `idle → connecting →
   * connected` (SINGLE-DEVICE BACKEND, and the diagram on `ConnectionStatus`),
   * so `connecting` must be emitted — and `describeLink('connecting')` has
   * `banner: true`, which raised the worry that "Connecting to the game…" could
   * flash for a frame on a game that connects to nothing.
   *
   * It cannot, and the reason is structural rather than lucky:
   * `ConnectionBanner` renders from the snapshot, and both transitions happen
   * inside one `connect()` call which flushes once, at the end. So subscribers
   * are notified exactly once and the snapshot they read already says
   * `connected`. `connecting` exists only as an event payload, and events are
   * decoration that no banner reads. If someone later flushes per transition,
   * this test fails rather than the banner flickering on a phone.
   */
  it('never publishes a snapshot in the connecting state', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    const published: string[] = [];
    transport.subscribe(() => published.push(transport.getSnapshot().status));

    await transport.connect();
    await transport.createRoom();

    expect(published).not.toContain('connecting');
    expect(published[0]).toBe('connected');
    expect(transport.getSnapshot().status).toBe('connected');
  });

  it('gives an event handler a snapshot that already reflects the event', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    let seatAtEvent: Seat | null = null;
    let moveCountAtEvent = -1;
    transport.on('moveApplied', (e) => {
      seatAtEvent = e.seat;
      moveCountAtEvent = transport.getSnapshot().room?.game?.moveCount ?? -1;
    });

    const openingSeat = game(transport).turn;
    await transport.sendMove(chooseMove(room(transport)));

    expect(seatAtEvent).toBe(openingSeat);
    expect(moveCountAtEvent).toBe(1);
  });
});

/* ========================================================================== *
 * Lifecycle
 * ========================================================================== */

describe('lifecycle', () => {
  it('ends the room on leaveRoom and allows another game after it', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    let closed = 0;
    transport.on('roomClosed', () => {
      closed += 1;
    });

    await transport.leaveRoom();
    expect(transport.getSnapshot().room).toBeNull();
    expect(transport.getSnapshot().role).toBe('none');
    expect(closed).toBe(1);

    // Harmless when not in a room.
    await expect(transport.leaveRoom()).resolves.toBeUndefined();
    expect(closed).toBe(1);

    await transport.createRoom();
    expect(room(transport).players).toHaveLength(2);
  });

  it('is terminal after dispose, and dispose is repeatable', async () => {
    const transport = await startedGame(['Ann', 'Ben']);
    transport.dispose();
    expect(transport.getSnapshot().status).toBe('closed');
    transport.dispose();
    expect(transport.getSnapshot().status).toBe('closed');

    const error = await rejection(transport.sendMove({ cell: 0, size: 'small' }));
    expect(error.code).toBe('CONNECTION_LOST');
  });

  it('rejects commands before a room exists with NOT_IN_ROOM', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    await transport.connect();
    expect((await rejection(transport.startGame())).code).toBe('NOT_IN_ROOM');
    expect((await rejection(transport.sendMove({ cell: 0, size: 'small' }))).code).toBe(
      'NOT_IN_ROOM',
    );
    expect((await rejection(transport.requestRematch(true))).code).toBe('NOT_IN_ROOM');
  });

  it('retains the last error and clears it on the next successful command', async () => {
    const transport = makeTransport(['Ann', 'Ben']);
    await rejection(transport.setName('Zoe'));
    expect(transport.getSnapshot().lastError?.code).toBe('UNSUPPORTED');

    await transport.createRoom();
    expect(transport.getSnapshot().lastError).toBeNull();
  });
});

/* ========================================================================== *
 * The synthetic identities must not leak
 * ========================================================================== */

describe('synthetic identities', () => {
  /**
   * There is no auto-save in this feature, and a hot-seat identity written to
   * storage would be indistinguishable next session from the device's real one.
   */
  it('writes nothing to storage across a whole game', async () => {
    const writes: string[] = [];
    const fake = {
      getItem: () => null,
      setItem: (key: string) => writes.push(key),
      removeItem: (key: string) => writes.push(key),
      clear: () => writes.push('clear'),
      key: () => null,
      length: 0,
    };
    const globals = globalThis as unknown as { localStorage?: unknown };
    const had = 'localStorage' in globals;
    const previous = globals.localStorage;
    globals.localStorage = fake;
    try {
      const transport = await startedGame(['Ann', 'Ben', 'Cal']);
      await playToEnd(transport);
      await transport.requestRematch(true);
      transport.dispose();
    } finally {
      if (had) globals.localStorage = previous;
      else delete globals.localStorage;
    }
    expect(writes).toEqual([]);
  });

  it('reuses the device identity for seat 0 and mints the rest', async () => {
    const transport = makeTransport(['Ann', 'Ben', 'Cal']);
    await transport.createRoom();
    const ids = room(transport).players.map((p) => p.playerId);

    expect(ids[0]).toBe(testIdentity().playerId);
    expect(ids[1]).not.toBe(testIdentity().playerId);
    expect(new Set(ids).size).toBe(3);
  });

  it('gives two transports built from one identity different synthetic seats', async () => {
    const first = makeTransport(['Ann', 'Ben']);
    const second = makeTransport(['Ann', 'Ben']);
    await first.createRoom();
    await second.createRoom();

    expect(room(first).players[1].playerId).not.toBe(room(second).players[1].playerId);
  });
});
