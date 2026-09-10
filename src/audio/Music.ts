import type { AudioBus } from './AudioBus.js';

/**
 * Procedural background music.
 *
 * Same reasoning as the textures and the effects: no asset to fetch, nothing to
 * license, a few hundred bytes of code instead of a few hundred kilobytes of
 * audio. A driving minor-key arpeggio suits a game about fighting your way
 * through someone else's mainframe.
 *
 * Scheduling uses the standard Web Audio lookahead: a timer wakes every 25ms
 * and schedules any note falling inside the next 150ms, placing it on the audio
 * clock rather than playing it on the spot. `setInterval` alone is far too
 * jittery for rhythm — it drifts by tens of milliseconds under load, which is
 * audible immediately — but it is perfectly adequate for deciding *what to
 * schedule next*.
 */

/** Am – F – C – G. Four bars, the backbone of more or less every synth track. */
const PROGRESSION = [
  { root: 220.0, third: 261.63, fifth: 329.63 }, // Am
  { root: 174.61, third: 220.0, fifth: 261.63 }, // F
  { root: 196.0, third: 246.94, fifth: 329.63 }, // C (voiced from G)
  { root: 196.0, third: 246.94, fifth: 293.66 }, // G
];

const BPM = 124;
const STEPS_PER_BAR = 8;
const STEP_SEC = 60 / BPM / 2;
const LOOKAHEAD_SEC = 0.15;
const TICK_MS = 25;

export class Music {
  private timer = 0;
  private step = 0;
  private nextNoteAt = 0;
  private running = false;

  constructor(private bus: AudioBus) {}

  get isPlaying(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.step = 0;
    this.nextNoteAt = this.bus.now + 0.1;
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private schedule(): void {
    const ctx = this.bus.context;
    if (!ctx || !this.running) return;

    // Catch up if the tab was throttled and the clock ran on without us.
    if (this.nextNoteAt < ctx.currentTime) this.nextNoteAt = ctx.currentTime + 0.05;

    while (this.nextNoteAt < ctx.currentTime + LOOKAHEAD_SEC) {
      this.playStep(this.step, this.nextNoteAt);
      this.nextNoteAt += STEP_SEC;
      this.step = (this.step + 1) % (STEPS_PER_BAR * PROGRESSION.length);
    }
  }

  private playStep(step: number, at: number): void {
    const chord = PROGRESSION[Math.floor(step / STEPS_PER_BAR) % PROGRESSION.length]!;
    const beat = step % STEPS_PER_BAR;

    // Bass on the downbeat and the off-beat push.
    if (beat === 0 || beat === 5) {
      this.note({ freq: chord.root / 2, duration: 0.34, type: 'sawtooth', gain: 0.22, at, cutoff: 620 });
    }

    // Eighth-note arpeggio, the part you actually hum.
    const arp = [chord.root, chord.third, chord.fifth, chord.third * 2, chord.fifth, chord.third, chord.root * 2, chord.fifth];
    this.note({ freq: arp[beat]!, duration: 0.17, type: 'square', gain: 0.055, at, cutoff: 2400 });

    // Sparse pad, once a bar, to stop it sounding like a ringtone.
    if (beat === 0) {
      this.note({ freq: chord.third, duration: 1.3, type: 'triangle', gain: 0.035, at, cutoff: 1100 });
    }

    // Hats on the off-beats.
    if (beat % 2 === 1) this.hat(at, beat === 3 || beat === 7 ? 0.05 : 0.028);
  }

  private note(opts: {
    freq: number;
    duration: number;
    type: OscillatorType;
    gain: number;
    at: number;
    cutoff: number;
  }): void {
    const ctx = this.bus.context;
    const out = this.bus.destination('music');
    if (!ctx || !out) return;

    try {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = opts.type;
      osc.frequency.setValueAtTime(opts.freq, opts.at);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(opts.cutoff, opts.at);

      env.gain.setValueAtTime(0.0001, opts.at);
      env.gain.exponentialRampToValueAtTime(opts.gain, opts.at + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, opts.at + opts.duration);

      osc.connect(filter).connect(env).connect(out);
      osc.start(opts.at);
      osc.stop(opts.at + opts.duration + 0.02);
    } catch {
      /* a dropped note is not worth a crash */
    }
  }

  private hat(at: number, gain: number): void {
    const ctx = this.bus.context;
    const out = this.bus.destination('music');
    if (!ctx || !out) return;

    try {
      const frames = Math.floor(ctx.sampleRate * 0.05);
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(7000, at);

      const env = ctx.createGain();
      env.gain.setValueAtTime(gain, at);
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);

      source.connect(filter).connect(env).connect(out);
      source.start(at);
    } catch {
      /* as above */
    }
  }
}
