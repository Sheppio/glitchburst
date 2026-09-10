export class Pool {
    create;
    slots = [];
    /**
     * Where the last search ended. Freed slots cluster around recent activity, so
     * resuming from there usually hits an inactive entry immediately rather than
     * rescanning a long prefix of live ones.
     */
    cursor = 0;
    constructor(create) {
        this.create = create;
    }
    /** Every slot ever created, live or not. Iterate and skip inactive entries. */
    get items() {
        return this.slots;
    }
    get size() {
        return this.slots.length;
    }
    /**
     * O(n) — call once and cache, never per item in a spawn loop. `spawnChips`
     * used to call the equivalent inside its loop, which made dropping a Trojan
     * Tank's four chips quadratic in the size of the pool.
     */
    countActive() {
        let n = 0;
        for (const item of this.slots)
            if (item.active)
                n++;
        return n;
    }
    /** An inactive slot, or a freshly created one. Callers set `active = true`. */
    acquire() {
        const count = this.slots.length;
        for (let i = 0; i < count; i++) {
            const index = (this.cursor + i) % count;
            const item = this.slots[index];
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
//# sourceMappingURL=pool.js.map