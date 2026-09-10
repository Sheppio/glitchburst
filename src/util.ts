/** Tiny shared helpers. No dependencies, no Phaser. */

export type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter — the seam between the netcode and the renderer. */
export class Emitter<Events extends Record<string, unknown>> {
  private map = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Handler<Events[K]>): void {
    this.map.get(event)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.map.get(event);
    if (!set) return;
    // Copy so a handler may unsubscribe during dispatch.
    for (const fn of [...set]) (fn as Handler<Events[K]>)(payload);
  }

  clear(): void {
    this.map.clear();
  }
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Shortest-path interpolation between two angles in radians. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
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
export function approachAngle(from: number, to: number, maxDelta: number): number {
  let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  if (Math.abs(diff) <= maxDelta) return to;
  return from + Math.sign(diff) * maxDelta;
}

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Human-typeable room code — no visually ambiguous characters. */
export function makeRoomCode(len = 4): string {
  let s = '';
  for (let n = 0; n < len; n++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/**
 * Player ids double as the host-election key: the room sorts them and the
 * lowest wins, so they must be unique and comparable. A time prefix means an
 * earlier arrival sorts first, which makes the first player to join the host.
 */
export function makePlayerId(): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${t}${r}`;
}

/** Monotonic-ish counter for locally generated entity ids, base36 for wire size. */
export function counterId(prefix: string, n: number): string {
  return prefix + n.toString(36);
}
