/** Shared, engine-agnostic type vocabulary. Nothing here imports Phaser. */

export type PlayerId = string;
export type EnemyId = string;
export type RoomId = string;

export type ClassId = 'overclocker' | 'fireman' | 'glitcher' | 'encoder';

/** Wire-compact enemy discriminator. */
export enum EnemyKind {
  GlitchBug = 0,
  FirewallDrone = 1,
  TrojanTank = 2,
  PacketWraith = 3,
  SporeNode = 4,
  RansomBrute = 5,
}

export interface Vec2 {
  x: number;
  y: number;
}

/** A point the host AI steers enemies toward: a real player, or a Glitcher decoy. */
export interface AiTarget extends Vec2 {
  id: string;
  /**
   * Targeting weight. 1 is an ordinary player; anything higher is treated as a
   * flat distance discount (see `AI.decoyPullPerPriority`), so a decoy wins
   * within its radius even against a player at point-blank range.
   */
  priority: number;
  alive: boolean;
}

/** Authoritative enemy record. Only ever mutated on the host. */
export interface Enemy extends Vec2 {
  id: EnemyId;
  kind: EnemyKind;
  /** 1-7. Scales health and reward; drawn as a coloured pip. See `enemyLevels.ts`. */
  level: number;
  hp: number;
  maxHp: number;
  vx: number;
  vy: number;
  speed: number;
  /** Seconds this enemy has been on the field. Drives `enrageScale`. */
  age: number;
  /** Seconds until this enemy may fire again (drones only). */
  cooldown: number;
  /** Seconds of remaining stun from a Fireman shockwave. */
  stun: number;
  targetId: string | null;
}

/** What a peer knows about an enemy it received over the wire. */
export interface EnemySnapshot {
  id: EnemyId;
  x: number;
  y: number;
  kind: EnemyKind;
  level: number;
  hp: number;
}

export interface PlayerState {
  id: PlayerId;
  name: string;
  cls: ClassId;
  x: number;
  y: number;
  /** Weapon angle in radians. */
  angle: number;
  hp: number;
  maxHp: number;
  /** Bitfield: 1 = firing, 2 = ability active, 4 = downed. */
  flags: number;
  /** Palette id. What this player *asked* for — see `sim/palette.ts`. */
  colour: string;
  /** Local receive timestamp, used for roster timeouts. Never transmitted. */
  lastSeen: number;
}

export const FLAG_FIRING = 1;
export const FLAG_ABILITY = 2;
export const FLAG_DOWN = 4;

/** Unified controller output — the single thing the game reads, whatever the device. */
export interface Intent {
  /** Normalised movement vector, magnitude 0..1. */
  moveX: number;
  moveY: number;
  /** Weapon angle in radians. */
  aim: number;
  /** True while the aim angle is being driven by a real stick/pointer, not autoaim. */
  aiming: boolean;
  firing: boolean;
  /** Edge-triggered: true for exactly one frame when the ability key goes down. */
  abilityPressed: boolean;
}

export interface EnemyProjectile extends Vec2 {
  id: string;
  vx: number;
  vy: number;
  life: number;
  damage: number;
}

/** A world-space effect owned by a player and shared with the room. */
export interface FieldEffect extends Vec2 {
  id: string;
  owner: PlayerId;
  kind: 'decoy' | 'heal' | 'shockwave';
  radius: number;
  /** Seconds remaining. */
  ttl: number;
}
