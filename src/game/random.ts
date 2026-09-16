/**
 * Seeded pseudo-randomness.
 *
 * The engine never calls `Math.random` or reads the clock: every game is a pure
 * function of its config (including `seed`) and its move list, so a server and
 * every client independently reach the same state. The only thing chance
 * decides in Otrio is who goes first — the physical rules say "the youngest
 * player", which does not translate.
 *
 * `mulberry32` is used because it is 5 lines, has no state beyond one uint32,
 * and produces identical output on every JS engine (all arithmetic is via
 * `Math.imul` and `>>> 0`, so there are no float-precision differences).
 */

/** A deterministic `() => number` in [0, 1), seeded by `seed`. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in [0, bound), for `bound > 0`. */
export function randomInt(rng: () => number, bound: number): number {
  if (!Number.isInteger(bound) || bound <= 0) throw new RangeError(`Bad bound: ${bound}`);
  return Math.floor(rng() * bound) % bound;
}

/**
 * Deterministic element of a non-empty array.
 *
 * Used for first-player selection; also handy for a bot that wants a
 * reproducible "random" move.
 */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('Cannot pick from an empty list');
  return items[randomInt(rng, items.length)];
}

/**
 * Turn an arbitrary string (a room code, a match id) into a 32-bit seed, so
 * everyone in a lobby derives the same first player without extra messages.
 * FNV-1a.
 */
export function seedFromString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
