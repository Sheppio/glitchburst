/**
 * Enemy levels.
 *
 * Waves used to get harder through a health multiplier the player could not
 * see: the same Glitch Bug that died in one shot at wave 2 took four at wave 20
 * and looked identical. That reads as your weapon getting worse, not as the
 * malware getting tougher.
 *
 * A level is the same scaling made legible. Every enemy carries one, 1 to 7,
 * drawn as a coloured pip at the centre of its body — violet at level 1 through
 * to red at level 7, so you can see what is walking at you before you commit to
 * shooting it.
 *
 * Engine-agnostic: no Phaser, no DOM. The renderer consumes `LEVEL_COLOURS`,
 * the host consumes the rest, and the wire packs the level in beside the kind.
 */
export const MAX_LEVEL = 7;
/**
 * Violet to red, low to high.
 *
 * Deliberately a rainbow rather than a two-colour ramp: seven steps of one hue
 * are indistinguishable at pip size and in peripheral vision, which is where
 * this is actually read. Pips are drawn on a white disc, so each of these only
 * ever has to contrast with white, not with six different body colours.
 *
 * Cyan stands in for the textbook rainbow's indigo. Indigo and blue are the one
 * genuinely redundant pair in ROYGBIV — side by side at pip size they read as
 * the same colour, which costs a whole level of information.
 */
export const LEVEL_COLOURS = [
    0x7c3aed, // 1 violet
    0x2563eb, // 2 blue
    0x0891b2, // 3 cyan
    0x16a34a, // 4 green
    0xeab308, // 5 yellow
    0xf97316, // 6 orange
    0xdc2626, // 7 red
];
/** CSS equivalents, for anything rendered in the DOM overlay. */
export const LEVEL_CSS = LEVEL_COLOURS.map((c) => `#${c.toString(16).padStart(6, '0')}`);
export const LEVELS = {
    /**
     * Health multiplier per level above 1.
     *
     * Geometric, because the player's damage is now endless and therefore grows
     * linearly: a linear health curve would never catch up and the run would have
     * no end.
     *
     * 1.35 puts level 7 at 5.4x a level 1 of the same kind. Picked by modelling a
     * perfect solo Overclocker against the wave timer: it keeps waves 1-8
     * comfortable, has the player just about holding the line through 9-12, and
     * first puts them behind at wave 13 — by which point power-ups have started
     * landing. Each subsequent level-up spikes the difficulty and the damage
     * stacks grind it back down, which is the sawtooth the run is built on.
     */
    healthPerLevel: 1.35,
    /** Waves between level-ups. Level 7 arrives around wave 25. */
    wavesPerLevel: 4,
    /**
     * Chance an individual spawn rolls one level above or below the wave's base.
     *
     * A wave of seven identical pips is a uniform wall; a spread means most of
     * what you face is the expected threat with the occasional outlier worth
     * reacting to. Applied per enemy, so the mix is visible within one wave.
     */
    spreadChance: 0.22,
};
export function clampLevel(level) {
    if (!Number.isFinite(level))
        return 1;
    const n = Math.round(level);
    return n < 1 ? 1 : n > MAX_LEVEL ? MAX_LEVEL : n;
}
/** Health multiplier for a level. Level 1 is always exactly 1. */
export function levelHealthScale(level) {
    return LEVELS.healthPerLevel ** (clampLevel(level) - 1);
}
/**
 * Chips and score for killing one.
 *
 * Rewards have to climb with health or the economy inverts: a level 7 brute
 * with eleven times the health paying the same two chips as a level 1 would
 * make progression slow down exactly as the game speeds up. Deliberately
 * sub-linear — the reward rises, but killing tough things is still less
 * chips-per-second than mowing fodder, which keeps both worth shooting.
 */
export function levelRewardScale(level) {
    return 1 + (clampLevel(level) - 1) * 0.5;
}
/**
 * Points for killing one, given its base value and level.
 *
 * Shared, because two machines compute it independently: the host resolves the
 * kill, but every client scores its *own* kills off the broadcast death event.
 * Two copies of this arithmetic would drift and the squad would disagree about
 * the scoreboard.
 */
export function killScore(baseScore, level) {
    return Math.round(baseScore * levelRewardScale(level));
}
/** The level a wave spawns by default, before spread. */
export function baseLevelForWave(wave) {
    return clampLevel(1 + Math.floor((wave - 1) / LEVELS.wavesPerLevel));
}
/**
 * Roll the level for one spawn.
 *
 * `random` is injectable so the pacing tests are deterministic rather than
 * flaky — this is the sort of thing that would otherwise fail one run in ten
 * and get dismissed as noise.
 */
export function rollLevel(wave, random = Math.random) {
    const base = baseLevelForWave(wave);
    const roll = random();
    if (roll > LEVELS.spreadChance)
        return base;
    // Half the spread goes up, half down — so an early wave occasionally shows
    // you what is coming, and a late one occasionally gives you a breather.
    return clampLevel(roll < LEVELS.spreadChance / 2 ? base - 1 : base + 1);
}
//# sourceMappingURL=enemyLevels.js.map