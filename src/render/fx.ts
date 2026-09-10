import * as Phaser from 'phaser';
import { DATA_STRINGS } from '../sim/enemyTypes.js';
import { TEX } from './textures.js';

const MONO = '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace';

/**
 * Everything that makes a kill feel good: pixel bursts, leaked data strings,
 * damage numbers, muzzle flashes and ability rings.
 *
 * Text objects are pooled. A single wave can kill a dozen enemies inside one
 * frame, and allocating a fresh `Text` per fragment means allocating a fresh
 * canvas texture per fragment — the one reliable way to stutter a Phaser game.
 */
export class Fx {
  private emitters = new Map<number, Phaser.GameObjects.Particles.ParticleEmitter>();
  private textPool: Phaser.GameObjects.Text[] = [];
  private live = new Set<Phaser.GameObjects.Text>();

  constructor(
    private scene: Phaser.Scene,
    private depth = 60,
  ) {}

  /**
   * Enemy death: a shower of pixel debris plus a fragment of the data the
   * process was holding. Two visual languages on purpose — the particles read
   * as destruction, the text reads as *information spilling out*, which is the
   * whole conceit of the setting.
   */
  enemyBurst(x: number, y: number, colour: number, scale = 1): void {
    this.emitterFor(colour).explode(Math.round(14 * scale), x, y);
    this.emitterFor(0xffffff).explode(Math.round(5 * scale), x, y);

    const label = DATA_STRINGS[Math.floor(Math.random() * DATA_STRINGS.length)]!;
    this.floatText(x, y - 6, label, colour, 15 * scale, 900);
  }

  /** Small spark where a bullet connects, before the enemy is confirmed dead. */
  hitSpark(x: number, y: number, colour: number): void {
    this.emitterFor(colour).explode(4, x, y);
  }

  damageNumber(x: number, y: number, amount: number, colour: number): void {
    this.floatText(x, y, `-${Math.round(amount)}`, colour, 13, 620);
  }

  healNumber(x: number, y: number, amount: number): void {
    this.floatText(x, y, `+${Math.round(amount)}`, 0x7cff00, 13, 620);
  }

  muzzleFlash(x: number, y: number, angle: number, colour: number): void {
    const flash = this.scene.add
      .image(x, y, TEX.glow)
      .setTint(colour)
      .setBlendMode(Phaser.BlendModes.ADD)
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
  ring(x: number, y: number, radius: number, colour: number, durationMs = 420): void {
    const ring = this.scene.add
      .image(x, y, TEX.ring)
      .setTint(colour)
      .setBlendMode(Phaser.BlendModes.ADD)
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
  banner(text: string, colour: number, sub?: string): void {
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

    const targets: Phaser.GameObjects.GameObject[] = [label];

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

  private floatText(x: number, y: number, value: string, colour: number, size: number, duration: number): void {
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

    this.scene.tweens.add({
      targets: label,
      y: y - 42 - Math.random() * 20,
      alpha: 0,
      duration,
      ease: 'Cubic.easeOut',
      onComplete: () => this.releaseText(label),
    });
  }

  private takeText(): Phaser.GameObjects.Text {
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

  private releaseText(label: Phaser.GameObjects.Text): void {
    label.setVisible(false).setActive(false);
    this.live.delete(label);
    // Cap the pool: a huge wave should not permanently hold 200 text canvases.
    if (this.textPool.length < 48) this.textPool.push(label);
    else label.destroy();
  }

  /**
   * One emitter per colour, created on demand. Phaser can only tint a
   * particle emitter as a whole, so the colours the game actually uses (three
   * enemy families, plus white) become three or four long-lived emitters
   * instead of one per burst.
   */
  private emitterFor(colour: number): Phaser.GameObjects.Particles.ParticleEmitter {
    const existing = this.emitters.get(colour);
    if (existing) return existing;

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

function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}
