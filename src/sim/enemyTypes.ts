import { EnemyKind } from '../types.js';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  /** Malware family flavour text shown on the death burst. */
  tag: string;
  hp: number;
  speed: number;
  radius: number;
  /** Damage applied to a player on contact, per hit. Victim-authority (requirement 4). */
  contactDamage: number;
  /** Seconds between contact hits on the same player. */
  contactCooldown: number;
  colour: number;
  /** Relative spawn weight, scaled by wave number in `HordeEngine`. */
  weight: number;
  /**
   * First wave this kind can appear in.
   *
   * Everything arriving at once means wave 1 already shows the whole game. Held
   * back, each new silhouette is a small event, and the player learns one
   * threat at a time instead of six simultaneously.
   */
  minWave: number;
  /** Perpendicular weave amplitude, as a fraction of speed. 0 for straight-line movers. */
  weave?: number;
  /** Spawns this many Glitch Bugs where it dies. */
  splitInto?: number;
  score: number;
  /**
   * Chips dropped on death. Fixed per kind rather than randomised: every
   * client spawns these independently from the same death event, so a random
   * count would leave clients disagreeing about what is on the floor.
   */
  chipDrop: number;
  /**
   * Chance this kind drops a power-up outright on death, 0..1. Rolled from a
   * hash of the enemy's id rather than at random, so every client agrees on
   * which corpse dropped one.
   */
  powerUpChance: number;
  /** Present only on ranged enemies. */
  ranged?: {
    /** The drone tries to hover at this distance from its target. */
    preferredRange: number;
    fireIntervalSec: number;
    projectileSpeed: number;
    projectileDamage: number;
    projectileLifeSec: number;
  };
}

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  [EnemyKind.GlitchBug]: {
    kind: EnemyKind.GlitchBug,
    name: 'Glitch Bug',
    tag: '0xBUG',
    hp: 30,
    speed: 168,
    radius: 13,
    contactDamage: 7,
    contactCooldown: 0.6,
    colour: 0xff2d95,
    weight: 68,
    minWave: 1,
    score: 10,
    chipDrop: 1,
    powerUpChance: 0,
  },
  [EnemyKind.FirewallDrone]: {
    kind: EnemyKind.FirewallDrone,
    name: 'Firewall Drone',
    tag: 'ICE.SYS',
    hp: 58,
    speed: 108,
    radius: 19,
    contactDamage: 4,
    contactCooldown: 0.8,
    colour: 0xffb300,
    weight: 24,
    minWave: 3,
    score: 25,
    chipDrop: 2,
    powerUpChance: 0.06,
    ranged: {
      preferredRange: 300,
      fireIntervalSec: 1.7,
      projectileSpeed: 330,
      projectileDamage: 9,
      projectileLifeSec: 3.2,
    },
  },
  [EnemyKind.TrojanTank]: {
    kind: EnemyKind.TrojanTank,
    name: 'Trojan Tank',
    tag: 'TROJAN',
    hp: 265,
    speed: 56,
    radius: 33,
    contactDamage: 18,
    contactCooldown: 0.9,
    colour: 0x7a5cff,
    weight: 8,
    minWave: 8,
    score: 60,
    chipDrop: 4,
    powerUpChance: 0.22,
  },
  [EnemyKind.PacketWraith]: {
    kind: EnemyKind.PacketWraith,
    name: 'Packet Wraith',
    tag: 'SYN/ACK',
    hp: 26,
    speed: 232,
    radius: 11,
    contactDamage: 6,
    contactCooldown: 0.45,
    colour: 0x00a98f,
    weight: 30,
    minWave: 4,
    score: 18,
    chipDrop: 1,
    powerUpChance: 0,
    // Weaves rather than charging, so it is genuinely harder to lead than a bug
    // despite being no tougher.
    weave: 0.75,
  },

  [EnemyKind.SporeNode]: {
    kind: EnemyKind.SporeNode,
    name: 'Spore Node',
    tag: 'fork()',
    hp: 78,
    speed: 96,
    radius: 18,
    contactDamage: 9,
    contactCooldown: 0.7,
    colour: 0xf4511e,
    weight: 18,
    minWave: 6,
    score: 35,
    chipDrop: 2,
    powerUpChance: 0.04,
    // Killing one is not the end of it. Punishes clearing the slow target
    // first and walking away.
    splitInto: 2,
  },

  [EnemyKind.RansomBrute]: {
    kind: EnemyKind.RansomBrute,
    name: 'Ransom Brute',
    tag: 'ENCRYPT',
    hp: 540,
    speed: 46,
    radius: 39,
    contactDamage: 27,
    contactCooldown: 1,
    colour: 0x455a64,
    weight: 5,
    minWave: 12,
    score: 120,
    chipDrop: 6,
    powerUpChance: 0.3,
  },
};

/** Every kind, in the order they are unlocked. */
export const ALL_KINDS: EnemyKind[] = [
  EnemyKind.GlitchBug,
  EnemyKind.FirewallDrone,
  EnemyKind.PacketWraith,
  EnemyKind.SporeNode,
  EnemyKind.TrojanTank,
  EnemyKind.RansomBrute,
];

/** Fragments of "leaked data" that spray out of a corpse. */
export const DATA_STRINGS = [
  '0xDEAD', 'NULL', 'SEGV', '11010', 'ERR_', 'void*', '<EOF>', '0x00FF',
  'PURGED', 'free()', 'ACK', '404', 'kill -9', '/dev/null', 'FLUSH',
];
