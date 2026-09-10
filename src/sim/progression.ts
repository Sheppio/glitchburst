/**
 * In-run progression: chips dropped by dead malware, converted into power-ups.
 *
 * Engine-agnostic and entirely per-player, which is a deliberate networking
 * decision as much as a design one — see `GameScene.spawnChips`. Nothing in
 * here imports Phaser or touches the wire.
 */

export type UpgradeId = 'damage' | 'speed' | 'firerate';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  /** Two or three characters, for the HUD. */
  short: string;
  blurb: string;
  colour: number;
  cssColour: string;
  /** Fractional change per stack. */
  step: number;
  maxStacks: number;
}

export const UPGRADES: Record<UpgradeId, UpgradeDef> = {
  damage: {
    id: 'damage',
    name: 'Payload Boost',
    short: 'DMG',
    blurb: '+18% weapon damage',
    colour: 0xff2d95,
    cssColour: '#ff2d95',
    step: 0.18,
    maxStacks: 12,
  },
  speed: {
    id: 'speed',
    name: 'Clock Boost',
    short: 'SPD',
    blurb: '+8% movement speed',
    colour: 0x00c8dc,
    cssColour: '#00c8dc',
    step: 0.08,
    maxStacks: 8,
  },
  firerate: {
    id: 'firerate',
    name: 'Pipeline Boost',
    short: 'ROF',
    blurb: '+11% fire rate',
    colour: 0xff9f00,
    cssColour: '#ff9f00',
    step: 0.11,
    maxStacks: 10,
  },
};

export const UPGRADE_ORDER: UpgradeId[] = ['damage', 'speed', 'firerate'];

export const PROGRESSION = {
  /** Chips needed for one power-up. */
  chipsPerPowerUp: 10,
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
} as const;

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
  /** Chips collected across the whole run, for the end-of-run readout. */
  totalChips = 0;
  readonly stacks: Record<UpgradeId, number> = { damage: 0, speed: 0, firerate: 0 };

  /** @returns true if this chip completed a set and earned a power-up. */
  addChip(): boolean {
    this.chips += 1;
    this.totalChips += 1;
    if (this.chips < PROGRESSION.chipsPerPowerUp) return false;
    this.chips -= PROGRESSION.chipsPerPowerUp;
    return true;
  }

  /** @returns false if that upgrade is already maxed. */
  grant(id: UpgradeId): boolean {
    if (this.stacks[id] >= UPGRADES[id].maxStacks) return false;
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
  rollUpgrade(random: () => number = Math.random): UpgradeId | null {
    const available = UPGRADE_ORDER.filter((id) => this.stacks[id] < UPGRADES[id].maxStacks);
    if (!available.length) return null;

    const weights = available.map((id) => 1 / (1 + this.stacks[id]));
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = random() * total;
    for (let i = 0; i < available.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) return available[i]!;
    }
    return available[available.length - 1]!;
  }

  get damageMultiplier(): number {
    return 1 + this.stacks.damage * UPGRADES.damage.step;
  }

  get speedMultiplier(): number {
    return 1 + this.stacks.speed * UPGRADES.speed.step;
  }

  /** Fire *interval* shrinks as fire rate rises, so this is below 1. */
  get fireIntervalMultiplier(): number {
    return 1 / (1 + this.stacks.firerate * UPGRADES.firerate.step);
  }

  get totalStacks(): number {
    return this.stacks.damage + this.stacks.speed + this.stacks.firerate;
  }
}
