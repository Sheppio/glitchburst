import { NET } from '../config.js';
import type { EnemyId, PlayerId, RoomId } from '../types.js';

const root = NET.topicRoot;

/**
 * Every topic the game uses, in one place. Keeping these as functions rather
 * than string literals scattered through the codebase means the wire format is
 * auditable from a single file.
 */
export const Topics = {
  room: (r: RoomId) => `${root}/room/${r}`,

  /** Retained-free presence beacon, one topic per player. Also used as the LWT topic. */
  presence: (r: RoomId, p: PlayerId) => `${root}/room/${r}/presence/${p}`,
  presenceAll: (r: RoomId) => `${root}/room/${r}/presence/+`,

  /** Host liveness. Drives the election in `RoomSession`. */
  hostBeat: (r: RoomId) => `${root}/room/${r}/host/heartbeat`,

  /** Per-player state, published by that player and nobody else. */
  playerState: (r: RoomId, p: PlayerId) => `${root}/room/${r}/player/${p}/state`,
  playerStateAll: (r: RoomId) => `${root}/room/${r}/player/+/state`,

  /** The batched horde snapshot — one message for the entire horde, 20x/sec. */
  hordePositions: (r: RoomId) => `${root}/room/${r}/horde/positions`,

  /** Deaths, drone projectiles and wave announcements, batched the same way. */
  hordeEvents: (r: RoomId) => `${root}/room/${r}/horde/events`,

  /** Attacker-authority damage reports, addressed to a single enemy. */
  enemyDamage: (r: RoomId, e: EnemyId) => `${root}/room/${r}/enemy/${e}/damage`,
  enemyDamageAll: (r: RoomId) => `${root}/room/${r}/enemy/+/damage`,

  /** Class abilities that other clients must see (decoys, heal fields, shockwaves). */
  ability: (r: RoomId) => `${root}/room/${r}/ability`,
} as const;

/** Pull the wildcard segment out of a concrete topic, e.g. the enemy id from `.../enemy/7a/damage`. */
export function segment(topic: string, indexFromEnd: number): string {
  const parts = topic.split('/');
  return parts[parts.length - 1 - indexFromEnd] ?? '';
}
