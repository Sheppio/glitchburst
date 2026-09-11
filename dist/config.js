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
    /** Presence ping interval. */
    presenceMs: 1000,
    /**
     * Silence for this long drops a peer from the roster.
     *
     * Fifteen seconds, not five, because this timeout is a *backstop* rather than
     * the way departures are noticed. A player who closes the tab, crashes or
     * loses the network is de-listed immediately by the MQTT will, and one who
     * leaves deliberately publishes `alive: 0` on the way out. What is left for
     * the timeout to catch is a client that is alive but has gone quiet — and
     * five seconds of quiet is something a browser hands out for free: a garbage
     * collection pause, a tab the OS has decided is not visible, or simply four
     * self-driving clients on one laptop all simulating a hundred enemies.
     *
     * Dropping a live player is not a cosmetic error. It shrinks the squad, which
     * changes the reboot rules, and it can make a client believe it is the last
     * one standing and start running its own horde — at which point the room has
     * quietly become two rooms on different waves.
     */
    presenceTimeoutMs: 15000,
    /**
     * A gap this long between roster ticks means *we* stopped running, and every
     * timeout is measured from a clock that was not moving.
     *
     * Browsers freeze the update loop of a tab that is not visible, and throttle
     * its timers to a crawl. Someone testing multiplayer has four clients open
     * and at most one of them in front; on any machine, a tab that has been
     * behind another for a while comes back to a roster full of players it last
     * heard from a minute ago. Dropping them all on the first tick after waking
     * is the single worst thing this client can do, because a shrunken roster
     * changes the reboot rules and can promote it to host of a room that already
     * has one.
     *
     * Time we spent asleep is not evidence about anybody else, so it is forgiven:
     * everyone gets a fresh window to prove they are still there.
     */
    stallForgivenessMs: 2000,
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
    /**
     * Fraction of a wave's window its spawns are spread across.
     *
     * A wave arriving as one instantaneous block is jarring: thirty enemies pop
     * into existence at once, the ring around you closes in a single frame, and
     * there is no moment where you are reacting to anything — you are simply
     * surrounded. Streaming them in over part of the window turns the same wave
     * into pressure that builds, which you can read and fall back from.
     *
     * A fraction rather than a fixed rate, so the stream stays proportional: a
     * wave of eighty gets a longer window and therefore a longer trickle, not
     * eighty enemies crammed into the same six seconds.
     */
    waveSpawnFraction: 0.4,
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
    /**
     * Waves also grow harder over time, independent of headcount.
     *
     * Small, because enemy *levels* now carry most of that growth (see
     * `sim/enemyLevels.ts`) and they do it visibly. This is the residual creep
     * between level-ups, so the four waves inside one level are not identical.
     */
    healthPerWave: 0.04,
    /** Solo play gets a small handicap so one player can hold a lane. */
    soloHealthDiscount: 0.9,
};
/** Camera zoom limits. Mirrored by the settings slider's own range. */
export const ZOOM = {
    min: 0.6,
    max: 1.4,
    /**
     * One notch of the wheel, and the granularity the value is snapped to.
     *
     * Matched to the settings slider's own step, so the two controls land on the
     * same values — a wheel that left the zoom on 0.8734 would be a number the
     * slider could never return to, and the readout would disagree with itself.
     */
    step: 0.05,
    /**
     * Scroll distance, in pixels, that counts as one notch.
     *
     * 100 is what a mouse wheel click reports in Chrome, so a mouse gets one step
     * per click. A trackpad sends many small deltas instead, which accumulate —
     * treating each of those as a notch would cross the whole zoom range in a
     * flick.
     */
    wheelNotch: 100,
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
    /**
     * Solo reboots are a flat wait, not an escalating one.
     *
     * On your own the pool of three *is* the escalating cost — every death is
     * measurably closer to the end of the run. Stacking a rising timer on top of
     * that charges twice for the same mistake, and the second charge is the worst
     * kind: sitting watching. Short enough to get straight back in.
     */
    soloRebootSec: 3,
    /** First reboot takes this long. Squad play only; solo uses the flat wait. */
    rebootBaseSec: 5,
    /**
     * Each subsequent reboot adds this much.
     *
     * Escalation is the difficulty curve for a *squad*, where reboots are not
     * counted at all: a flat delay would make dying nearly free by the tenth
     * time, while a rising one makes a bad run compound without ever
     * hard-stopping a team that is still fighting.
     */
    rebootStepSec: 3,
    /** Ceiling, so a long squad run cannot leave someone watching for a minute. */
    rebootMaxSec: 20,
    /**
     * A reboot places you at least this far from the nearest hostile.
     *
     * Coming back inside the swarm that just killed you spends the reboot on
     * nothing — the same reasoning that made reboots restore full health. At this
     * range even the fastest kind needs over a second to reach you, which is
     * enough to pick a direction.
     */
    rebootSafeRadius: 300,
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
    /**
     * Passive health regeneration, per second, once out of combat.
     *
     * Deliberately slow, and gated behind a quiet period rather than ticking
     * during a fight. Regen that runs while you are being hit turns every
     * engagement into a damage race the player usually wins; regen that only
     * starts once you have disengaged rewards backing off, which is the decision
     * worth encouraging in a horde game.
     */
    regenPerSec: 1.1,
    /** Seconds without taking damage before regeneration begins. */
    regenDelaySec: 4,
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
/**
 * The low-health warning at the screen edge.
 *
 * Health is a number in the corner of a screen whose middle is where you are
 * actually looking, which is a poor place to put the one fact that decides
 * whether you should be backing off. On the way to dying the frame itself says
 * so, and the alarm underneath it pulses faster as it gets worse.
 */
export const DANGER = {
    /** Health fraction below which the warning starts. */
    threshold: 0.3,
    /** Steady component of the wash at the very edge of death. */
    baseAlpha: 0.1,
    /** How much more the pulse adds on top. */
    pulseAlpha: 0.15,
    /**
     * Strength at the threshold, as a fraction of full.
     *
     * Without a floor the wash scales linearly from nothing, which means the
     * first third of the danger band is invisible on a deliberately bright arena
     * — measured at a fifth of full health it was reaching alpha 0.14 against a
     * near-white background, which is not a warning. It arrives already legible
     * and then gets worse.
     */
    onset: 0.42,
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
    /**
     * How far the off-screen markers sit in from the edge of the screen.
     *
     * Half the arrow plus a little: on the edge itself half of it is clipped by
     * the viewport, which reads as a rendering fault rather than as a pointer.
     */
    markerMargin: 24,
    /** Power-up markers: present, not attention-grabbing. */
    markerPowerUpColour: 0x5a6473,
    markerPowerUpAlpha: 0.4,
};
//# sourceMappingURL=config.js.map