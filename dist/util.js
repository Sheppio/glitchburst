/** Tiny shared helpers. No dependencies, no Phaser. */
/** Minimal typed event emitter — the seam between the netcode and the renderer. */
export class Emitter {
    map = new Map();
    on(event, fn) {
        let set = this.map.get(event);
        if (!set) {
            set = new Set();
            this.map.set(event, set);
        }
        set.add(fn);
        return () => this.off(event, fn);
    }
    off(event, fn) {
        this.map.get(event)?.delete(fn);
    }
    emit(event, payload) {
        const set = this.map.get(event);
        if (!set)
            return;
        // Copy so a handler may unsubscribe during dispatch.
        for (const fn of [...set])
            fn(payload);
    }
    clear() {
        this.map.clear();
    }
}
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** Shortest-path interpolation between two angles in radians. */
export function lerpAngle(a, b, t) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI)
        d += Math.PI * 2;
    return a + d * t;
}
/**
 * Step `from` toward `to` by at most `maxDelta` radians, the short way round.
 *
 * Used for the player's turn rate: unlike `lerpAngle`, this moves at a constant
 * angular speed rather than easing, so the turn takes a predictable time
 * regardless of how far it has to go — which is what makes a turn-rate limit
 * feel like a mechanic instead of like lag.
 */
export function approachAngle(from, to, maxDelta) {
    let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI)
        diff += Math.PI * 2;
    if (Math.abs(diff) <= maxDelta)
        return to;
    return from + Math.sign(diff) * maxDelta;
}
/**
 * Deterministic 0..1 from a string, via FNV-1a.
 *
 * Used for drop rolls: every client must independently agree on whether a given
 * corpse dropped loot, and they share nothing but the enemy's id. `Math.random`
 * would have each client seeing a different world.
 */
/**
 * Squared distance from a point to the line *segment* ab.
 *
 * This is what makes fast projectiles hit things. Testing only a bullet's
 * end-of-frame position asks "is it touching now?", but at 1500 px/s a round
 * covers 25px per frame — comfortably further than a Glitch Bug is wide — so it
 * can start in front of an enemy and end behind it having never been measured
 * as touching. Sweeping the whole step closes that gap, and with it the
 * point-blank case where the target is nearer than one frame of travel.
 */
export function segmentDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    return (px - cx) ** 2 + (py - cy) ** 2;
}
export function hashUnit(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return ((hash >>> 0) % 100000) / 100000;
}
export const dist2 = (ax, ay, bx, by) => {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
};
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Human-typeable room code — no visually ambiguous characters. */
export function makeRoomCode(len = 4) {
    let s = '';
    for (let n = 0; n < len; n++)
        s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
}
/**
 * Player ids double as the host-election key: the room sorts them and the
 * lowest wins, so they must be unique and comparable. A time prefix means an
 * earlier arrival sorts first, which makes the first player to join the host.
 */
export function makePlayerId() {
    const t = Date.now().toString(36).padStart(9, '0');
    const r = Math.floor(Math.random() * 36 ** 4)
        .toString(36)
        .padStart(4, '0');
    return `${t}${r}`;
}
/** Monotonic-ish counter for locally generated entity ids, base36 for wire size. */
export function counterId(prefix, n) {
    return prefix + n.toString(36);
}
//# sourceMappingURL=util.js.map