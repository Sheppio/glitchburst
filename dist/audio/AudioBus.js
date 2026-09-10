export class AudioBus {
    ctx = null;
    master = null;
    gains = { sfx: null, music: null };
    enabled = { sfx: true, music: true };
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
                    gain.gain.value = this.enabled[channel] ? this.levelFor(channel) : 0;
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
    setEnabled(channel, on) {
        this.enabled[channel] = on;
        const gain = this.gains[channel];
        if (!gain || !this.ctx)
            return;
        // Ramp rather than jump: a hard gain change on a running oscillator clicks.
        const target = on ? this.levelFor(channel) : 0;
        gain.gain.cancelScheduledValues(this.ctx.currentTime);
        gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
    isEnabled(channel) {
        return this.enabled[channel];
    }
    /** The node effects should connect to. Null when audio is unavailable or off. */
    destination(channel) {
        if (!this.ready || !this.enabled[channel])
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
    levelFor(channel) {
        // Music sits well under the effects; it is a bed, not a feature.
        return channel === 'music' ? 0.32 : 0.9;
    }
}
//# sourceMappingURL=AudioBus.js.map