/**
 * Synthesised one-shots.
 *
 * Each effect is a few oscillators and an envelope, built and thrown away. That
 * is the idiomatic Web Audio pattern: nodes are cheap, and a node that has
 * finished is garbage rather than something to pool.
 *
 * The palette is deliberately narrow — short blips, filtered noise and falling
 * sweeps — so the game sounds like one machine rather than a sample pack.
 */
export class Sfx {
    bus;
    constructor(bus) {
        this.bus = bus;
    }
    /**
     * A pitched blip. The workhorse: most effects here are one or two of these.
     *
     * @param freq    starting frequency
     * @param endFreq frequency to glide to, for sweeps
     */
    tone(opts) {
        const out = this.bus.destination('sfx');
        const ctx = this.bus.context;
        if (!out || !ctx)
            return;
        try {
            const start = ctx.currentTime + (opts.delay ?? 0);
            const osc = ctx.createOscillator();
            const env = ctx.createGain();
            osc.type = opts.type ?? 'square';
            osc.frequency.setValueAtTime(opts.freq, start);
            if (opts.endFreq !== undefined) {
                osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.endFreq), start + opts.duration);
            }
            if (opts.detune)
                osc.detune.setValueAtTime(opts.detune, start);
            // Fast attack, exponential decay. A linear fade to zero sounds synthetic;
            // an exponential one sounds like something physically stopping.
            const peak = opts.gain ?? 0.25;
            env.gain.setValueAtTime(0.0001, start);
            env.gain.exponentialRampToValueAtTime(peak, start + 0.006);
            env.gain.exponentialRampToValueAtTime(0.0001, start + opts.duration);
            osc.connect(env).connect(out);
            osc.start(start);
            osc.stop(start + opts.duration + 0.02);
        }
        catch {
            /* a dropped effect is not worth a crash */
        }
    }
    /** Filtered noise burst — impacts, bursts and anything percussive. */
    noise(opts) {
        const out = this.bus.destination('sfx');
        const ctx = this.bus.context;
        if (!out || !ctx)
            return;
        try {
            const start = ctx.currentTime;
            const frames = Math.max(1, Math.floor(ctx.sampleRate * opts.duration));
            const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < frames; i++) {
                // Fade the noise inside the buffer so the tail never clicks.
                data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
            }
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            const filter = ctx.createBiquadFilter();
            filter.type = opts.type ?? 'bandpass';
            filter.frequency.setValueAtTime(opts.freq, start);
            filter.Q.value = 1.2;
            const env = ctx.createGain();
            env.gain.setValueAtTime(opts.gain ?? 0.2, start);
            env.gain.exponentialRampToValueAtTime(0.0001, start + opts.duration);
            source.connect(filter).connect(env).connect(out);
            source.start(start);
        }
        catch {
            /* as above */
        }
    }
    /* ------------------------------------------------------------- weapons */
    /**
     * Weapon report, pitched per class so the four sound distinct in a squad.
     * Throttled hard: auto-fire at the Overclocker's rate would otherwise be ten
     * of these a second, which stops reading as individual shots.
     */
    shoot(cls) {
        if (!this.bus.throttle('shoot', 0.055))
            return;
        switch (cls) {
            case 'fireman': // Shotgun: broadband thump, no clear pitch.
                this.noise({ duration: 0.18, freq: 900, gain: 0.3, type: 'lowpass' });
                this.tone({ freq: 190, endFreq: 60, duration: 0.16, type: 'sawtooth', gain: 0.2 });
                break;
            case 'overclocker': // Laser: tight, high, falling.
                this.tone({ freq: 1150, endFreq: 520, duration: 0.09, type: 'square', gain: 0.13 });
                break;
            case 'glitcher': // SMG: dry and clicky.
                this.tone({ freq: 820, endFreq: 400, duration: 0.06, type: 'square', gain: 0.11 });
                break;
            default: // Lance: cleaner, longer.
                this.tone({ freq: 660, endFreq: 300, duration: 0.12, type: 'triangle', gain: 0.16 });
        }
    }
    /** Bullet connects. Very short, very quiet — this fires constantly. */
    hit() {
        if (!this.bus.throttle('hit', 0.04))
            return;
        this.noise({ duration: 0.05, freq: 2600, gain: 0.09 });
    }
    /** Enemy destroyed. Bigger enemies get a lower, longer collapse. */
    kill(big) {
        if (!this.bus.throttle('kill', 0.045))
            return;
        this.noise({ duration: big ? 0.34 : 0.16, freq: big ? 420 : 1100, gain: big ? 0.3 : 0.18, type: 'lowpass' });
        this.tone({
            freq: big ? 260 : 520,
            endFreq: big ? 48 : 110,
            duration: big ? 0.36 : 0.18,
            type: 'sawtooth',
            gain: big ? 0.2 : 0.12,
        });
    }
    /**
     * A drone firing at you.
     *
     * Incoming fire was the one thing in the game that could hurt you and make no
     * sound at all — a drone shooting from off screen was a health bar dropping
     * for no announced reason, which reads as the game cheating rather than as a
     * shot you missed. Deliberately unlike any weapon in the player's hands: a
     * short rising chirp where every player weapon falls, so it never registers
     * as your own gun.
     */
    enemyShot() {
        if (!this.bus.throttle('enemyShot', 0.07))
            return;
        this.tone({ freq: 300, endFreq: 640, duration: 0.08, type: 'square', gain: 0.07 });
    }
    /**
     * Something that has been chasing you long enough to speed up.
     *
     * One warning for a wave rather than one per enemy: they age together, so the
     * throttle is long enough that a field crossing the threshold at once is a
     * single growl. Low and slow, against a palette that is otherwise short and
     * bright.
     */
    enrage() {
        if (!this.bus.throttle('enrage', 4))
            return;
        this.tone({ freq: 150, endFreq: 92, duration: 0.7, type: 'sawtooth', gain: 0.16 });
        this.tone({ freq: 74, endFreq: 46, duration: 0.85, type: 'square', gain: 0.1, delay: 0.06 });
    }
    /* -------------------------------------------------------------- player */
    hurt() {
        if (!this.bus.throttle('hurt', 0.16))
            return;
        this.tone({ freq: 320, endFreq: 90, duration: 0.26, type: 'sawtooth', gain: 0.3 });
        this.noise({ duration: 0.14, freq: 700, gain: 0.16, type: 'lowpass' });
    }
    died() {
        this.tone({ freq: 420, endFreq: 50, duration: 0.9, type: 'sawtooth', gain: 0.3 });
        this.tone({ freq: 210, endFreq: 40, duration: 1.1, type: 'square', gain: 0.16, delay: 0.05 });
    }
    /**
     * Low health, pulsed while it lasts.
     *
     * Called every frame and rate-limited from the inside, because the interval
     * *is* the information: the pulse doubles in rate between a quarter health
     * and nearly dead, so how much trouble you are in is audible without reading
     * a number. Above the threshold it is silent and costs nothing.
     *
     * @param ratio current health as a fraction of maximum.
     */
    alarm(ratio) {
        if (!Number.isFinite(ratio) || ratio > 0.3 || ratio <= 0)
            return;
        // 0.92s of quiet at the threshold, 0.42s at the edge of death.
        const urgency = 1 - ratio / 0.3;
        if (!this.bus.throttle('alarm', 0.92 - urgency * 0.5))
            return;
        this.tone({ freq: 210, endFreq: 150, duration: 0.1, type: 'triangle', gain: 0.1 + urgency * 0.07 });
    }
    /** Back on your feet. The short answer to `died`, and the only other riser. */
    reboot() {
        this.tone({ freq: 180, endFreq: 720, duration: 0.34, type: 'triangle', gain: 0.2 });
        this.tone({ freq: 270, endFreq: 1080, duration: 0.3, type: 'square', gain: 0.08, delay: 0.04 });
    }
    /**
     * The run is over.
     *
     * Longer and lower than `died`, which it follows immediately — a death you
     * come back from and a death you do not have to be distinguishable in the
     * half second before the card appears.
     */
    gameOver() {
        this.tone({ freq: 300, endFreq: 34, duration: 1.6, type: 'sawtooth', gain: 0.26 });
        this.tone({ freq: 150, endFreq: 28, duration: 1.9, type: 'square', gain: 0.14, delay: 0.12 });
        this.noise({ duration: 1.2, freq: 220, gain: 0.12, type: 'lowpass' });
    }
    ability() {
        // Rising pair: the one sound in the game that goes *up*, so an ability
        // firing is unmistakable even under a wave.
        this.tone({ freq: 240, endFreq: 900, duration: 0.3, type: 'sawtooth', gain: 0.22 });
        this.tone({ freq: 360, endFreq: 1350, duration: 0.3, type: 'square', gain: 0.1, delay: 0.03 });
    }
    /* ----------------------------------------------------------- pickups */
    /** Chip banked. Tiny and bright; pitch climbs with the streak. */
    chip(progress) {
        if (!this.bus.throttle('chip', 0.035))
            return;
        const step = Math.round(progress * 7);
        this.tone({ freq: 880 * Math.pow(2, step / 12), duration: 0.07, type: 'triangle', gain: 0.12 });
    }
    /** Power-up collected: a bright major arpeggio, the game's reward sound. */
    powerUp() {
        const root = 523.25; // C5
        [0, 4, 7, 12].forEach((semitone, i) => {
            this.tone({
                freq: root * Math.pow(2, semitone / 12),
                duration: 0.34,
                type: 'triangle',
                gain: 0.16,
                delay: i * 0.06,
            });
        });
    }
    /** A power-up hitting the floor — quieter cousin of the collection sound. */
    drop() {
        this.tone({ freq: 700, endFreq: 1100, duration: 0.18, type: 'triangle', gain: 0.13 });
    }
    /* -------------------------------------------------------------- room */
    wave() {
        this.tone({ freq: 160, duration: 0.5, type: 'sawtooth', gain: 0.16 });
        this.tone({ freq: 240, duration: 0.5, type: 'square', gain: 0.09, delay: 0.12 });
    }
    /** Menu and HUD interaction. */
    click() {
        if (!this.bus.throttle('click', 0.03))
            return;
        this.tone({ freq: 1320, endFreq: 1760, duration: 0.05, type: 'square', gain: 0.08 });
    }
    toggle(on) {
        this.tone({ freq: on ? 700 : 480, endFreq: on ? 1050 : 320, duration: 0.08, type: 'square', gain: 0.1 });
    }
}
//# sourceMappingURL=Sfx.js.map