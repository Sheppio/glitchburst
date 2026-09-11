/**
 * Enemies get faster the longer they live.
 *
 * A horde shooter has one degenerate strategy and this is it: the arena is
 * 2400x1600, every chasing enemy is slower than every class, and a player who
 * stops shooting and simply runs in circles is never caught. With auto-move on
 * that can run literally forever — the reported case was a lone self-driving
 * client circling with a tail of hostiles trailing behind it, wave frozen,
 * nothing resolving.
 *
 * Rather than raise base speeds — which would make every wave harder from the
 * first second, punishing the ordinary case to fix the pathological one — an
 * enemy's speed grows with its own time on the field. Kill things at a normal
 * rate and almost nothing lives long enough to leave the grace period. Refuse
 * to engage and the horde closes anyway.
 *
 * Engine-agnostic and pure. The simulation is host-only, so only the host's
 * numbers matter for movement; the renderer uses the same curve for the visual
 * tell, which is why this is shared rather than buried in the engine.
 */

export const ENRAGE = {
  /**
   * Seconds on the field before anything changes.
   *
   * Long enough that a wave being cleared at a reasonable pace never sees it —
   * this is a stalemate breaker, not a difficulty knob.
   */
  graceSec: 18,
  /** Fraction of base speed added per second after the grace period. */
  perSec: 0.05,
  /**
   * Hard ceiling on the multiplier.
   *
   * 2.1x puts the fastest chasers just above a fully upgraded player's top
   * speed, so running eventually stops being an answer, while leaving the
   * slowest ones no threat at all to a player who is playing. Reached at 40
   * seconds on the field.
   *
   * Tuned down from a first pass at 12s/6%/2.4x, which caught a circling kiter
   * hard — 27% of the final twenty seconds in contact. That is more pressure
   * than this needs to apply: the complaint it answers is a stalemate that
   * never ends, not a stalemate that ends slowly. At these numbers the same
   * kiter is still run down, and a late wave that takes half a minute to clear
   * is not quietly turned into a different game.
   */
  maxScale: 2.1,
} as const;

/** Speed multiplier for an enemy that has been alive `age` seconds. */
export function enrageScale(age: number): number {
  if (!Number.isFinite(age) || age <= ENRAGE.graceSec) return 1;
  const scale = 1 + (age - ENRAGE.graceSec) * ENRAGE.perSec;
  return scale > ENRAGE.maxScale ? ENRAGE.maxScale : scale;
}

/**
 * 0 to 1 across the same curve, for the renderer.
 *
 * Kept here rather than derived from `enrageScale` at the call site so the
 * visual tell cannot drift out of step with the mechanic it is announcing.
 */
export function enrageProgress(age: number): number {
  const span = ENRAGE.maxScale - 1;
  return span <= 0 ? 0 : (enrageScale(age) - 1) / span;
}
