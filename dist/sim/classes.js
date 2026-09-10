/**
 * The four playable security programs.
 *
 * Everything that differentiates a class is data, not code: the weapon is
 * driven entirely by `WeaponDef`, and abilities dispatch on `AbilityDef.kind`
 * in one switch inside `GameScene`. Adding a fifth class means adding an entry
 * here plus one case in that switch.
 */
export const CLASSES = {
    overclocker: {
        id: 'overclocker',
        name: 'Overclocker',
        role: 'DPS',
        blurb: 'Piercing beam weapon. Burns through a whole column of malware at once.',
        colour: 0x00e5ff,
        cssColour: '#00e5ff',
        maxHp: 100,
        speed: 252,
        radius: 16,
        weapon: {
            name: 'Overclocked Laser',
            fireIntervalSec: 0.095,
            damage: 11,
            pellets: 1,
            spread: 0.02,
            speed: 1500,
            lifeSec: 0.55,
            pierce: 3,
            radius: 5,
            knockback: 20,
        },
        ability: {
            kind: 'overclock',
            name: 'Thermal Runaway',
            blurb: '+90% fire rate and +35% speed for 5s.',
            cooldownSec: 14,
            durationSec: 5,
            radius: 0,
            magnitude: 1.9,
        },
    },
    fireman: {
        id: 'fireman',
        name: 'Fireman',
        role: 'Tank',
        blurb: 'Wide, short-range EMP burst. Soaks damage and clears space.',
        colour: 0xffb300,
        cssColour: '#ffb300',
        maxHp: 190,
        speed: 196,
        radius: 19,
        weapon: {
            name: 'EMP Shotgun',
            fireIntervalSec: 0.56,
            damage: 12,
            pellets: 7,
            spread: 0.58,
            speed: 820,
            lifeSec: 0.3,
            pierce: 1,
            radius: 6,
            knockback: 120,
        },
        ability: {
            kind: 'shockwave',
            name: 'Purge Pulse',
            blurb: 'Knocks back and stuns every nearby process.',
            cooldownSec: 10,
            durationSec: 0.45,
            radius: 265,
            magnitude: 1.6,
        },
    },
    glitcher: {
        id: 'glitcher',
        name: 'Glitcher',
        role: 'Utility',
        blurb: 'Fast, fragile. Rewrites what the horde thinks it is chasing.',
        colour: 0xff2d95,
        cssColour: '#ff2d95',
        maxHp: 90,
        speed: 288,
        radius: 15,
        weapon: {
            name: 'Fork Bomb SMG',
            fireIntervalSec: 0.13,
            damage: 9,
            pellets: 1,
            spread: 0.09,
            speed: 1020,
            lifeSec: 0.75,
            pierce: 1,
            radius: 5,
            knockback: 30,
        },
        ability: {
            kind: 'decoy',
            name: 'Decoy Hologram',
            blurb: 'Drops a spoofed process the horde targets for 5s.',
            cooldownSec: 12,
            durationSec: 5,
            radius: 0,
            magnitude: 1,
        },
    },
    encoder: {
        id: 'encoder',
        name: 'Encoder',
        role: 'Support',
        blurb: 'Deploys a checksum field that repairs allies standing inside it.',
        colour: 0x7cff00,
        cssColour: '#7cff00',
        maxHp: 120,
        speed: 228,
        radius: 16,
        weapon: {
            name: 'Parity Lance',
            fireIntervalSec: 0.22,
            damage: 13,
            pellets: 1,
            spread: 0.04,
            speed: 940,
            lifeSec: 0.7,
            pierce: 2,
            radius: 5,
            knockback: 40,
        },
        ability: {
            kind: 'healfield',
            name: 'Checksum Field',
            blurb: 'Heals allies inside the node for 8s.',
            cooldownSec: 16,
            durationSec: 8,
            radius: 150,
            magnitude: 13,
        },
    },
};
/**
 * Fraction of a spread weapon's pellets assumed to connect with a single
 * target. A shotgun's paper dps counts all seven, which only happens at
 * point-blank range against something large — quoting it would tell the player
 * the Fireman out-damages every other class, which is not true in play.
 */
export const PELLET_CONNECT_SHARE = 0.6;
/**
 * Sustained single-target damage per second.
 *
 * One definition, used both to rank auto-aim targets and to label the class
 * cards, so the number a player is shown is the same number the game reasons
 * with.
 */
export function classDps(def) {
    const w = def.weapon;
    const connecting = w.pellets > 1 ? w.pellets * PELLET_CONNECT_SHARE : 1;
    return (w.damage * connecting) / w.fireIntervalSec;
}
/** How far a round travels before expiring. */
export function weaponRange(def) {
    return def.weapon.speed * def.weapon.lifeSec;
}
export const CLASS_ORDER = ['overclocker', 'fireman', 'glitcher', 'encoder'];
export function isClassId(value) {
    return value in CLASSES;
}
//# sourceMappingURL=classes.js.map