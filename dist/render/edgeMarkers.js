/**
 * Off-screen indicators: where a teammate is, and where a power-up is.
 *
 * The arena is 2400x1600 and the camera shows a fraction of it, so most of the
 * time your squad is somewhere you cannot see. Without a pointer the only way
 * to regroup is to guess a direction and run, and a power-up that spawns off
 * screen is simply never collected.
 *
 * A marker is placed on an inset rectangle — the screen edge, pulled in far
 * enough that the arrow is fully drawn rather than half clipped — where the ray
 * from the middle of the screen to the target crosses it.
 *
 * Pure, screen-space, Phaser-free: it takes a camera rectangle and a world
 * point and returns where to draw. Testable without a browser.
 */
/**
 * Where to draw a marker for `target`, or null when it is already on screen.
 *
 * `margin` insets the edge the marker sits on. Half the arrow's own size plus a
 * little, or it hangs off the side of the screen it is meant to be pointing
 * from.
 */
export function edgeMarker(target, view, margin) {
    // Screen-space position of the target, and of the middle of the screen.
    const sx = target.x - view.x;
    const sy = target.y - view.y;
    const cx = view.width / 2;
    const cy = view.height / 2;
    if (sx >= 0 && sx <= view.width && sy >= 0 && sy <= view.height)
        return null;
    const dx = sx - cx;
    const dy = sy - cy;
    // Exactly on the centre cannot be off screen, but a degenerate view rect
    // could produce this; a marker with no direction is worse than none.
    if (dx === 0 && dy === 0)
        return null;
    // How far along the ray the inset rectangle is crossed. Each axis gives a
    // limit; the nearer one is the edge actually hit, and an axis with no
    // component cannot be the one that stops the ray.
    const halfW = Math.max(1, cx - margin);
    const halfH = Math.max(1, cy - margin);
    const limitX = dx === 0 ? Infinity : halfW / Math.abs(dx);
    const limitY = dy === 0 ? Infinity : halfH / Math.abs(dy);
    const scale = Math.min(limitX, limitY);
    return {
        x: cx + dx * scale,
        y: cy + dy * scale,
        angle: Math.atan2(dy, dx),
        distance: Math.hypot(dx, dy),
    };
}
//# sourceMappingURL=edgeMarkers.js.map