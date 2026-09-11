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
import { CHANNEL_REFERENCE, channelGain } from './volume.js';
export class AudioBus {
    ctx = null;
    master = null;
    gains = { sfx: null, music: null };
    /** Slider positions, 0–1. Zero is mute — see `destination`. */
    volumes = { sfx: 1, music: 1 };
    /** Last play time per throttle key, to stop a sound stacking on itself. */
    lastPlayed = new Map();
    get context() {
        return this.ctx;
    }
    get ready() {
        return this.ctx !== null && this.ctx.state === 'running';
    }
    /** Seconds on the audio clock. Scheduling wants this, not `performance.now`. */
    get now() {
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
    unlock() {
        try {
            if (!this.ctx) {
                const Ctor = window.AudioContext ?? window.webkitAudioContext;
                if (!Ctor)
                    return;
                this.ctx = new Ctor();
                this.master = this.ctx.createGain();
                this.master.gain.value = 0.85;
                this.master.connect(this.ctx.destination);
                for (const channel of ['sfx', 'music']) {
                    const gain = this.ctx.createGain();
                    gain.gain.value = this.gainFor(channel);
                    gain.connect(this.master);
                    this.gains[channel] = gain;
                }
            }
            if (this.ctx.state === 'suspended')
                void this.ctx.resume().catch(() => undefined);
        }
        catch {
            // No audio available. The game is fully playable without it.
            this.ctx = null;
        }
    }
    /**
     * Set a channel's level, 0–1.
     *
     * Called on every `input` event while a slider is dragged, so it has to be
     * cheap and it has to ramp: a hard gain change on a running oscillator clicks
     * audibly, and a drag would otherwise crackle the whole way down.
     */
    setVolume(channel, volume) {
        this.volumes[channel] = !Number.isFinite(volume) ? 0 : volume < 0 ? 0 : volume > 1 ? 1 : volume;
        const gain = this.gains[channel];
        if (!gain || !this.ctx)
            return;
        gain.gain.cancelScheduledValues(this.ctx.currentTime);
        gain.gain.setTargetAtTime(this.gainFor(channel), this.ctx.currentTime, 0.02);
    }
    volumeOf(channel) {
        return this.volumes[channel];
    }
    isEnabled(channel) {
        return this.volumes[channel] > 0;
    }
    /**
     * The node effects should connect to. Null when audio is unavailable or the
     * channel is at zero — a muted channel should build no oscillators at all,
     * not build them and multiply them by zero.
     */
    destination(channel) {
        if (!this.ready || this.volumes[channel] <= 0)
            return null;
        return this.gains[channel];
    }
    /**
     * Rate limit for sounds that can fire many times a frame.
     *
     * Auto-fire plus a hundred dying enemies would otherwise stack hundreds of
     * oscillators a second: expensive, and it sums into a wall of noise rather
     * than reading as individual events.
     */
    throttle(key, minIntervalSec) {
        const now = this.now;
        const last = this.lastPlayed.get(key) ?? -Infinity;
        if (now - last < minIntervalSec)
            return false;
        this.lastPlayed.set(key, now);
        return true;
    }
    suspend() {
        void this.ctx?.suspend().catch(() => undefined);
    }
    gainFor(channel) {
        return channelGain(this.volumes[channel], CHANNEL_REFERENCE[channel]);
    }
}
//# sourceMappingURL=AudioBus.js.map