import { CLASSES, CLASS_ORDER } from '../sim/classes.js';
import { UPGRADES, UPGRADE_ORDER } from '../sim/progression.js';
import { ENEMY_DEFS } from '../sim/enemyTypes.js';
import { EnemyKind } from '../types.js';
export const TEX = {
    player: (cls) => `tex-player-${cls}`,
    enemy: (kind) => `tex-enemy-${kind}`,
    bullet: 'tex-bullet',
    enemyBullet: 'tex-enemy-bullet',
    pixel: 'tex-pixel',
    glow: 'tex-glow',
    ring: 'tex-ring',
    decoy: 'tex-decoy',
    chip: 'tex-chip',
    powerUp: (id) => `tex-powerup-${id}`,
    grid: 'tex-grid',
    vignette: 'tex-vignette',
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
    for (const id of UPGRADE_ORDER)
        drawPowerUp(scene, UPGRADES[id]);
    for (const id of CLASS_ORDER)
        drawPlayer(scene, id, CLASSES[id].colour, CLASSES[id].radius);
    drawBug(scene);
    drawDrone(scene);
    drawTank(scene);
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
/** Skittering Glitch Bug: small, angular, unstable. */
function drawBug(scene) {
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
    g.generateTexture(TEX.enemy(EnemyKind.GlitchBug), size, size);
    g.destroy();
}
/** Rogue Firewall Drone: a hovering hexagonal shell with a hot aperture. */
function drawDrone(scene) {
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
    g.generateTexture(TEX.enemy(EnemyKind.FirewallDrone), size, size);
    g.destroy();
}
/** Trojan Tank: heavy, plated, obviously slow. */
function drawTank(scene) {
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
    g.generateTexture(TEX.enemy(EnemyKind.TrojanTank), size, size);
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
 * A power-up node: a hexagonal container in the upgrade's colour, carrying a
 * glyph that says what it does at a glance — an arrow for speed, a chevron
 * stack for fire rate, a burst for damage.
 */
function drawPowerUp(scene, def) {
    const size = 60;
    const c = size / 2;
    const r = 20;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(def.colour, 0.2).fillCircle(c, c, r + 8);
    const hex = (radius) => {
        g.beginPath();
        for (let n = 0; n < 6; n++) {
            const a = (Math.PI / 3) * n - Math.PI / 2;
            const px = c + Math.cos(a) * radius;
            const py = c + Math.sin(a) * radius;
            if (n === 0)
                g.moveTo(px, py);
            else
                g.lineTo(px, py);
        }
        g.closePath();
    };
    g.fillStyle(0x0b1017, 0.9);
    hex(r + 2);
    g.fillPath();
    g.fillStyle(0xffffff, 1);
    hex(r);
    g.fillPath();
    g.fillStyle(def.colour, 1);
    hex(r - 4);
    g.fillPath();
    g.fillStyle(0xffffff, 1);
    if (def.id === 'speed') {
        // Forward chevron.
        g.beginPath();
        g.moveTo(c - 7, c - 9).lineTo(c + 8, c).lineTo(c - 7, c + 9).lineTo(c - 3, c).closePath();
        g.fillPath();
    }
    else if (def.id === 'firerate') {
        // Three stacked bars, reading as rate.
        g.fillRect(c - 9, c - 7, 18, 3);
        g.fillRect(c - 9, c - 1.5, 18, 3);
        g.fillRect(c - 9, c + 4, 18, 3);
    }
    else {
        // Impact burst.
        for (let n = 0; n < 8; n++) {
            const a = (Math.PI / 4) * n;
            g.fillRect(c + Math.cos(a) * 5 - 1.5, c + Math.sin(a) * 5 - 1.5, 3, 3);
        }
        g.fillCircle(c, c, 3.5);
    }
    g.generateTexture(TEX.powerUp(def.id), size, size);
    g.destroy();
}
//# sourceMappingURL=textures.js.map