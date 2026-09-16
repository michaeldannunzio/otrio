import { forwardRef, useId, useState } from 'react';

import { ui } from '../../store';
import {
  copyText,
  formatRoomCode,
  isEnterableRoomCode,
  roomCodePhonetics,
  roomCodeUrl,
  sanitizeRoomCodeInput,
  shareRoom,
  spellRoomCode,
  ROOM_CODE_MAX_LENGTH,
} from '../lib/roomCode';
import { Button } from './primitives';

/**
 * Entering a room code.
 *
 * One real `<input>`, not a row of single-character boxes. Segmented inputs
 * look tidier and are worse at every job that matters here: paste breaks,
 * backspace across a boundary breaks, screen readers announce "edit, blank"
 * six times, and -- decisively -- the code length is not fixed, because a
 * peer-to-peer backend may pack signalling data into it. One field handles all
 * of that for free; letter-spacing and a tabular face do the legibility work.
 *
 * Normalisation runs on every keystroke, so someone who reads `0` off a screen
 * and types the letter `O` still gets into the room.
 */
export const RoomCodeInput = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (next: string) => void;
    onSubmit?: () => void;
    error?: string | null;
    label?: string;
    disabled?: boolean;
  }
>(function RoomCodeInput({ value, onChange, onSubmit, error, label = 'Room code', disabled }, ref) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className={['o-field o-codefield', error ? 'o-field--error' : ''].filter(Boolean).join(' ')}>
      <label className="o-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        className="o-field__input o-codefield__input"
        value={formatRoomCode(value)}
        onChange={(e) => onChange(sanitizeRoomCodeInput(e.currentTarget.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onSubmit && isEnterableRoomCode(value)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        disabled={disabled}
        // A phone keyboard that starts in caps and never autocorrects is the
        // whole difference between this working and not working at a table.
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        maxLength={ROOM_CODE_MAX_LENGTH + 3 /* allow for the thin-space grouping */}
        placeholder="ABC123"
        aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
      />
      <p className="o-field__hint" id={hintId}>
        Letters and numbers, as read out by whoever started the game.
      </p>
      {error ? (
        <p className="o-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      {/*
        The live spelling of what has been typed so far. A screen reader user
        typing a code otherwise has no way to check it: the field's value is
        announced as an attempt at a word.
      */}
      <p className="u-visually-hidden" aria-live="polite">
        {value ? spellRoomCode(value) : ''}
      </p>
    </div>
  );
});

/**
 * Showing a room code so three other people can get it into their phones.
 *
 * The code is large, tracked out and tabular. Under it sit the three ways
 * people actually share one: read it aloud (with a phonetic crib for the noisy
 * case), send a link, or copy it. The accessible name spells the code out,
 * because "9K4TM" read as a word helps nobody.
 */
export function RoomCodeDisplay({ code, compact = false }: { code: string; compact?: boolean }) {
  const [phoneticsOpen, setPhoneticsOpen] = useState(false);
  const spelled = spellRoomCode(code);

  async function onCopy() {
    const ok = await copyText(code);
    ui.toast({
      tone: ok ? 'success' : 'warning',
      title: ok ? 'Room code copied' : "Couldn't copy",
      detail: ok ? undefined : 'Select the code and copy it by hand.',
      timeout: 3000,
      key: 'copy',
    });
    if (ok) ui.announce(`Room code ${spelled} copied.`);
  }

  async function onShare() {
    const shared = await shareRoom(code);
    if (shared) return;
    const ok = await copyText(roomCodeUrl(code));
    ui.toast({
      tone: ok ? 'success' : 'warning',
      title: ok ? 'Invite link copied' : "Couldn't share",
      detail: ok ? 'Paste it into your group chat.' : 'Copy the code and send it instead.',
      timeout: 4000,
      key: 'copy',
    });
  }

  return (
    <div className={['o-code', compact ? 'o-code--compact' : ''].filter(Boolean).join(' ')}>
      <p className="o-code__caption" id="room-code-caption">
        Room code
      </p>
      <p className="o-code__value u-tabular" aria-describedby="room-code-caption">
        {/* Sighted readers get the grouped form; everyone else gets it spelled. */}
        <span aria-hidden="true">{formatRoomCode(code)}</span>
        <span className="u-visually-hidden">{spelled}</span>
      </p>

      <div className="o-code__actions">
        <Button onClick={onCopy} icon={<CopyIcon />}>
          Copy code
        </Button>
        <Button onClick={onShare} icon={<ShareIcon />}>
          Share link
        </Button>
      </div>

      <div className="o-code__phonetics">
        <button
          type="button"
          className="o-linkbtn"
          aria-expanded={phoneticsOpen}
          aria-controls="room-code-phonetics"
          onClick={() => setPhoneticsOpen((v) => !v)}
        >
          {phoneticsOpen ? 'Hide how to say it' : 'How to say it out loud'}
        </button>
        <ul
          id="room-code-phonetics"
          className="o-code__phoneticList"
          hidden={!phoneticsOpen}
        >
          {roomCodePhonetics(code).map((p, i) => (
            <li key={`${p.char}-${i}`}>
              <span className="o-code__phoneticChar u-tabular">{p.char}</span>
              <span className="o-code__phoneticWord">{p.word}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="o-icon">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="o-icon">
      <path d="M12 3v13M12 3 8 7M12 3l4 4" />
      <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}
