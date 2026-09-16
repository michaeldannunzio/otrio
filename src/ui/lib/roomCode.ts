/**
 * Presentation helpers for room codes.
 *
 * The *rules* for room codes live in `src/net/protocol.ts` and this module does
 * not second-guess them. In particular:
 *
 *  - The alphabet is Crockford Base32, which keeps one member of each confusable
 *    pair so `normalizeRoomCode` has somewhere to fold the other one onto
 *    (O -> 0, I/L -> 1, U -> V). That is strictly better than the tempting
 *    approach of banning both halves, which leaves a player who types the letter
 *    they can see with nowhere to go.
 *  - Length is deliberately NOT fixed: hosted codes are 5 characters, but a
 *    peer-to-peer backend may need to pack signalling data into the code.
 *    `isPlausibleRoomCode` accepts 4-12, and so does every input in this UI.
 *
 * What this module adds is everything the protocol has no opinion about: how a
 * code looks on screen, how it sounds when shouted across a table, and how it
 * travels through a group chat.
 */

import {
  isPlausibleRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
} from '../../net/protocol';

export { isPlausibleRoomCode, normalizeRoomCode, ROOM_CODE_ALPHABET };

/**
 * Longest code any input will accept. Matches the upper bound of
 * `isPlausibleRoomCode`; it is a guard against paste accidents, not a format.
 */
export const ROOM_CODE_MAX_LENGTH = 12;

/** Shortest code any input will accept. */
export const ROOM_CODE_MIN_LENGTH = 4;

/**
 * NATO spelling alphabet, plus digits. Two jobs:
 *
 *  1. A screen reader announces "9K4TM" as an attempt at a word, which is
 *     useless to the person trying to read it to a friend. Every visible code
 *     therefore carries a spelled-out accessible name.
 *  2. Four people around a table in a noisy room genuinely need "Kilo" rather
 *     than "K", because K/A/J all end in the same vowel.
 */
const PHONETIC: Record<string, string> = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
  A: 'Alfa',
  B: 'Bravo',
  C: 'Charlie',
  D: 'Delta',
  E: 'Echo',
  F: 'Foxtrot',
  G: 'Golf',
  H: 'Hotel',
  J: 'Juliett',
  K: 'Kilo',
  M: 'Mike',
  N: 'November',
  P: 'Papa',
  Q: 'Quebec',
  R: 'Romeo',
  S: 'Sierra',
  T: 'Tango',
  V: 'Victor',
  W: 'Whiskey',
  X: 'X-ray',
  Y: 'Yankee',
  Z: 'Zulu',
};

/**
 * Normalise a single typed character and report whether it landed in the
 * alphabet, so the input can say "that character isn't used in room codes"
 * instead of eating the keystroke in silence -- the single most confusing thing
 * a code input can do.
 */
export function normalizeRoomCodeChar(
  input: string,
): { ok: true; char: string } | { ok: false } {
  const folded = normalizeRoomCode(input);
  if (folded.length === 1 && ROOM_CODE_ALPHABET.includes(folded)) {
    return { ok: true, char: folded };
  }
  return { ok: false };
}

/** Normalise and clamp a pasted or typed string. Safe on every keystroke. */
export function sanitizeRoomCodeInput(input: string): string {
  return normalizeRoomCode(input).slice(0, ROOM_CODE_MAX_LENGTH);
}

/**
 * The same, but it says what it threw away.
 *
 * `sanitizeRoomCodeInput` silently drops anything unusable, which is the exact
 * failure `normalizeRoomCodeChar` was written to prevent: a player presses a
 * key, nothing appears, and there is no way to tell a dead keyboard from a
 * character the field refuses. Silence is the worst possible answer because it
 * is indistinguishable from a bug.
 *
 * Whitespace and the thin spaces we inject for grouping are not reported --
 * those are ours, not the player's, and telling someone their space bar was
 * rejected would be noise.
 */
export function sanitizeRoomCodeInputReporting(input: string): {
  value: string;
  /** Distinct characters the player typed that a room code cannot contain. */
  rejected: string[];
} {
  const rejected: string[] = [];
  let value = '';
  for (const raw of input) {
    if (/\s/u.test(raw)) continue; // our own grouping, or a stray space
    const result = normalizeRoomCodeChar(raw);
    if (result.ok) {
      if (value.length < ROOM_CODE_MAX_LENGTH) value += result.char;
    } else if (!rejected.includes(raw)) {
      rejected.push(raw);
    }
  }
  return { value, rejected };
}

/** Complete enough to be worth sending to the referee. */
export function isEnterableRoomCode(code: string): boolean {
  return isPlausibleRoomCode(normalizeRoomCode(code));
}

/**
 * Visual grouping. A run of characters is much easier to re-find mid-sentence
 * when it is broken up, but the break has to survive an unknown length:
 * short codes stay whole (breaking a 5-character code into 3+2 reads worse than
 * leaving it), longer ones break into fours.
 */
export function formatRoomCode(code: string, separator = ' '): string {
  const clean = normalizeRoomCode(code);
  if (clean.length <= 6) return clean;
  const groups: string[] = [];
  for (let i = 0; i < clean.length; i += 4) groups.push(clean.slice(i, i + 4));
  return groups.join(separator);
}

/**
 * Spelled-out form for `aria-label` and for the read-aloud panel:
 * "Hotel Kilo four nine Tango Mike".
 */
export function spellRoomCode(code: string): string {
  return normalizeRoomCode(code)
    .split('')
    .map((c) => PHONETIC[c] ?? c)
    .join(' ');
}

/** Per-character pairs, for rendering the "say it out loud" list. */
export function roomCodePhonetics(code: string): Array<{ char: string; word: string }> {
  return normalizeRoomCode(code)
    .split('')
    .map((char) => ({ char, word: PHONETIC[char] ?? char }));
}

/** Shareable link for the "just send it in the group chat" path. */
export function roomCodeUrl(code: string): string {
  const clean = normalizeRoomCode(code);
  if (typeof window === 'undefined') return `?room=${clean}`;
  const url = new URL(window.location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('room', clean);
  return url.toString();
}

/**
 * Pull a room code out of `?room=` / `?r=` / `#CODE` on first load, so a tapped
 * link drops straight into the join flow with the code already filled in.
 */
export function roomCodeFromLocation(search: string, hash: string): string | null {
  try {
    const params = new URLSearchParams(search);
    const q = params.get('room') ?? params.get('r');
    if (q) {
      const code = normalizeRoomCode(q);
      if (isPlausibleRoomCode(code)) return code;
    }
  } catch {
    /* malformed query string: fall through to the hash */
  }
  const h = normalizeRoomCode(hash);
  return isPlausibleRoomCode(h) ? h : null;
}

/**
 * Copy a code (or link) to the clipboard, with a fallback for the browsers and
 * insecure-origin cases where the async clipboard API is unavailable. Returns
 * whether it worked so the caller can announce success or offer manual copy.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Native share sheet when the device has one. Returns false if unavailable. */
export async function shareRoom(code: string): Promise<boolean> {
  const url = roomCodeUrl(code);
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({
        title: 'Otrio',
        text: `Join my Otrio game. Room code ${formatRoomCode(code, ' ')}.`,
        url,
      });
      return true;
    } catch {
      // The user dismissed the sheet, or the browser refused. Either way the
      // caller should fall back to copy rather than show an error.
      return false;
    }
  }
  return false;
}
