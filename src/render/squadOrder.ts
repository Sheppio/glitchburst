/**
 * The order squad health bars are listed in.
 *
 * You first, then whoever is running the horde, then everyone else in the
 * order they joined.
 *
 * Your own bar is the one you glance at mid-fight, so it holds still at the
 * top rather than shuffling as people join and leave. The host is next because
 * it is the one player whose connection the whole room depends on — if they
 * stall, everyone's horde stalls, so their health is worth a glance too.
 *
 * Join order for the rest, which player ids already encode: they are
 * time-prefixed, which is exactly why the lowest id wins a host election. The
 * alternative, insertion order into the remotes map, is really "order their
 * first packet happened to arrive" — stable enough to look deliberate and
 * arbitrary enough to differ between clients looking at the same room.
 *
 * Pure and Phaser-free so it can be tested without a browser.
 */

export interface SquadMember {
  id: string;
  isSelf: boolean;
  isHost: boolean;
}

const rank = (m: SquadMember): number => (m.isSelf ? 0 : m.isHost ? 1 : 2);

/** Sorts a copy; the caller's array is left alone. */
export function orderSquad<T extends SquadMember>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
