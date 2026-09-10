export const EMPTY_SAMPLE = {
    moveX: 0,
    moveY: 0,
    aim: null,
    firing: false,
    ability: false,
    active: false,
};
/**
 * Hardware drift floor, applied per axis before anything else looks at a stick.
 *
 * Worn analogue sticks — the Steam Deck's after a year of travel, an old DualShock,
 * a third-party Xbox pad — rest at a non-zero value on one or both axes. Left
 * alone that reads as a held direction: the character walks into a wall while
 * nobody is touching the controller, and the crosshair crawls. Zeroing any axis
 * under this threshold kills the drift outright, at the cost of a sliver of
 * precision nobody can feel.
 */
export const HARDWARE_DEADZONE = 0.15;
/** Per-axis drift filter. Independent of the radial deadzone applied afterwards. */
export function filterAxis(value) {
    return Math.abs(value) < HARDWARE_DEADZONE ? 0 : value;
}
/**
 * Radial deadzone + rescale, so the stick reaches full magnitude at the rim.
 *
 * This runs *after* `filterAxis`. The per-axis pass exists to kill drift; this
 * one exists to make the remaining travel feel linear, and treating the stick
 * as a disc rather than two independent axes is what stops diagonals from
 * feeling faster than cardinals.
 */
export function applyDeadzone(x, y, deadzone) {
    const mag = Math.hypot(x, y);
    // `<=` rather than `<`, and never divide by a zero magnitude: a centred stick
    // with a zero deadzone (which is what the keyboard source passes) would
    // otherwise compute 0/0 and hand back NaN. That NaN propagates into the
    // player position, then into enemy spawn anchors, and every downstream
    // comparison silently inverts — NaN fails every bounds check it is given.
    if (mag === 0 || mag <= deadzone)
        return { x: 0, y: 0, mag: 0 };
    const scaled = Math.min(1, (mag - deadzone) / (1 - deadzone));
    return { x: (x / mag) * scaled, y: (y / mag) * scaled, mag: scaled };
}
//# sourceMappingURL=sources.js.map