import type { AudioBus } from './AudioBus.js';

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
  constructor(private bus: AudioBus) {}

  /**
   * A pitched blip. The workhorse: most effects here are one or two of these.
   *
   * @param freq    starting frequency
   * @param endFreq frequency to glide to, for sweeps
   */
  private tone(opts: {
    freq: number;
    endFreq?: number;
    duration: number;
    type?: OscillatorType;
    gain?: number;
    delay?: number;
    detune?: number;
  }): void {
    const out = this.bus.destination('sfx');
    const ctx = this.bus.context;
    if (!out || !ctx) return;

    try {
      const start = ctx.currentTime + (opts.delay ?? 0);
      const osc = ctx.createOscillator();
      const env = ctx.createGain();

      osc.type = opts.type ?? 'square';
      osc.frequency.setValueAtTime(opts.freq, start);
      if (opts.endFreq !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.endFreq), start + opts.duration);
      }
      if (opts.detune) osc.detune.setValueAtTime(opts.detune, start);

      // Fast attack, exponential decay. A linear fade to zero sounds synthetic;
      // an exponential one sounds like something physically stopping.
      const peak = opts.gain ?? 0.25;
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(peak, start + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, start + opts.duration);

      osc.connect(env).connect(out);
      osc.start(start);
      osc.stop(start + opts.duration + 0.02);
    } catch {
      /* a dropped effect is not worth a crash */
    }
  }

  /** Filtered noise burst — impacts, bursts and anything percussive. */
  private noise(opts: { duration: number; freq: number; gain?: number; type?: BiquadFilterType }): void {
    const out = this.bus.destination('sfx');
    const ctx = this.bus.context;
    if (!out || !ctx) return;

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
    } catch {
      /* as above */
    }
  }

  /* ------------------------------------------------------------- weapons */

  /**
   * Weapon report, pitched per class so the four sound distinct in a squad.
   * Throttled hard: auto-fire at the Overclocker's rate would otherwise be ten
   * of these a second, which stops reading as individual shots.
   */
  shoot(cls: string): void {
    if (!this.bus.throttle('shoot', 0.055)) return;

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
  hit(): void {
    if (!this.bus.throttle('hit', 0.04)) return;
    this.noise({ duration: 0.05, freq: 2600, gain: 0.09 });
  }

  /** Enemy destroyed. Bigger enemies get a lower, longer collapse. */
  kill(big: boolean): void {
    if (!this.bus.throttle('kill', 0.045)) return;
    this.noise({ duration: big ? 0.34 : 0.16, freq: big ? 420 : 1100, gain: big ? 0.3 : 0.18, type: 'lowpass' });
    this.tone({
      freq: big ? 260 : 520,
      endFreq: big ? 48 : 110,
      duration: big ? 0.36 : 0.18,
      type: 'sawtooth',
      gain: big ? 0.2 : 0.12,
    });
  }

  /* -------------------------------------------------------------- player */

  hurt(): void {
    if (!this.bus.throttle('hurt', 0.16)) return;
    this.tone({ freq: 320, endFreq: 90, duration: 0.26, type: 'sawtooth', gain: 0.3 });
    this.noise({ duration: 0.14, freq: 700, gain: 0.16, type: 'lowpass' });
  }

  died(): void {
    this.tone({ freq: 420, endFreq: 50, duration: 0.9, type: 'sawtooth', gain: 0.3 });
    this.tone({ freq: 210, endFreq: 40, duration: 1.1, type: 'square', gain: 0.16, delay: 0.05 });
  }

  ability(): void {
    // Rising pair: the one sound in the game that goes *up*, so an ability
    // firing is unmistakable even under a wave.
    this.tone({ freq: 240, endFreq: 900, duration: 0.3, type: 'sawtooth', gain: 0.22 });
    this.tone({ freq: 360, endFreq: 1350, duration: 0.3, type: 'square', gain: 0.1, delay: 0.03 });
  }

  /* ----------------------------------------------------------- pickups */

  /** Chip banked. Tiny and bright; pitch climbs with the streak. */
  chip(progress: number): void {
    if (!this.bus.throttle('chip', 0.035)) return;
    const step = Math.round(progress * 7);
    this.tone({ freq: 880 * Math.pow(2, step / 12), duration: 0.07, type: 'triangle', gain: 0.12 });
  }

  /** Power-up collected: a bright major arpeggio, the game's reward sound. */
  powerUp(): void {
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
  drop(): void {
    this.tone({ freq: 700, endFreq: 1100, duration: 0.18, type: 'triangle', gain: 0.13 });
  }

  /* -------------------------------------------------------------- room */

  wave(): void {
    this.tone({ freq: 160, duration: 0.5, type: 'sawtooth', gain: 0.16 });
    this.tone({ freq: 240, duration: 0.5, type: 'square', gain: 0.09, delay: 0.12 });
  }

  /** Menu and HUD interaction. */
  click(): void {
    if (!this.bus.throttle('click', 0.03)) return;
    this.tone({ freq: 1320, endFreq: 1760, duration: 0.05, type: 'square', gain: 0.08 });
  }

  toggle(on: boolean): void {
    this.tone({ freq: on ? 700 : 480, endFreq: on ? 1050 : 320, duration: 0.08, type: 'square', gain: 0.1 });
  }
}
