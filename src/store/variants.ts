/**
 * The two official optional rules (docs/RULES.md §8).
 *
 * Both are real, printed rules rather than house rules, so the UI has a place
 * for them -- but neither exists in the wire protocol yet: `CreateRoomOptions`
 * has `maxPlayers`, `allowSpectators` and `turnTimeoutMs` and nothing else, and
 * `Capabilities` has no way to say whether a backend implements them.
 *
 * Rather than ship toggles that silently do nothing, the controls are gated on
 * `variantsSupported()`. Today that returns false everywhere and the section
 * does not render; the moment the referee advertises support it appears, with
 * no further change here. A toggle that appears to work and does not is worse
 * than an absent one, because the player finds out three turns in.
 *
 * To turn them on, the net layer needs:
 *   - `Capabilities.variants?: boolean`
 *   - `CreateRoomOptions.variants?: VariantOptions`
 *   - `RoomState.variants?: VariantOptions`, so joiners can see what they are in
 */

import type { Capabilities, CreateRoomOptions, RoomState } from '../net/protocol';

export interface VariantOptions {
  /**
   * Otrio Extreme (§8.1): match play to five points, one per game won.
   * `0` or omitted means a single game.
   */
  targetScore?: number;
  /**
   * The Extreme penalty: -1 to "the player who failed to block the winner".
   * The rulebook's phrasing is a judgement call, so the implementation uses the
   * only version a computer can adjudicate -- the player who moved immediately
   * before the winning move -- and the UI says so rather than pretending the
   * two are the same.
   */
  blockPenalty?: boolean;
  /**
   * Centre-medium handicap (§8.2): the medium slot in the centre space is
   * permanently unplayable, which the rulebook offers as a fix for a first
   * player who keeps winning a two-player game.
   */
  centreMediumBlocked?: boolean;
  /**
   * Two-player strict colour alternation (§4.6, §10.1). Default on: it is what
   * the printed sheet says, and it changes the character of the 2-player game
   * substantially. Exposed because two reputable sources omit it.
   */
  twoPlayerStrictAlternation?: boolean;
}

type CapabilitiesWithVariants = Capabilities & { variants?: boolean };
type RoomWithVariants = RoomState & { variants?: VariantOptions };
type CreateWithVariants = CreateRoomOptions & { variants?: VariantOptions };

export const DEFAULT_VARIANTS: VariantOptions = {
  targetScore: 0,
  blockPenalty: false,
  centreMediumBlocked: false,
  twoPlayerStrictAlternation: true,
};

/** Whether this backend can actually honour variant settings. */
export function variantsSupported(capabilities: Capabilities | null | undefined): boolean {
  return (capabilities as CapabilitiesWithVariants | null | undefined)?.variants === true;
}

/** What the room is actually playing, for display to someone who just joined. */
export function variantsOf(room: RoomState | null): VariantOptions {
  return { ...DEFAULT_VARIANTS, ...((room as RoomWithVariants | null)?.variants ?? {}) };
}

/**
 * Attach variants to create-room options, but only when the backend understands
 * them -- sending a field that is ignored is how a lobby setting becomes a lie.
 */
export function withVariants(
  options: CreateRoomOptions,
  variants: VariantOptions,
  capabilities: Capabilities | null | undefined,
): CreateRoomOptions {
  if (!variantsSupported(capabilities)) return options;
  return { ...options, variants } as CreateWithVariants;
}

/** Short badges describing a room's active variants. Empty for a plain game. */
export function variantBadges(room: RoomState | null): string[] {
  const v = variantsOf(room);
  const out: string[] = [];
  if (v.targetScore && v.targetScore > 0) out.push(`First to ${v.targetScore}`);
  if (v.blockPenalty) out.push('Blocking penalty');
  if (v.centreMediumBlocked) out.push('Centre medium blocked');
  if (v.twoPlayerStrictAlternation === false) out.push('Free colour choice');
  return out;
}
