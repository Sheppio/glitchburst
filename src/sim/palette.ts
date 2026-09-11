/**
 * Player colours.
 *
 * Colour used to mean class. That was fine while a class was the only thing
 * distinguishing one chassis from another, and wrong as soon as two people in
 * the same room picked the same program: two identical cyan circles in a swarm
 * of a hundred enemies, and neither player able to tell which one they were
 * driving. Colour now says *who*, and the glyph in the roster says *what*.
 *
 * The room holds four and the palette holds eight, so there is always somewhere
 * for a clash to go.
 *
 * Engine-agnostic and pure — no Phaser, no DOM, no network. The resolver below
 * is the interesting part and is exactly the sort of thing that has to be
 * testable without a browser.
 */

export interface PlayerColour {
  id: string;
  name: string;
  /** For Phaser tints and generated textures. */
  colour: number;
  /** For CSS custom properties. */
  cssColour: string;
}

/**
 * Chosen to stay legible on the white mainframe floor and to stay apart from
 * each other at arm's length. The first four are the old class colours, which
 * were already tuned against that background.
 */
export const PALETTE: readonly PlayerColour[] = [
  { id: 'cyan', name: 'Cyan', colour: 0x00e5ff, cssColour: '#00e5ff' },
  { id: 'amber', name: 'Amber', colour: 0xffb300, cssColour: '#ffb300' },
  { id: 'magenta', name: 'Magenta', colour: 0xff2d95, cssColour: '#ff2d95' },
  { id: 'lime', name: 'Lime', colour: 0x7cff00, cssColour: '#7cff00' },
  { id: 'violet', name: 'Violet', colour: 0x9b5cff, cssColour: '#9b5cff' },
  { id: 'cobalt', name: 'Cobalt', colour: 0x2f6bff, cssColour: '#2f6bff' },
  { id: 'vermilion', name: 'Vermilion', colour: 0xff4d2e, cssColour: '#ff4d2e' },
  { id: 'jade', name: 'Jade', colour: 0x00c07a, cssColour: '#00c07a' },
];

export const COLOUR_ORDER: readonly string[] = PALETTE.map((c) => c.id);
export const DEFAULT_COLOUR = PALETTE[0]!.id;

const BY_ID = new Map(PALETTE.map((c) => [c.id, c]));

export function isColourId(value: string): boolean {
  return BY_ID.has(value);
}

/** Never throws: an unknown id — an older client, a corrupted field — reads as the default. */
export function colourOf(id: string): PlayerColour {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_COLOUR)!;
}

export interface ColourClaim {
  id: string;
  /** What that player asked for. */
  colour: string;
}

/**
 * Hand every player in the room a colour nobody else has.
 *
 * There is no server to arbitrate this, so the rule has to be one every client
 * can apply alone and arrive at the same answer — the same constraint the host
 * election works under. Two properties do it:
 *
 *   *Seniority.* Claims are settled in ascending player id, and ids are time
 *   prefixed, so the earliest joiner keeps what they asked for and a newcomer
 *   who picks a taken colour is the one who moves. Nobody's colour changes
 *   under them because somebody else walked in.
 *
 *   *Determinism.* The displaced player takes the next free entry walking
 *   forward from their choice, wrapping. No randomness and no negotiation, so
 *   every client — including the displaced one — computes the same result from
 *   the same roster without a message being sent.
 *
 * The picker greys out colours already spoken for, so in practice this only
 * fires on a genuine race: two people choosing the same colour in the same
 * half-second, before either has seen the other's presence.
 *
 * @returns player id → colour id, for every claim given.
 */
export function resolveColours(claims: readonly ColourClaim[]): Record<string, string> {
  const order = [...claims].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const taken = new Set<string>();
  const out: Record<string, string> = {};

  for (const claim of order) {
    const wanted = isColourId(claim.colour) ? claim.colour : DEFAULT_COLOUR;
    let pick = wanted;

    if (taken.has(pick)) {
      const start = COLOUR_ORDER.indexOf(wanted);
      for (let n = 1; n <= COLOUR_ORDER.length; n++) {
        const candidate = COLOUR_ORDER[(start + n) % COLOUR_ORDER.length]!;
        if (!taken.has(candidate)) {
          pick = candidate;
          break;
        }
      }
      // More players than colours cannot happen — the room holds four and the
      // palette holds eight — but if it ever did, a duplicate is a far better
      // outcome than an undefined colour.
    }

    taken.add(pick);
    out[claim.id] = pick;
  }

  return out;
}
