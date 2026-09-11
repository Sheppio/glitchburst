/**
 * Wire codec.
 *
 * Everything on the wire is a delimited ASCII string rather than JSON. For the
 * horde snapshot this matters a lot: at the 100-enemy cap, JSON costs roughly
 * 5.5 KB per frame and 110 KB/s at 20 Hz, which public brokers will throttle.
 * The delimited form below is ~1.4 KB per frame (~28 KB/s) and parses with a
 * couple of `split` calls.
 *
 * Format (requirement 3):   id,x,y,kl,hp;id,x,y,kl,hp;...
 *
 * Ids and health are base36; positions are rounded to whole world pixels, which
 * is well under the size of every sprite and therefore invisible once the peer
 * interpolates (see `render/lerp.ts`).
 *
 * `kl` is kind and level packed into one base36 field rather than two. A
 * separate level field would have cost two bytes per enemy — 200 at the cap,
 * which pushed the snapshot over the 40 KB/s budget the whole codec exists to
 * respect. Packed, only level 7 needs a second character.
 */
import { clampLevel, MAX_LEVEL } from '../sim/enemyLevels.js';
import { DEFAULT_COLOUR } from '../sim/palette.js';
const REC = ';';
const FLD = ',';
const EVT = '|';
const i = (n) => (Number.isFinite(n) ? Math.round(n) : 0);
const b36 = (n) => i(n).toString(36);
const un36 = (s) => {
    const v = parseInt(s, 36);
    return Number.isFinite(v) ? v : 0;
};
const num = (s) => {
    const v = Number(s);
    return Number.isFinite(v) ? v : 0;
};
/* ------------------------------------------------------------------ horde */
/** Number of enemy kinds the pack/unpack pair is sized for. */
const KINDS = 6;
/** kind (0-5) and level (1-7) as one number, 0-41. */
const packKindLevel = (kind, level) => (kind >= 0 && kind < KINDS ? kind : 0) + (clampLevel(level) - 1) * KINDS;
/** Host -> room. The entire horde as one message. */
export function encodeHorde(enemies) {
    let out = '';
    for (const e of enemies) {
        out += e.id + FLD + i(e.x) + FLD + i(e.y) + FLD + b36(packKindLevel(e.kind, e.level)) + FLD + b36(e.hp) + REC;
    }
    return out;
}
/** Peer <- room. Tolerant of truncation: a malformed trailing record is dropped. */
export function decodeHorde(payload) {
    const out = [];
    if (!payload)
        return out;
    for (const rec of payload.split(REC)) {
        if (!rec)
            continue;
        const f = rec.split(FLD);
        if (f.length < 5)
            continue;
        // Clamp to the known range rather than naming each kind: an unrecognised
        // value is a peer on a newer build, and rendering it as a level 1 Glitch
        // Bug is a better failure than dropping it and shooting at nothing.
        const packed = un36(f[3]);
        const kind = packed % KINDS;
        const level = Math.floor(packed / KINDS) + 1;
        out.push({
            id: f[0],
            x: num(f[1]),
            y: num(f[2]),
            kind: (kind >= 0 && kind < KINDS ? kind : 0),
            level: level >= 1 && level <= MAX_LEVEL ? level : 1,
            hp: un36(f[4]),
        });
    }
    return out;
}
/** Host -> room. Deaths, drone shots and wave banners, batched into one message. */
export function encodeEvents(events) {
    const parts = [];
    for (const e of events) {
        switch (e.t) {
            case 'death':
                parts.push(`D:${e.id},${i(e.x)},${i(e.y)},${e.kind},${clampLevel(e.level)}`);
                break;
            case 'shot':
                parts.push(`P:${e.id},${i(e.x)},${i(e.y)},${i(e.vx)},${i(e.vy)},${i(e.damage)}`);
                break;
            case 'wave':
                parts.push(`W:${e.n},${e.size}`);
                break;
        }
    }
    return parts.join(EVT);
}
export function decodeEvents(payload) {
    const out = [];
    if (!payload)
        return out;
    for (const raw of payload.split(EVT)) {
        const colon = raw.indexOf(':');
        if (colon < 1)
            continue;
        const tag = raw.slice(0, colon);
        const f = raw.slice(colon + 1).split(FLD);
        if (tag === 'D' && f.length >= 4) {
            // The level field is read leniently: deaths are the one place a dropped
            // field costs only a slightly wrong chip count, not a desynced horde.
            out.push({
                t: 'death',
                id: f[0],
                x: num(f[1]),
                y: num(f[2]),
                kind: num(f[3]),
                level: f.length >= 5 ? clampLevel(num(f[4])) : 1,
            });
        }
        else if (tag === 'P' && f.length >= 6) {
            out.push({
                t: 'shot',
                id: f[0],
                x: num(f[1]),
                y: num(f[2]),
                vx: num(f[3]),
                vy: num(f[4]),
                damage: num(f[5]),
            });
        }
        else if (tag === 'W' && f.length >= 2) {
            out.push({ t: 'wave', n: num(f[0]), size: num(f[1]) });
        }
    }
    return out;
}
/* ----------------------------------------------------------------- player */
/**
 * Player -> room, on that player's own topic. The player id is carried by the
 * topic, not the payload, so it is not repeated here.
 *
 *   name,cls,x,y,angle(centi-radians),hp,maxHp,flags[,colour]
 *
 * `colour` is a trailing field so a client running an older build — Pages
 * caches, and nobody reloads mid-session — still decodes, and simply appears in
 * the default colour until it catches up.
 */
export function encodePlayer(p) {
    return [
        sanitizeName(p.name),
        p.cls,
        i(p.x),
        i(p.y),
        i(p.angle * 100),
        i(p.hp),
        i(p.maxHp),
        p.flags,
        p.colour,
    ].join(FLD);
}
export function decodePlayer(id, payload) {
    const f = payload.split(FLD);
    if (f.length < 8)
        return null;
    return {
        id,
        name: f[0],
        cls: f[1],
        x: num(f[2]),
        y: num(f[3]),
        angle: num(f[4]) / 100,
        hp: num(f[5]),
        maxHp: num(f[6]) || 100,
        flags: num(f[7]),
        colour: f[8] ?? DEFAULT_COLOUR,
        lastSeen: performance.now(),
    };
}
/** Names go on the wire inside a comma-delimited record, so they must not contain one. */
export function sanitizeName(name) {
    return (name || 'ANON').replace(/[^A-Za-z0-9_\- ]/g, '').slice(0, 14).trim() || 'ANON';
}
/**
 * Trigger pulls, not individual projectiles.
 *
 * Only the shot origin and angle go on the wire; pellet count, spread, speed
 * and lifetime are all derivable from the shooter's class, which every client
 * already knows. A Fireman's seven-pellet blast is therefore one record of
 * about fourteen bytes rather than seven.
 */
export function encodeShots(shots) {
    let out = '';
    for (const shot of shots)
        out += i(shot.x) + FLD + i(shot.y) + FLD + i(shot.angle * 100) + REC;
    return out;
}
export function decodeShots(payload) {
    const out = [];
    if (!payload)
        return out;
    for (const rec of payload.split(REC)) {
        if (!rec)
            continue;
        const f = rec.split(FLD);
        if (f.length < 3)
            continue;
        out.push({ x: num(f[0]), y: num(f[1]), angle: num(f[2]) / 100 });
    }
    return out;
}
export function encodePresence(m) {
    return [sanitizeName(m.name), m.cls, m.host, m.alive, m.colour].join(FLD);
}
export function decodePresence(id, payload) {
    const f = payload.split(FLD);
    if (f.length < 4)
        return null;
    // Trailing, and defaulted: see `encodePlayer`.
    return {
        id, name: f[0], cls: f[1], host: num(f[2]), alive: num(f[3]),
        colour: f[4] ?? DEFAULT_COLOUR,
    };
}
/* ----------------------------------------------------------- run summary */
/** One client's own contribution to the group totals: `shots,chips,powerUps,reboots`. */
export function encodePlayerStats(s) {
    return [b36(s.shots), b36(s.chips), b36(s.powerUps), b36(s.reboots)].join(FLD);
}
export function decodePlayerStats(payload) {
    const f = payload.split(FLD);
    if (f.length < 4)
        return null;
    return { shots: un36(f[0]), chips: un36(f[1]), powerUps: un36(f[2]), reboots: un36(f[3]) };
}
export function encodeHeartbeat(hostId, seq, s) {
    return [
        hostId, seq, i(s.enemyCount), i(s.wave), s.paused ? 1 : 0, i(s.score),
        s.running ? 1 : 0, i(s.kills), i(s.seconds),
    ].join(FLD);
}
export function decodeHeartbeat(payload) {
    const f = payload.split(FLD);
    if (f.length < 4)
        return null;
    // Everything past the wave is a later addition and is read optionally, so a
    // client on an older build still produces a valid heartbeat. Score and
    // running are `null` rather than 0/false when absent: zero is a legitimate
    // score and adopting it every beat would wipe the board, and a missing
    // running flag must not be read as "this room is a lobby" and strand
    // everyone outside a live match.
    return {
        hostId: f[0],
        seq: num(f[1]),
        enemyCount: num(f[2]),
        wave: num(f[3]),
        paused: f.length > 4 && num(f[4]) === 1,
        score: f.length > 5 ? num(f[5]) : null,
        running: f.length > 6 ? num(f[6]) === 1 : null,
        kills: f.length > 7 ? num(f[7]) : 0,
        seconds: f.length > 8 ? num(f[8]) : 0,
    };
}
/** Host -> room: `1|0,hostId,displayName`. */
export function encodePause(paused, byId, byName) {
    return [paused ? 1 : 0, byId, sanitizeName(byName)].join(FLD);
}
export function decodePause(payload) {
    const f = payload.split(FLD);
    if (f.length < 3)
        return null;
    return { paused: num(f[0]) === 1, byId: f[1], byName: f[2] };
}
/* ------------------------------------------------------------------ misc */
/** Attacker-authority damage report: `amount,attackerId`. */
export function encodeDamage(amount, attacker) {
    return i(amount) + FLD + attacker;
}
export function decodeDamage(payload) {
    const f = payload.split(FLD);
    if (f.length < 2)
        return null;
    return { amount: num(f[0]), attacker: f[1] };
}
/** Ability field effects: `id,owner,kind,x,y,radius,ttl`. */
export function encodeField(f) {
    return [f.id, f.owner, f.kind, i(f.x), i(f.y), i(f.radius), i(f.ttl * 10)].join(FLD);
}
export function decodeField(payload) {
    const f = payload.split(FLD);
    if (f.length < 7)
        return null;
    const kind = f[2];
    if (kind !== 'decoy' && kind !== 'heal' && kind !== 'shockwave')
        return null;
    return {
        id: f[0],
        owner: f[1],
        kind,
        x: num(f[3]),
        y: num(f[4]),
        radius: num(f[5]),
        ttl: num(f[6]) / 10,
    };
}
//# sourceMappingURL=codec.js.map