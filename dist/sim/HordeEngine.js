import { AI, DIFFICULTY, HORDE, WORLD } from '../config.js';
import { EnemyKind } from '../types.js';
import { clamp, counterId, dist2 } from '../util.js';
import { ENEMY_DEFS } from './enemyTypes.js';
/**
 * The authoritative horde simulation. Runs on exactly one client at a time.
 *
 * This file imports nothing from Phaser on purpose: the host's source of truth
 * is a plain object graph stepped by `step(dt, targets)`, which means it can be
 * driven from a test harness in Node, and — more importantly — that a peer
 * promoted mid-game can start running it without any renderer state to inherit.
 *
 * AI is deliberately dumb (requirement 6): steer straight at the nearest
 * target. No navmesh, no A*, no line-of-sight. At the 100-enemy cap that is a
 * few hundred float ops per tick. The only concession to looking good is a
 * uniform-grid separation pass so the horde spreads out instead of collapsing
 * into a single stacked sprite.
 */
export class HordeEngine {
    enemies = new Map();
    nextId = 1;
    nextProjectileId = 1;
    waveTimer = HORDE.firstWaveDelaySec;
    /** Enemies spawned by the current wave, for the early-clear check. */
    lastWaveSize = 0;
    /** Seconds since the current wave landed. */
    sinceWave = 0;
    wave = 0;
    pending = new Map();
    grid = new Map();
    /**
     * Live squad size, 1-4. Set every step from the host's target list, so it
     * tracks players joining and leaving without any explicit bookkeeping.
     */
    players = 1;
    /**
     * Enemy health multiplier: waves make everything tougher over time, squad
     * size makes it tougher in the moment, and a solo player gets a discount so
     * one program can still hold a lane. See `DIFFICULTY` for the reasoning.
     */
    get hpScale() {
        const byWave = 1 + this.wave * DIFFICULTY.healthPerWave;
        const bySquad = 1 + (this.players - 1) * DIFFICULTY.healthPerPlayer;
        const solo = this.players <= 1 ? DIFFICULTY.soloHealthDiscount : 1;
        return byWave * bySquad * solo;
    }
    /** How many enemies a wave spawns, scaled by squad size. */
    get waveSize() {
        const byWave = HORDE.baseWaveSize + this.wave * HORDE.waveGrowth;
        const bySquad = 1 + (this.players - 1) * DIFFICULTY.sizePerPlayer;
        return Math.round(byWave * bySquad);
    }
    /** Squad size the difficulty is currently tuned to. Surfaced in the HUD. */
    get squadSize() {
        return this.players;
    }
    get enemyCount() {
        return this.enemies.size;
    }
    get waveNumber() {
        return this.wave;
    }
    reset() {
        this.enemies.clear();
        this.pending.clear();
        this.wave = 0;
        this.waveTimer = HORDE.firstWaveDelaySec;
        this.lastWaveSize = 0;
        this.sinceWave = 0;
        this.nextId = 1;
    }
    /**
     * Adopt an existing horde. Used when a peer is promoted mid-game: it already
     * has interpolated snapshots of every enemy, so the new host resumes from
     * those positions instead of wiping the board.
     */
    adopt(snapshots, wave) {
        this.enemies.clear();
        let highest = 0;
        for (const s of snapshots) {
            const def = ENEMY_DEFS[s.kind] ?? ENEMY_DEFS[EnemyKind.GlitchBug];
            this.enemies.set(s.id, {
                id: s.id,
                kind: s.kind,
                x: s.x,
                y: s.y,
                vx: 0,
                vy: 0,
                hp: s.hp > 0 ? s.hp : def.hp,
                maxHp: Math.max(s.hp, def.hp),
                speed: def.speed,
                cooldown: Math.random() * 2,
                stun: 0,
                targetId: null,
            });
            // Keep minting ids above anything already in flight so nothing collides.
            const n = parseInt(s.id.replace(/^e/, ''), 36);
            if (Number.isFinite(n) && n > highest)
                highest = n;
        }
        this.nextId = highest + 1;
        this.wave = wave;
        // Adopting a live horde means a wave is already in progress, so give the
        // new host a half interval of breathing room. Adopting *nothing* means this
        // is a fresh room, and it should open on the normal first-wave grace period
        // rather than idling for seven seconds.
        this.waveTimer = this.enemies.size > 0
            ? this.intervalFor(this.enemies.size) * 0.5
            : HORDE.firstWaveDelaySec;
        this.lastWaveSize = this.enemies.size;
        this.sinceWave = 0;
    }
    /**
     * Attacker-authority damage (requirement 4). Any client may report a hit; the
     * host is the only one that applies it. Reports are accumulated per enemy and
     * resolved on the next step, so two players hitting the same bug in the same
     * frame cannot double-resolve a death.
     */
    reportDamage(enemyId, amount, attacker) {
        if (!this.enemies.has(enemyId) || !(amount > 0))
            return;
        const existing = this.pending.get(enemyId);
        if (existing)
            existing.amount += amount;
        else
            this.pending.set(enemyId, { amount, attacker });
    }
    /** Fireman ability: push everything nearby away and stun it. */
    applyShockwave(x, y, radius, stunSec, impulse) {
        const r2 = radius * radius;
        for (const e of this.enemies.values()) {
            const d2 = dist2(e.x, e.y, x, y);
            if (d2 > r2)
                continue;
            const d = Math.sqrt(d2) || 1;
            const falloff = 1 - d / radius;
            e.vx += ((e.x - x) / d) * impulse * falloff;
            e.vy += ((e.y - y) / d) * impulse * falloff;
            e.stun = Math.max(e.stun, stunSec * falloff + 0.2);
        }
    }
    step(dt, targets) {
        const result = { events: [], kills: [] };
        // Decoys are targets but not players, so they must not inflate difficulty —
        // baiting the horde would otherwise make the horde bigger.
        const playerTargets = targets.filter((t) => t.alive && t.priority <= 1 && t.id !== 'origin').length;
        this.players = clamp(playerTargets, 1, HORDE.maxPlayers);
        this.resolveDamage(result);
        this.advanceWaves(dt, targets, result);
        const live = targets.filter((t) => t.alive);
        this.rebuildGrid();
        for (const e of this.enemies.values()) {
            const def = ENEMY_DEFS[e.kind];
            const target = this.pickTarget(e, live);
            e.targetId = target?.id ?? null;
            if (e.stun > 0) {
                // Stunned: keep the knockback impulse but apply no steering of its own.
                e.stun -= dt;
                e.vx *= 0.86;
                e.vy *= 0.86;
            }
            else if (target) {
                const dx = target.x - e.x;
                const dy = target.y - e.y;
                const d = Math.hypot(dx, dy) || 1;
                if (def.ranged) {
                    // Drones hover: close in when far, back off when crowded, strafe otherwise.
                    const gap = d - def.ranged.preferredRange;
                    const approach = Math.abs(gap) < 40 ? 0 : Math.sign(gap);
                    const strafe = e.id.charCodeAt(e.id.length - 1) % 2 === 0 ? 1 : -1;
                    e.vx = ((dx / d) * approach + (-dy / d) * strafe * 0.55) * e.speed;
                    e.vy = ((dy / d) * approach + (dx / d) * strafe * 0.55) * e.speed;
                    e.cooldown -= dt;
                    if (e.cooldown <= 0 && d < def.ranged.preferredRange * 1.6) {
                        e.cooldown = def.ranged.fireIntervalSec;
                        result.events.push({
                            t: 'shot',
                            id: counterId('p', this.nextProjectileId++),
                            x: e.x,
                            y: e.y,
                            vx: (dx / d) * def.ranged.projectileSpeed,
                            vy: (dy / d) * def.ranged.projectileSpeed,
                            damage: def.ranged.projectileDamage,
                        });
                    }
                }
                else {
                    e.vx = (dx / d) * e.speed;
                    e.vy = (dy / d) * e.speed;
                }
            }
            else {
                e.vx *= 0.9;
                e.vy *= 0.9;
            }
            this.separate(e, def.radius);
            e.x = clamp(e.x + e.vx * dt, 20, WORLD.width - 20);
            e.y = clamp(e.y + e.vy * dt, 20, WORLD.height - 20);
        }
        return result;
    }
    /* ------------------------------------------------------------- internals */
    resolveDamage(result) {
        if (this.pending.size === 0)
            return;
        for (const [id, dmg] of this.pending) {
            const e = this.enemies.get(id);
            if (!e)
                continue;
            e.hp -= dmg.amount;
            if (e.hp <= 0) {
                this.enemies.delete(id);
                const def = ENEMY_DEFS[e.kind];
                result.events.push({ t: 'death', id: e.id, x: e.x, y: e.y, kind: e.kind });
                result.kills.push({ id: e.id, kind: e.kind, x: e.x, y: e.y, score: def.score, attacker: dmg.attacker });
            }
        }
        this.pending.clear();
    }
    /** Seconds a wave of `size` enemies is given before the next one lands. */
    intervalFor(size) {
        return Math.max(HORDE.waveMinIntervalSec, HORDE.waveBaseIntervalSec + size * HORDE.wavePerEnemySec);
    }
    advanceWaves(dt, targets, result) {
        this.waveTimer -= dt;
        this.sinceWave += dt;
        // Clearing the field pulls the next wave forward, subject to a floor — so
        // skill is rewarded with tempo rather than with waiting around.
        const cleared = this.lastWaveSize > 0 &&
            this.enemies.size <= Math.max(2, Math.round(this.lastWaveSize * HORDE.waveClearFraction)) &&
            this.sinceWave >= HORDE.waveMinIntervalSec;
        if (this.waveTimer > 0 && !cleared)
            return;
        this.wave += 1;
        this.sinceWave = 0;
        const want = this.waveSize;
        const room = HORDE.maxEnemies - this.enemies.size;
        const size = Math.max(0, Math.min(want, room));
        for (let n = 0; n < size; n++)
            this.spawn(this.rollKind(), targets);
        // The timer is set from the wave actually spawned, not the one requested:
        // near the enemy cap a wave can be trimmed, and it should not then be
        // granted time for enemies that were never created.
        this.lastWaveSize = size;
        this.waveTimer = this.intervalFor(size);
        result.events.push({ t: 'wave', n: this.wave, size });
    }
    /** Later waves shift the mix away from bugs and toward drones and tanks. */
    rollKind() {
        const bug = Math.max(20, ENEMY_DEFS[EnemyKind.GlitchBug].weight - this.wave * 3);
        const drone = ENEMY_DEFS[EnemyKind.FirewallDrone].weight + this.wave * 2;
        const tank = ENEMY_DEFS[EnemyKind.TrojanTank].weight + this.wave * 1.2;
        const roll = Math.random() * (bug + drone + tank);
        if (roll < bug)
            return EnemyKind.GlitchBug;
        if (roll < bug + drone)
            return EnemyKind.FirewallDrone;
        return EnemyKind.TrojanTank;
    }
    spawn(kind, targets) {
        if (this.enemies.size >= HORDE.maxEnemies)
            return null;
        const def = ENEMY_DEFS[kind];
        const anchor = targets.length
            ? targets[Math.floor(Math.random() * targets.length)]
            : { x: WORLD.width / 2, y: WORLD.height / 2 };
        // Ring spawn around a random player, pushed out past the safe radius and
        // clamped into the arena. A handful of tries is plenty; the fallback is
        // simply a slightly closer spawn, which is survivable.
        let x = 0;
        let y = 0;
        for (let attempt = 0; attempt < 8; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const radius = HORDE.minSpawnDistance + Math.random() * 260;
            x = clamp(anchor.x + Math.cos(angle) * radius, 40, WORLD.width - 40);
            y = clamp(anchor.y + Math.sin(angle) * radius, 40, WORLD.height - 40);
            const tooClose = targets.some((t) => t.alive && dist2(x, y, t.x, t.y) < HORDE.minSpawnDistance * HORDE.minSpawnDistance);
            if (!tooClose)
                break;
        }
        const hp = Math.round(def.hp * this.hpScale);
        const enemy = {
            id: counterId('e', this.nextId++),
            kind,
            x,
            y,
            vx: 0,
            vy: 0,
            hp,
            maxHp: hp,
            speed: def.speed * (0.9 + Math.random() * 0.2),
            cooldown: Math.random() * 1.5,
            stun: 0,
            targetId: null,
        };
        this.enemies.set(enemy.id, enemy);
        return enemy;
    }
    /**
     * Nearest target wins, after each target's priority is converted into a flat
     * discount on its distance. A Glitcher decoy carries enough discount to beat
     * a player the enemy is already touching, which is the whole point of the
     * ability — and the steering code above needs no knowledge that decoys exist.
     *
     * This is the one place the AI pays for a square root. At the 100-enemy cap
     * against a four-player squad plus decoys that is a few hundred `sqrt` calls
     * a tick, which is far cheaper than the alternative of special-casing decoys
     * through the whole targeting path.
     */
    pickTarget(e, targets) {
        let best = null;
        let bestScore = Infinity;
        for (const t of targets) {
            const attraction = (Math.max(1, t.priority) - 1) * AI.decoyPullPerPriority;
            const score = Math.sqrt(dist2(e.x, e.y, t.x, t.y)) - attraction;
            if (score < bestScore) {
                bestScore = score;
                best = t;
            }
        }
        return best;
    }
    cellKey(x, y) {
        // 12-bit pack; the arena is far smaller than 4096 cells on either axis.
        return ((x / 72) | 0) * 4096 + ((y / 72) | 0);
    }
    rebuildGrid() {
        this.grid.clear();
        for (const e of this.enemies.values()) {
            const key = this.cellKey(e.x, e.y);
            const cell = this.grid.get(key);
            if (cell)
                cell.push(e);
            else
                this.grid.set(key, [e]);
        }
    }
    /**
     * Cheap crowd separation. Only the enemy's own cell and its eight neighbours
     * are consulted, so this stays roughly O(n) instead of the O(n^2) a naive
     * all-pairs pass would cost at the 100-enemy cap.
     */
    separate(e, radius) {
        const cx = (e.x / 72) | 0;
        const cy = (e.y / 72) | 0;
        let pushX = 0;
        let pushY = 0;
        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                const cell = this.grid.get((cx + ox) * 4096 + (cy + oy));
                if (!cell)
                    continue;
                for (const other of cell) {
                    if (other === e)
                        continue;
                    const min = radius + ENEMY_DEFS[other.kind].radius;
                    const d2 = dist2(e.x, e.y, other.x, other.y);
                    if (d2 >= min * min || d2 === 0)
                        continue;
                    const d = Math.sqrt(d2);
                    const strength = (min - d) / min;
                    pushX += ((e.x - other.x) / d) * strength;
                    pushY += ((e.y - other.y) / d) * strength;
                }
            }
        }
        e.vx += pushX * 130;
        e.vy += pushY * 130;
    }
}
//# sourceMappingURL=HordeEngine.js.map