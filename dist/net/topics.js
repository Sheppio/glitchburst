import { NET } from '../config.js';
const root = NET.topicRoot;
/**
 * Every topic the game uses, in one place. Keeping these as functions rather
 * than string literals scattered through the codebase means the wire format is
 * auditable from a single file.
 */
export const Topics = {
    room: (r) => `${root}/room/${r}`,
    /** Retained-free presence beacon, one topic per player. Also used as the LWT topic. */
    presence: (r, p) => `${root}/room/${r}/presence/${p}`,
    presenceAll: (r) => `${root}/room/${r}/presence/+`,
    /** Host liveness. Drives the election in `RoomSession`. */
    hostBeat: (r) => `${root}/room/${r}/host/heartbeat`,
    /** Per-player state, published by that player and nobody else. */
    playerState: (r, p) => `${root}/room/${r}/player/${p}/state`,
    playerStateAll: (r) => `${root}/room/${r}/player/+/state`,
    /** One player's contribution to the group run summary. */
    playerStats: (r, p) => `${root}/room/${r}/player/${p}/stats`,
    playerStatsAll: (r) => `${root}/room/${r}/player/+/stats`,
    /** Shots fired by one player, batched. Cosmetic only — see GameScene. */
    playerShots: (r, p) => `${root}/room/${r}/player/${p}/shots`,
    playerShotsAll: (r) => `${root}/room/${r}/player/+/shots`,
    /** The batched horde snapshot — one message for the entire horde, 20x/sec. */
    hordePositions: (r) => `${root}/room/${r}/horde/positions`,
    /** Deaths, drone projectiles and wave announcements, batched the same way. */
    hordeEvents: (r) => `${root}/room/${r}/horde/events`,
    /** Attacker-authority damage reports, addressed to a single enemy. */
    enemyDamage: (r, e) => `${root}/room/${r}/enemy/${e}/damage`,
    enemyDamageAll: (r) => `${root}/room/${r}/enemy/+/damage`,
    /** Class abilities that other clients must see (decoys, heal fields, shockwaves). */
    ability: (r) => `${root}/room/${r}/ability`,
    /** Host-authoritative pause. Freezes the horde for the whole room. */
    pause: (r) => `${root}/room/${r}/pause`,
};
/** Pull the wildcard segment out of a concrete topic, e.g. the enemy id from `.../enemy/7a/damage`. */
export function segment(topic, indexFromEnd) {
    const parts = topic.split('/');
    return parts[parts.length - 1 - indexFromEnd] ?? '';
}
//# sourceMappingURL=topics.js.map