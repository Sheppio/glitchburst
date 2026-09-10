/**
 * Web Audio plumbing: one context, three gain stages, and the unlock dance.
 *
 * Sound is *synthesised* rather than loaded, for the same reason every texture
 * is drawn at boot: the game ships as a handful of static files with no assets
 * to fetch, no CORS surface and no loading screen. It also happens to suit the
 * setting — a mainframe should bleep, not play recorded gunfire.
 *
 * Every entry point is defensive. Audio is a garnish: a browser that refuses to
 * give us a context, or an effect that throws mid-frame, must never take the
 * game down with it.
 */
export type AudioChannel = 'sfx' | 'music';

export class AudioBus {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private gains: Record<AudioChannel, GainNode | null> = { sfx: null, music: null };
  private enabled: Record<AudioChannel, boolean> = { sfx: true, music: true };
  /** Last play time per throttle key, to stop a sound stacking on itself. */
  private lastPlayed = new Map<string, number>();

  get context(): AudioContext | null {
    return this.ctx;
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Seconds on the audio clock. Scheduling wants this, not `performance.now`. */
  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /**
   * Create or resume the context.
   *
   * Browsers refuse to start audio outside a user gesture, so this is called
   * from the first click, tap or keypress rather than at load. Calling it again
   * later is harmless and is how we recover from a context the browser
   * suspended when the tab went to the background.
   */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();

        this.master = this.ctx.createGain();
        this.master.gain.value = 0.85;
        this.master.connect(this.ctx.destination);

        for (const channel of ['sfx', 'music'] as const) {
          const gain = this.ctx.createGain();
          gain.gain.value = this.enabled[channel] ? this.levelFor(channel) : 0;
          gain.connect(this.master);
          this.gains[channel] = gain;
        }
      }

      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      // No audio available. The game is fully playable without it.
      this.ctx = null;
    }
  }

  setEnabled(channel: AudioChannel, on: boolean): void {
    this.enabled[channel] = on;
    const gain = this.gains[channel];
    if (!gain || !this.ctx) return;
    // Ramp rather than jump: a hard gain change on a running oscillator clicks.
    const target = on ? this.levelFor(channel) : 0;
    gain.gain.cancelScheduledValues(this.ctx.currentTime);
    gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  isEnabled(channel: AudioChannel): boolean {
    return this.enabled[channel];
  }

  /** The node effects should connect to. Null when audio is unavailable or off. */
  destination(channel: AudioChannel): GainNode | null {
    if (!this.ready || !this.enabled[channel]) return null;
    return this.gains[channel];
  }

  /**
   * Rate limit for sounds that can fire many times a frame.
   *
   * Auto-fire plus a hundred dying enemies would otherwise stack hundreds of
   * oscillators a second: expensive, and it sums into a wall of noise rather
   * than reading as individual events.
   */
  throttle(key: string, minIntervalSec: number): boolean {
    const now = this.now;
    const last = this.lastPlayed.get(key) ?? -Infinity;
    if (now - last < minIntervalSec) return false;
    this.lastPlayed.set(key, now);
    return true;
  }

  suspend(): void {
    void this.ctx?.suspend().catch(() => undefined);
  }

  private levelFor(channel: AudioChannel): number {
    // Music sits well under the effects; it is a bed, not a feature.
    return channel === 'music' ? 0.32 : 0.9;
  }
}
