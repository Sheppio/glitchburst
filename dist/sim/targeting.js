/**
 * Auto-aim target selection.
 *
 * "Nearest" is the obvious rule and the wrong one. It abandons an enemy you are
 * one shot from killing the instant something healthier wanders closer, so
 * damage gets smeared across a crowd and nothing actually dies — the worst
 * outcome in a game where a dead enemy stops shooting back.
 *
 * Instead every candidate is scored by **how long it would take to eliminate**,
 * and the cheapest wins. Three real costs, all in seconds so they can simply be
 * added:
 *
 *   timeToAim    how long the barrel takes to swing there, at the turn rate
 *   timeToReach  how long a round takes to fly there
 *   timeToKill   how long its remaining health takes to chew through
 *
 * That single change produces the behaviour asked for without a special case:
 * an enemy at 5% health has a near-zero `timeToKill`, so it stays the best
 * target even after something at full health gets closer. A full-health Trojan
 * Tank two paces away is genuinely expensive, and the formula says so.
 *
 * Two adjustments on top:
 *
 *   - **Stickiness.** The current target gets a discount, so two similar
 *     candidates cannot flip-flop frame to frame. Without it the barrel jitters
 *     between equals and hits neither.
 *   - **Range.** Beyond the weapon's reach a round expires before arrival, so
 *     those candidates are penalised rather than excluded — facing a distant
 *     threat still beats facing nothing when there is no valid target at all.
 */
export const TARGETING = {
    /**
     * Score multiplier for the enemy already being tracked. 0.72 means a rival
     * must be ~28% cheaper to steal the lock — enough to stop jitter between
     * near-equal candidates, small enough that a genuinely better target still
     * wins immediately.
     */
    stickyDiscount: 0.72,
    /**
     * Seconds added per unit of "distance beyond weapon range", scaled by bullet
     * speed. Keeps unreachable targets available as a fallback while making any
     * reachable one strictly better.
     */
    outOfRangeWeight: 3,
    /** Floor on dps, so a divide-by-zero cannot produce an infinite kill time. */
    minDps: 1,
};
/** Shortest angular distance between two headings, in radians. */
function angleGap(from, to) {
    let diff = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI)
        diff += Math.PI * 2;
    return Math.abs(diff);
}
/**
 * Estimated seconds to eliminate this candidate. Lower is better.
 *
 * Exported so it can be unit tested and tuned directly, rather than only
 * observed through the behaviour it produces.
 */
export function targetScore(candidate, ctx) {
    const dx = candidate.x - ctx.fromX;
    const dy = candidate.y - ctx.fromY;
    const distance = Math.hypot(dx, dy);
    const timeToAim = ctx.turnRate > 0 ? angleGap(ctx.facing, Math.atan2(dy, dx)) / ctx.turnRate : 0;
    const timeToReach = ctx.bulletSpeed > 0 ? distance / ctx.bulletSpeed : 0;
    const timeToKill = Math.max(0, candidate.hp) / Math.max(TARGETING.minDps, ctx.dps);
    // Rounds die before they arrive past this distance, so the shot is wasted.
    const overshoot = Math.max(0, distance - ctx.weaponRange);
    const rangePenalty = ctx.bulletSpeed > 0 ? (overshoot / ctx.bulletSpeed) * TARGETING.outOfRangeWeight : 0;
    const score = timeToAim + timeToReach + timeToKill + rangePenalty;
    return candidate.id === ctx.currentTargetId ? score * TARGETING.stickyDiscount : score;
}
/** The cheapest candidate to eliminate, or null if nothing is in acquisition range. */
export function pickTarget(candidates, ctx) {
    let best = null;
    let bestScore = Infinity;
    const maxRange2 = ctx.maxRange * ctx.maxRange;
    for (const candidate of candidates) {
        const dx = candidate.x - ctx.fromX;
        const dy = candidate.y - ctx.fromY;
        if (dx * dx + dy * dy > maxRange2)
            continue;
        const score = targetScore(candidate, ctx);
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}
//# sourceMappingURL=targeting.js.map