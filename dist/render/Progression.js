import { WORLD } from '../config.js';
import { PROGRESSION, PlayerProgress, UPGRADES } from '../sim/progression.js';
import { clamp, dist2, hashUnit } from '../util.js';
import { Pool } from './pool.js';
import { TEX } from './textures.js';
/**
 * Chips, power-ups and the upgrades they buy.
 *
 * Split out of `GameScene`, which had grown to sixteen hundred lines covering
 * netcode, combat, rendering and this. Progression is the cleanest seam in
 * that class: it needs the player's position and almost nothing else, and it
 * never touches the network at all.
 */
export class ProgressionSystem {
    host;
    /** This player's run progress. Never leaves the client. */
    progress = new PlayerProgress();
    chips;
    powerUps;
    constructor(host) {
        this.host = host;
        this.chips = new Pool(() => ({
            sprite: host.scene.add.image(0, 0, TEX.chip).setDepth(12),
            x: 0, y: 0, vx: 0, vy: 0, homing: false, speed: 0, ttl: 0, active: false,
        }));
        this.powerUps = new Pool(() => ({
            shadow: host.scene.add.image(0, 0, TEX.shadow).setDepth(11).setVisible(false),
            orbit: host.scene.add.image(0, 0, TEX.orbit).setDepth(13).setVisible(false),
            sprite: host.scene.add.image(0, 0, TEX.powerUp('damage')).setDepth(14),
            upgrade: 'damage', x: 0, y: 0, ttl: 0, active: false,
        }));
    }
    /** Everything a dead enemy leaves behind. */
    dropFrom(x, y, def, enemyId) {
        this.spawnChips(x, y, def.chipDrop, enemyId);
        this.maybeDropPowerUp(x, y, def.powerUpChance, enemyId);
    }
    update(dt) {
        this.updateChips(dt);
        this.updatePowerUps(dt);
    }
    /**
     * Bigger malware sometimes drops a power-up outright, on top of its chips —
     * so committing to a Trojan Tank while a wave closes in is a decision rather
     * than a chore.
     *
     * The roll is a hash of the enemy id, not `Math.random`, so every client
     * independently agrees on which corpse dropped one. The *upgrade* it offers
     * is still rolled per player, because it is weighted against that player's
     * own build — two players can walk to the same node and each get what their
     * loadout is short of.
     */
    maybeDropPowerUp(x, y, chance, enemyId) {
        if (chance <= 0 || hashUnit(enemyId) >= chance)
            return;
        this.spawnPowerUp(x, y);
    }
    /* ------------------------------------------------------------ progression */
    /**
     * Drop chips where an enemy died.
     *
     * Chips are spawned independently on **every** client and collected purely
     * locally — they never touch the wire. That is worth being explicit about,
     * because the obvious alternative (host owns the loot, clients ask to pick it
     * up) is worse in every dimension that matters here: it adds a round trip to
     * the most tactile interaction in the game, it needs arbitration for two
     * players reaching the same chip, and it makes pickups feel laggy on exactly
     * the connection that is already struggling.
     *
     * Making them per-player costs nothing on the network (deaths are already
     * broadcast), removes the race entirely, and is better co-op design besides:
     * nobody competes with their squad for loot, and a player who joins a fight
     * late is not starved of progression.
     *
     * The drop count is fixed per enemy kind and the scatter is derived from the
     * enemy id, so every client independently produces the same pile.
     */
    spawnChips(x, y, count, enemyId) {
        const seed = enemyId.charCodeAt(enemyId.length - 1) + enemyId.length;
        // Counted once, not per chip: this used to scan (and allocate) the whole
        // pool for every chip in the drop, making a Trojan Tank's four-chip payout
        // quadratic in pool size.
        let room = PROGRESSION.maxChips - this.chips.countActive();
        for (let n = 0; n < count; n++) {
            if (room-- <= 0)
                return;
            const angle = (((seed * 31 + n * 97) % 360) * Math.PI) / 180;
            const chip = this.chips.acquire();
            chip.x = x;
            chip.y = y;
            // A small outward pop so a stack of four reads as four, not one.
            chip.vx = Math.cos(angle) * 90;
            chip.vy = Math.sin(angle) * 90;
            chip.homing = false;
            chip.speed = 0;
            chip.ttl = PROGRESSION.chipTtlSec;
            chip.active = true;
            chip.sprite.setPosition(x, y).setVisible(true).setAlpha(1).setScale(1);
        }
    }
    updateChips(dt) {
        const who = this.host.collector();
        const collectable = who.canCollect;
        for (const chip of this.chips.items) {
            if (!chip.active)
                continue;
            chip.ttl -= dt;
            if (chip.ttl <= 0) {
                chip.active = false;
                chip.sprite.setVisible(false);
                continue;
            }
            const dx = who.x - chip.x;
            const dy = who.y - chip.y;
            const distance = Math.hypot(dx, dy);
            if (collectable && !chip.homing && distance <= PROGRESSION.magnetRadius) {
                chip.homing = true;
                chip.speed = PROGRESSION.magnetInitialSpeed;
            }
            if (chip.homing && collectable) {
                // Accelerate, never damp. This is the whole point: the player has a top
                // speed and the chip does not, so the gap always closes. Damping here
                // (which an earlier version applied every frame) caps the chip at
                // accel/damping, which landed below player run speed at range — chips
                // could simply be outrun.
                chip.speed = Math.min(PROGRESSION.magnetMaxSpeed, chip.speed + PROGRESSION.magnetAccel * dt);
                const step = chip.speed * dt;
                // Collect on contact, or when this frame's step would carry the chip
                // past the player — at these speeds a fast chip can cross the whole
                // pickup radius between frames and would otherwise tunnel straight
                // through.
                if (distance <= PROGRESSION.pickupRadius || step >= distance) {
                    chip.active = false;
                    chip.sprite.setVisible(false);
                    this.collectChip();
                    continue;
                }
                const inv = 1 / (distance || 1);
                chip.x += dx * inv * step;
                chip.y += dy * inv * step;
                chip.sprite.setPosition(chip.x, chip.y);
            }
            else {
                // Loose on the floor: let the death pop settle out.
                chip.vx *= PROGRESSION.scatterDamping;
                chip.vy *= PROGRESSION.scatterDamping;
                chip.x += chip.vx * dt;
                chip.y += chip.vy * dt;
                chip.sprite.setPosition(chip.x, chip.y);
                if (collectable && distance <= PROGRESSION.pickupRadius) {
                    chip.active = false;
                    chip.sprite.setVisible(false);
                    this.collectChip();
                    continue;
                }
            }
            // Blink out the last couple of seconds so an expiring chip is not a surprise.
            if (chip.ttl < 2.5)
                chip.sprite.setAlpha(0.35 + Math.sin(this.host.scene.time.now / 60) * 0.35);
        }
    }
    collectChip() {
        const who = this.host.collector();
        this.host.award(1);
        const earned = this.progress.addChip();
        this.host.fx.chipSpark(who.x, who.y);
        if (earned)
            this.spawnPowerUp();
    }
    /**
     * Drop a power-up. With no position it materialises beside the player, which
     * is what a completed set of chips does.
     */
    spawnPowerUp(atX, atY) {
        const who = this.host.collector();
        const upgrade = this.progress.rollUpgrade();
        if (!upgrade) {
            // Everything is maxed; bank it as score instead of dropping a dud.
            this.host.award(250);
            this.host.banner('FULLY OPTIMISED', '+250');
            return;
        }
        const angle = Math.random() * Math.PI * 2;
        const fromKill = atX !== undefined && atY !== undefined;
        const originX = fromKill ? atX : who.x + Math.cos(angle) * PROGRESSION.spawnRadius;
        const originY = fromKill ? atY : who.y + Math.sin(angle) * PROGRESSION.spawnRadius;
        const powerUp = this.powerUps.acquire();
        powerUp.upgrade = upgrade;
        powerUp.x = clamp(originX, 40, WORLD.width - 40);
        powerUp.y = clamp(originY, 40, WORLD.height - 40);
        powerUp.ttl = PROGRESSION.powerUpTtlSec;
        powerUp.active = true;
        const colour = UPGRADES[upgrade].colour;
        powerUp.sprite
            .setTexture(TEX.powerUp(upgrade))
            .setPosition(powerUp.x, powerUp.y)
            .setVisible(true)
            .setAlpha(1)
            .setScale(0.2);
        powerUp.orbit
            .setPosition(powerUp.x, powerUp.y)
            .setTint(colour)
            .setVisible(true)
            .setAlpha(0.55)
            .setScale(0.2);
        powerUp.shadow
            .setPosition(powerUp.x, powerUp.y + 22)
            .setVisible(true)
            .setAlpha(0.9)
            .setScale(0.55);
        this.host.scene.tweens.add({ targets: powerUp.sprite, scale: 1, duration: 320, ease: 'Back.easeOut' });
        this.host.scene.tweens.add({ targets: powerUp.orbit, scale: 1, duration: 420, ease: 'Back.easeOut' });
        this.host.fx.ring(powerUp.x, powerUp.y, 90, UPGRADES[upgrade].colour, 420);
        this.host.banner(fromKill ? 'RARE DROP' : 'POWER-UP READY', UPGRADES[upgrade].name);
    }
    updatePowerUps(dt) {
        const who = this.host.collector();
        for (const powerUp of this.powerUps.items) {
            if (!powerUp.active)
                continue;
            powerUp.ttl -= dt;
            if (powerUp.ttl <= 0) {
                this.retire(powerUp);
                continue;
            }
            // Bob, orbit and breathe. Nothing else in the arena moves like this, so
            // the motion identifies a pickup from across the screen before its shape
            // or colour is legible — which is the point, in a crowd of enemies.
            const t = this.host.scene.time.now;
            const bob = Math.sin(t / 300) * 6;
            powerUp.sprite.setY(powerUp.y + bob).setRotation(Math.sin(t / 900) * 0.1);
            powerUp.orbit.setY(powerUp.y + bob * 0.6).setRotation(-t / 900);
            // The shadow shrinks as the crystal rises, which is what sells the hover.
            powerUp.shadow.setScale(0.55 - bob * 0.006, 0.55).setAlpha(0.9 - bob * 0.02);
            if (powerUp.ttl < 4) {
                const blink = 0.35 + Math.abs(Math.sin(t / 90)) * 0.65;
                powerUp.sprite.setAlpha(blink);
                powerUp.orbit.setAlpha(blink * 0.55);
            }
            if (!who.canCollect)
                continue;
            const reach = PROGRESSION.powerUpPickupRadius + who.radius;
            if (dist2(who.x, who.y, powerUp.x, powerUp.y) > reach * reach)
                continue;
            this.retire(powerUp);
            this.applyUpgrade(powerUp.upgrade);
        }
    }
    /** A power-up is three sprites; they must leave play together. */
    retire(powerUp) {
        powerUp.active = false;
        powerUp.sprite.setVisible(false);
        powerUp.orbit.setVisible(false);
        powerUp.shadow.setVisible(false);
    }
    applyUpgrade(id) {
        const who = this.host.collector();
        const def = UPGRADES[id];
        if (!this.progress.grant(id))
            return;
        this.host.fx.ring(who.x, who.y, 150, def.colour, 480);
        this.host.fx.upgradeText(who.x, who.y - 40, def.blurb, def.colour);
        this.host.banner(def.name.toUpperCase(), `${def.blurb} · ${this.progress.stacks[id]} stacks`);
        this.host.scene.cameras.main.flash(140, 255, 255, 255, false);
        this.host.rumble(0.5, 0.3, 130);
    }
}
//# sourceMappingURL=Progression.js.map