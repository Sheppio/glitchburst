import * as Phaser from 'phaser';
import { HORDE, LIVES, NET, PLAYER, RENDER, TURN_RATE_RAD_PER_SEC, WORLD, ZOOM } from '../config.js';
import { HAPTIC } from '../input/settings.js';
import { decodeEvents, decodeField, decodeHorde, decodePause, decodeShots, decodePlayer, encodeDamage, encodeEvents, encodeField, encodeHorde, encodePause, encodePlayer, encodeShots, encodePlayerStats, decodePlayerStats, } from '../net/codec.js';
import { Topics, segment } from '../net/topics.js';
import { CLASSES, classDps } from '../sim/classes.js';
import { ENEMY_DEFS } from '../sim/enemyTypes.js';
import { clampLevel, killScore } from '../sim/enemyLevels.js';
import { enrageProgress } from '../sim/enrage.js';
import { summaryRows, sumPlayerStats } from '../sim/stats.js';
import { HordeEngine } from '../sim/HordeEngine.js';
import { UPGRADES, UPGRADE_ORDER } from '../sim/progression.js';
import { colourOf, DEFAULT_COLOUR } from '../sim/palette.js';
import { pickTarget } from '../sim/targeting.js';
import { autopilotMove, smoothHeading } from '../sim/autopilot.js';
import { EnemyKind, FLAG_ABILITY, FLAG_DOWN, FLAG_FIRING } from '../types.js';
import { approachAngle, clamp, counterId, dist2, lerpAngle, segmentDist2 } from '../util.js';
import { DAMAGE_RED, Fx } from './fx.js';
import { fadeOut, glide, smoothing } from './lerp.js';
import { Pool } from './pool.js';
import { orderSquad } from './squadOrder.js';
import { edgeMarker } from './edgeMarkers.js';
import { ProgressionSystem } from './Progression.js';
import { TEX } from './textures.js';
/** Quantisation of the enrage tell: sixteen steps across the whole curve. */
const HEAT_STEPS = 16;
/** Sprite scale for a given enrage step. Shared so the hit flash lands on it too. */
const heatScale = (step) => 1 + (step > 0 ? step / HEAT_STEPS : 0) * 0.12;
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
    cfg;
    def;
    /**
     * This client's colour, after the room's clashes have been settled.
     *
     * Colour identifies the *player*, not the class — two people running the same
     * program used to be two identical circles in a swarm of a hundred enemies.
     * The resolved value can change under you when a lower id claims what you
     * asked for, so it is re-read rather than captured once.
     */
    colourId = DEFAULT_COLOUR;
    /**
     * Last heading the autopilot actually drove, and when it drove it. The policy
     * is stateless by design, so the memory lives here.
     *
     * Timed off `performance.now()` rather than Phaser's delta, for the third
     * time in this codebase: Phaser smooths and caps the delta it hands to
     * `update`, so a starved renderer running at 5fps still reports 15ms a frame.
     * Feeding that to an exponential smoother stretches an 80ms ease into a
     * second of real time — the self-driving client visibly crawled away from a
     * standing start. The run clock and the HUD-resize watcher hit the same wall.
     */
    autoHeading = { x: 0, y: 0 };
    autoHeadingAt = 0;
    get tint() {
        return colourOf(this.colourId).colour;
    }
    /** A teammate's settled colour: from presence where possible, their claim otherwise. */
    remoteColour(state) {
        const settled = this.cfg.room.resolvedColours()[state.id];
        return colourOf(settled ?? state.colour).colour;
    }
    player;
    playerAura;
    me = {
        id: '',
        name: '',
        cls: 'overclocker',
        colour: DEFAULT_COLOUR,
        x: 0,
        y: 0,
        angle: 0,
        hp: 100,
        maxHp: 100,
        flags: 0,
        lastSeen: 0,
    };
    fx;
    /**
     * Every enemy health bar, drawn into one Graphics object.
     *
     * A hundred enemies with two sprites each would be two hundred game objects
     * to position every frame; one Graphics redrawn per frame is a single object
     * and, because bars only appear on damaged enemies, usually a handful of
     * rectangles.
     */
    healthBars;
    /**
     * Every bullet's motion streak this frame, in one Graphics.
     *
     * Rounds move 13-25px per frame, so without a trail fast fire reads as a
     * dotted line rather than a stream. One cleared-and-redrawn Graphics costs a
     * single object for the whole volley, where per-bullet trail sprites would
     * cost one each.
     */
    bulletTrails;
    horde = null;
    enemies = new Map();
    remotes = new Map();
    fields = new Map();
    bullets = new Pool(() => ({
        sprite: this.add.image(0, 0, TEX.bullet).setDepth(25),
        x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, damage: 0, pierce: 1, radius: 5, knockback: 0,
        hit: new Set(), active: false,
    }));
    /**
     * Off-screen indicators for teammates and power-ups.
     *
     * Screen-space: `setScrollFactor(0)` pins them to the camera, so the same
     * sprite is drawn at a screen coordinate rather than a world one and nothing
     * has to be converted back every frame.
     */
    vignette = null;
    /** Last applied bounds, so the slow re-measure only touches the camera on a change. */
    boundsSignature = '';
    markers = new Pool(() => ({
        sprite: this.add.image(0, 0, TEX.marker).setDepth(60).setScrollFactor(0).setVisible(false),
        active: false,
    }));
    enemyBullets = new Pool(() => ({
        sprite: this.add.image(0, 0, TEX.enemyBullet).setDepth(24).setTint(ENEMY_DEFS[EnemyKind.FirewallDrone].colour),
        x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, damage: 0, active: false,
    }));
    /**
     * Projectiles fired by *other* players.
     *
     * Purely cosmetic: they never test collision and never deal damage, because
     * under attacker authority only the shooter's own client decides whether its
     * rounds connected. Rendering them is what makes a squad feel like a squad
     * rather than four people fighting invisible battles beside each other.
     */
    remoteBullets = new Pool(() => ({
        sprite: this.add.image(0, 0, TEX.bullet).setDepth(24),
        x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, damage: 0, active: false,
    }));
    /** Shots fired locally since the last publish. */
    outboundShots = [];
    /** Chips, power-ups and upgrades. See `render/Progression.ts`. */
    progression;
    /** Enemy currently held by auto-aim, so the lock can be sticky. */
    autoTargetId = null;
    fireCooldown = 0;
    abilityCooldown = 0;
    abilityActiveUntil = 0;
    contactCooldown = 0;
    /** Seconds since the player last took a hit, for out-of-combat regeneration. */
    sinceDamage = 0;
    downedFor = 0;
    /** Times this player has been reduced to zero health this run. */
    deaths = 0;
    /**
     * Deaths already spent when this client last found itself alone in the room,
     * and whether it was in a squad on the previous frame.
     *
     * A run that drops from squad to solo must not have the solo budget applied
     * retroactively. In a squad there is no death limit at all — you come back
     * for as long as somebody is standing — so a long co-op run racks up deaths
     * freely. Comparing that total against three the instant the roster shrinks
     * ends the run on the spot, which is exactly what a moment of presence
     * silence used to do: four self-driving clients, one stall, and two of them
     * hit System Failure within seconds of each other while the rest played on.
     */
    soloFromDeaths = 0;
    wasInSquad = false;
    gameOver = false;
    tornDown = false;
    score = 0;
    /** Rounds this client has fired. Pellets, not trigger pulls. */
    shotsFired = 0;
    /** Enemies killed in this run, room-wide. Counted by the host, published by it. */
    kills = 0;
    /** Run clock, in seconds. Host-authoritative like the rest of the summary. */
    runSeconds = 0;
    /** `performance.now()` at the previous tick, for the wall-clock run timer. */
    runClockAt = 0;
    /** Group run summary, keyed by player. Includes this client's own entry. */
    playerStats = new Map();
    statsAccumulator = 0;
    snapshotTick = 0;
    lastWave = 0;
    paused = false;
    pausedBy = '';
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
    hostTimer = 0;
    lastHostStepAt = 0;
    /** Accumulator for the fixed-rate player-state publisher. */
    playerAccumulator = 0;
    damageAccumulator = 0;
    /** Damage this client has dealt but not yet reported, keyed by enemy. */
    pendingDamage = new Map();
    unsubs = [];
    nextLocalId = 1;
    constructor() {
        super('game');
    }
    init(cfg) {
        this.cfg = cfg;
        this.def = CLASSES[cfg.classId];
    }
    create() {
        const { room, input, playerName, classId } = this.cfg;
        this.colourId = room.colourId;
        this.me = {
            id: room.playerId,
            name: playerName,
            cls: classId,
            colour: room.claimedColour,
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
            sfx: this.cfg.sfx,
            baseMaxHp: this.def.maxHp,
            collector: () => ({
                x: this.me.x,
                y: this.me.y,
                radius: this.def.radius,
                canCollect: this.downedFor <= 0,
            }),
            banner: (text, sub) => this.cfg.onBanner(text, sub),
            rumble: (weak, strong, ms) => this.cfg.input.triggerRumble(weak, strong, ms),
        });
        this.playerAura = this.add
            .image(this.me.x, this.me.y, TEX.glow)
            .setTint(this.tint)
            // Normal, not additive: additive light over a white arena is a no-op.
            .setBlendMode(Phaser.BlendModes.NORMAL)
            .setScale(0.85)
            .setDepth(8);
        this.player = this.add
            .image(this.me.x, this.me.y, TEX.player(classId, this.colourId))
            .setDepth(30);
        // Above the enemies, below the bullets.
        this.healthBars = this.add.graphics().setDepth(22);
        this.bulletTrails = this.add.graphics().setDepth(23);
        this.buildVignette();
        this.cameras.main
            .startFollow(this.player, true, 0.12, 0.12)
            .setBackgroundColor('#f2f5f9');
        this.applyZoom();
        // The strips reflow with the window, shrink on a phone, and grow when the
        // reboot counter appears — and at scene creation the HUD has not been shown
        // yet, so the first measurement is of a hidden element. Re-measured on a
        // slow timer, which is cheap because it only touches the camera when the
        // numbers actually change.
        this.scale.on(Phaser.Scale.Events.RESIZE, this.applyZoom);
        this.unsubs.push(this.cfg.settings.events.on('change', this.applyZoom));
        // The UI raises this whenever a strip actually changes size, including once
        // on first layout — which matters, because at scene creation the HUD has
        // not been shown yet and measuring it then measures a hidden element.
        //
        // An observer rather than a timer: Phaser's clock advances on the same
        // capped delta as `update`, so on a slow renderer a 400ms repeat fired
        // roughly every two seconds, and the camera spent that long bounded wrong.
        document.addEventListener('gb:hud-resize', this.applyZoom);
        this.unsubs.push(() => document.removeEventListener('gb:hud-resize', this.applyZoom));
        // Auto-aim asks the scene for a target; the scene is the only thing that
        // knows where the enemies are.
        input.aimAssist = (from, range) => this.nearestEnemy(from, range);
        // Autopilot asks the scene for a direction, for the same reason.
        input.moveAssist = () => this.autopilot();
        this.wireNetwork();
        room.hostStatsProvider = () => ({
            enemyCount: this.horde?.enemyCount ?? this.enemies.size,
            wave: this.horde?.waveNumber ?? this.lastWave,
            paused: this.paused,
            score: this.score,
            running: true,
            kills: this.kills,
            seconds: Math.round(this.runSeconds),
        });
        this.unsubs.push(room.events.on('hostChange', ({ isHost, reason }) => this.onHostChange(isHost, reason)), room.events.on('hostStats', ({ wave, paused, score, kills, seconds }) => {
            this.lastWave = wave;
            // Room-wide summary numbers come from the host for the same reason the
            // score does: counted locally from QoS-0 events they drift apart, and
            // a group summary that differs per screen is not a group summary.
            if (!this.horde) {
                this.kills = kills;
                this.runSeconds = seconds;
            }
            // A client that joined mid-pause, or missed the pause message, syncs here.
            if (!this.cfg.room.isHost && paused !== this.paused)
                this.applyPause(paused, this.pausedBy);
            // Peers count kills locally for instant feedback and take the host's
            // total as the truth. Null means a host on an older build that does not
            // report one — better to keep the local tally than zero the board.
            if (!this.horde && score !== null)
                this.score = score;
        }), room.events.on('peerLeave', ({ id }) => this.removeRemote(id)));
        if (room.isHost)
            this.onHostChange(true, 'initial');
        window.addEventListener('keydown', this.onKeyDown);
        // Both events, because they are not interchangeable: stopping a scene emits
        // SHUTDOWN, but destroying the *game* emits only DESTROY. Listening for
        // SHUTDOWN alone left the host's 20Hz interval running after the game was
        // gone — stepping a dead scene, and still publishing the old horde into the
        // room, which the next run then inherited as its opening wave.
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardown());
        this.events.once(Phaser.Scenes.Events.DESTROY, () => this.teardown());
    }
    update(_time, delta) {
        // Read pause input first: it is the one control that must keep working
        // while everything else is frozen.
        this.pollPauseInput();
        // A finished run is frozen, not merely veiled. Left running, the horde
        // carried on swarming an empty arena behind the summary the squad is
        // trying to read — and on the host it kept simulating and broadcasting a
        // match nobody was playing.
        if (this.paused || this.gameOver) {
            // Drop the clock reference so a pause is not billed to the run when play
            // resumes.
            this.runClockAt = 0;
            // Markers are drawn screen-space and would otherwise sit frozen on top of
            // the pause card and the failure summary.
            this.updateMarkers();
            this.pushHud();
            return;
        }
        const dt = Math.min(delta, 50) / 1000;
        // The run clock reads `performance.now()` rather than Phaser's delta.
        //
        // Phaser smooths and caps the delta it hands to `update`, which is the
        // right thing for a simulation and the wrong thing for a stopwatch: at the
        // ~4fps this suite's software renderer manages it reported around 55ms a
        // frame however long the frame really took, and a ten-second run timed
        // itself at two. Clamped only against a backgrounded tab.
        if (this.horde) {
            const now = performance.now();
            if (this.runClockAt > 0)
                this.runSeconds += Math.min(now - this.runClockAt, 1000) / 1000;
            this.runClockAt = now;
        }
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
        this.updateMarkers();
        this.flushDamage(dt);
        this.publishPlayer(dt);
        this.publishStats(dt);
        this.pushHud();
    }
    /* ------------------------------------------------------------ local play */
    updateLocalPlayer(dt) {
        const { input } = this.cfg;
        this.trackSquadSize();
        this.syncMaxHealth();
        this.syncColour();
        const cam = this.cameras.main;
        const screen = {
            x: (this.me.x - cam.worldView.x) * cam.zoom,
            y: (this.me.y - cam.worldView.y) * cam.zoom,
        };
        const intent = input.update(screen, this.me);
        const boosted = this.time.now < this.abilityActiveUntil && this.def.ability.kind === 'overclock';
        if (this.gameOver) {
            this.me.flags = FLAG_DOWN;
            this.player.setAlpha(0.18);
            return;
        }
        if (this.downedFor > 0) {
            this.downedFor -= dt;
            this.me.flags = FLAG_DOWN;
            this.player.setAlpha(0.35);
            // A wipe is a property of the room, not of the instant you happened to
            // die. Checking it only at the moment of death meant whoever died second
            // ended their run while the first player — merely *rebooting*, not out —
            // carried on for another fifteen seconds before noticing. Re-checked
            // every frame while down, every client reaches the same answer within one
            // player broadcast.
            if (this.squadWiped()) {
                this.declareGameOver();
                return;
            }
            if (this.downedFor <= 0)
                this.respawn();
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
        this.regenerate(dt);
        // Fire along the chassis, not the request: the turn rate has to cost
        // something or it is just an animation.
        if (intent.firing && this.fireCooldown <= 0)
            this.fireWeapon(this.me.angle, boosted);
        if (intent.abilityPressed && this.abilityCooldown <= 0)
            this.activateAbility();
        this.me.flags =
            (intent.firing ? FLAG_FIRING : 0) | (this.time.now < this.abilityActiveUntil ? FLAG_ABILITY : 0);
        this.checkEnemyContact(dt);
    }
    /**
     * Re-skin when this client's settled colour changes.
     *
     * It can change without the player touching anything: somebody with a lower
     * id joins and claims what you asked for, and seniority hands it to them. The
     * chassis colour is baked into the texture rather than tinted — see
     * `drawPlayer` — so this is a texture swap, not a tint.
     */
    syncColour() {
        const settled = this.cfg.room.colourId;
        if (settled === this.colourId)
            return;
        this.colourId = settled;
        this.player.setTexture(TEX.player(this.def.id, settled));
        this.playerAura.setTint(this.tint);
    }
    /**
     * Carry Heap Expansion stacks into the live player.
     *
     * Polled rather than pushed from the moment the upgrade is granted: reboots
     * and the heal field both write `maxHp`, and one missed path is a player
     * capped at their old maximum for the rest of the run. A comparison per frame
     * is cheaper than the bug.
     *
     * The extra capacity arrives *filled*. A power-up that hands you headroom you
     * then have to earn back is felt as nothing at the moment you take it, which
     * for the one upgrade that exists to save your life is the wrong moment to be
     * subtle. It also makes the pickup a small emergency heal, which is when it
     * tends to be walked over.
     */
    syncMaxHealth() {
        const max = this.progression.progress.maxHealth;
        if (max === this.me.maxHp)
            return;
        this.me.hp = Math.min(max, this.me.hp + Math.max(0, max - this.me.maxHp));
        this.me.maxHp = max;
    }
    /**
     * Out-of-combat healing.
     *
     * The delay is the design: healing through a fight turns every engagement
     * into a damage race, whereas healing only once disengaged rewards backing
     * off — the decision actually worth encouraging when you are outnumbered.
     */
    regenerate(dt) {
        this.sinceDamage += dt;
        if (this.me.hp >= this.me.maxHp)
            return;
        if (this.sinceDamage < PLAYER.regenDelaySec)
            return;
        const rate = PLAYER.regenPerSec + this.progression.progress.bonusRegenPerSec;
        const before = this.me.hp;
        this.me.hp = Math.min(this.me.maxHp, this.me.hp + rate * dt);
        // A tick every few points, not every frame: a number per frame is noise.
        if (Math.floor(this.me.hp / 10) > Math.floor(before / 10)) {
            this.fx.healNumber(this.me.x, this.me.y - 30, 10);
        }
    }
    fireWeapon(angle, boosted) {
        const w = this.def.weapon;
        this.fireCooldown =
            (w.fireIntervalSec * this.progression.progress.fireIntervalMultiplier) /
                (boosted ? this.def.ability.magnitude : 1);
        const damage = w.damage * this.progression.progress.damageMultiplier;
        const step = w.pellets > 1 ? w.spread / (w.pellets - 1) : 0;
        const start = angle - w.spread / 2;
        this.shotsFired += w.pellets;
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
            bullet.maxLife = w.lifeSec;
            bullet.damage = damage;
            bullet.pierce = w.pierce;
            bullet.radius = w.radius;
            bullet.knockback = w.knockback;
            bullet.hit.clear();
            bullet.active = true;
            bullet.sprite
                .setPosition(bullet.x, bullet.y)
                .setRotation(a)
                .setTint(this.tint)
                .setAlpha(1)
                .setVisible(true);
        }
        // One record per trigger pull; the pellet fan is rebuilt from the class
        // definition on the receiving side. Capped so a pathological burst cannot
        // inflate a single message.
        if (this.outboundShots.length < 16) {
            this.outboundShots.push({ x: this.me.x, y: this.me.y, angle });
        }
        this.cfg.sfx.shoot(this.def.id);
        this.fx.muzzleFlash(this.me.x + Math.cos(angle) * (this.def.radius + 10), this.me.y + Math.sin(angle) * (this.def.radius + 10), angle, this.tint);
        this.cameras.main.shake(60, 0.0016);
        this.cfg.input.triggerRumble(HAPTIC.shot.weak, HAPTIC.shot.strong, HAPTIC.shot.ms);
    }
    /**
     * Class abilities. Everything that other clients must see goes on the wire as
     * a field effect; purely local buffs (the Overclocker's) ride along in the
     * player state flags instead, which costs nothing extra.
     */
    activateAbility() {
        const ability = this.def.ability;
        this.abilityCooldown = ability.cooldownSec;
        this.abilityActiveUntil = this.time.now + ability.durationSec * 1000;
        // Requirement: rumble when the local player activates their class ability.
        this.cfg.input.triggerRumble(HAPTIC.ability.weak, HAPTIC.ability.strong, HAPTIC.ability.ms);
        this.cfg.sfx.ability();
        switch (ability.kind) {
            case 'overclock':
                this.fx.ring(this.me.x, this.me.y, 120, this.tint, 320);
                this.cfg.onBanner('THERMAL RUNAWAY');
                break;
            case 'shockwave': {
                // Visual is immediate and local; the knockback is applied by whoever
                // owns the horde, because enemy state is never edited off-host.
                this.fx.ring(this.me.x, this.me.y, ability.radius, this.tint, 460);
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
    broadcastField(kind, x, y, radius, ttl) {
        const field = {
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
    updateBullets(dt) {
        const trails = this.bulletTrails;
        trails.clear();
        for (const b of this.bullets.items) {
            if (!b.active)
                continue;
            b.life -= dt;
            const fromX = b.x;
            const fromY = b.y;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) {
                this.retireBullet(b);
                continue;
            }
            // Fade out over the last stretch of the round's life. A bullet that
            // simply vanishes at maximum range reads as a glitch; one that thins out
            // reads as the round losing energy, and incidentally shows the player
            // where their weapon actually stops.
            const fade = fadeOut(b.life, b.maxLife);
            b.sprite.setPosition(b.x, b.y).setAlpha(fade);
            trails.lineStyle(3, b.sprite.tintTopLeft, 0.4 * fade);
            trails.lineBetween(fromX, fromY, b.x, b.y);
            for (const enemy of this.enemies.values()) {
                if (b.hit.has(enemy.id))
                    continue;
                const reach = b.radius + ENEMY_DEFS[enemy.kind].radius;
                // Sweep the whole step, not just its endpoint — see `segmentDist2`.
                // Written as "not within reach" rather than "beyond reach" so that a
                // non-finite coordinate fails the test instead of passing it.
                const gap = segmentDist2(enemy.sprite.x, enemy.sprite.y, fromX, fromY, b.x, b.y);
                if (!(gap <= reach * reach))
                    continue;
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
    flashEnemy(enemy) {
        this.cfg.sfx.hit();
        enemy.sprite.setTintFill(DAMAGE_RED);
        enemy.sprite.setScale(1.22);
        // Back to the enrage size, not to 1: an enraged enemy that shrank every
        // time it was shot would flicker between two sizes under sustained fire.
        this.tweens.add({
            targets: enemy.sprite,
            scale: heatScale(enemy.heat),
            duration: 130,
            ease: 'Cubic.easeOut',
        });
        this.time.delayedCall(80, () => {
            // The enemy may have died and been destroyed inside this window.
            if (!enemy.sprite.scene)
                return;
            enemy.sprite.clearTint();
            // `clearTint` resets to white, which wipes the enrage wash along with the
            // flash. Invalidating the cached step puts it back on the next frame.
            enemy.heat = -1;
        });
    }
    /** Coalesced so a shotgun blast is one message per enemy, not one per pellet. */
    reportDamage(enemyId, amount) {
        this.pendingDamage.set(enemyId, (this.pendingDamage.get(enemyId) ?? 0) + amount);
    }
    flushDamage(dt) {
        this.damageAccumulator += dt * 1000;
        if (this.damageAccumulator < NET.damageFlushMs || this.pendingDamage.size === 0)
            return;
        this.damageAccumulator = 0;
        const room = this.cfg.room.roomId;
        for (const [enemyId, amount] of this.pendingDamage) {
            if (this.horde) {
                // We are the host: apply locally rather than round-tripping the broker.
                this.horde.reportDamage(enemyId, amount, this.me.id);
            }
            else {
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
    checkEnemyContact(dt) {
        this.contactCooldown -= dt;
        if (this.contactCooldown > 0)
            return;
        for (const enemy of this.enemies.values()) {
            const def = ENEMY_DEFS[enemy.kind];
            const reach = def.radius + this.def.radius;
            if (!(dist2(this.me.x, this.me.y, enemy.sprite.x, enemy.sprite.y) <= reach * reach))
                continue;
            this.takeDamage(def.contactDamage);
            this.contactCooldown = def.contactCooldown;
            return;
        }
    }
    updateEnemyBullets(dt) {
        const reach = this.def.radius + 8;
        for (const b of this.enemyBullets.items) {
            if (!b.active)
                continue;
            b.life -= dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) {
                b.active = false;
                b.sprite.setVisible(false);
                continue;
            }
            b.sprite.setPosition(b.x, b.y).setRotation(Math.atan2(b.vy, b.vx)).setAlpha(fadeOut(b.life, b.maxLife));
            // Only ever tested against the local player — again, victim authority.
            if (this.downedFor <= 0 && dist2(b.x, b.y, this.me.x, this.me.y) <= reach * reach) {
                this.takeDamage(b.damage);
                b.active = false;
                b.sprite.setVisible(false);
            }
        }
    }
    takeDamage(amount) {
        if (this.downedFor > 0)
            return;
        this.me.hp = Math.max(0, this.me.hp - amount);
        this.sinceDamage = 0;
        this.cfg.sfx.hurt();
        this.fx.damageNumber(this.me.x, this.me.y - 26, amount);
        this.cameras.main.shake(120, 0.006);
        this.cameras.main.flash(90, 255, 60, 120, false);
        // Requirement: rumble when the local player takes damage.
        this.cfg.input.triggerRumble(HAPTIC.damage.weak, HAPTIC.damage.strong, HAPTIC.damage.ms);
        // Publish immediately rather than waiting for the next scheduled tick — a
        // health change is the one piece of player state worth a dedicated message.
        this.publishPlayerNow();
        if (this.me.hp <= 0)
            this.onKilled();
    }
    /**
     * Zero health. Whether that is a setback or the end of the run depends on the
     * mode — see `LIVES`.
     */
    onKilled() {
        this.deaths += 1;
        this.me.flags = FLAG_DOWN;
        this.fx.enemyBurst(this.me.x, this.me.y, this.tint, 1.6);
        this.cfg.sfx.died();
        if (!this.canReboot()) {
            this.declareGameOver();
            return;
        }
        this.downedFor = this.rebootDelay();
        const left = this.rebootsLeft();
        this.cfg.onBanner('PROCESS TERMINATED', left === null
            ? `Rebooting in ${this.downedFor}s`
            : `Rebooting in ${this.downedFor}s · ${left} reboot${left === 1 ? '' : 's'} left`);
    }
    /**
     * Solo runs spend a fixed pool of reboots. A squad instead reboots for as
     * long as somebody is still on their feet, so a wipe is what ends the run —
     * which means the last player standing is carrying the whole team, and knows
     * it.
     */
    canReboot() {
        if (this.cfg.room.squadSize > 1)
            return !this.squadWiped();
        return this.soloDeaths() <= LIVES.soloReboots;
    }
    /**
     * Deaths that count against the solo pool.
     *
     * Rebased at the moment this client became alone, so the three reboots are
     * three reboots *from then* rather than a bill for a co-op run that has
     * already been paid in full by teammates staying upright.
     */
    soloDeaths() {
        return this.deaths - this.soloFromDeaths;
    }
    /** Notice the room emptying, so the solo pool starts from now. */
    trackSquadSize() {
        const inSquad = this.cfg.room.squadSize > 1;
        if (inSquad === this.wasInSquad)
            return;
        this.wasInSquad = inSquad;
        if (!inSquad)
            this.soloFromDeaths = this.deaths;
    }
    squadmatesAlive() {
        let alive = 0;
        for (const remote of this.remotes.values()) {
            if ((remote.state.flags & FLAG_DOWN) === 0)
                alive++;
        }
        return alive;
    }
    /**
     * Every squadmate is down.
     *
     * Deliberately has no opinion about *this* client — callers ask only while
     * they are themselves down, and mixing the two made the old version read as
     * if it answered a question it did not.
     *
     * With no squadmate state at all the answer is "no". That happens when the
     * roster lists a player who has not published yet, and ending somebody's run
     * on missing information is a far worse failure than letting it continue.
     */
    squadWiped() {
        if (this.cfg.room.squadSize <= 1)
            return false;
        if (this.remotes.size === 0)
            return false;
        return this.squadmatesAlive() === 0;
    }
    /**
     * End the run on this client.
     *
     * Shared by the two routes into it — dying with nothing left, and noticing a
     * wipe while already down — so both produce the same state and the same
     * banner.
     */
    declareGameOver() {
        if (this.gameOver)
            return;
        this.gameOver = true;
        this.downedFor = Infinity;
        this.me.flags = FLAG_DOWN;
        // Stop the simulation itself, not just the rendering of it: the host tick
        // is a timer of its own and would otherwise keep stepping and broadcasting.
        this.stopHostLoop();
        this.cfg.room.running = false;
        // Get this client's final numbers out before the summary is read.
        this.publishStatsNow();
        this.cfg.onBanner('SYSTEM FAILURE', this.cfg.room.squadSize > 1 ? 'The squad was wiped out' : 'No reboots remaining');
        // Tell the room immediately rather than waiting for the next 15Hz tick, so
        // the other clients converge on the wipe in one hop instead of two.
        this.publishPlayerNow();
    }
    /** Null in a squad, where reboots are not counted. */
    rebootsLeft() {
        if (this.cfg.room.squadSize > 1)
            return null;
        return Math.max(0, LIVES.soloReboots - this.soloDeaths());
    }
    rebootDelay() {
        // Solo is flat: the pool of three reboots is already the escalating cost,
        // and a rising timer on top charges twice for the same mistake.
        if (this.cfg.room.squadSize <= 1)
            return LIVES.soloRebootSec;
        return Math.min(LIVES.rebootMaxSec, LIVES.rebootBaseSec + (this.deaths - 1) * LIVES.rebootStepSec);
    }
    /**
     * Squared distance from a point to the nearest enemy on screen.
     *
     * Read off the sprites rather than the simulation, so it is the same answer
     * on the host and on a peer — a peer has no `HordeEngine`, but it has every
     * enemy's interpolated position, which is what the player can actually see.
     */
    nearestEnemyDist2(x, y) {
        let nearest = Infinity;
        for (const view of this.enemies.values()) {
            const d2 = dist2(x, y, view.sprite.x, view.sprite.y);
            if (d2 < nearest)
                nearest = d2;
        }
        return nearest;
    }
    /**
     * Somewhere safe to come back.
     *
     * Rebooting inside the swarm that just killed you spends the reboot on
     * nothing, which is the same reasoning that made reboots restore full health
     * — and at the enemy cap the odds of your corpse being surrounded are high.
     *
     * Searched as rings expanding from where you fell, so you return to the same
     * part of the arena: near your squad, near whatever you were defending, and
     * not teleported across the map for no reason. The first clear point wins, so
     * the common case is a short hop rather than the furthest corner.
     */
    safeRespawnPoint() {
        const safe2 = LIVES.rebootSafeRadius * LIVES.rebootSafeRadius;
        let best = { x: this.me.x, y: this.me.y };
        let bestClearance = this.nearestEnemyDist2(best.x, best.y);
        if (bestClearance >= safe2)
            return best;
        const samples = 12;
        for (const radius of [280, 440, 640, 880, 1150]) {
            for (let n = 0; n < samples; n++) {
                // Offset each ring so successive rings do not sample the same bearings
                // and miss a gap between them.
                const angle = (Math.PI * 2 * n) / samples + radius;
                const x = clamp(this.me.x + Math.cos(angle) * radius, 60, WORLD.width - 60);
                const y = clamp(this.me.y + Math.sin(angle) * radius, 60, WORLD.height - 60);
                const clearance = this.nearestEnemyDist2(x, y);
                if (clearance >= safe2)
                    return { x, y };
                if (clearance > bestClearance) {
                    bestClearance = clearance;
                    best = { x, y };
                }
            }
        }
        // Nothing in range is genuinely clear — a hundred enemies cover a lot of
        // arena. Come back at the roomiest spot found rather than where you fell.
        return best;
    }
    /**
     * One frame of self-driving, for the `autoMove` setting.
     *
     * The scene's job here is only to describe what it can see; the policy lives
     * in `sim/autopilot.ts`, where it is pure and testable without a browser.
     *
     * Enemy positions come off the sprites rather than the simulation so a peer,
     * which has no `HordeEngine`, drives on exactly what it can see — the same
     * choice made for reboot relocation.
     */
    autopilot() {
        const enemies = [];
        for (const view of this.enemies.values()) {
            enemies.push({ x: view.sprite.x, y: view.sprite.y });
        }
        // Chips and upgrades both carry their remaining life, so the bot can turn
        // down a trip it cannot finish. Progression is not optional for a bot meant
        // to get somewhere: a run with no upgrades stalls at the same wave whoever
        // is driving it, and a power-up left on the floor to expire is the single
        // most expensive mistake available.
        const chips = [];
        for (const chip of this.progression.chips.items) {
            if (chip.active)
                chips.push({ x: chip.x, y: chip.y, ttl: chip.ttl });
        }
        const powerUps = [];
        for (const powerUp of this.progression.powerUps.items) {
            if (powerUp.active)
                powerUps.push({ x: powerUp.x, y: powerUp.y, ttl: powerUp.ttl });
        }
        const w = this.def.weapon;
        const move = autopilotMove({
            x: this.me.x,
            y: this.me.y,
            enemies,
            chips,
            powerUps,
            weaponRange: w.speed * w.lifeSec,
            moveSpeed: this.def.speed * this.progression.progress.speedMultiplier,
            world: { width: WORLD.width, height: WORLD.height },
        });
        // Eased into, not snapped to. The policy re-decides from scratch every
        // frame and two of its choices are discrete, so the raw heading flickers —
        // which on screen is a player vibrating rather than running.
        const now = performance.now();
        // A quarter second caps the first frame and any gap after a backgrounded
        // tab: at that length the ease is 96% complete in one step, which is the
        // right answer — there is nothing to smooth across a pause.
        const elapsed = this.autoHeadingAt === 0 ? 1 / 60 : (now - this.autoHeadingAt) / 1000;
        this.autoHeadingAt = now;
        this.autoHeading = smoothHeading(this.autoHeading, move, Math.min(0.25, elapsed));
        // Spend the ability the moment it is up and something is in reach. A bot
        // that hoards its cooldown never exercises the ability wire path, which is
        // half of what a test client is for.
        const ability = this.abilityCooldown <= 0 &&
            enemies.some((e) => dist2(e.x, e.y, this.me.x, this.me.y) < 420 * 420);
        return { x: this.autoHeading.x, y: this.autoHeading.y, ability };
    }
    respawn() {
        // Full health. A partial reboot straight back into the wave that killed you
        // tends to mean dying again immediately, which spends a life on nothing.
        this.me.maxHp = this.progression.progress.maxHealth;
        this.me.hp = this.me.maxHp;
        this.me.flags = 0;
        this.downedFor = 0;
        this.sinceDamage = PLAYER.regenDelaySec;
        const spot = this.safeRespawnPoint();
        const relocated = dist2(spot.x, spot.y, this.me.x, this.me.y) > 1;
        this.me.x = spot.x;
        this.me.y = spot.y;
        if (relocated) {
            // Snap both the sprite and the camera. The camera follows with a lerp,
            // which would otherwise pan across the arena showing the player a long
            // slow slide instead of a reboot.
            this.player.setPosition(spot.x, spot.y);
            this.cameras.main.centerOn(spot.x, spot.y);
            this.cfg.onBanner('REBOOTED', 'Relocated clear of hostiles');
        }
        this.fx.ring(this.me.x, this.me.y, 160, this.tint, 500);
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
    hostStep() {
        const horde = this.horde;
        if (!horde || this.tornDown)
            return;
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
            this.cfg.net.publish(Topics.hordePositions(this.cfg.room.roomId), encodeHorde(horde.enemies.values()));
            return;
        }
        const result = horde.step(dt, this.aiTargets());
        // Mirror the authoritative state into the local views. Positions go to the
        // view's *target*, not the sprite — the host interpolates its own horde on
        // exactly the same path a peer does, so there is one movement code path and
        // the host's own enemies stay smooth between 20Hz steps.
        this.snapshotTick++;
        for (const enemy of horde.enemies.values()) {
            const view = this.enemies.get(enemy.id) ??
                this.spawnEnemyView(enemy.id, enemy.kind, enemy.level, enemy.x, enemy.y);
            view.tx = enemy.x;
            view.ty = enemy.y;
            view.hp = enemy.hp;
            view.maxHp = enemy.maxHp;
            view.seen = this.snapshotTick;
        }
        this.pruneUnseen();
        for (const event of result.events) {
            if (event.t === 'death') {
                this.killEnemyView(event.id, event.x, event.y, event.kind, event.level);
            }
            else if (event.t === 'shot') {
                this.spawnEnemyBullet(event.x, event.y, event.vx, event.vy, event.damage);
            }
            else if (event.t === 'wave') {
                this.lastWave = event.n;
                this.cfg.sfx.wave();
                this.cfg.onBanner(`WAVE ${event.n}`, `${event.size} hostile processes incoming`);
            }
        }
        // ---- the batched broadcast (requirement 3) -------------------------
        const room = this.cfg.room.roomId;
        this.cfg.net.publish(Topics.hordePositions(room), encodeHorde(horde.enemies.values()));
        if (result.events.length) {
            this.cfg.net.publish(Topics.hordeEvents(room), encodeEvents(result.events));
        }
    }
    startHostLoop() {
        if (this.hostTimer !== 0)
            return;
        this.lastHostStepAt = performance.now();
        this.hostTimer = window.setInterval(() => this.hostStep(), 1000 / NET.hordeHz);
    }
    stopHostLoop() {
        if (this.hostTimer === 0)
            return;
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
    togglePause() {
        if (!this.cfg.room.isHost)
            return;
        this.setPaused(!this.paused);
    }
    setPaused(paused) {
        if (!this.cfg.room.isHost || this.paused === paused)
            return;
        this.applyPause(paused, this.me.name);
        this.cfg.net.publish(Topics.pause(this.cfg.room.roomId), encodePause(paused, this.me.id, this.me.name));
    }
    applyPause(paused, byName) {
        this.paused = paused;
        this.pausedBy = byName;
        if (paused) {
            // Silence the sticks so a held direction does not queue up movement that
            // fires the instant the game resumes.
            this.cfg.input.update({ x: 0, y: 0 }, this.me);
        }
        else {
            // Resuming after a long pause must not hand the simulation a huge dt.
            this.lastHostStepAt = performance.now();
        }
    }
    /** Escape on a keyboard, Start/Options on a pad. Host only. */
    pollPauseInput() {
        if (!this.cfg.room.isHost)
            return;
        if (this.cfg.input.gamepad.readPause())
            this.togglePause();
    }
    /** Players plus decoys. Decoys carry a priority multiplier the AI divides by. */
    aiTargets() {
        const targets = [];
        if (this.downedFor <= 0) {
            targets.push({ id: this.me.id, x: this.me.x, y: this.me.y, priority: 1, alive: true });
        }
        for (const [id, remote] of this.remotes) {
            if ((remote.state.flags & FLAG_DOWN) !== 0)
                continue;
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
    onHostChange(isHost, reason) {
        if (isHost && !this.horde) {
            this.horde = new HordeEngine();
            // Seamless handover: adopt the enemies already on screen rather than
            // clearing the board. The promoted peer has interpolated positions for
            // every one of them, which is close enough to resume from.
            this.horde.adopt([...this.enemies.values()].map((v) => ({ id: v.id, x: v.sprite.x, y: v.sprite.y, kind: v.kind, hp: v.hp })), this.lastWave);
            this.startHostLoop();
            if (reason !== 'initial') {
                this.cfg.onBanner('AUTHORITY ACQUIRED', 'This client now runs the horde');
            }
        }
        else if (!isHost && this.horde) {
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
    interpolateEnemies(deltaMs) {
        const now = performance.now();
        for (const view of this.enemies.values()) {
            glide(view.sprite, view.tx, view.ty, RENDER.enemyLerp, deltaMs, RENDER.snapDistance);
            if (view.kind !== EnemyKind.TrojanTank) {
                const dx = view.tx - view.sprite.x;
                const dy = view.ty - view.sprite.y;
                if (dx * dx + dy * dy > 4)
                    view.sprite.setRotation(Math.atan2(dy, dx));
            }
            this.showHeat(view, (now - view.bornAt) / 1000);
        }
    }
    /**
     * The enrage tell: something that has been chasing you for half a minute
     * should look like it.
     *
     * A tint and a size bump rather than an extra sprite. Adding an aura per
     * enemy would double the display list at the hundred-enemy cap, which is the
     * same trade already refused for the level pips — and for the same reason.
     *
     * The tint washes warm rather than going red: a full red multiply would flood
     * the level pip at the centre of every enemy, and that pip is the only thing
     * telling a player which of two identical drones is the dangerous one.
     *
     * Quantised to sixteen steps so a hundred sprites are not each having two
     * properties written on every frame of the run.
     */
    showHeat(view, age) {
        const step = Math.round(enrageProgress(age) * HEAT_STEPS);
        if (step === view.heat)
            return;
        view.heat = step;
        const heat = step / HEAT_STEPS;
        // White leaves the texture alone; lerping the green and blue channels down
        // from there warms it without touching the reds it already has.
        view.sprite.setTint((255 << 16) | (Math.round(255 - heat * 96) << 8) | Math.round(255 - heat * 120));
        view.sprite.setScale(heatScale(step));
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
    drawHealthBars() {
        const g = this.healthBars;
        g.clear();
        for (const view of this.enemies.values()) {
            if (view.maxHp <= 0 || view.hp >= view.maxHp)
                continue;
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
    onHordeSnapshot(payload) {
        if (this.horde)
            return; // The host's own broadcast, echoed back to it.
        this.snapshotTick++;
        for (const snap of decodeHorde(payload)) {
            let view = this.enemies.get(snap.id);
            if (!view)
                view = this.spawnEnemyView(snap.id, snap.kind, snap.level, snap.x, snap.y);
            view.tx = snap.x;
            view.ty = snap.y;
            view.hp = snap.hp;
            // Max health is not on the wire — enemy health scales with wave and squad
            // size, so a peer infers it from the highest value it has seen. Exact for
            // any enemy the peer watched spawn; briefly optimistic for one that was
            // already damaged when this client joined, which self-corrects upward.
            if (snap.hp > view.maxHp)
                view.maxHp = snap.hp;
            view.seen = this.snapshotTick;
        }
        // The snapshot is complete state, so anything missing from it is gone —
        // this cleans up kills whose death event never arrived.
        this.pruneUnseen();
    }
    onHordeEvents(payload) {
        for (const event of decodeEvents(payload)) {
            switch (event.t) {
                case 'death':
                    // Peers play the burst; the host already did when it resolved the kill.
                    if (!this.horde) {
                        this.killEnemyView(event.id, event.x, event.y, event.kind, event.level);
                    }
                    break;
                case 'shot':
                    if (!this.horde)
                        this.spawnEnemyBullet(event.x, event.y, event.vx, event.vy, event.damage);
                    break;
                case 'wave':
                    if (!this.horde) {
                        this.lastWave = event.n;
                        this.cfg.sfx.wave();
                        this.cfg.onBanner(`WAVE ${event.n}`, `${event.size} hostile processes incoming`);
                    }
                    break;
            }
        }
    }
    /* -------------------------------------------------------------- plumbing */
    wireNetwork() {
        const { net, room } = this.cfg;
        const id = room.roomId;
        this.unsubs.push(net.subscribe(Topics.hordePositions(id), (_t, payload) => this.onHordeSnapshot(payload)), net.subscribe(Topics.hordeEvents(id), (_t, payload) => this.onHordeEvents(payload)), net.subscribe(Topics.playerStateAll(id), (topic, payload) => {
            const playerId = segment(topic, 1);
            if (playerId === this.me.id)
                return;
            const state = decodePlayer(playerId, payload);
            if (state)
                this.upsertRemote(state);
        }), 
        // Only meaningful on the host; peers subscribe anyway so a promotion
        // mid-flight does not miss the reports already in the air.
        net.subscribe(Topics.enemyDamageAll(id), (topic, payload) => {
            if (!this.horde)
                return;
            const enemyId = segment(topic, 1);
            const [amountText, attacker] = payload.split(',');
            const amount = Number(amountText);
            if (Number.isFinite(amount))
                this.horde.reportDamage(enemyId, amount, attacker ?? '?');
        }), net.subscribe(Topics.playerStatsAll(id), (topic, payload) => {
            const playerId = segment(topic, 1);
            if (playerId === this.me.id)
                return; // ours is authoritative locally
            const stats = decodePlayerStats(payload);
            if (stats)
                this.playerStats.set(playerId, stats);
        }), net.subscribe(Topics.playerShotsAll(id), (topic, payload) => {
            const shooter = segment(topic, 1);
            // Our own shots are already on screen.
            if (shooter === this.me.id)
                return;
            for (const shot of decodeShots(payload))
                this.spawnRemoteShot(shooter, shot);
        }), net.subscribe(Topics.pause(id), (_t, payload) => {
            const msg = decodePause(payload);
            // Only the acting host may pause the room; ignore anyone else.
            if (!msg || msg.byId === this.me.id || msg.byId !== this.cfg.room.hostId)
                return;
            this.applyPause(msg.paused, msg.byName);
        }), net.subscribe(Topics.ability(id), (_t, payload) => {
            const field = decodeField(payload);
            if (field && field.owner !== this.me.id)
                this.applyField(field);
        }));
    }
    /** Ability fields are shared state: everyone renders them, the host acts on them. */
    applyField(field) {
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
        if (field.kind === 'heal')
            sprite.setScale((field.radius * 2) / 128);
        this.fields.set(field.id, { ...field, sprite });
    }
    updateFields(dt) {
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
    publishPlayer(dt) {
        this.playerAccumulator += dt * 1000;
        const interval = 1000 / NET.playerHz;
        if (this.playerAccumulator < interval)
            return;
        this.playerAccumulator %= interval;
        this.publishPlayerNow();
    }
    /**
     * This client's contribution to the group summary.
     *
     * Once a second is plenty — it is a summary, not gameplay — and because it is
     * a full snapshot rather than a delta, a dropped message costs nothing but a
     * second of staleness. Also published the moment a run ends, so the card the
     * squad reads is not up to a second out of date.
     */
    publishStats(dt) {
        this.statsAccumulator += dt;
        if (this.statsAccumulator < 1)
            return;
        this.statsAccumulator = 0;
        this.publishStatsNow();
    }
    publishStatsNow() {
        const mine = this.myStats();
        this.playerStats.set(this.me.id, mine);
        this.cfg.net.publish(Topics.playerStats(this.cfg.room.roomId, this.me.id), encodePlayerStats(mine));
    }
    myStats() {
        return {
            shots: this.shotsFired,
            chips: this.progression.progress.totalChips,
            powerUps: this.progression.progress.powerUpsTaken,
            reboots: this.deaths,
        };
    }
    /** The finished run, as lines the failure screen can print. */
    summaryRows() {
        const group = this.groupStats();
        return summaryRows(group.room, group.players);
    }
    /** The group totals, as shown on the failure screen. */
    groupStats() {
        this.playerStats.set(this.me.id, this.myStats());
        return {
            room: {
                kills: this.kills,
                wave: this.horde?.waveNumber ?? this.lastWave,
                seconds: Math.round(this.runSeconds),
                score: this.score,
            },
            players: sumPlayerStats(this.playerStats.values()),
        };
    }
    publishPlayerNow() {
        const room = this.cfg.room.roomId;
        this.cfg.net.publish(Topics.playerState(room, this.me.id), encodePlayer(this.me));
        // Shots ride the same cadence but only when there are any, so a player who
        // is not firing costs nothing extra.
        if (this.outboundShots.length) {
            this.cfg.net.publish(Topics.playerShots(room, this.me.id), encodeShots(this.outboundShots));
            this.outboundShots.length = 0;
        }
    }
    /**
     * Let the camera scroll past the arena walls by the height of the HUD.
     *
     * Bounded to the arena exactly, the camera stops dead at a wall — so a player
     * pinned against the bottom edge ends up drawn *underneath* the bottom strip,
     * along with whatever is eating them. Extending the bounds by the strips'
     * own heights means the arena edge comes to rest just clear of them; what
     * scrolls into view beyond the wall is empty ground, and the HUD is sitting
     * on exactly that.
     */
    applyCameraBounds = () => {
        const cam = this.cameras.main;
        const zoom = cam.zoom || 1;
        // The insets are screen pixels but the bounds are world units, so at half
        // zoom a strip covers twice as much arena.
        const { top, bottom } = this.cfg.hudInsets();
        const worldTop = top / zoom;
        const worldBottom = bottom / zoom;
        const signature = `${Math.round(worldTop)}:${Math.round(worldBottom)}`;
        if (signature === this.boundsSignature)
            return;
        this.boundsSignature = signature;
        cam.setBounds(0, -worldTop, WORLD.width, WORLD.height + worldTop + worldBottom);
    };
    /**
     * Apply the player's chosen zoom.
     *
     * Anything pinned to the camera has to be un-scaled by hand: Phaser's zoom
     * multiplies everything the camera draws, `scrollFactor(0)` included, so the
     * vignette and the edge markers would shrink and grow with the arena instead
     * of staying put as screen furniture.
     */
    applyZoom = () => {
        const cam = this.cameras.main;
        const zoom = clamp(this.cfg.settings.current.zoom, ZOOM.min, ZOOM.max);
        if (cam.zoom !== zoom)
            cam.setZoom(zoom);
        for (const marker of this.markers.items)
            marker.sprite.setScale(1 / zoom);
        this.vignette?.setDisplaySize(cam.width / zoom, cam.height / zoom);
        // The bounds are expressed in world units, so a zoom change resizes them.
        this.boundsSignature = '';
        this.applyCameraBounds();
    };
    /**
     * Draw an arrow at the screen edge for everything worth knowing about that is
     * currently off screen.
     *
     * Teammates take their class colour, so a glance tells you *who* is over
     * there. Power-ups get a muted grey: they are worth knowing about, not worth
     * pulling your eye off whatever is shooting at you.
     */
    updateMarkers() {
        for (const marker of this.markers.items) {
            marker.active = false;
            marker.sprite.setVisible(false);
        }
        // Cleared, then left cleared: a frozen or veiled game has nothing to point
        // at, and arrows over a summary card are just clutter.
        if (this.gameOver || this.paused)
            return;
        const view = this.cameras.main.worldView;
        const place = (at, colour, alpha) => {
            const found = edgeMarker(at, view, RENDER.markerMargin);
            if (!found)
                return;
            const marker = this.markers.acquire();
            marker.active = true;
            // Un-scaled by the zoom, so a marker is the same size on screen whatever
            // the player has the camera set to.
            marker.sprite.setScale(1 / (this.cameras.main.zoom || 1));
            marker.sprite
                .setPosition(found.x, found.y)
                .setRotation(found.angle)
                .setTint(colour)
                .setAlpha(alpha)
                .setVisible(true);
        };
        for (const remote of this.remotes.values()) {
            // A downed teammate is the one you most want to find, so they are not
            // hidden — just dimmed, the way their sprite is.
            const downed = (remote.state.flags & FLAG_DOWN) !== 0;
            place(remote.state, this.remoteColour(remote.state), downed ? 0.45 : 0.95);
        }
        for (const powerUp of this.progression.powerUps.items) {
            if (powerUp.active)
                place(powerUp, RENDER.markerPowerUpColour, RENDER.markerPowerUpAlpha);
        }
    }
    /* ----------------------------------------------------- entity bookkeeping */
    spawnEnemyView(id, kind, level, x, y) {
        const def = ENEMY_DEFS[kind] ?? ENEMY_DEFS[EnemyKind.GlitchBug];
        const lvl = clampLevel(level);
        const sprite = this.add.image(x, y, TEX.enemy(def.kind, lvl)).setDepth(20);
        // Materialise, rather than appear. Skipped for the first couple of seconds
        // so a client joining mid-wave does not play sixty of these at once — that
        // burst is a state sync, not sixty things arriving.
        if (this.time.now > 2000) {
            sprite.setScale(0.2).setAlpha(0.3);
            this.tweens.add({ targets: sprite, scale: 1, alpha: 1, duration: 260, ease: 'Back.easeOut' });
            this.fx.spawnFlash(x, y, def.colour, def.radius);
        }
        const view = {
            bornAt: performance.now(),
            heat: 0,
            id, kind: def.kind, level: lvl, hp: def.hp, maxHp: def.hp,
            sprite, tx: x, ty: y, seen: this.snapshotTick,
        };
        this.enemies.set(id, view);
        return view;
    }
    /**
     * A confirmed kill, from the host's death event.
     *
     * Scoring happens here rather than from the host's own `StepResult`, because
     * only one machine sees that: a peer's kills were resolved on the host and
     * credited to nobody locally, so a peer's score never moved off zero.
     *
     * The score is the *squad's*, not yours — this is a co-op game with one
     * SCORE readout, and two clients showing different numbers for it reads as a
     * bug whichever number is "right". So every client counts every kill, from
     * the death event that already reaches all of them. The host's running total
     * rides the heartbeat twice a second and peers adopt it, which repairs the
     * drift a dropped QoS-0 death event would otherwise leave permanently.
     */
    killEnemyView(id, x, y, kind, level) {
        const view = this.enemies.get(id);
        const def = ENEMY_DEFS[kind] ?? ENEMY_DEFS[EnemyKind.GlitchBug];
        if (view) {
            view.sprite.destroy();
            this.enemies.delete(id);
        }
        this.score += killScore(def.score, clampLevel(level));
        this.kills += 1;
        this.fx.enemyBurst(x, y, def.colour, kind === EnemyKind.TrojanTank ? 2 : 1);
        this.cfg.sfx.kill(kind === EnemyKind.TrojanTank);
        this.progression.dropFrom(x, y, def, id, clampLevel(level));
    }
    /**
     * Rebuild another player's shot locally.
     *
     * The wire carried one trigger pull; the fan of pellets comes from that
     * player's class, so a Fireman's shotgun looks like a shotgun and an
     * Overclocker's laser looks like a laser without either being transmitted.
     */
    spawnRemoteShot(shooter, shot) {
        const remote = this.remotes.get(shooter);
        if (!remote)
            return;
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
            bullet.maxLife = w.lifeSec;
            bullet.damage = 0;
            bullet.active = true;
            bullet.sprite
                .setTexture(TEX.bullet)
                .setPosition(bullet.x, bullet.y)
                .setRotation(a)
                .setTint(def.colour)
                .setAlpha(1)
                .setVisible(true);
        }
        this.fx.muzzleFlash(shot.x + Math.cos(shot.angle) * (def.radius + 10), shot.y + Math.sin(shot.angle) * (def.radius + 10), shot.angle, def.colour);
    }
    updateRemoteBullets(dt) {
        const trails = this.bulletTrails;
        for (const b of this.remoteBullets.items) {
            if (!b.active)
                continue;
            b.life -= dt;
            const fromX = b.x;
            const fromY = b.y;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD.width || b.y > WORLD.height) {
                b.active = false;
                b.sprite.setVisible(false);
                continue;
            }
            const fade = fadeOut(b.life, b.maxLife);
            b.sprite.setPosition(b.x, b.y).setAlpha(fade);
            trails.lineStyle(3, b.sprite.tintTopLeft, 0.3 * fade);
            trails.lineBetween(fromX, fromY, b.x, b.y);
        }
    }
    /** Anything absent from the newest full snapshot no longer exists. */
    pruneUnseen() {
        for (const [id, view] of this.enemies) {
            if (view.seen !== this.snapshotTick) {
                view.sprite.destroy();
                this.enemies.delete(id);
            }
        }
    }
    upsertRemote(state) {
        let remote = this.remotes.get(state.id);
        const def = CLASSES[state.cls] ?? CLASSES.overclocker;
        const settled = this.cfg.room.resolvedColours()[state.id] ?? state.colour;
        const swatch = colourOf(settled);
        if (!remote) {
            const sprite = this.add
                .image(state.x, state.y, TEX.player(def.id, swatch.id))
                .setDepth(28)
                .setAlpha(0.95);
            const aura = this.add
                .image(state.x, state.y, TEX.glow)
                .setTint(swatch.colour)
                .setBlendMode(Phaser.BlendModes.NORMAL)
                .setScale(0.7)
                .setDepth(7)
                .setAlpha(0.2);
            const label = this.add
                .text(state.x, state.y - 34, state.name, {
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: '12px',
                color: swatch.cssColour,
            })
                .setOrigin(0.5)
                .setDepth(29);
            remote = { state, sprite, label, aura, swatch: '' };
            this.remotes.set(state.id, remote);
        }
        // Keep the render position; only the *target* comes from the network.
        const previous = remote.state;
        remote.state = { ...state };
        remote.state.x = state.x;
        remote.state.y = state.y;
        // Re-skinned on a change of either, because both can happen mid-run: the
        // staging area edits a program, and a colour can be taken out from under a
        // player by somebody with a lower id.
        if (previous.cls !== state.cls || remote.swatch !== swatch.id) {
            remote.swatch = swatch.id;
            remote.sprite.setTexture(TEX.player(def.id, swatch.id));
            remote.aura.setTint(swatch.colour);
            remote.label.setColor(swatch.cssColour);
        }
    }
    updateRemotes(deltaMs) {
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
    removeRemote(id) {
        const remote = this.remotes.get(id);
        if (!remote)
            return;
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
    nearestEnemy(from, range) {
        const w = this.def.weapon;
        // Same definition the class cards quote, scaled by this run's upgrades, so
        // the number shown to the player is the number the game reasons with.
        const dps = (classDps(this.def) * this.progression.progress.damageMultiplier) / this.progression.progress.fireIntervalMultiplier;
        const candidates = [];
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
    retireBullet(b) {
        b.active = false;
        b.sprite.setVisible(false);
    }
    spawnEnemyBullet(x, y, vx, vy, damage) {
        const bullet = this.enemyBullets.acquire();
        Object.assign(bullet, { x, y, vx, vy, damage, life: 3.2, maxLife: 3.2, active: true });
        bullet.sprite.setPosition(x, y).setAlpha(1).setVisible(true);
    }
    /* ------------------------------------------------------------------- HUD */
    pushHud() {
        const squad = [
            {
                id: this.me.id,
                name: this.me.name,
                cls: this.me.cls,
                colour: this.colourId,
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
                colour: remote.swatch,
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
            respawnIn: Number.isFinite(this.downedFor) ? Math.max(0, this.downedFor) : 0,
            rebootsLeft: this.rebootsLeft(),
            gameOver: this.gameOver,
            // Only assembled once the run is over: it aggregates across the roster
            // every call, and nothing reads it until the failure screen is up.
            summary: this.gameOver ? this.summaryRows() : [],
            players: this.cfg.room.squadSize,
            chips: this.progression.progress.chips,
            chipsPerPowerUp: Math.round(this.progression.progress.chipsNeeded),
            upgrades: UPGRADE_ORDER.map((id) => ({
                short: UPGRADES[id].short,
                cssColour: UPGRADES[id].cssColour,
                stacks: this.progression.progress.stacks[id],
            })),
            paused: this.paused,
            pausedBy: this.pausedBy,
            canPause: this.cfg.room.isHost,
            squad: orderSquad(squad),
        });
    }
    /* ---------------------------------------------------------------- arena */
    /**
     * Corner darkening, pinned to the camera.
     *
     * The Cyber-Pop look is deliberately bright, which also makes it flat — a
     * uniformly lit rectangle has no centre. This is subtle enough not to dim the
     * action but enough to frame it.
     */
    buildVignette() {
        const cam = this.cameras.main;
        this.vignette = this.add
            .image(cam.width / 2, cam.height / 2, TEX.vignette)
            .setScrollFactor(0)
            .setDepth(150)
            .setDisplaySize(cam.width, cam.height);
        this.scale.on('resize', () => this.applyZoom());
    }
    buildArena() {
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
            }
            else {
                trace.moveTo(x, y).lineTo(x, y + len).lineTo(x + 40, y + len + 40);
            }
            trace.strokePath();
        }
    }
    onKeyDown = (e) => {
        if (e.key !== 'Escape' && e.code !== 'KeyP')
            return;
        if (e.target instanceof HTMLInputElement)
            return;
        e.preventDefault();
        this.togglePause();
    };
    teardown() {
        // Idempotent: SHUTDOWN and DESTROY can both fire for one scene.
        if (this.tornDown)
            return;
        this.tornDown = true;
        window.removeEventListener('keydown', this.onKeyDown);
        this.stopHostLoop();
        for (const unsub of this.unsubs)
            unsub();
        this.unsubs = [];
        this.cfg.input.aimAssist = null;
        this.cfg.input.moveAssist = null;
        this.horde = null;
    }
}
/** Kept for the enemy cap assertion in the HUD; see `config.ts`. */
export const MAX_ENEMIES = HORDE.maxEnemies;
//# sourceMappingURL=GameScene.js.map