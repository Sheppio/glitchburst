/**
 * GLITCHBURST — global configuration.
 *
 * NOTE ON BROKERS: the game is served from GitHub Pages over HTTPS, so the
 * browser will refuse any plaintext `ws://` connection (mixed content). Every
 * broker endpoint below MUST be `wss://`.
 */
/** Public, unauthenticated brokers. Anyone can subscribe — do not put secrets on these topics. */
export const BROKERS = [
    { id: 'hivemq', label: 'HiveMQ (public)', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { id: 'emqx', label: 'EMQX (public)', url: 'wss://broker.emqx.io:8084/mqtt' },
    { id: 'mosquitto', label: 'Eclipse Mosquitto (public)', url: 'wss://test.mosquitto.org:8081/mqtt' },
];
export const NET = {
    /** Root of the topic tree. */
    topicRoot: 'tds',
    /** Host broadcasts the whole horde this many times per second (requirement 3). */
    hordeHz: 20,
    /** Each client broadcasts its own player state this often. */
    playerHz: 15,
    /** Host proves it is alive this often. */
    heartbeatHz: 2,
    /** No heartbeat for this long => the host is presumed dead and an election runs. */
    hostTimeoutMs: 2500,
    /** Presence ping interval; peers silent for 3x this are dropped from the roster. */
    presenceMs: 1000,
    presenceTimeoutMs: 5000,
    /** Enemy damage events are coalesced into one message per this many ms to spare the broker. */
    damageFlushMs: 60,
    keepaliveSec: 30,
    connectTimeoutMs: 8000,
    reconnectMs: 2000,
};
export const WORLD = {
    width: 2400,
    height: 1600,
    gridSize: 80,
};
export const HORDE = {
    /** Hard cap on simultaneous live enemies (requirement 3). */
    maxEnemies: 100,
    /** A room holds a squad of one to four. The fifth arrival is turned away. */
    maxPlayers: 4,
    /**
     * Wave pacing.
     *
     * A fixed interval cannot work here. Wave size grows linearly and enemy
     * health grows with it, so the damage a wave represents grows roughly
     * quadratically — against a constant timer that means the dps required to
     * keep up outruns any possible player by about wave five, and the field
     * saturates at the enemy cap shortly after. No amount of skill closes a
     * quadratic gap.
     *
     * So the timer scales with the size of the wave it is pacing, and clearing
     * the field early pulls the next wave forward. The result is a game that
     * responds to how well you are actually doing: play well and waves come
     * faster (and so do chips), struggle and you get the full window to recover.
     */
    waveBaseIntervalSec: 10,
    /** Extra seconds granted per enemy in the wave. */
    wavePerEnemySec: 0.55,
    /** Floor, so a strong player cannot be buried by back-to-back waves. */
    waveMinIntervalSec: 5,
    /**
     * Clear the field below this fraction of the wave that spawned it and the
     * next one arrives early. Not zero: hunting the last stragglers across the
     * arena is dead time, not difficulty.
     */
    waveClearFraction: 0.22,
    /** Grace period before the first wave of a fresh room. */
    firstWaveDelaySec: 4,
    baseWaveSize: 8,
    waveGrowth: 3,
    /** Enemies spawn at least this far from any player. */
    minSpawnDistance: 520,
};
/**
 * Difficulty scaling for a 1-4 player squad.
 *
 * Two independent dials, because they solve different problems. Squad *size*
 * multiplies how many enemies spawn — four players clear a wave roughly four
 * times faster, so a solo-tuned wave evaporates and nobody feels threatened.
 * Squad *health* scaling is much gentler: raising enemy HP with headcount stops
 * a full squad from deleting Trojan Tanks instantly, but pushed too far it
 * punishes the group for grouping, which is the opposite of what a co-op game
 * should reward.
 *
 * Both are applied per wave, from the live roster — so a player leaving
 * mid-session eases the next wave rather than leaving four players' worth of
 * malware chasing one survivor.
 */
export const DIFFICULTY = {
    /** Extra wave size per additional player: 1.0x solo → 2.35x at four. */
    sizePerPlayer: 0.45,
    /** Extra enemy health per additional player: 1.0x solo → 1.36x at four. */
    healthPerPlayer: 0.12,
    /** Waves also grow harder over time, independent of headcount. */
    healthPerWave: 0.09,
    /** Solo play gets a small handicap so one player can hold a lane. */
    soloHealthDiscount: 0.9,
};
export const LIVES = {
    /**
     * Reboots available to a solo player. The fourth death ends the run.
     *
     * Solo and squad play need different rules because they fail differently. On
     * your own, unlimited reboots mean the run has no stakes and never resolves —
     * you simply grind until bored. In a squad the pressure comes from your
     * friends: someone has to stay standing, and being revived by the team
     * surviving is a better mechanic than counting tokens, so headcount replaces
     * the limit entirely.
     */
    soloReboots: 3,
    /** First reboot takes this long. */
    rebootBaseSec: 5,
    /**
     * Each subsequent reboot adds this much.
     *
     * Escalation is the actual difficulty curve here: a flat delay means dying is
     * nearly free by the tenth time, while a rising one makes a bad run compound
     * without ever hard-stopping a squad that is still fighting.
     */
    rebootStepSec: 3,
    /** Ceiling, so a long squad run cannot leave someone watching for a minute. */
    rebootMaxSec: 20,
};
export const PLAYER = {
    /**
     * Maximum weapon/body turn rate, in revolutions per minute.
     *
     * The player no longer snaps to the aim angle; the chassis rotates toward it
     * at this rate and shots leave along the barrel's *actual* facing. That gives
     * aiming weight, and it means auto-aim visibly swings onto a target instead
     * of teleporting the crosshair — which is the whole reason to have it.
     *
     * Scale, so this is tunable with intent: 240 RPM is 4 turns a second, or a
     * 180-degree spin in ~0.13s — fast enough to feel responsive, slow enough to
     * see. 60 RPM (one turn a second) already feels sluggish for a twin-stick.
     * Note that 2 RPM would be one revolution every 30 seconds, which is not a
     * playable value; the units here are per minute, not per second.
     */
    turnRateRpm: 240,
};
/** Derived once: RPM -> radians per second. */
export const TURN_RATE_RAD_PER_SEC = (PLAYER.turnRateRpm * Math.PI * 2) / 60;
export const AI = {
    /**
     * How far a decoy reaches, in world pixels per priority step above a player.
     *
     * Priority is applied as a *distance discount* rather than a multiplier. A
     * multiplier is useless exactly when the ability matters: an enemy already
     * standing on a player is 40px away, and no plausible multiplier makes a
     * decoy 700px away look closer than that. Subtracting a flat attraction
     * distance instead means a decoy reliably wins inside its radius and
     * reliably loses outside it, which is both easier to reason about and easier
     * to tune.
     */
    decoyPullPerPriority: 220,
};
export const RENDER = {
    /**
     * Peer-side interpolation strength. This is the fraction of the remaining
     * distance closed in 1/60s; it is re-scaled per frame so the result is
     * framerate independent. See `render/lerp.ts`.
     */
    enemyLerp: 0.22,
    remotePlayerLerp: 0.28,
    /** If a peer sprite is further than this from its target, snap instead of gliding. */
    snapDistance: 420,
};
//# sourceMappingURL=config.js.map