/**
 * In-run progression: chips dropped by dead malware, converted into power-ups.
 *
 * Engine-agnostic and entirely per-player, which is a deliberate networking
 * decision as much as a design one — see `GameScene.spawnChips`. Nothing in
 * here imports Phaser or touches the wire.
 */
export const UPGRADES = {
    damage: {
        id: 'damage',
        name: 'Payload Boost',
        short: 'DMG',
        blurb: '+9% weapon damage',
        colour: 0xff2d95,
        cssColour: '#ff2d95',
        step: 0.09,
        // Endless, and the only one that is. Damage is the upgrade with no ceiling
        // in the fiction and no downside in the code: it scales one multiplier and
        // costs nothing per frame. Enemy health now climbs geometrically with
        // level, so a linearly growing damage stat is what keeps a long run a
        // contest rather than a formality — and it means the last power-up of a
        // 40-minute run is still worth walking across the arena for.
        maxStacks: Infinity,
    },
    speed: {
        id: 'speed',
        name: 'Clock Boost',
        short: 'SPD',
        blurb: '+4.5% movement speed',
        colour: 0x00c8dc,
        cssColour: '#00c8dc',
        step: 0.045,
        // Capped: movement speed is the one stat that changes what the collision
        // code has to cope with. Enough of it and a player crosses more than an
        // enemy radius per frame, which is the tunnelling bug bullets already
        // needed swept collision to fix.
        maxStacks: 12,
    },
    regen: {
        id: 'regen',
        name: 'Self Repair',
        short: 'REG',
        blurb: '+0.55 health per second',
        colour: 0x3fae00,
        cssColour: '#3fae00',
        step: 0.55,
        // Capped: regeneration that outpaces incoming damage removes the fail
        // state, and a horde shooter with no fail state is a screensaver.
        maxStacks: 12,
    },
    firerate: {
        id: 'firerate',
        name: 'Pipeline Boost',
        short: 'ROF',
        blurb: '+5.5% fire rate',
        colour: 0xff9f00,
        cssColour: '#ff9f00',
        step: 0.055,
        // Capped, by request and by arithmetic: fire rate multiplies live bullets,
        // and the bullet pool is the one per-frame cost that scales with an
        // upgrade rather than with the horde.
        maxStacks: 16,
    },
};
export const UPGRADE_ORDER = ['damage', 'speed', 'firerate', 'regen'];
export const PROGRESSION = {
    /**
     * Chips for the first power-up. Each subsequent one costs more.
     *
     * A flat price made the whole build resolve by wave ten: every upgrade was
     * taken while the waves were still small, and the rest of the run had no
     * progression left in it. Halving the per-stack values alone would not have
     * fixed that — it would only have made the same early plateau weaker.
     *
     * Escalating instead keeps the shape people actually enjoy: the first few
     * come quickly and teach you what the upgrades do, and the last few are
     * genuinely earned.
     */
    chipsPerPowerUp: 8,
    /**
     * Added to the price for each power-up already taken.
     *
     * One extra chip per power-up, so the cost reads as a simple count the player
     * can follow: 8, 9, 10, 11. There is no ceiling — the stack caps bound it
     * naturally, and the most expensive upgrade in a maxed run costs 67. A
     * ceiling would have made the last third of the curve flat, which is exactly
     * the plateau this was meant to remove.
     */
    chipCostGrowth: 1,
    /** Chips inside this radius latch on and home in. */
    magnetRadius: 175,
    /** ...and are collected inside this one. */
    pickupRadius: 30,
    /**
     * Homing acceleration, px/s^2. A chip under attraction accelerates without
     * damping, so it always closes: the player has a fixed top speed and the chip
     * does not, which means a chip can never be outrun. Roughly 0.35s to cross
     * the magnet radius from a standing start.
     */
    magnetAccel: 2600,
    /** Small kick on latch, so attraction reads instantly rather than creeping. */
    magnetInitialSpeed: 170,
    /** Only a tunnelling guard; the overshoot check below is the real safety. */
    magnetMaxSpeed: 2600,
    /** Friction on the initial scatter pop, before a chip latches on. */
    scatterDamping: 0.88,
    /** Chips left on the floor this long are cleaned up. */
    chipTtlSec: 26,
    /** Hard cap on loose chips, so a cleared wave cannot flood the scene. */
    maxChips: 220,
    /** A power-up materialises this close to the player who earned it. */
    spawnRadius: 86,
    powerUpPickupRadius: 38,
    powerUpTtlSec: 45,
};
/**
 * One player's run progress.
 *
 * Multipliers are exposed rather than raw stack counts so call sites read as
 * `damage * progress.damageMultiplier` and never need to know how stacking
 * works.
 */
export class PlayerProgress {
    /** Chips banked toward the next power-up. */
    chips = 0;
    /** Power-ups claimed this run. Drives the rising price. */
    powerUpsTaken = 0;
    /** Chips collected across the whole run, for the end-of-run readout. */
    totalChips = 0;
    stacks = { damage: 0, speed: 0, firerate: 0, regen: 0 };
    /** Chips required for the next power-up, rising with each one taken. */
    get chipsNeeded() {
        return PROGRESSION.chipsPerPowerUp + this.powerUpsTaken * PROGRESSION.chipCostGrowth;
    }
    /** @returns true if this chip completed a set and earned a power-up. */
    addChip() {
        this.chips += 1;
        this.totalChips += 1;
        if (this.chips < this.chipsNeeded)
            return false;
        this.chips -= this.chipsNeeded;
        this.powerUpsTaken += 1;
        return true;
    }
    /** @returns false if that upgrade is already maxed. */
    grant(id) {
        if (this.stacks[id] >= UPGRADES[id].maxStacks)
            return false;
        this.stacks[id] += 1;
        return true;
    }
    /**
     * Which upgrade a newly earned power-up should offer.
     *
     * Picks among whatever is not maxed, biased toward what the player has least
     * of — so a long run broadens rather than dumping a twelfth damage stack on
     * someone who has never seen a speed boost.
     */
    rollUpgrade(random = Math.random) {
        const available = UPGRADE_ORDER.filter((id) => this.stacks[id] < UPGRADES[id].maxStacks);
        if (!available.length)
            return null;
        const weights = available.map((id) => 1 / (1 + this.stacks[id]));
        const total = weights.reduce((a, b) => a + b, 0);
        let roll = random() * total;
        for (let i = 0; i < available.length; i++) {
            roll -= weights[i];
            if (roll <= 0)
                return available[i];
        }
        return available[available.length - 1];
    }
    get damageMultiplier() {
        return 1 + this.stacks.damage * UPGRADES.damage.step;
    }
    get speedMultiplier() {
        return 1 + this.stacks.speed * UPGRADES.speed.step;
    }
    /** Fire *interval* shrinks as fire rate rises, so this is below 1. */
    get fireIntervalMultiplier() {
        return 1 / (1 + this.stacks.firerate * UPGRADES.firerate.step);
    }
    /**
     * Extra health per second from Self Repair stacks. Unlike the others this is
     * additive rather than multiplicative — there is no base rate to scale, and a
     * multiplier on a small number would make the first stack feel like nothing.
     */
    get bonusRegenPerSec() {
        return this.stacks.regen * UPGRADES.regen.step;
    }
    get totalStacks() {
        return UPGRADE_ORDER.reduce((sum, id) => sum + this.stacks[id], 0);
    }
}
//# sourceMappingURL=progression.js.map