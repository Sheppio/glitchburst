/** Drawn inside a 24×24 box on a ring of radius 8 centred at (12, 12). */
const MARKS = {
    // One beam, leaving the muzzle and running off the edge of the box — it does
    // not stop at the first thing it hits. It emerges from the ring rather than
    // crossing it: a line straight through a circle is a prohibition sign, which
    // is not what a DPS class wants to be wearing.
    overclocker: `
    <circle cx="9.5" cy="12" r="6.5" />
    <path d="M16.5 12h6.5" />
    <path d="M20.3 9.3 23 12l-2.7 2.7" />`,
    // Three rays off the same muzzle. Wide and short, which is the gun.
    fireman: `
    <circle cx="9.5" cy="12" r="6.5" />
    <path d="M16.5 12h6" />
    <path d="m15 7.8 4.2-3" />
    <path d="m15 16.2 4.2 3" />`,
    // The ghost sits behind and is drawn faint, so the real one still reads as
    // the subject at 20px rather than the pair reading as a figure of eight.
    glitcher: `
    <circle cx="15" cy="9.5" r="6.8" opacity="0.42" />
    <circle cx="9.5" cy="14.5" r="6.8" />`,
    // A field, not a medkit: the cross is inside the ring because what heals you
    // is standing in the thing.
    encoder: `
    <circle cx="12" cy="12" r="7.5" />
    <path d="M12 7.8v8.4" />
    <path d="M7.8 12h8.4" />`,
};
/**
 * One class glyph as SVG markup.
 *
 * Decorative by default — every place this is used already names the class in
 * text beside it, so announcing the glyph as well would read the same
 * information twice to a screen reader.
 */
export function classIconSvg(id) {
    return (`<svg class="class-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ` +
        `fill="none" stroke="currentColor" stroke-width="2" ` +
        `stroke-linecap="round" stroke-linejoin="round">${MARKS[id]}</svg>`);
}
//# sourceMappingURL=classIcon.js.map