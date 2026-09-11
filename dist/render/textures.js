import { CLASSES, CLASS_ORDER } from '../sim/classes.js';
import { UPGRADES, UPGRADE_ORDER } from '../sim/progression.js';
import { ENEMY_DEFS } from '../sim/enemyTypes.js';
import { LEVEL_COLOURS, MAX_LEVEL } from '../sim/enemyLevels.js';
import { EnemyKind } from '../types.js';
export const TEX = {
    player: (cls) => `tex-player-${cls}`,
    enemy: (kind, level) => `tex-enemy-${kind}-${level}`,
    bullet: 'tex-bullet',
    enemyBullet: 'tex-enemy-bullet',
    pixel: 'tex-pixel',
    glow: 'tex-glow',
    ring: 'tex-ring',
    decoy: 'tex-decoy',
    chip: 'tex-chip',
    orbit: 'tex-orbit',
    shadow: 'tex-shadow',
    spark: 'tex-spark',
    powerUp: (id) => `tex-powerup-${id}`,
    grid: 'tex-grid',
    vignette: 'tex-vignette',
    marker: 'tex-marker',
};
/**
 * Every sprite in the game is drawn at boot rather than loaded.
 *
 * No image assets means no loading screen, no atlas to keep in sync, and no
 * CORS or Pages-path problems — which matters for a build that is meant to be
 * a single static deploy. It also suits the art direction: the Cyber-Pop
 * Mainframe look is flat neon geometry over white, and geometry is exactly what
 * `Graphics` is good at.
 */
export function createTextures(scene) {
    drawPixel(scene);
    drawGlow(scene);
    drawRing(scene);
    drawGrid(scene);
    drawBullets(scene);
    drawDecoy(scene);
    drawChip(scene);
    drawOrbit(scene);
    drawShadow(scene);
    drawSpark(scene);
    drawVignette(scene);
    for (const id of UPGRADE_ORDER)
        drawPowerUp(scene, UPGRADES[id]);
    for (const id of CLASS_ORDER)
        drawPlayer(scene, id, CLASSES[id].colour, CLASSES[id].radius);
    // Every kind at every level: 42 textures, drawn once at boot. The
    // alternative — one body sprite plus a tinted pip sprite per enemy — would
    // double the display list at the 100-enemy cap and add a position to sync
    // every frame, to save a few hundred KB of texture memory we are not short
    // of.
    drawMarker(scene);
    for (let level = 1; level <= MAX_LEVEL; level++) {
        drawBug(scene, level);
        drawDrone(scene, level);
        drawTank(scene, level);
        drawWraith(scene, level);
        drawSpore(scene, level);
        drawBrute(scene, level);
    }
}
/** A single white texel. Particles tint it, so one texture covers every burst. */
function drawPixel(scene) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1).fillRect(0, 0, 4, 4);
    g.generateTexture(TEX.pixel, 4, 4);
    g.destroy();
}
/** Soft radial falloff, used additively for every light source in the game. */
function drawGlow(scene) {
    const size = 128;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    for (let r = size / 2; r > 0; r -= 2) {
        const t = r / (size / 2);
        g.fillStyle(0xffffff, 0.035 * (1 - t) ** 1.5);
        g.fillCircle(size / 2, size / 2, r);
    }
    g.generateTexture(TEX.glow, size, size);
    g.destroy();
}
/** Hollow ring, scaled up for shockwaves and heal fields. */
function drawRing(scene) {
    const size = 128;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.lineStyle(6, 0xffffff, 1).strokeCircle(size / 2, size / 2, size / 2 - 6);
    g.lineStyle(2, 0xffffff, 0.45).strokeCircle(size / 2, size / 2, size / 2 - 16);
    g.generateTexture(TEX.ring, size, size);
    g.destroy();
}
/** One tile of the mainframe floor: pale silver rules on white. */
function drawGrid(scene) {
    const size = 80;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xf7f9fc, 1).fillRect(0, 0, size, size);
    g.lineStyle(1, 0xd8e0ea, 1);
    g.beginPath();
    g.moveTo(0, 0).lineTo(size, 0);
    g.moveTo(0, 0).lineTo(0, size);
    g.strokePath();
    g.lineStyle(1, 0xeaeff5, 1);
    g.beginPath();
    g.moveTo(0, size / 2).lineTo(size, size / 2);
    g.moveTo(size / 2, 0).lineTo(size / 2, size);
    g.strokePath();
    g.generateTexture(TEX.grid, size, size);
    g.destroy();
}
function drawBullets(scene) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    // Player round. Drawn pointing right, and built around a dark rim rather than
    // a glow: this arena is white, so a bright bullet has nothing to be brighter
    // than. Tint multiplies, so the rim stays dark whatever colour the class is
    // while the body takes the class colour at full saturation.
    g.fillStyle(0x0b1017, 0.92).fillRoundedRect(0, 0, 32, 15, 7);
    g.fillStyle(0xffffff, 1).fillRoundedRect(2, 2, 28, 11, 5);
    // Darker tail and lighter nose give it a direction of travel.
    g.fillStyle(0x0b1017, 0.22).fillRoundedRect(2, 2, 9, 11, 5);
    g.generateTexture(TEX.bullet, 32, 15);
    g.clear();
    // Enemy round: a hollow diamond with the same dark rim, so it reads as
    // hostile at a glance and never disappears into the floor.
    g.fillStyle(0x0b1017, 0.92).fillCircle(11, 11, 10);
    g.fillStyle(0xffffff, 1);
    g.beginPath();
    g.moveTo(11, 2).lineTo(20, 11).lineTo(11, 20).lineTo(2, 11);
    g.closePath();
    g.fillPath();
    g.fillStyle(0x0b1017, 0.75).fillCircle(11, 11, 3);
    g.generateTexture(TEX.enemyBullet, 22, 22);
    g.destroy();
}
/**
 * The player chassis: a chevron pointing along +x, because Phaser's rotation of
 * 0 points right and every aim angle in the game is an atan2 result.
 *
 * The canvas is sized from the *furthest* thing drawn — the muzzle end of the
 * barrel — rather than from the body radius. Sizing it to the body clips the
 * barrel and, worse, shifts the texture's centre away from the body, so the
 * sprite appears to orbit its own origin as it turns.
 */
function drawPlayer(scene, cls, colour, radius) {
    const barrelStart = radius - 3;
    const barrelLength = radius + 12;
    const reach = barrelStart + barrelLength;
    const size = (reach + 6) * 2;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    // Outer glow, then a soft contact shadow so a white chassis still reads
    // against the white mainframe floor.
    g.fillStyle(colour, 0.16).fillCircle(c, c, radius + 11);
    g.fillStyle(0x0b1017, 0.10).fillCircle(c, c, radius + 3);
    g.fillStyle(0xffffff, 1).fillCircle(c, c, radius);
    g.lineStyle(3.5, colour, 1).strokeCircle(c, c, radius);
    // Barrel.
    g.fillStyle(colour, 1).fillRoundedRect(c + barrelStart, c - 4, barrelLength, 8, 3);
    // Directional notch, so the facing stays legible even at small scale.
    g.fillStyle(colour, 1);
    g.beginPath();
    g.moveTo(c + radius * 0.2, c - radius * 0.62);
    g.lineTo(c + radius * 0.95, c);
    g.lineTo(c + radius * 0.2, c + radius * 0.62);
    g.closePath();
    g.fillPath();
    g.fillStyle(0xffffff, 0.9).fillCircle(c - radius * 0.25, c, radius * 0.3);
    g.generateTexture(TEX.player(cls), size, size);
    g.destroy();
}
/**
 * Off-screen indicator: a chevron, drawn pointing right so a sprite rotation
 * of zero points the way the marker's own angle expects.
 *
 * White-cored with a dark rim for the same reason the level pips have a halo —
 * it is tinted per teammate and has to stay legible over the arena grid, the
 * vignette and whatever is happening underneath it.
 */
function drawMarker(scene) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const w = 28;
    const h = 22;
    g.fillStyle(0x0b1017, 0.25);
    g.beginPath();
    g.moveTo(w, h / 2);
    g.lineTo(3, 1);
    g.lineTo(9, h / 2);
    g.lineTo(3, h - 1);
    g.closePath();
    g.fillPath();
    g.fillStyle(0xffffff, 1);
    g.beginPath();
    g.moveTo(w - 2, h / 2);
    g.lineTo(5.5, 3.5);
    g.lineTo(11, h / 2);
    g.lineTo(5.5, h - 3.5);
    g.closePath();
    g.fillPath();
    g.generateTexture(TEX.marker, w, h);
    g.destroy();
}
/**
 * The level pip: a coloured dot at the centre of every enemy.
 *
 * Always on a white disc with a dark rim, because the pip has to be read
 * against six different body colours and in peripheral vision while something
 * else is shooting at you. On white it only ever has to contrast with white,
 * which is what makes a seven-step rainbow legible at this size.
 *
 * Drawn last, so it sits on top of whatever the body put in the middle.
 */
function levelPip(g, c, radius, level) {
    // Sized off the body so it stays proportionate, but floored so it is still
    // readable on a Packet Wraith and capped so it does not become the Ransom
    // Brute's defining feature. The small kinds are where this is tightest: the
    // pip has to be legible without swallowing the silhouette that tells you
    // what you are shooting at.
    const pip = Math.max(3.1, Math.min(7.5, radius * 0.27));
    const colour = LEVEL_COLOURS[Math.max(0, Math.min(LEVEL_COLOURS.length - 1, level - 1))];
    g.fillStyle(0xffffff, 1).fillCircle(c, c, pip + 1.9);
    g.lineStyle(1.2, 0x0b1017, 0.55).strokeCircle(c, c, pip + 1.9);
    g.fillStyle(colour, 1).fillCircle(c, c, pip);
}
/** Skittering Glitch Bug: small, angular, unstable. */
function drawBug(scene, level) {
    const def = ENEMY_DEFS[EnemyKind.GlitchBug];
    const size = def.radius * 2 + 16;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(def.colour, 0.2).fillCircle(c, c, def.radius + 7);
    g.fillStyle(def.colour, 1);
    g.beginPath();
    g.moveTo(c + def.radius, c);
    g.lineTo(c - def.radius * 0.5, c - def.radius);
    g.lineTo(c - def.radius * 0.15, c);
    g.lineTo(c - def.radius * 0.5, c + def.radius);
    g.closePath();
    g.fillPath();
    g.fillStyle(0xffffff, 1).fillCircle(c + def.radius * 0.25, c, 3);
    levelPip(g, c, def.radius, level);
    g.generateTexture(TEX.enemy(EnemyKind.GlitchBug, level), size, size);
    g.destroy();
}
/** Rogue Firewall Drone: a hovering hexagonal shell with a hot aperture. */
function drawDrone(scene, level) {
    const def = ENEMY_DEFS[EnemyKind.FirewallDrone];
    const size = def.radius * 2 + 18;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(def.colour, 0.18).fillCircle(c, c, def.radius + 8);
    g.lineStyle(3.5, def.colour, 1);
    g.beginPath();
    for (let n = 0; n < 6; n++) {
        const a = (Math.PI / 3) * n;
        const px = c + Math.cos(a) * def.radius;
        const py = c + Math.sin(a) * def.radius;
        if (n === 0)
            g.moveTo(px, py);
        else
            g.lineTo(px, py);
    }
    g.closePath();
    g.strokePath();
    g.fillStyle(0xffffff, 1).fillCircle(c, c, def.radius * 0.45);
    g.fillStyle(def.colour, 1).fillCircle(c, c, def.radius * 0.24);
    g.fillStyle(def.colour, 1).fillRoundedRect(c + def.radius * 0.5, c - 3, def.radius * 0.7, 6, 3);
    levelPip(g, c, def.radius, level);
    g.generateTexture(TEX.enemy(EnemyKind.FirewallDrone, level), size, size);
    g.destroy();
}
/** Trojan Tank: heavy, plated, obviously slow. */
function drawTank(scene, level) {
    const def = ENEMY_DEFS[EnemyKind.TrojanTank];
    const r = def.radius;
    // Sized from the cannon's muzzle (r * 1.35 from centre), not the hull.
    const size = Math.ceil(r * 1.35 + 8) * 2;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(def.colour, 0.16).fillCircle(c, c, r + 10);
    g.fillStyle(0xffffff, 1).fillRoundedRect(c - r, c - r, r * 2, r * 2, 9);
    g.lineStyle(5, def.colour, 1).strokeRoundedRect(c - r, c - r, r * 2, r * 2, 9);
    g.lineStyle(3, def.colour, 0.55);
    g.beginPath();
    g.moveTo(c - r * 0.45, c - r * 0.55).lineTo(c - r * 0.45, c + r * 0.55);
    g.moveTo(c + r * 0.1, c - r * 0.55).lineTo(c + r * 0.1, c + r * 0.55);
    g.strokePath();
    g.fillStyle(def.colour, 1).fillRoundedRect(c + r * 0.75, c - 5, r * 0.6, 10, 4);
    levelPip(g, c, def.radius, level);
    g.generateTexture(TEX.enemy(EnemyKind.TrojanTank, level), size, size);
    g.destroy();
}
/** Packet Wraith: a lean double chevron. Reads as speed before anything else. */
function drawWraith(scene, level) {
    const def = ENEMY_DEFS[EnemyKind.PacketWraith];
    const r = def.radius;
    const size = Math.ceil(r * 1.9 + 8) * 2;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(def.colour, 0.2).fillCircle(c, c, r + 6);
    const chevron = (offset, scale) => {
        g.beginPath();
        g.moveTo(c + offset + r * scale, c);
        g.lineTo(c + offset - r * 0.5 * scale, c - r * scale);
        g.lineTo(c + offset - r * 0.1 * scale, c);
        g.lineTo(c + offset - r * 0.5 * scale, c + r * scale);
        g.closePath();
        g.fillPath();
    };
    g.fillStyle(def.colour, 1);
    chevron(r * 0.45, 1);
    g.fillStyle(def.colour, 0.55);
    chevron(-r * 0.55, 0.8);
    levelPip(g, c, def.radius, level);
    g.generateTexture(TEX.enemy(EnemyKind.PacketWraith, level), size, size);
    g.destroy();
}
/** Spore Node: a spiked seed, visibly full of something waiting to get out. */
function drawSpore(scene, level) {
    const def = ENEMY_DEFS[EnemyKind.SporeNode];
    const r = def.radius;
    const size = Math.ceil(r * 1.6 + 8) * 2;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(def.colour, 0.18).fillCircle(c, c, r + 7);
    // Spikes.
    g.fillStyle(def.colour, 1);
    for (let n = 0; n < 8; n++) {
        const a = (Math.PI / 4) * n;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * r * 1.5, c + Math.sin(a) * r * 1.5);
        g.lineTo(c + Math.cos(a + 0.34) * r * 0.85, c + Math.sin(a + 0.34) * r * 0.85);
        g.lineTo(c + Math.cos(a - 0.34) * r * 0.85, c + Math.sin(a - 0.34) * r * 0.85);
        g.closePath();
        g.fillPath();
    }
    g.fillStyle(0x0b1017, 0.9).fillCircle(c, c, r * 0.92);
    g.fillStyle(def.colour, 1).fillCircle(c, c, r * 0.78);
    // Two pale cells inside — the things it splits into.
    g.fillStyle(0xffffff, 0.85).fillCircle(c - r * 0.26, c - r * 0.1, r * 0.24);
    g.fillStyle(0xffffff, 0.85).fillCircle(c + r * 0.26, c + r * 0.14, r * 0.24);
    levelPip(g, c, def.radius, level);
    g.generateTexture(TEX.enemy(EnemyKind.SporeNode, level), size, size);
    g.destroy();
}
/** Ransom Brute: a heavy plated octagon with a padlock slot. */
function drawBrute(scene, level) {
    const def = ENEMY_DEFS[EnemyKind.RansomBrute];
    const r = def.radius;
    const size = Math.ceil(r * 1.35 + 10) * 2;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const octagon = (radius) => {
        g.beginPath();
        for (let n = 0; n < 8; n++) {
            const a = (Math.PI / 4) * n + Math.PI / 8;
            const px = c + Math.cos(a) * radius;
            const py = c + Math.sin(a) * radius;
            if (n === 0)
                g.moveTo(px, py);
            else
                g.lineTo(px, py);
        }
        g.closePath();
    };
    g.fillStyle(def.colour, 0.2).fillCircle(c, c, r + 9);
    g.fillStyle(0x0b1017, 0.9);
    octagon(r + 3);
    g.fillPath();
    g.fillStyle(def.colour, 1);
    octagon(r);
    g.fillPath();
    // Plating.
    g.lineStyle(3, 0x0b1017, 0.45);
    g.beginPath();
    g.moveTo(c - r * 0.55, c - r * 0.7).lineTo(c - r * 0.55, c + r * 0.7);
    g.moveTo(c + r * 0.55, c - r * 0.7).lineTo(c + r * 0.55, c + r * 0.7);
    g.strokePath();
    // Lock: a shackle over a slot, so "ransom" is legible at a glance.
    g.lineStyle(4, 0xffd54f, 1).strokeCircle(c, c - r * 0.18, r * 0.3);
    g.fillStyle(0xffd54f, 1).fillRoundedRect(c - r * 0.38, c - r * 0.1, r * 0.76, r * 0.62, 3);
    g.fillStyle(0x0b1017, 0.85).fillRect(c - r * 0.06, c + r * 0.06, r * 0.12, r * 0.26);
    // Cannon.
    g.fillStyle(def.colour, 1).fillRoundedRect(c + r * 0.85, c - 6, r * 0.5, 12, 4);
    levelPip(g, c, def.radius, level);
    g.generateTexture(TEX.enemy(EnemyKind.RansomBrute, level), size, size);
    g.destroy();
}
/** Glitcher decoy: a wireframe echo of a player chassis. */
function drawDecoy(scene) {
    const size = 56;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xff2d95, 0.18).fillCircle(c, c, 22);
    g.lineStyle(3, 0xff2d95, 0.95).strokeCircle(c, c, 15);
    g.lineStyle(2, 0xff2d95, 0.6);
    g.beginPath();
    g.moveTo(c - 22, c).lineTo(c + 22, c);
    g.moveTo(c, c - 22).lineTo(c, c + 22);
    g.strokePath();
    g.generateTexture(TEX.decoy, size, size);
    g.destroy();
}
/**
 * A dropped compute chip: a square die with contact pins down both sides.
 *
 * Small, so it needs a hard silhouette rather than a glow — the same reason
 * bullets are built around a dark rim. At this size, detail beyond the pins
 * would be mush.
 */
function drawChip(scene) {
    const size = 20;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x4caf00, 0.22).fillCircle(size / 2, size / 2, size / 2);
    // Pins.
    g.fillStyle(0x0b1017, 0.85);
    for (let n = 0; n < 3; n++) {
        const y = 5 + n * 4;
        g.fillRect(1, y, 3, 2);
        g.fillRect(size - 4, y, 3, 2);
    }
    g.fillStyle(0x0b1017, 0.9).fillRoundedRect(3.5, 3.5, 13, 13, 3);
    g.fillStyle(0x7cff3d, 1).fillRoundedRect(5, 5, 10, 10, 2);
    g.fillStyle(0x0b1017, 0.55).fillRect(7.5, 7.5, 5, 5);
    g.generateTexture(TEX.chip, size, size);
    g.destroy();
}
/**
 * A power-up node: an upright crystal on a bright white core.
 *
 * Shape carries the meaning here. Every enemy is a filled, saturated silhouette
 * — a magenta dart, an amber hexagon, a violet slab — so a pickup must not be
 * any of those. The previous design was a hexagon in magenta or amber, which is
 * to say it was shaped like a Firewall Drone and coloured like a Glitch Bug;
 * players read it as something to shoot.
 *
 * This inverts the value structure instead of just changing the outline:
 * enemies are saturated bodies with a dark rim, a pickup is a *white* body with
 * a saturated frame. Even at a glance in a crowd, bright-cored means friendly.
 */
function drawPowerUp(scene, def) {
    const size = 68;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const crystal = (radius, waist) => {
        g.beginPath();
        g.moveTo(c, c - radius);
        g.lineTo(c + waist, c - radius * 0.35);
        g.lineTo(c + waist, c + radius * 0.35);
        g.lineTo(c, c + radius);
        g.lineTo(c - waist, c + radius * 0.35);
        g.lineTo(c - waist, c - radius * 0.35);
        g.closePath();
    };
    g.fillStyle(def.colour, 0.18).fillCircle(c, c, 27);
    g.fillStyle(def.colour, 1);
    crystal(25, 17);
    g.fillPath();
    g.fillStyle(0xffffff, 1);
    crystal(19, 12.5);
    g.fillPath();
    // Facet highlight: a flat white shape reads as a sticker, a shaded one reads
    // as an object worth walking to.
    g.fillStyle(def.colour, 0.16);
    g.beginPath();
    g.moveTo(c, c - 19).lineTo(c + 12.5, c - 6.6).lineTo(c, c + 19).closePath();
    g.fillPath();
    g.fillStyle(def.colour, 1);
    drawGlyph(g, c, c, def.id);
    g.generateTexture(TEX.powerUp(def.id), size, size);
    g.destroy();
}
/** The mark inside a power-up, saying what it does without a word of text. */
function drawGlyph(g, c, m, id) {
    if (id === 'speed') {
        // Double chevron — momentum.
        for (const dx of [-4, 2]) {
            g.beginPath();
            g.moveTo(c + dx - 3, m - 7).lineTo(c + dx + 4, m).lineTo(c + dx - 3, m + 7).lineTo(c + dx - 0.5, m).closePath();
            g.fillPath();
        }
    }
    else if (id === 'firerate') {
        // Three ascending bars — rate.
        g.fillRect(c - 7, m + 1, 3.5, 6);
        g.fillRect(c - 1.75, m - 3, 3.5, 10);
        g.fillRect(c + 3.5, m - 7, 3.5, 14);
    }
    else if (id === 'regen') {
        // Cross — the one glyph everybody already knows means health.
        g.fillRect(c - 2.4, m - 8, 4.8, 16);
        g.fillRect(c - 8, m - 2.4, 16, 4.8);
    }
    else {
        // Radiating burst — impact.
        for (let n = 0; n < 6; n++) {
            const a = (Math.PI / 3) * n;
            g.fillRect(c + Math.cos(a) * 6.5 - 1.4, m + Math.sin(a) * 6.5 - 1.4, 2.8, 2.8);
        }
        g.fillCircle(c, m, 3.6);
    }
}
/**
 * Orbiting bracket, drawn behind a power-up and counter-rotated.
 *
 * Nothing in the game orbits anything, so the motion alone identifies a pickup
 * from across the arena — before its shape or colour is even legible.
 */
function drawOrbit(scene) {
    const size = 96;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.lineStyle(2.5, 0xffffff, 1);
    for (let n = 0; n < 4; n++) {
        const start = (Math.PI / 2) * n + 0.35;
        g.beginPath();
        g.arc(c, c, 40, start, start + 0.75, false);
        g.strokePath();
    }
    for (let n = 0; n < 4; n++) {
        const a = (Math.PI / 2) * n;
        g.fillStyle(0xffffff, 1).fillRect(c + Math.cos(a) * 40 - 2, c + Math.sin(a) * 40 - 2, 4, 4);
    }
    g.generateTexture(TEX.orbit, size, size);
    g.destroy();
}
/** Soft contact shadow. Grounds a floating object against a flat white floor. */
function drawShadow(scene) {
    const size = 64;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    for (let r = 22; r > 0; r -= 1) {
        g.fillStyle(0x0b1017, 0.02 * (1 - r / 22));
        g.fillEllipse(size / 2, size / 2, r * 2, r * 0.9);
    }
    g.generateTexture(TEX.shadow, size, size);
    g.destroy();
}
/** Four-point star, for sparkles that read differently to square pixel debris. */
function drawSpark(scene) {
    const size = 16;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.beginPath();
    g.moveTo(c, 0).lineTo(c + 1.8, c - 1.8).lineTo(size, c).lineTo(c + 1.8, c + 1.8);
    g.lineTo(c, size).lineTo(c - 1.8, c + 1.8).lineTo(0, c).lineTo(c - 1.8, c - 1.8);
    g.closePath();
    g.fillPath();
    g.generateTexture(TEX.spark, size, size);
    g.destroy();
}
/**
 * Screen-space vignette. The arena is deliberately bright, which flattens it;
 * darkening the corners gives the playfield a centre without dimming the
 * action.
 */
function drawVignette(scene) {
    const size = 256;
    const c = size / 2;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    // Concentric *rings*, not filled discs. Filling discs stacks alpha toward the
    // middle, which darkens the centre — the exact opposite of a vignette, and it
    // renders as a grey blob over the playfield.
    //
    // The outer radius overshoots the texture so the corners, which are the
    // furthest points from centre, actually get covered.
    const inner = c * 0.55;
    const outer = c * 1.5;
    for (let r = outer; r > inner; r -= 1.5) {
        const t = (r - inner) / (outer - inner);
        g.lineStyle(2.5, 0x243049, 0.02 * t * t);
        g.strokeCircle(c, c, r);
    }
    g.generateTexture(TEX.vignette, size, size);
    g.destroy();
}
//# sourceMappingURL=textures.js.map