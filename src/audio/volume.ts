/**
 * Volume curve.
 *
 * Sliders are linear in *position*; ears are not linear in amplitude. A gain
 * slider wired straight through spends its bottom quarter going from silent to
 * loud and its top half doing almost nothing audible, so squaring the position
 * before it reaches the gain node buys back most of the travel: half-way now
 * lands around -12 dB, which reads as "noticeably quieter" rather than "barely
 * touched it".
 *
 * Kept here, free of any Web Audio types, so the arithmetic is testable in Node
 * alongside the rest of the simulation.
 */

/**
 * Gain at full slider, per channel. These are the mix: music is a bed under the
 * effects, not a peer, so 100% music is deliberately quieter than 100% SFX.
 */
export const CHANNEL_REFERENCE = { sfx: 0.9, music: 0.32 } as const;

/**
 * Slider position (0–1) to a share of the channel's reference gain.
 *
 * `NaN` is folded to silence rather than clamped, because it fails *both*
 * bounds comparisons and would otherwise sail through to `gain.value` — where,
 * depending on the browser, it either throws or wedges the channel permanently.
 */
export function volumeCurve(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  const v = volume < 0 ? 0 : volume > 1 ? 1 : volume;
  return v * v;
}

/** Slider position to the gain value a channel's `GainNode` should carry. */
export function channelGain(volume: number, reference: number): number {
  return reference * volumeCurve(volume);
}
