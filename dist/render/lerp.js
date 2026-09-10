/**
 * Framerate-independent interpolation (requirement 6).
 *
 * The naive form `pos += (target - pos) * 0.2` every frame is wrong the moment
 * the frame rate changes: at 144 Hz it converges more than twice as fast as at
 * 60 Hz, so a peer on a high-refresh monitor sees a visibly different game to
 * one on a laptop. Re-scaling the factor by the real elapsed time fixes that.
 *
 * `base` is expressed as "fraction of the gap closed in one 60 Hz frame".
 */
export function smoothing(base, deltaMs) {
    const frames = deltaMs / (1000 / 60);
    return 1 - Math.pow(1 - base, frames);
}
/**
 * Glide a peer-side sprite toward the position the host last reported.
 *
 * Enemy snapshots land at 20 Hz — one every 50 ms, or roughly every third
 * frame — so without this the horde teleports. Beyond `snapDistance` the
 * sprite jumps instead: that distance means a teleport actually happened (a
 * fresh spawn, a host handover, or a dropped burst of messages), and smoothing
 * across it would draw an enemy sliding through walls of the arena it was
 * never in.
 */
export function glide(current, targetX, targetY, base, deltaMs, snapDistance) {
    const dx = targetX - current.x;
    const dy = targetY - current.y;
    if (dx * dx + dy * dy > snapDistance * snapDistance) {
        current.x = targetX;
        current.y = targetY;
        return;
    }
    const t = smoothing(base, deltaMs);
    current.x += dx * t;
    current.y += dy * t;
}
//# sourceMappingURL=lerp.js.map