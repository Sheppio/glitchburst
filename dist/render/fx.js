import * as Phaser from 'phaser';
import { DATA_STRINGS } from '../sim/enemyTypes.js';
import { TEX } from './textures.js';
const MONO = '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';
/** One colour means "something took damage", regardless of what was hit. */
export const DAMAGE_RED = 0xe6003c;
/**
 * Everything that makes a kill feel good: pixel bursts, leaked data strings,
 * damage numbers, muzzle flashes and ability rings.
 *
 * Text objects are pooled. A single wave can kill a dozen enemies inside one
 * frame, and allocating a fresh `Text` per fragment means allocating a fresh
 * canvas texture per fragment — the one reliable way to stutter a Phaser game.
 */
export class Fx {
    scene;
    depth;
    emitters = new Map();
    textPool = [];
    live = new Set();
    constructor(scene, depth = 60) {
        this.scene = scene;
        this.depth = depth;
    }
    /**
     * Enemy death: a shower of pixel debris plus a fragment of the data the
     * process was holding. Two visual languages on purpose — the particles read
     * as destruction, the text reads as *information spilling out*, which is the
     * whole conceit of the setting.
     */
    enemyBurst(x, y, colour, scale = 1) {
        this.emitterFor(colour).explode(Math.round(14 * scale), x, y);
        this.emitterFor(0xffffff).explode(Math.round(5 * scale), x, y);
        const label = DATA_STRINGS[Math.floor(Math.random() * DATA_STRINGS.length)];
        this.floatText(x, y - 6, label, colour, 15 * scale, 900);
    }
    /** Materialisation ring for an enemy arriving in the arena. */
    spawnFlash(x, y, colour, radius) {
        const ring = this.scene.add
            .image(x, y, TEX.ring)
            .setTint(colour)
            .setDepth(this.depth - 2)
            .setScale((radius * 3) / 128)
            .setAlpha(0.8);
        this.scene.tweens.add({
            targets: ring,
            scale: (radius * 0.6) / 128,
            alpha: 0,
            duration: 300,
            ease: 'Cubic.easeOut',
            onComplete: () => ring.destroy(),
        });
    }
    /** Small spark where a bullet connects, before the enemy is confirmed dead. */
    hitSpark(x, y, colour) {
        this.emitterFor(colour).explode(5, x, y);
        this.emitterFor(DAMAGE_RED).explode(4, x, y);
    }
    /**
     * Damage taken by anything, in red.
     *
     * Deliberately not the enemy's own colour, which is what this used to do:
     * tying the number to the target made damage read as decoration rather than
     * as a distinct event, and an amber number over an amber drone was nearly
     * invisible. One colour for "damage", always, with a white outline so it
     * stays legible over sprites, grid lines and other numbers.
     */
    /** A chip landing in the bank. Deliberately quiet — this fires constantly. */
    chipSpark(x, y) {
        this.emitterFor(0x7cff3d).explode(3, x, y);
    }
    /** What an upgrade actually did, in its own colour. */
    upgradeText(x, y, text, colour) {
        this.floatText(x, y, text, colour, 19, 1400, '#ffffff');
    }
    damageNumber(x, y, amount) {
        this.floatText(x, y, `-${Math.round(amount)}`, DAMAGE_RED, 17, 700, '#ffffff');
    }
    healNumber(x, y, amount) {
        this.floatText(x, y, `+${Math.round(amount)}`, 0x3fae00, 15, 620, '#ffffff');
    }
    muzzleFlash(x, y, angle, colour) {
        const flash = this.scene.add
            .image(x, y, TEX.glow)
            .setTint(colour)
            // NOT additive: the arena is white, so adding light to it produces
            // nothing. Normal alpha over white reads as a soft colour wash instead.
            .setBlendMode(Phaser.BlendModes.NORMAL)
            .setDepth(this.depth - 1)
            .setScale(0.28)
            .setRotation(angle);
        this.scene.tweens.add({
            targets: flash,
            scale: 0.05,
            alpha: 0,
            duration: 110,
            onComplete: () => flash.destroy(),
        });
    }
    /** Expanding ring — the Fireman's shockwave and the peer-side echo of it. */
    ring(x, y, radius, colour, durationMs = 420) {
        const ring = this.scene.add
            .image(x, y, TEX.ring)
            .setTint(colour)
            .setBlendMode(Phaser.BlendModes.NORMAL)
            .setDepth(this.depth)
            .setScale(0.15)
            .setAlpha(0.95);
        this.scene.tweens.add({
            targets: ring,
            scale: (radius * 2) / 128,
            alpha: 0,
            duration: durationMs,
            ease: 'Cubic.easeOut',
            onComplete: () => ring.destroy(),
        });
    }
    /** Screen-space banner for waves, host handover and other room-level news. */
    banner(text, colour, sub) {
        const cam = this.scene.cameras.main;
        const label = this.scene.add
            .text(cam.width / 2, cam.height / 2 - 90, text, {
            fontFamily: MONO,
            fontSize: '42px',
            color: hex(colour),
            align: 'center',
        })
            .setOrigin(0.5)
            .setScrollFactor(0)
            .setDepth(200)
            .setAlpha(0);
        const targets = [label];
        if (sub) {
            const subLabel = this.scene.add
                .text(cam.width / 2, cam.height / 2 - 50, sub, {
                fontFamily: MONO,
                fontSize: '15px',
                color: '#5a6472',
                align: 'center',
            })
                .setOrigin(0.5)
                .setScrollFactor(0)
                .setDepth(200)
                .setAlpha(0);
            targets.push(subLabel);
        }
        this.scene.tweens.add({
            targets,
            alpha: 1,
            y: '-=18',
            duration: 260,
            ease: 'Cubic.easeOut',
            yoyo: true,
            hold: 900,
            onComplete: () => targets.forEach((t) => t.destroy()),
        });
    }
    /* ------------------------------------------------------------- internals */
    floatText(x, y, value, colour, size, duration, stroke) {
        const label = this.takeText();
        label
            .setText(value)
            .setPosition(x + (Math.random() - 0.5) * 18, y)
            .setColor(hex(colour))
            .setFontSize(size)
            .setAlpha(1)
            .setScale(1)
            .setVisible(true)
            .setActive(true);
        if (stroke)
            label.setStroke(stroke, 4);
        else
            label.setStroke('', 0);
        this.scene.tweens.add({
            targets: label,
            y: y - 42 - Math.random() * 20,
            alpha: 0,
            duration,
            ease: 'Cubic.easeOut',
            onComplete: () => this.releaseText(label),
        });
    }
    takeText() {
        const pooled = this.textPool.pop();
        if (pooled) {
            this.live.add(pooled);
            return pooled;
        }
        const label = this.scene.add
            .text(0, 0, '', { fontFamily: MONO, fontSize: '14px', color: '#ffffff' })
            .setOrigin(0.5)
            .setDepth(this.depth + 1);
        this.live.add(label);
        return label;
    }
    releaseText(label) {
        label.setVisible(false).setActive(false);
        this.live.delete(label);
        // Cap the pool: a huge wave should not permanently hold 200 text canvases.
        if (this.textPool.length < 48)
            this.textPool.push(label);
        else
            label.destroy();
    }
    /**
     * One emitter per colour, created on demand. Phaser can only tint a
     * particle emitter as a whole, so the colours the game actually uses (three
     * enemy families, plus white) become three or four long-lived emitters
     * instead of one per burst.
     */
    emitterFor(colour) {
        const existing = this.emitters.get(colour);
        if (existing)
            return existing;
        const emitter = this.scene.add.particles(0, 0, TEX.pixel, {
            lifespan: { min: 260, max: 620 },
            speed: { min: 60, max: 300 },
            scale: { start: 1.5, end: 0 },
            alpha: { start: 1, end: 0.1 },
            rotate: { min: 0, max: 360 },
            gravityY: 0,
            blendMode: Phaser.BlendModes.NORMAL,
            tint: colour,
            emitting: false,
        });
        emitter.setDepth(this.depth);
        this.emitters.set(colour, emitter);
        return emitter;
    }
}
function hex(colour) {
    return `#${colour.toString(16).padStart(6, '0')}`;
}
//# sourceMappingURL=fx.js.map