import {
  isTwoPlayerVariant,
  leaveRoom,
  outcomeOf,
  useNet,
  usePrefs,
  useUi,
} from '../../store';
import { MAX_NAME_LENGTH, isLocalRoomCode } from '../../net/protocol';
import { setName } from '../../store';
import { describeQuality } from '../lib/copy';
import { gradeQuality } from '../../net/transport';
import { Sheet } from '../components/Sheet';
import { Button, Field, Segmented, Switch } from '../components/primitives';
import { RoomCodeDisplay } from '../components/RoomCode';
import { PlayerDetails } from '../hud/PlayerRail';
import { MoveLog } from '../hud/MoveLog';
import { HowToPlay } from '../components/HowToPlay';

/**
 * Everything behind the menu button: preferences, the room code again (for the
 * person who arrived late), the full player list, and the way out.
 *
 * Leaving is deliberately two taps. It ends someone's game, including possibly
 * three other people's, and a single mis-tap next to the board is exactly how
 * that happens on a phone.
 */
export function Sheets() {
  const sheet = useUi((s) => s.sheet);
  const closeSheet = useUi((s) => s.closeSheet);

  return (
    <>
      <SettingsSheet open={sheet === 'settings'} onClose={closeSheet} />
      <Sheet open={sheet === 'players'} onClose={closeSheet} title="Players">
        <PlayerDetails />
      </Sheet>
      <Sheet open={sheet === 'move-log'} onClose={closeSheet} title="Moves">
        <MoveLog compact />
      </Sheet>
      <HowToPlaySheet open={sheet === 'how-to-play'} onClose={closeSheet} />
      <RoomInfoSheet open={sheet === 'room-info'} onClose={closeSheet} />
      <LeaveSheet open={sheet === 'leave-confirm'} onClose={closeSheet} />
    </>
  );
}

function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefs = usePrefs();
  const openSheet = useUi((s) => s.openSheet);
  const room = useNet((s) => s.room);
  const quality = useNet((s) => s.quality);
  const capabilities = useNet((s) => s.capabilities);
  const inGame = room !== null && room.phase !== 'lobby';
  const finished = outcomeOf(room).kind !== 'none';
  /*
   * Is this a game being passed round one device?
   *
   * `isLocalRoomCode(room.code)` is the supported feature test and
   * `capabilities.kind` is explicitly not one -- it is documented
   * diagnostics-only (Homer, 2026-09-24), and the "no transport installed"
   * literal in `transportStore.ts` reports `kind: 'hosted'` while being neither.
   */
  const onOneDevice = room !== null && isLocalRoomCode(room.code);

  return (
    <Sheet open={open} onClose={onClose} title="Game menu">
      <div className="o-settings">
        <Field
          label="Your name"
          value={prefs.name}
          maxLength={MAX_NAME_LENGTH}
          onChange={(e) => prefs.setName(e.currentTarget.value)}
          onBlur={(e) => void setName(e.currentTarget.value)}
        />

        <Segmented
          legend="Appearance"
          name="theme"
          value={prefs.theme}
          // `setTheme` delegates to the theme owner, which applies the DOM
          // attributes itself and notifies the mirror. Calling
          // `applyThemeAttributes` here as well would paint without telling the
          // store, and the next change from anywhere would silently revert it.
          onChange={(t) => prefs.setTheme(t)}
          options={[
            { value: 'system', label: 'Match device' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />

        <Switch
          label="Label ring sizes"
          description="Draws S, M and L on the rings, so size does not depend on judging diameter."
          checked={prefs.sizeLabels}
          onChange={() => prefs.toggle('sizeLabels')}
        />
        <Switch
          label="Always show the flat board"
          description="A keyboard-operable 3×3 grid under the 3D board. It plays the same game."
          checked={prefs.showTextBoard}
          onChange={() => prefs.toggle('showTextBoard')}
        />
        <Switch
          label="Reduce motion"
          description="Calms animations even if your device is not set to reduce motion."
          checked={prefs.motion === 'reduced'}
          onChange={(on) => prefs.setMotion(on ? 'reduced' : 'system')}
        />
        <Switch
          label="Vibrate on your turn"
          description="A short tick when a tap registers. Not available on every phone."
          checked={prefs.haptics}
          onChange={() => prefs.toggle('haptics')}
        />

        {/*
          Mid-game is exactly when someone asks what the three win conditions
          are, and until now the only answer lived on a screen you could not get
          back to.
        */}
        <Button block onClick={() => openSheet('how-to-play')}>
          How you win
        </Button>

        {room && inGame ? (
          // Below xl the log has no rail, so this is its only route. Without it
          // the feature would be built and unreachable, which is the state it
          // was already in as a live region nobody could see.
          <Button block onClick={() => openSheet('move-log')}>
            Moves so far
          </Button>
        ) : null}

        {room ? (
          <div className="o-settings__section">
            <h3 className="o-settings__heading">This room</h3>

            {/*
              Latency. Hidden on one device because the sentence would be a
              lie about a link that does not exist: with no ping there is no
              `rttMs`, `gradeQuality(null)` is `'unknown'`, and
              `describeQuality` renders that as "Connection quality unknown"
              -- which reads as a connection being measured badly rather than
              as no connection at all. (Both functions read 2026-09-24; this
              is what they return, not what I expect them to.)
            */}
            {!onOneDevice ? (
              <p className="o-settings__line">
                {describeQuality(gradeQuality(quality.rttMs), quality.rttMs)}
              </p>
            ) : null}

            {capabilities && !capabilities.impartialReferee ? (
              <p className="o-settings__line">
                Friendly game — one of the phones is running the rules rather than a server.
              </p>
            ) : null}

            {/*
              Sharing the code. A local code is a sentinel, not an invitation:
              `newLocalRoomCode()` mints `LOCAL` + 6 characters purely so the
              referee's `hashSeed(code, seq)` varies who opens the game, and
              `isPlausibleRoomCode` returns false for it, so a player who typed
              one into another phone would get `CODE_INVALID`. Offering it to
              share is offering something that cannot work.
            */}
            {!onOneDevice ? (
              <Button block onClick={() => openSheet('room-info')}>
                Show the room code
              </Button>
            ) : null}
          </div>
        ) : null}

        {room ? (
          <Button variant="danger" block onClick={() => openSheet('leave-confirm')}>
            {inGame && !finished ? 'Leave the game' : 'Leave room'}
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}

function HowToPlaySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const room = useNet((s) => s.room);
  return (
    <Sheet open={open} onClose={onClose} title="How you win">
      <HowToPlay twoPlayer={isTwoPlayerVariant(room)} />
    </Sheet>
  );
}

function RoomInfoSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const code = useNet((s) => s.room?.code ?? null);
  if (!code) return null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Room code"
      description="Anyone with this can join, if there is a free seat."
      compact
    >
      <RoomCodeDisplay code={code} compact />
    </Sheet>
  );
}

function LeaveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const room = useNet((s) => s.room);
  const isHost = useNet((s) => s.isHost);
  const inPlay = room?.phase === 'playing' || room?.phase === 'paused';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={inPlay ? 'Leave the game?' : 'Leave the room?'}
      compact
      description={
        inPlay
          ? 'Your rings stay on the board as blockers and the others keep playing without you. Leaving on purpose gives up your seat straight away — there is no reconnect window.'
          : isHost
            ? 'Someone else will take over as host.'
            : 'You can rejoin with the same code if a seat is free.'
      }
      footer={
        <>
          <Button variant="danger" block onClick={() => void leaveRoom()}>
            Leave
          </Button>
          <Button variant="ghost" block onClick={onClose}>
            Stay
          </Button>
        </>
      }
    >
      <p className="o-settings__line">
        {inPlay
          ? 'If your connection drops instead, your seat is held for a while and you can come straight back.'
          : ''}
      </p>
    </Sheet>
  );
}
