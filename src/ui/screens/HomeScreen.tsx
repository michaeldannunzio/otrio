import { useEffect, useRef, useState } from 'react';

import {
  DEFAULT_VARIANTS,
  createRoom,
  joinRoom,
  setName,
  useNet,
  usePrefs,
  useTransportHolder,
  switchToHostedBackend,
  useUi,
  variantsSupported,
  withVariants,
} from '../../store';
import type { VariantOptions } from '../../store';
import { MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS } from '../../net/protocol';
import { describeWireError } from '../lib/copy';
// Goku's predicate, exported from the module that emits the string it tests.
// I had a copy of the regex here; house rule 3 -- a string copied across a
// module boundary is a divergence with a delay fuse -- and this one had already
// lit. Now the producer and the predicate move together.
import { isMissingRelay } from '../../net/rtcTransport';
import { isEnterableRoomCode } from '../lib/roomCode';
import { useScreenFocus } from '../lib/a11y';
import { Button, Card, Field, Segmented, Switch } from '../components/primitives';
import { RoomCodeInput } from '../components/RoomCode';

/**
 * The first screen: pick a name, then either open a room or join one.
 *
 * Both paths are one tap from here. The create options (how many players,
 * whether people can watch) are revealed inline rather than hidden behind a
 * settings screen, because on a phone a second screen is a second chance to
 * lose someone.
 */
export function HomeScreen() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const entry = useUi((s) => s.entry);
  const setEntry = useUi((s) => s.setEntry);
  const prefilledCode = useUi((s) => s.prefilledCode);

  const name = usePrefs((s) => s.name);
  const capabilities = useNet((s) => s.capabilities);
  const configured = useTransportHolder((s) => s.configured);

  const [code, setCode] = useState(prefilledCode);
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [allowSpectators, setAllowSpectators] = useState(true);
  const [variants, setVariants] = useState<VariantOptions>(DEFAULT_VARIANTS);
  const [busy, setBusy] = useState<null | 'create' | 'join'>(null);
  const [error, setError] = useState<{
    text: string;
    offerHosted: boolean;
    /** False when retrying provably cannot help, e.g. no TURN relay exists. */
    offerRetry: boolean;
  } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  useScreenFocus(headingRef, 'home');

  // A shared link drops straight into the join flow with the code already in.
  useEffect(() => {
    if (prefilledCode) {
      setCode(prefilledCode);
      setEntry('join');
    }
  }, [prefilledCode, setEntry]);

  useEffect(() => {
    if (entry === 'join') codeRef.current?.focus({ preventScroll: true });
  }, [entry]);

  async function onCreate() {
    setBusy('create');
    setError(null);
    const result = await createRoom(
      withVariants({ maxPlayers, allowSpectators }, variants, capabilities),
    );
    setBusy(null);
    if (!result.ok) {
      const copy = describeWireError(result.error);
      const peerFailure =
        result.error.code === 'PEER_UNREACHABLE' || result.error.code === 'SIGNALING_FAILED';
      setError({
        text: `${copy.title}. ${copy.detail}`,
        // Switching backends resolves every peer-to-peer failure, so it is
        // never the wrong offer for one.
        offerHosted: peerFailure,
        // But "try again" is only honest when trying again could work. With no
        // TURN relay configured there is nothing to retry into -- that is a
        // deployment fix, and a retry button would just be a button that fails.
        offerRetry: copy.retry && !isMissingRelay(result.error),
      });
    }
  }

  async function onJoin() {
    if (!isEnterableRoomCode(code)) {
      setCodeError('Enter the code you were given — at least four characters.');
      codeRef.current?.focus();
      return;
    }
    setBusy('join');
    setCodeError(null);
    const result = await joinRoom(code);
    setBusy(null);
    if (!result.ok) {
      const copy = describeWireError(result.error);
      setCodeError(`${copy.title}. ${copy.detail}`);
      codeRef.current?.focus();
    }
  }

  const disabled = !configured || busy !== null;

  return (
    <div className="o-screen o-home">
      <header className="o-home__hero">
        <h1 className="o-home__title" ref={headingRef} tabIndex={-1}>
          Otrio
        </h1>
        <p className="o-home__tagline">
          Three in a row, three of a size, or three nested. For two to four people, one phone each.
        </p>
      </header>

      <Card className="o-home__card">
        <Field
          label="Your name"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          autoComplete="nickname"
          enterKeyHint="done"
          hint="Everyone in the room sees this."
          onChange={(e) => usePrefs.getState().setName(e.currentTarget.value)}
          onBlur={(e) => void setName(e.currentTarget.value)}
        />
      </Card>

      {entry === 'home' ? (
        <div className="o-home__choices">
          <Button variant="primary" size="lg" block onClick={() => setEntry('create')} disabled={!configured}>
            Start a new game
          </Button>
          <Button size="lg" block onClick={() => setEntry('join')} disabled={!configured}>
            Join with a code
          </Button>
        </div>
      ) : null}

      {entry === 'create' ? (
        <Card className="o-home__card">
          <h2 className="o-home__cardTitle">New game</h2>
          <Segmented
            legend="How many players?"
            name="maxPlayers"
            value={maxPlayers}
            onChange={setMaxPlayers}
            hint="You can start as soon as everyone has joined and tapped Ready."
            options={Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => {
              const n = MIN_PLAYERS + i;
              return { value: n, label: String(n), detail: n === 1 ? 'player' : 'players' };
            })}
          />
          {capabilities?.spectators ? (
            <label className="o-check">
              <input
                type="checkbox"
                checked={allowSpectators}
                onChange={(e) => setAllowSpectators(e.currentTarget.checked)}
              />
              <span>Let extra people watch</span>
            </label>
          ) : null}
          {variantsSupported(capabilities) ? (
            <div className="o-home__variants">
              <h3 className="o-home__variantsTitle">Optional rules</h3>
              {maxPlayers === 2 ? (
                <Switch
                  label="Strict colour alternation"
                  description="The printed rules make each 2-player player switch between their two colours every turn. Turning this off lets them choose freely."
                  checked={variants.twoPlayerStrictAlternation !== false}
                  onChange={(on) => setVariants((v) => ({ ...v, twoPlayerStrictAlternation: on }))}
                />
              ) : null}
              <Switch
                label="Otrio Extreme"
                description="Play a series. One point per game won, first to five takes the match."
                checked={(variants.targetScore ?? 0) > 0}
                onChange={(on) => setVariants((v) => ({ ...v, targetScore: on ? 5 : 0 }))}
              />
              {(variants.targetScore ?? 0) > 0 ? (
                <Switch
                  label="Blocking penalty"
                  description="Minus one point for whoever moved immediately before the winning move. The rulebook says “failed to block”, which only a human can judge; this is the closest rule a computer can apply."
                  checked={variants.blockPenalty === true}
                  onChange={(on) => setVariants((v) => ({ ...v, blockPenalty: on }))}
                />
              ) : null}
              {maxPlayers === 2 ? (
                <Switch
                  label="Block the centre medium"
                  description="The rulebook's handicap for a first player who keeps winning: nobody may use the medium ring in the centre space."
                  checked={variants.centreMediumBlocked === true}
                  onChange={(on) => setVariants((v) => ({ ...v, centreMediumBlocked: on }))}
                />
              ) : null}
            </div>
          ) : null}
          {error ? (
            <div role="alert">
              <p className="o-inlineError">{error.text}</p>
              {error.offerRetry ? (
                <Button block busy={busy === 'create'} onClick={onCreate}>
                  Try again
                </Button>
              ) : null}
              {error.offerHosted ? (
                <Button
                  variant={error.offerRetry ? 'ghost' : 'secondary'}
                  block
                  onClick={() => void switchToHostedBackend()}
                >
                  Try the hosted game instead
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="o-home__actions">
            <Button variant="primary" size="lg" block busy={busy === 'create'} disabled={disabled} onClick={onCreate}>
              {busy === 'create' ? 'Opening the room…' : 'Create room'}
            </Button>
            <Button variant="ghost" block onClick={() => setEntry('home')} disabled={busy !== null}>
              Back
            </Button>
          </div>
        </Card>
      ) : null}

      {entry === 'join' ? (
        <Card className="o-home__card">
          <h2 className="o-home__cardTitle">Join a game</h2>
          <RoomCodeInput
            ref={codeRef}
            value={code}
            onChange={(next) => {
              setCode(next);
              setCodeError(null);
            }}
            onSubmit={onJoin}
            error={codeError}
            disabled={busy !== null}
          />
          <div className="o-home__actions">
            <Button
              variant="primary"
              size="lg"
              block
              busy={busy === 'join'}
              disabled={disabled || !isEnterableRoomCode(code)}
              onClick={onJoin}
            >
              {busy === 'join' ? 'Joining…' : 'Join room'}
            </Button>
            <Button variant="ghost" block onClick={() => setEntry('home')} disabled={busy !== null}>
              Back
            </Button>
          </div>
        </Card>
      ) : null}

      <details className="o-rules">
        <summary className="o-rules__summary">How you win</summary>
        <ul className="o-rules__list">
          <li>Three of your rings of the same size in a row, column or diagonal.</li>
          <li>Three of your rings in a line growing small, medium, large — either direction.</li>
          <li>All three of your sizes nested inside one space.</li>
        </ul>
        <p className="o-rules__note">
          On your turn you place exactly one ring. Rings never move once placed.
        </p>
      </details>
    </div>
  );
}
