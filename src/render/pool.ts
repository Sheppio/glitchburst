/**
 * Reusable object pool for pooled scene entities.
 *
 * Five near-identical `find(x => !x.active)` implementations had accumulated —
 * bullets, remote bullets, enemy bullets, chips and power-ups — which is five
 * places to fix anything wrong with any of them.
 *
 * Note this is a *maintainability* change, not a performance one. Profiling the
 * worst case the game can reach (100 enemies, a full chip pool, bullets in
 * flight) put every per-frame method together at about 1.2ms against a 16.7ms
 * budget, with pool acquisition far too small to isolate. The rotating cursor
 * below is simply free alongside the deduplication, not a fix for a measured
 * problem.
 */
export interface Poolable {
  active: boolean;
}

export class Pool<T extends Poolable> {
  private slots: T[] = [];
  /**
   * Where the last search ended. Freed slots cluster around recent activity, so
   * resuming from there usually hits an inactive entry immediately rather than
   * rescanning a long prefix of live ones.
   */
  private cursor = 0;

  constructor(private readonly create: () => T) {}

  /** Every slot ever created, live or not. Iterate and skip inactive entries. */
  get items(): readonly T[] {
    return this.slots;
  }

  get size(): number {
    return this.slots.length;
  }

  /**
   * O(n) — call once and cache, never per item in a spawn loop. `spawnChips`
   * used to call the equivalent inside its loop, which made dropping a Trojan
   * Tank's four chips quadratic in the size of the pool.
   */
  countActive(): number {
    let n = 0;
    for (const item of this.slots) if (item.active) n++;
    return n;
  }

  /** An inactive slot, or a freshly created one. Callers set `active = true`. */
  acquire(): T {
    const count = this.slots.length;
    for (let i = 0; i < count; i++) {
      const index = (this.cursor + i) % count;
      const item = this.slots[index]!;
      if (!item.active) {
        this.cursor = index;
        return item;
      }
    }
    const created = this.create();
    this.slots.push(created);
    this.cursor = this.slots.length - 1;
    return created;
  }
}
