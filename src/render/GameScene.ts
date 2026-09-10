import * as Phaser from 'phaser';
import { HORDE, NET, RENDER, TURN_RATE_RAD_PER_SEC, WORLD } from '../config.js';
import { HAPTIC } from '../input/settings.js';
import type { InputManager } from '../input/InputManager.js';
import type { SettingsStore } from '../input/settings.js';
import {
  decodeEvents,
  decodeField,
  decodeHorde,
  decodePause,
  decodeShots,
  decodePlayer,
  encodeDamage,
  encodeEvents,
  encodeField,
  encodeHorde,
  encodePause,
  encodePlayer,
  encodeShots,
} from '../net/codec.js';
import type { ShotRecord } from '../net/codec.js';
import type { MqttNet } from '../net/MqttNet.js';
import type { RoomSession } from '../net/RoomSession.js';
import { Topics, segment } from '../net/topics.js';
import { CLASSES, classDps } from '../sim/classes.js';
import type { ClassDef } from '../sim/classes.js';
import { ENEMY_DEFS } from '../sim/enemyTypes.js';
import { HordeEngine } from '../sim/HordeEngine.js';
import { PROGRESSION, UPGRADES, UPGRADE_ORDER } from '../sim/progression.js';
import { pickTarget } from '../sim/targeting.js';
import { EnemyKind, FLAG_ABILITY, FLAG_DOWN, FLAG_FIRING } from '../types.js';
import type { AiTarget, ClassId, EnemyId, FieldEffect, PlayerId, PlayerState, Vec2 } from '../types.js';
import { approachAngle, clamp, counterId, dist2, lerpAngle, segmentDist2 } from '../util.js';
import { DAMAGE_RED, Fx } from './fx.js';
import { glide, smoothing } from './lerp.js';
import { Pool } from './pool.js';
import { ProgressionSystem } from './Progression.js';
import { TEX } from './textures.js';

export interface HudSnapshot {
  hp: number;
  maxHp: number;
  score: number;
  wave: number;
  enemies: number;
  isHost: boolean;
  hostName: string;
  abilityReady: boolean;
  abilityRemaining: number;
  abilityName: string;
  downed: boolean;
  respawnIn: number;
  /** Chips banked toward the next power-up, and how many a set takes. */
  chips: number;
  chipsPerPowerUp: number;
  upgrades: Array<{ short: string; cssColour: string; stacks: number }>;
  paused: boolean;
  /** Display name of whoever paused, for the overlay. */
  pausedBy: string;
  /** Only the host may pause or resume. */
  canPause: boolean;
  /** Live squad size, 1-4 — what the horde difficulty is scaled to. */
  players: number;
  squad: Array<{ id: string; name: string; cls: ClassId; hp: number; maxHp: number; isSelf: boolean; isHost: boolean }>;
}

export interface GameSceneInit {
  net: MqttNet;
  room: RoomSession;
  input: InputManager;
  settings: SettingsStore;
  classId: ClassId;
  playerName: string;
  onHud: (snapshot: HudSnapshot) => void;
  onBanner: (text: string, sub?: string) => void;
}

interface EnemyView {
  id: EnemyId;
  kind: EnemyKind;
  hp: number;
  maxHp: number;
  sprite: Phaser.GameObjects.Image;
  /** Network target position. On the host this tracks the simulation directly. */
  tx: number;
  ty: number;
  /** Snapshot tick this enemy last appeared in — drives stale cleanup on peers. */
  seen: number;
}

interface Bullet {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
  pierce: number;
  radius: number;
  knockback: number;
  hit: Set<EnemyId>;
  active: boolean;
}

interface EnemyBullet {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
  active: boolean;
}

interface RemotePlayer {
  state: PlayerState;
  sprite: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  aura: Phaser.GameObjects.Image;
}

interface ActiveField extends FieldEffect {
  sprite: Phaser.GameObjects.Image;
}

/**
 * The game.
 *
 * Two responsibilities are worth reading in isolation:
 *
 *  - `hostStep()` — if this client won the election it owns the horde. It runs
 *    on a fixed 20Hz timer, independent of rendering, and broadcasts the whole
 *    horde as one batched string per tick.
 *
 *  - `onHordeSnapshot()` — if this client is a peer it never simulates enemies.
 *    It unpacks that string, spawns anything it has not seen before (which is
 *    what makes joining mid-wave seamless), and glides the rest toward their
 *    new positions instead of teleporting them.
 *
 * Hit detection is split by authority, deliberately:
 *  - a player's *own* client decides when malware hurts it, and publishes the
 *    result (victim authority);
 *  - a *shooter's* client decides when its bullets connect, and reports damage
 *    to the host, which is the only place enemy health actually changes
 *    (attacker authority).
 * Both halves put the decision on the machine with zero latency to the input
 * that caused it, which is why the game stays responsive on a public broker.
 */
export class GameScene extends Phaser.Scene {
  private cfg!: GameSceneInit;
  private def!: ClassDef;

  private player!: Phaser.GameObjects.Image;
  private playerAura!: Phaser.GameObjects.Image;
  private me: PlayerState = {
    id: '',
    name: '',
    cls: 'overclocker',
    x: 0,
    y: 0,
    angle: 0,
    hp: 100,
    maxHp: 100,
    flags: 0,
    lastSeen: 0,
  };

  private fx!: Fx;
  /**
   * Every enemy health bar, drawn into one Graphics object.
   *
   * A hundred enemies with two sprites each would be two hundred game objects
   * to position every frame; one Graphics redrawn per frame is a single object
   * and, because bars only appear on damaged enemies, usually a handful of
   * rectangles.
   */
  private healthBars!: Phaser.GameObjects.Graphics;
  private horde: HordeEngine | null = null;

  private enemies = new Map<EnemyId, EnemyView>();
  private remotes = new Map<PlayerId, RemotePlayer>();
  private fields = new Map<string, ActiveField>();
  private bullets = new Pool<Bullet>(() => ({
    sprite: this.add.image(0, 0, TEX.bullet).setDepth(25),
    x: 0, y: 0, vx: 0, vy: 0, life: 0, damage: 0, pierce: 1, radius: 5, knockback: 0,
    hit: new Set(), active: false,
  }));

  private enemyBullets = new Pool<EnemyBullet>(() => ({
    sprite: this.add.image(0, 0, TEX.enemyBullet).setDepth(24).setTint(ENEMY_DEFS[EnemyKind.FirewallDrone].colour),
    x: 0, y: 0, vx: 0, vy: 0, life: 0, damage: 0, active: false,
  }));
  /**
   * Projectiles fired by *other* players.
   *
   * Purely cosmetic: they never test collision and never deal damage, because
   * under attacker authority only the shooter's own client decides whether its
   * rounds connected. Rendering them is what makes a squad feel like a squad
   * rather than four people fighting invisible battles beside each other.
   */
  private remoteBullets = new Pool<EnemyBullet>(() => ({
    sprite: this.add.image(0, 0, TEX.bullet).setDepth(24),
    x: 0, y: 0, vx: 0, vy: 0, life: 0, damage: 0, active: false,
  }));
  /** Shots fired locally since the last publish. */
  private outboundShots: ShotRecord[] = [];
  /** Chips, power-ups and upgrades. See `render/Progression.ts`. */
  private progression!: ProgressionSystem;
  /** Enemy currently held by auto-aim, so the lock can be sticky. */
  private autoTargetId: string | null = null;

  private fireCooldown = 0;
  private abilityCooldown = 0;
  private abilityActiveUntil = 0;
  private contactCooldown = 0;
  private downedFor = 0;
  private score = 0;
  private snapshotTick = 0;
  private lastWave = 0;
  private paused = false;
  private pausedBy = '';

  /**
   * Host simulation timer.
   *
   * Deliberately NOT driven by the render loop. Tying the horde to
   * requestAnimationFrame makes the whole room's difficulty a function of the
   * host's graphics card: a host rendering at 8fps would broadcast at 8Hz and
   * simulate in 125ms steps, and every peer would see a stuttering horde
   * through no fault of their own. A fixed interval keeps the authoritative
   * tick at 20Hz regardless of what the host's screen is doing.
   */
  private hostTimer = 0;
  private lastHostStepAt = 0;

  /** Accumulator for the fixed-rate player-state publisher. */
  private playerAccumulator = 0;
  private damageAccumulator = 0;

  /** Damage this client has dealt but not yet reported, keyed by enemy. */
  private pendingDamage = new Map<EnemyId, number>();

  private unsubs: Array<() => void> = [];
  private nextLocalId = 1;

  constructor() {
    super('game');
  }

  init(cfg: GameSceneInit): void {
    this.cfg = cfg;
    this.def = CLASSES[cfg.classId];
  }

  create(): void {
    const { room, input, playerName, classId } = this.cfg;

    this.me = {
      id: room.playerId,
      name: playerName,
      cls: classId,
      x: WORLD.width / 2 + (Math.random() - 0.5) * 240,
      y: WORLD.height / 2 + (Math.random() - 0.5) * 240,
      angle: 0,
      hp: this.def.maxHp,
      maxHp: this.def.maxHp,
      flags: 0,
      lastSeen: 0,
    };

    this.buildArena();
    this.fx = new Fx(this);

    this.progression = new ProgressionSystem({
      scene: this,
      fx: this.fx,
      collector: () => ({
        x: this.me.x,
        y: this.me.y,
        radius: this.def.radius,
        canCollect: this.downedFor <= 0,
      }),
      award: (score) => {
        this.score += score;
      },
      banner: (text, sub) => this.cfg.onBanner(text, sub),
      rumble: (weak, strong, ms) => this.cfg.input.triggerRumble(weak, strong, ms),
    });

    this.playerAura = this.add
      .image(this.me.x, this.me.y, TEX.glow)
      .setTint(this.def.colour)
      // Normal, not additive: additive light over a white arena is a no-op.
      .setBlendMode(Phaser.BlendModes.NORMAL)
      .setScale(0.85)
      .setDepth(8);

    this.player = this.add.image(this.me.x, this.me.y, TEX.player(classId)).setDepth(30);

    // Above the enemies, below the bullets.
    this.healthBars = this.add.graphics().setDepth(22);

    this.cameras.main
      .setBounds(0, 0, WORLD.width, WORLD.height)
      .startFollow(this.player, true, 0.12, 0.12)
      .setBackgroundColor('#f2f5f9');

    // Auto-aim asks the scene for a target; the scene is the only thing that
    // knows where the enemies are.
    input.aimAssist = (from, range) => this.nearestEnemy(from, range);

    this.wireNetwork();

    room.hostStatsProvider = () => ({
      enemyCount: this.horde?.enemyCount ?? this.enemies.size,
      wave: this.horde?.waveNumber ?? this.lastWave,
      paused: this.paused,
    });

    this.unsubs.push(
      room.events.on('hostChange', ({ isHost, reason }) => this.onHostChange(isHost, reason)),
      room.events.on('hostStats', ({ wave, paused }) => {
        this.lastWave = wave;
        // A client that joined mid-pause, or missed the pause message, syncs here.
        if (!this.cfg.room.isHost && paused !== this.paused) this.applyPause(paused, this.pausedBy);
      }),
      room.events.on('peerLeave', ({ id }) => this.removeRemote(id)),
    );

    if (room.isHost) this.onHostChange(true, 'initial');

    window.addEventListener('keydown', this.onKeyDown);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
  }

  override update(_time: number, delta: number): void {
    // Read pause input first: it is the one control that must keep working
    // while everything else is frozen.
    this.pollPauseInput();
    if (this.paused) {
      this.pushHud();
      return;
    }

    const dt = Math.min(delta, 50) / 1000;

    this.updateLocalPlayer(dt);
    this.updateBullets(dt);
    this.updateEnemyBullets(dt);
    this.updateRemoteBullets(dt);
    this.updateFields(dt);
    this.progression.update(dt);

    // Enemy motion is interpolated identically whether this client is the host
    // or a peer: the host's own simulation only refreshes targets at 20Hz too.
    this.interpolateEnemies(delta);
    this.drawHealthBars();

    this.updateRemotes(delta);
    this.flushDamage(dt);
    this.publishPlayer(dt);
    this.pushHud();
  }

  /* ------------------------------------------------------------ local play */

  private updateLocalPlayer(dt: number): void {
    const { input } = this.cfg;
    const cam = this.cameras.main;
    const screen: Vec2 = {
      x: (this.me.x - cam.worldView.x) * cam.zoom,
      y: (this.me.y - cam.worldView.y) * cam.zoom,
    };

    const intent = input.update(screen, this.me);
    const boosted = this.time.now < this.abilityActiveUntil && this.def.ability.kind === 'overclock';

    if (this.downedFor > 0) {
      this.downedFor -= dt;
      this.me.flags = FLAG_DOWN;
      this.player.setAlpha(0.35);
      if (this.downedFor <= 0) this.respawn();
      return;
    }

    const speed = this.def.speed * (boosted ? 1.35 : 1) * this.progression.progress.speedMultiplier;
    this.me.x = clamp(this.me.x + intent.moveX * speed * dt, 24, WORLD.width - 24);
    this.me.y = clamp(this.me.y + intent.moveY * speed * dt, 24, WORLD.height - 24);

    // Turn toward the requested angle at a fixed rate rather than snapping to
    // it. Shots leave along the barrel's real facing (see fireWeapon below), so
    // this is a mechanic, not a cosmetic: you cannot snap-fire behind you, and
    // auto-aim visibly swings onto its target.
    this.me.angle = approachAngle(this.me.angle, intent.aim, TURN_RATE_RAD_PER_SEC * dt);

    this.player.setPosition(this.me.x, this.me.y).setRotation(this.me.angle).setAlpha(1);
    this.playerAura.setPosition(this.me.x, this.me.y).setAlpha(boosted ? 0.55 : 0.22);

    this.fireCooldown -= dt;
    this.abilityCooldown -= dt;

    // Fire along the chassis, not the request: the turn rate has to cost
    // something or it is just an animation.
    if (intent.firing && this.fireCooldown <= 0) this.fireWeapon(this.me.angle, boosted);
    if (intent.abilityPressed && this.abilityCooldown <= 0) this.activateAbility();

    this.me.flags =
      (intent.firing ? FLAG_FIRING : 0) | (this.time.now < this.abilityActiveUntil ? FLAG_ABILITY : 0);

    this.checkEnemyContact(dt);
  }

  private fireWeapon(angle: number, boosted: boolean): void {
    const w = this.def.weapon;
    this.fireCooldown =
      (w.fireIntervalSec * this.progression.progress.fireIntervalMultiplier) /
      (boosted ? this.def.ability.magnitude : 1);
    const damage = w.damage * this.progression.progress.damageMultiplier;

    const step = w.pellets > 1 ? w.spread / (w.pellets - 1) : 0;
    const start = angle - w.spread / 2;

    for (let n = 0; n < w.pellets; n++) {
      const a = w.pellets > 1 ? start + step * n : angle + (Math.random() - 0.5) * w.spread;
      const bullet = this.bullets.acquire();
      // Spawn just inside the chassis, not at the barrel tip. An enemy pressed
      // against the player sits *closer* than the muzzle, so spawning at the
      // tip put the round past it — and since auto-aim targets the nearest
      // enemy, the one thing you could never hit was the thing eating you.
      bullet.x = this.me.x + Math.cos(angle) * (this.def.radius * 0.5);
      bullet.y = this.me.y + Math.sin(angle) * (this.def.radius * 0.5);
      bullet.vx = Math.cos(a) * w.speed;
      bullet.vy = Math.sin(a) * w.speed;
      bullet.life = w.lifeSec;
      bullet.damage = damage;
      bullet.pierce = w.pierce;
      bullet.radius = w.radius;
      bullet.knockback = w.knockback;
      bullet.hit.clear();
      bullet.active = true;
      bullet.sprite
        .setPosition(bullet.x, bullet.y)
        .setRotation(a)
        .setTint(this.def.colour)
        .setVisible(true);
    }

    // One record per trigger pull; the pellet fan is rebuilt from the class
    // definition on the receiving side. Capped so a pathological burst cannot
    // inflate a single message.
    if (this.outboundShots.length < 16) {
      this.outboundShots.push({ x: this.me.x, y: this.me.y, angle });
    }

    this.fx.muzzleFlash(
      this.me.x + Math.cos(angle) * (this.def.radius + 10),
      this.me.y + Math.sin(angle) * (this.def.radius + 10),
      angle,
      this.def.colour,
    );
    this.cameras.main.shake(60, 0.0016);
    this.cfg.input.triggerRumble(HAPTIC.shot.weak, HAPTIC.shot.strong, HAPTIC.shot.ms);
  }

  /**
   * Class abilities. Everything that other clients must see goes on the wire as
   * a field effect; purely local buffs (the Overclocker's) ride along in the
   * player state flags instead, which costs nothing extra.
   */
  private activateAbility(): void {
    const ability = this.def.ability;
    this.abilityCooldown = ability.cooldownSec;
    this.abilityActiveUntil = this.time.now + ability.durationSec * 1000;

    // Requirement: rumble when the local player activates their class ability.
    this.cfg.input.triggerRumble(HAPTIC.ability.weak, HAPTIC.ability.strong, HAPTIC.ability.ms);

    switch (ability.kind) {
      case 'overclock':
        this.fx.ring(this.me.x, this.me.y, 120, this.def.colour, 320);
        this.cfg.onBanner('THERMAL RUNAWAY');
        break;

      case 'shockwave': {
        // Visual is immediate and local; the knockback is applied by whoever
        // owns the horde, because enemy state is never edited off-host.
        this.fx.ring(this.me.x, this.me.y, ability.radius, this.def.colour, 460);
        this.cameras.main.shake(220, 0.008);
        this.broadcastField('shockwave', this.me.x, this.me.y, ability.radius, ability.durationSec);
        break;
      }

      case 'decoy':
        this.broadcastField('decoy', this.me.x, this.me.y, 40, ability.durationSec);
        break;

      case 'healfield':
        this.broadcastField('heal', this.me.x, this.me.y, ability.radius, ability.durationSec);
        break;
    }
  }

  private broadcastField(kind: FieldEffect['kind'], x: number, y: number, radius: number, ttl: number): void {
    const field: FieldEffect = {
      id: counterId(`${this.me.id}f`, this.nextLocalId++),
      owner: this.me.id,
      kind,
      x,
      y,
      radius,
      ttl,
    };
    this.cfg.net.publish(Topics.ability(this.cfg.room.roomId), encodeField(field));
    this.applyField(field);
  }

  /* -------------------------------------------------- hit detection: mine */

  /**
   * Attacker authority (requirement 4b). This client decides its own bullets
   * connected and *reports* damage; it never edits enemy health directly, even
   * when it happens to be the host — the report goes through the same queue so
   * there is exactly one code path.
   */
  private updateBullets(dt: number): void {
    for (const b of this.bullets.items) {
      if (!b.active) continue;

      b.life -= dt;
      const fromX = b.x;
      const fromY = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) {
        this.retireBullet(b);
        continue;
      }
      b.sprite.setPosition(b.x, b.y);

      for (const enemy of this.enemies.values()) {
        if (b.hit.has(enemy.id)) continue;
        const reach = b.radius + ENEMY_DEFS[enemy.kind].radius;
        // Sweep the whole step, not just its endpoint — see `segmentDist2`.
        // Written as "not within reach" rather than "beyond reach" so that a
        // non-finite coordinate fails the test instead of passing it.
        const gap = segmentDist2(enemy.sprite.x, enemy.sprite.y, fromX, fromY, b.x, b.y);
        if (!(gap <= reach * reach)) continue;

        b.hit.add(enemy.id);
        this.reportDamage(enemy.id, b.damage);
        this.fx.hitSpark(b.x, b.y, ENEMY_DEFS[enemy.kind].colour);
        this.fx.damageNumber(enemy.sprite.x, enemy.sprite.y - 16, b.damage);

        // Predict the health locally so the hit reads instantly; the host's
        // next snapshot is authoritative and will correct it 50 ms later.
        enemy.hp = Math.max(0, enemy.hp - b.damage);
        this.flashEnemy(enemy);

        if (--b.pierce <= 0) {
          this.retireBullet(b);
          break;
        }
      }
    }
  }

  /**
   * Hit feedback: punch the sprite up in scale and flash it solid red for a
   * few frames. `setTintFill` replaces the sprite's colour entirely rather
   * than multiplying it, which is what makes the flash read instantly even on
   * a dark violet Trojan Tank.
   */
  private flashEnemy(enemy: EnemyView): void {
    enemy.sprite.setTintFill(DAMAGE_RED);
    enemy.sprite.setScale(1.22);
    this.tweens.add({ targets: enemy.sprite, scale: 1, duration: 130, ease: 'Cubic.easeOut' });
    this.time.delayedCall(80, () => {
      // The enemy may have died and been destroyed inside this window.
      if (enemy.sprite.scene) enemy.sprite.clearTint();
    });
  }

  /** Coalesced so a shotgun blast is one message per enemy, not one per pellet. */
  private reportDamage(enemyId: EnemyId, amount: number): void {
    this.pendingDamage.set(enemyId, (this.pendingDamage.get(enemyId) ?? 0) + amount);
  }

  private flushDamage(dt: number): void {
    this.damageAccumulator += dt * 1000;
    if (this.damageAccumulator < NET.damageFlushMs || this.pendingDamage.size === 0) return;
    this.damageAccumulator = 0;

    const room = this.cfg.room.roomId;
    for (const [enemyId, amount] of this.pendingDamage) {
      if (this.horde) {
        // We are the host: apply locally rather than round-tripping the broker.
        this.horde.reportDamage(enemyId, amount, this.me.id);
      } else {
        this.cfg.net.publish(Topics.enemyDamage(room, enemyId), encodeDamage(amount, this.me.id));
      }
    }
    this.pendingDamage.clear();
  }

  /* ------------------------------------------------- hit detection: theirs */

  /**
   * Victim authority (requirement 4a). Malware touching *this* player is
   * resolved here and nowhere else, then the new health goes out with the next
   * player-state publish. No other client can decide this player took a hit,
   * which removes the whole class of "I was already behind cover" disputes.
   */
  private checkEnemyContact(dt: number): void {
    this.contactCooldown -= dt;
    if (this.contactCooldown > 0) return;

    for (const enemy of this.enemies.values()) {
      const def = ENEMY_DEFS[enemy.kind];
      const reach = def.radius + this.def.radius;
      if (!(dist2(this.me.x, this.me.y, enemy.sprite.x, enemy.sprite.y) <= reach * reach)) continue;

      this.takeDamage(def.contactDamage);
      this.contactCooldown = def.contactCooldown;
      return;
    }
  }

  private updateEnemyBullets(dt: number): void {
    const reach = this.def.radius + 8;
    for (const b of this.enemyBullets.items) {
      if (!b.active) continue;

      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) {
        b.active = false;
        b.sprite.setVisible(false);
        continue;
      }
      b.sprite.setPosition(b.x, b.y).setRotation(Math.atan2(b.vy, b.vx));

      // Only ever tested against the local player — again, victim authority.
      if (this.downedFor <= 0 && dist2(b.x, b.y, this.me.x, this.me.y) <= reach * reach) {
        this.takeDamage(b.damage);
        b.active = false;
        b.sprite.setVisible(false);
      }
    }
  }

  private takeDamage(amount: number): void {
    if (this.downedFor > 0) return;

    this.me.hp = Math.max(0, this.me.hp - amount);
    this.fx.damageNumber(this.me.x, this.me.y - 26, amount);
    this.cameras.main.shake(120, 0.006);
    this.cameras.main.flash(90, 255, 60, 120, false);

    // Requirement: rumble when the local player takes damage.
    this.cfg.input.triggerRumble(HAPTIC.damage.weak, HAPTIC.damage.strong, HAPTIC.damage.ms);

    // Publish immediately rather than waiting for the next scheduled tick — a
    // health change is the one piece of player state worth a dedicated message.
    this.publishPlayerNow();

    if (this.me.hp <= 0) {
      this.downedFor = 5;
      this.me.flags = FLAG_DOWN;
      this.fx.enemyBurst(this.me.x, this.me.y, this.def.colour, 1.6);
      this.cfg.onBanner('PROCESS TERMINATED', 'Rebooting in 5s');
    }
  }

  private respawn(): void {
    this.me.hp = Math.round(this.def.maxHp * 0.6);
    this.me.flags = 0;
    this.downedFor = 0;
    this.fx.ring(this.me.x, this.me.y, 160, this.def.colour, 500);
    this.publishPlayerNow();
  }

  /* ----------------------------------------------------------- host duties */

  /**
   * The host loop.
   *
   * The simulation is stepped every frame — that keeps enemy motion smooth on
   * the host's own screen and keeps the AI's dt small. Only the *broadcast* is
   * rate-limited, to `NET.hordeHz`. That distinction is the whole point of
   * requirement 3: a 100-enemy horde at 60 Hz would be 6000 position updates a
   * second, which no public broker will carry; batched at 20 Hz it is 20
   * messages a second, each about 1.4 KB.
   */
  private hostStep(): void {
    const horde = this.horde;
    if (!horde) return;

    // Real elapsed time, clamped. The clamp matters because browsers throttle
    // timers in background tabs: without it, a host that was hidden for ten
    // seconds would resume by advancing the simulation ten seconds in one step
    // and teleport the entire horde into the squad.
    const now = performance.now();
    const dt = Math.min(now - this.lastHostStepAt, 100) / 1000;
    this.lastHostStepAt = now;

    if (this.paused) {
      // Keep broadcasting the frozen horde so a client joining mid-pause still
      // materialises it — the positions simply stop changing.
      this.cfg.net.publish(
        Topics.hordePositions(this.cfg.room.roomId),
        encodeHorde(horde.enemies.values()),
      );
      return;
    }

    const result = horde.step(dt, this.aiTargets());

    // Mirror the authoritative state into the local views. Positions go to the
    // view's *target*, not the sprite — the host interpolates its own horde on
    // exactly the same path a peer does, so there is one movement code path and
    // the host's own enemies stay smooth between 20Hz steps.
    this.snapshotTick++;
    for (const enemy of horde.enemies.values()) {
      const view = this.enemies.get(enemy.id) ?? this.spawnEnemyView(enemy.id, enemy.kind, enemy.x, enemy.y);
      view.tx = enemy.x;
      view.ty = enemy.y;
      view.hp = enemy.hp;
      view.maxHp = enemy.maxHp;
      view.seen = this.snapshotTick;
    }
    this.pruneUnseen();

    for (const event of result.events) {
      if (event.t === 'death') {
        this.killEnemyView(event.id, event.x, event.y, event.kind);
      } else if (event.t === 'shot') {
        this.spawnEnemyBullet(event.x, event.y, event.vx, event.vy, event.damage);
      } else if (event.t === 'wave') {
        this.lastWave = event.n;
        this.cfg.onBanner(`WAVE ${event.n}`, `${event.size} hostile processes spawned`);
      }
    }
    for (const kill of result.kills) {
      if (kill.attacker === this.me.id) this.score += kill.score;
    }

    // ---- the batched broadcast (requirement 3) -------------------------
    const room = this.cfg.room.roomId;
    this.cfg.net.publish(Topics.hordePositions(room), encodeHorde(horde.enemies.values()));

    if (result.events.length) {
      this.cfg.net.publish(Topics.hordeEvents(room), encodeEvents(result.events));
    }
  }

  private startHostLoop(): void {
    if (this.hostTimer !== 0) return;
    this.lastHostStepAt = performance.now();
    this.hostTimer = window.setInterval(() => this.hostStep(), 1000 / NET.hordeHz);
  }

  private stopHostLoop(): void {
    if (this.hostTimer === 0) return;
    window.clearInterval(this.hostTimer);
    this.hostTimer = 0;
  }

  /* ----------------------------------------------------------------- pause */

  /**
   * Host-authoritative pause.
   *
   * Pausing is a property of the *room*, not of a client, because the horde
   * only exists on one machine: a peer that stopped rendering locally would
   * still be walked into by enemies the host kept simulating. So the host owns
   * the flag, broadcasts it, and stops stepping — and every other client
   * freezes because the snapshots stop changing.
   */
  togglePause(): void {
    if (!this.cfg.room.isHost) return;
    this.setPaused(!this.paused);
  }

  private setPaused(paused: boolean): void {
    if (!this.cfg.room.isHost || this.paused === paused) return;
    this.applyPause(paused, this.me.name);
    this.cfg.net.publish(
      Topics.pause(this.cfg.room.roomId),
      encodePause(paused, this.me.id, this.me.name),
    );
  }

  private applyPause(paused: boolean, byName: string): void {
    this.paused = paused;
    this.pausedBy = byName;

    if (paused) {
      // Silence the sticks so a held direction does not queue up movement that
      // fires the instant the game resumes.
      this.cfg.input.update({ x: 0, y: 0 }, this.me);
    } else {
      // Resuming after a long pause must not hand the simulation a huge dt.
      this.lastHostStepAt = performance.now();
    }
  }

  /** Escape on a keyboard, Start/Options on a pad. Host only. */
  private pollPauseInput(): void {
    if (!this.cfg.room.isHost) return;
    if (this.cfg.input.gamepad.readNav().menu) this.togglePause();
  }

  /** Players plus decoys. Decoys carry a priority multiplier the AI divides by. */
  private aiTargets(): AiTarget[] {
    const targets: AiTarget[] = [];

    if (this.downedFor <= 0) {
      targets.push({ id: this.me.id, x: this.me.x, y: this.me.y, priority: 1, alive: true });
    }
    for (const [id, remote] of this.remotes) {
      if ((remote.state.flags & FLAG_DOWN) !== 0) continue;
      targets.push({ id, x: remote.state.x, y: remote.state.y, priority: 1, alive: true });
    }
    for (const field of this.fields.values()) {
      // The Glitcher's decoy outranks a real player by a wide margin, which is
      // what actually pulls the horde off the squad for its 5 seconds.
      if (field.kind === 'decoy') {
        targets.push({ id: field.id, x: field.x, y: field.y, priority: 6, alive: true });
      }
    }

    // Nothing alive to chase: aim at the middle so the horde still converges.
    if (!targets.length) {
      targets.push({ id: 'origin', x: WORLD.width / 2, y: WORLD.height / 2, priority: 1, alive: true });
    }
    return targets;
  }

  private onHostChange(isHost: boolean, reason: string): void {
    if (isHost && !this.horde) {
      this.horde = new HordeEngine();
      // Seamless handover: adopt the enemies already on screen rather than
      // clearing the board. The promoted peer has interpolated positions for
      // every one of them, which is close enough to resume from.
      this.horde.adopt(
        [...this.enemies.values()].map((v) => ({ id: v.id, x: v.sprite.x, y: v.sprite.y, kind: v.kind, hp: v.hp })),
        this.lastWave,
      );
      this.startHostLoop();
      if (reason !== 'initial') {
        this.cfg.onBanner('AUTHORITY ACQUIRED', 'This client now runs the horde');
      }
    } else if (!isHost && this.horde) {
      this.stopHostLoop();
      this.horde = null;
      this.cfg.onBanner('AUTHORITY RELEASED', 'Another client is running the horde');
    }
  }

  /* ----------------------------------------------------------- peer duties */

  /**
   * Enemy interpolation (requirement 6). Targets refresh every 50 ms; frames
   * happen every 16. Without this the horde advances in visible steps.
   *
   * This runs on the host as well as on peers. Since the host's simulation is
   * now a fixed 20Hz timer rather than a per-frame step, its own horde needs
   * exactly the same smoothing that a peer's does — and sharing the path means
   * host and peers cannot drift apart visually.
   */
  private interpolateEnemies(deltaMs: number): void {
    for (const view of this.enemies.values()) {
      glide(view.sprite, view.tx, view.ty, RENDER.enemyLerp, deltaMs, RENDER.snapDistance);
      if (view.kind !== EnemyKind.TrojanTank) {
        const dx = view.tx - view.sprite.x;
        const dy = view.ty - view.sprite.y;
        if (dx * dx + dy * dy > 4) view.sprite.setRotation(Math.atan2(dy, dx));
      }
    }
  }

  /**
   * Health bars, drawn only for enemies that have actually been hurt.
   *
   * A bar over every enemy would be noise — at the cap that is a hundred of
   * them, and the thing a player wants to spot is the one that is nearly dead.
   * Hiding bars at full health makes a visible bar *mean* something: it marks a
   * target worth finishing, and it makes focus fire legible in a four-player
   * squad where someone else has already softened something up.
   */
  private drawHealthBars(): void {
    const g = this.healthBars;
    g.clear();

    for (const view of this.enemies.values()) {
      if (view.maxHp <= 0 || view.hp >= view.maxHp) continue;

      const def = ENEMY_DEFS[view.kind];
      const ratio = clamp(view.hp / view.maxHp, 0, 1);
      const width = Math.max(24, def.radius * 1.9);
      const height = 4;
      const x = view.sprite.x - width / 2;
      const y = view.sprite.y - def.radius - 11;

      // Dark surround first: on a white arena a bar needs an edge, not a glow.
      g.fillStyle(0x0b1017, 0.85).fillRect(x - 1.5, y - 1.5, width + 3, height + 3);
      g.fillStyle(0xffffff, 0.95).fillRect(x, y, width, height);
      g.fillStyle(ratio > 0.6 ? 0x4caf00 : ratio > 0.3 ? 0xff9f00 : DAMAGE_RED, 1);
      g.fillRect(x, y, width * ratio, height);
    }
  }

  /**
   * Unpack a batched horde snapshot.
   *
   * Note the spawn-on-sight rule (requirement 2): an id this client has never
   * seen is created on the spot rather than ignored. That is the entire
   * mid-game join story — a player who connects during wave 7 receives the next
   * snapshot 50 ms later and materialises all 60 enemies at once, with no
   * handshake and no state transfer.
   */
  private onHordeSnapshot(payload: string): void {
    if (this.horde) return; // The host's own broadcast, echoed back to it.

    this.snapshotTick++;
    for (const snap of decodeHorde(payload)) {
      let view = this.enemies.get(snap.id);
      if (!view) view = this.spawnEnemyView(snap.id, snap.kind, snap.x, snap.y);
      view.tx = snap.x;
      view.ty = snap.y;
      view.hp = snap.hp;
      // Max health is not on the wire — enemy health scales with wave and squad
      // size, so a peer infers it from the highest value it has seen. Exact for
      // any enemy the peer watched spawn; briefly optimistic for one that was
      // already damaged when this client joined, which self-corrects upward.
      if (snap.hp > view.maxHp) view.maxHp = snap.hp;
      view.seen = this.snapshotTick;
    }

    // The snapshot is complete state, so anything missing from it is gone —
    // this cleans up kills whose death event never arrived.
    this.pruneUnseen();
  }

  private onHordeEvents(payload: string): void {
    for (const event of decodeEvents(payload)) {
      switch (event.t) {
        case 'death':
          // Peers play the burst; the host already did when it resolved the kill.
          if (!this.horde) this.killEnemyView(event.id, event.x, event.y, event.kind);
          break;
        case 'shot':
          if (!this.horde) this.spawnEnemyBullet(event.x, event.y, event.vx, event.vy, event.damage);
          break;
        case 'wave':
          if (!this.horde) {
            this.lastWave = event.n;
            this.cfg.onBanner(`WAVE ${event.n}`, `${event.size} hostile processes spawned`);
          }
          break;
      }
    }
  }

  /* -------------------------------------------------------------- plumbing */

  private wireNetwork(): void {
    const { net, room } = this.cfg;
    const id = room.roomId;

    this.unsubs.push(
      net.subscribe(Topics.hordePositions(id), (_t, payload) => this.onHordeSnapshot(payload)),
      net.subscribe(Topics.hordeEvents(id), (_t, payload) => this.onHordeEvents(payload)),

      net.subscribe(Topics.playerStateAll(id), (topic, payload) => {
        const playerId = segment(topic, 1);
        if (playerId === this.me.id) return;
        const state = decodePlayer(playerId, payload);
        if (state) this.upsertRemote(state);
      }),

      // Only meaningful on the host; peers subscribe anyway so a promotion
      // mid-flight does not miss the reports already in the air.
      net.subscribe(Topics.enemyDamageAll(id), (topic, payload) => {
        if (!this.horde) return;
        const enemyId = segment(topic, 1);
        const [amountText, attacker] = payload.split(',');
        const amount = Number(amountText);
        if (Number.isFinite(amount)) this.horde.reportDamage(enemyId, amount, attacker ?? '?');
      }),

      net.subscribe(Topics.playerShotsAll(id), (topic, payload) => {
        const shooter = segment(topic, 1);
        // Our own shots are already on screen.
        if (shooter === this.me.id) return;
        for (const shot of decodeShots(payload)) this.spawnRemoteShot(shooter, shot);
      }),

      net.subscribe(Topics.pause(id), (_t, payload) => {
        const msg = decodePause(payload);
        // Only the acting host may pause the room; ignore anyone else.
        if (!msg || msg.byId === this.me.id || msg.byId !== this.cfg.room.hostId) return;
        this.applyPause(msg.paused, msg.byName);
      }),

      net.subscribe(Topics.ability(id), (_t, payload) => {
        const field = decodeField(payload);
        if (field && field.owner !== this.me.id) this.applyField(field);
      }),
    );
  }

  /** Ability fields are shared state: everyone renders them, the host acts on them. */
  private applyField(field: FieldEffect): void {
    if (field.kind === 'shockwave') {
      this.fx.ring(field.x, field.y, field.radius, CLASSES.fireman.colour, 460);
      // Enemy knockback is the host's to apply.
      this.horde?.applyShockwave(field.x, field.y, field.radius, CLASSES.fireman.ability.magnitude, 520);
      return;
    }

    const texture = field.kind === 'decoy' ? TEX.decoy : TEX.ring;
    const colour = field.kind === 'decoy' ? CLASSES.glitcher.colour : CLASSES.encoder.colour;
    const sprite = this.add
      .image(field.x, field.y, texture)
      .setTint(colour)
      .setDepth(6)
      .setAlpha(0.75)
      .setBlendMode(Phaser.BlendModes.NORMAL);

    if (field.kind === 'heal') sprite.setScale((field.radius * 2) / 128);

    this.fields.set(field.id, { ...field, sprite });
  }

  private updateFields(dt: number): void {
    for (const [id, field] of this.fields) {
      field.ttl -= dt;
      if (field.ttl <= 0) {
        field.sprite.destroy();
        this.fields.delete(id);
        continue;
      }

      field.sprite.setAlpha(0.4 + Math.sin(this.time.now / 120) * 0.15);

      // Healing is applied by the client being healed — the same victim
      // authority rule as damage, just in the other direction.
      if (field.kind === 'heal' && this.downedFor <= 0 && this.me.hp < this.me.maxHp) {
        if (dist2(this.me.x, this.me.y, field.x, field.y) < field.radius * field.radius) {
          const before = this.me.hp;
          this.me.hp = Math.min(this.me.maxHp, this.me.hp + CLASSES.encoder.ability.magnitude * dt);
          if (Math.floor(this.me.hp) > Math.floor(before) && Math.floor(this.me.hp) % 5 === 0) {
            this.fx.healNumber(this.me.x, this.me.y - 26, 5);
          }
        }
      }
    }
  }

  private publishPlayer(dt: number): void {
    this.playerAccumulator += dt * 1000;
    const interval = 1000 / NET.playerHz;
    if (this.playerAccumulator < interval) return;
    this.playerAccumulator %= interval;
    this.publishPlayerNow();
  }

  private publishPlayerNow(): void {
    const room = this.cfg.room.roomId;
    this.cfg.net.publish(Topics.playerState(room, this.me.id), encodePlayer(this.me));

    // Shots ride the same cadence but only when there are any, so a player who
    // is not firing costs nothing extra.
    if (this.outboundShots.length) {
      this.cfg.net.publish(Topics.playerShots(room, this.me.id), encodeShots(this.outboundShots));
      this.outboundShots.length = 0;
    }
  }

  /* ----------------------------------------------------- entity bookkeeping */

  private spawnEnemyView(id: EnemyId, kind: EnemyKind, x: number, y: number): EnemyView {
    const def = ENEMY_DEFS[kind] ?? ENEMY_DEFS[EnemyKind.GlitchBug];
    const sprite = this.add.image(x, y, TEX.enemy(def.kind)).setDepth(20);
    const view: EnemyView = { id, kind: def.kind, hp: def.hp, maxHp: def.hp, sprite, tx: x, ty: y, seen: this.snapshotTick };
    this.enemies.set(id, view);
    return view;
  }

  private killEnemyView(id: EnemyId, x: number, y: number, kind: EnemyKind): void {
    const view = this.enemies.get(id);
    const def = ENEMY_DEFS[kind] ?? ENEMY_DEFS[EnemyKind.GlitchBug];
    if (view) {
      view.sprite.destroy();
      this.enemies.delete(id);
    }
    this.fx.enemyBurst(x, y, def.colour, kind === EnemyKind.TrojanTank ? 2 : 1);
    this.progression.dropFrom(x, y, def, id);
  }

  /**
   * Rebuild another player's shot locally.
   *
   * The wire carried one trigger pull; the fan of pellets comes from that
   * player's class, so a Fireman's shotgun looks like a shotgun and an
   * Overclocker's laser looks like a laser without either being transmitted.
   */
  private spawnRemoteShot(shooter: PlayerId, shot: ShotRecord): void {
    const remote = this.remotes.get(shooter);
    if (!remote) return;

    const def = CLASSES[remote.state.cls] ?? CLASSES.overclocker;
    const w = def.weapon;
    const step = w.pellets > 1 ? w.spread / (w.pellets - 1) : 0;
    const start = shot.angle - w.spread / 2;

    for (let n = 0; n < w.pellets; n++) {
      const a = w.pellets > 1 ? start + step * n : shot.angle;
      const bullet = this.remoteBullets.acquire();
      bullet.x = shot.x + Math.cos(shot.angle) * (def.radius * 0.5);
      bullet.y = shot.y + Math.sin(shot.angle) * (def.radius * 0.5);
      bullet.vx = Math.cos(a) * w.speed;
      bullet.vy = Math.sin(a) * w.speed;
      bullet.life = w.lifeSec;
      bullet.damage = 0;
      bullet.active = true;
      bullet.sprite
        .setTexture(TEX.bullet)
        .setPosition(bullet.x, bullet.y)
        .setRotation(a)
        .setTint(def.colour)
        .setVisible(true);
    }

    this.fx.muzzleFlash(
      shot.x + Math.cos(shot.angle) * (def.radius + 10),
      shot.y + Math.sin(shot.angle) * (def.radius + 10),
      shot.angle,
      def.colour,
    );
  }

  private updateRemoteBullets(dt: number): void {
    for (const b of this.remoteBullets.items) {
      if (!b.active) continue;
      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) {
        b.active = false;
        b.sprite.setVisible(false);
        continue;
      }
      b.sprite.setPosition(b.x, b.y);
    }
  }

  /** Anything absent from the newest full snapshot no longer exists. */
  private pruneUnseen(): void {
    for (const [id, view] of this.enemies) {
      if (view.seen !== this.snapshotTick) {
        view.sprite.destroy();
        this.enemies.delete(id);
      }
    }
  }

  private upsertRemote(state: PlayerState): void {
    let remote = this.remotes.get(state.id);
    const def = CLASSES[state.cls] ?? CLASSES.overclocker;

    if (!remote) {
      const sprite = this.add.image(state.x, state.y, TEX.player(def.id)).setDepth(28).setAlpha(0.95);
      const aura = this.add
        .image(state.x, state.y, TEX.glow)
        .setTint(def.colour)
        .setBlendMode(Phaser.BlendModes.NORMAL)
        .setScale(0.7)
        .setDepth(7)
        .setAlpha(0.2);
      const label = this.add
        .text(state.x, state.y - 34, state.name, {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: '12px',
          color: def.cssColour,
        })
        .setOrigin(0.5)
        .setDepth(29);
      remote = { state, sprite, label, aura };
      this.remotes.set(state.id, remote);
    }

    // Keep the render position; only the *target* comes from the network.
    const previous = remote.state;
    remote.state = { ...state };
    remote.state.x = state.x;
    remote.state.y = state.y;
    if (previous.cls !== state.cls) remote.sprite.setTexture(TEX.player(def.id));
  }

  private updateRemotes(deltaMs: number): void {
    const t = smoothing(RENDER.remotePlayerLerp, deltaMs);
    for (const remote of this.remotes.values()) {
      const s = remote.state;
      remote.sprite.x += (s.x - remote.sprite.x) * t;
      remote.sprite.y += (s.y - remote.sprite.y) * t;
      remote.sprite
        .setRotation(lerpAngle(remote.sprite.rotation, s.angle, t))
        .setAlpha((s.flags & FLAG_DOWN) !== 0 ? 0.3 : 0.95);
      remote.aura.setPosition(remote.sprite.x, remote.sprite.y).setAlpha((s.flags & FLAG_ABILITY) !== 0 ? 0.5 : 0.18);
      remote.label.setPosition(remote.sprite.x, remote.sprite.y - 34);
    }
  }

  private removeRemote(id: PlayerId): void {
    const remote = this.remotes.get(id);
    if (!remote) return;
    remote.sprite.destroy();
    remote.label.destroy();
    remote.aura.destroy();
    this.remotes.delete(id);
  }

  /**
   * Auto-aim target selection.
   *
   * Delegates the actual choice to `sim/targeting`, which scores each candidate
   * by how long it would take to kill rather than how close it is — so a nearly
   * dead enemy keeps the lock even once something healthier gets nearer. See
   * that module for the reasoning.
   */
  private nearestEnemy(from: Vec2, range: number): Vec2 | null {
    const w = this.def.weapon;

    // Same definition the class cards quote, scaled by this run's upgrades, so
    // the number shown to the player is the number the game reasons with.
    const dps =
      (classDps(this.def) * this.progression.progress.damageMultiplier) / this.progression.progress.fireIntervalMultiplier;

    const candidates: Array<{ id: string; x: number; y: number; hp: number }> = [];
    for (const view of this.enemies.values()) {
      candidates.push({ id: view.id, x: view.sprite.x, y: view.sprite.y, hp: view.hp });
    }

    const target = pickTarget(candidates, {
      fromX: from.x,
      fromY: from.y,
      facing: this.me.angle,
      turnRate: TURN_RATE_RAD_PER_SEC,
      dps,
      bulletSpeed: w.speed,
      weaponRange: w.speed * w.lifeSec,
      maxRange: range,
      currentTargetId: this.autoTargetId,
    });

    this.autoTargetId = target?.id ?? null;
    return target ? { x: target.x, y: target.y } : null;
  }

  /* --------------------------------------------------------------- pooling */

  private retireBullet(b: Bullet): void {
    b.active = false;
    b.sprite.setVisible(false);
  }

  private spawnEnemyBullet(x: number, y: number, vx: number, vy: number, damage: number): void {
    const bullet = this.enemyBullets.acquire();
    Object.assign(bullet, { x, y, vx, vy, damage, life: 3.2, active: true });
    bullet.sprite.setPosition(x, y).setVisible(true);
  }

  /* ------------------------------------------------------------------- HUD */

  private pushHud(): void {
    const squad: HudSnapshot['squad'] = [
      {
        id: this.me.id,
        name: this.me.name,
        cls: this.me.cls,
        hp: Math.round(this.me.hp),
        maxHp: this.me.maxHp,
        isSelf: true,
        isHost: this.cfg.room.isHost,
      },
    ];
    for (const [id, remote] of this.remotes) {
      squad.push({
        id,
        name: remote.state.name,
        cls: remote.state.cls,
        hp: Math.round(remote.state.hp),
        maxHp: remote.state.maxHp,
        isSelf: false,
        isHost: this.cfg.room.hostId === id,
      });
    }

    const hostId = this.cfg.room.hostId;
    const hostName = this.cfg.room.isHost
      ? this.me.name
      : (this.remotes.get(hostId ?? '')?.state.name ?? '—');

    this.cfg.onHud({
      hp: Math.round(this.me.hp),
      maxHp: this.me.maxHp,
      score: this.score,
      wave: this.horde?.waveNumber ?? this.lastWave,
      enemies: this.enemies.size,
      isHost: this.cfg.room.isHost,
      hostName,
      abilityReady: this.abilityCooldown <= 0,
      abilityRemaining: Math.max(0, this.abilityCooldown),
      abilityName: this.def.ability.name,
      downed: this.downedFor > 0,
      respawnIn: Math.max(0, this.downedFor),
      players: this.cfg.room.squadSize,
      chips: this.progression.progress.chips,
      chipsPerPowerUp: PROGRESSION.chipsPerPowerUp,
      upgrades: UPGRADE_ORDER.map((id) => ({
        short: UPGRADES[id].short,
        cssColour: UPGRADES[id].cssColour,
        stacks: this.progression.progress.stacks[id],
      })),
      paused: this.paused,
      pausedBy: this.pausedBy,
      canPause: this.cfg.room.isHost,
      squad,
    });
  }

  /* ---------------------------------------------------------------- arena */

  private buildArena(): void {
    this.add.tileSprite(0, 0, WORLD.width, WORLD.height, TEX.grid).setOrigin(0).setDepth(0);

    // Arena boundary: a bright neon frame, so the edge of the mainframe reads
    // as a wall rather than as the screen running out.
    const border = this.add.graphics().setDepth(1);
    border.lineStyle(6, 0x00e5ff, 0.85).strokeRect(3, 3, WORLD.width - 6, WORLD.height - 6);
    border.lineStyle(2, 0xff2d95, 0.5).strokeRect(16, 16, WORLD.width - 32, WORLD.height - 32);

    // Decorative circuit runs.
    const trace = this.add.graphics().setDepth(1).lineStyle(2, 0xc9d6e6, 0.9);
    for (let n = 0; n < 26; n++) {
      const x = Math.random() * WORLD.width;
      const y = Math.random() * WORLD.height;
      const len = 90 + Math.random() * 260;
      trace.beginPath();
      if (Math.random() > 0.5) {
        trace.moveTo(x, y).lineTo(x + len, y).lineTo(x + len + 40, y + 40);
      } else {
        trace.moveTo(x, y).lineTo(x, y + len).lineTo(x + 40, y + len + 40);
      }
      trace.strokePath();
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' && e.code !== 'KeyP') return;
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    this.togglePause();
  };

  private teardown(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.stopHostLoop();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.cfg.input.aimAssist = null;
    this.horde = null;
  }
}

/** Kept for the enemy cap assertion in the HUD; see `config.ts`. */
export const MAX_ENEMIES = HORDE.maxEnemies;
