import { HAPTIC } from '../input/settings.js';
/**
 * Full front-end navigation from a controller, with no virtual cursor.
 *
 * Console browsers do have pointer emulation, but driving a floating cursor
 * across a menu with a stick is miserable, and on the PlayStation browser it
 * competes with the system's own cursor. So the menus are navigated the way a
 * console UI actually works: a focus ring that jumps between elements, D-pad or
 * left stick to move it, and one action button to commit.
 *
 * Movement is *spatial* rather than DOM order. The class-select screen is a
 * grid, and in DOM order "right" from the top-left card would land somewhere
 * arbitrary; comparing bounding boxes means the focus ring goes where the
 * player is looking.
 */
export class GamepadNavigator {
    pad;
    root;
    running = false;
    raf = 0;
    lastFocus = null;
    onConnectionChange = null;
    wasConnected = false;
    constructor(pad, root) {
        this.pad = pad;
        this.root = root;
    }
    /** Notified when a pad appears or disappears, so the UI can show hints. */
    set onConnection(fn) {
        this.onConnectionChange = fn;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.tick();
    }
    stop() {
        this.running = false;
        if (this.raf)
            cancelAnimationFrame(this.raf);
        this.raf = 0;
    }
    /** Move focus onto the first control of a freshly shown screen. */
    focusFirst() {
        const items = this.focusables();
        if (!items.length)
            return;
        const preferred = items.find((el) => el.hasAttribute('data-nav-default')) ?? items[0];
        this.focus(preferred);
    }
    tick = () => {
        if (!this.running)
            return;
        const nav = this.pad.readNav();
        if (nav.connected !== this.wasConnected) {
            this.wasConnected = nav.connected;
            this.onConnectionChange?.(nav.connected);
            if (nav.connected)
                this.focusFirst();
        }
        if (nav.connected) {
            if (nav.up)
                this.move('up');
            if (nav.down)
                this.move('down');
            if (nav.left)
                this.move('left');
            if (nav.right)
                this.move('right');
            if (nav.confirm)
                this.confirm();
            if (nav.back)
                this.back();
            // Start belongs to the pause control whenever a modal is up: in a match
            // that is the one button that has to resume, and taking the page
            // fullscreen instead would be a baffling answer to it.
            if (nav.menu && !this.modalOpen())
                this.lockFocus();
        }
        this.raf = requestAnimationFrame(this.tick);
    };
    /* ------------------------------------------------------------- internals */
    /** True while a pad is actually attached. */
    get connected() {
        return this.wasConnected;
    }
    /**
     * Everything on the *visible* screen that can take focus, in DOM order.
     *
     * Scoped to the topmost open modal when there is one. Without that the focus
     * ring wanders off a pause card onto the HUD buttons behind it, or off the
     * on-screen keyboard onto the form underneath — which on a controller is
     * indistinguishable from the menu breaking, because there is no pointer to
     * grab back with.
     */
    focusables() {
        const nodes = this.navScope().querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [data-nav]');
        return [...nodes].filter((el) => !el.hasAttribute('data-nav-skip') && isVisible(el));
    }
    modalOpen() {
        return this.openModals().length > 0;
    }
    /**
     * Modals that are genuinely on screen.
     *
     * `:not([hidden])` alone is not enough: a modal can have its own attribute
     * cleared and still be invisible because an ancestor screen is hidden. The
     * pause veil sits inside the HUD screen, so opening settings over a paused
     * match left the veil "not hidden" but off screen — and scoping to it meant B
     * looked for a back action inside an invisible card and found none, so the
     * button did nothing at all.
     */
    openModals() {
        return [...this.root.querySelectorAll('[data-nav-modal]:not([hidden])')].filter(isVisible);
    }
    /** The topmost open modal, or the whole overlay when none is open. */
    navScope() {
        const modals = this.openModals();
        return modals.length ? modals[modals.length - 1] : this.root;
    }
    current() {
        const active = document.activeElement;
        if (active instanceof HTMLElement && this.focusables().includes(active))
            return active;
        return null;
    }
    move(dir) {
        const items = this.focusables();
        if (!items.length)
            return;
        const from = this.current();
        if (!from) {
            this.focus(items[0]);
            return;
        }
        // Some controls own left/right themselves rather than passing it to the
        // focus ring. Without this a slider cannot be moved from a controller at
        // all: the D-pad would simply walk off it.
        if (dir === 'left' || dir === 'right') {
            const step = dir === 'right' ? 1 : -1;
            if (isTextInput(from))
                return; // caret movement belongs to the field
            if (isRange(from)) {
                this.nudgeRange(from, step);
                return;
            }
            if (from instanceof HTMLSelectElement) {
                this.cycleSelect(from, step);
                return;
            }
        }
        const origin = rectOf(from);
        let best = null;
        let bestScore = Infinity;
        for (const el of items) {
            if (el === from)
                continue;
            const r = rectOf(el);
            const score = directionalScore(dir, origin, r);
            if (score < bestScore) {
                bestScore = score;
                best = el;
            }
        }
        // Nothing in that direction: step in DOM order instead of dead-ending.
        //
        // Not an axis wrap, which is what this used to do. The main menu is a
        // single row of three buttons, so wrapping along the vertical axis resolved
        // to the button already focused and *down did nothing at all* — which from
        // a controller is indistinguishable from the menu being broken. Stepping
        // guarantees every press moves, and on a single row down behaves as right.
        if (!best) {
            const index = items.indexOf(from);
            const forward = dir === 'down' || dir === 'right';
            best = items[(index + (forward ? 1 : -1) + items.length) % items.length];
        }
        if (best && best !== from)
            this.focus(best);
    }
    /**
     * Move a slider one step.
     *
     * `stepUp`/`stepDown` rather than arithmetic on the value: the browser
     * already implements step and clamping correctly, and doing it by hand turns
     * 0.15 + 0.01 into 0.16000000000000003, which is then what gets stored.
     */
    nudgeRange(el, direction) {
        const before = el.value;
        try {
            if (direction > 0)
                el.stepUp();
            else
                el.stepDown();
        }
        catch {
            return; // not steppable; nothing sensible to do
        }
        if (el.value === before)
            return; // already at the end of its travel
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        this.pad.triggerRumble(HAPTIC.navigate.weak, HAPTIC.navigate.strong, HAPTIC.navigate.ms);
    }
    /**
     * Step a dropdown without opening it.
     *
     * A native `select` popup is rendered by the browser chrome, not the page,
     * and a gamepad cannot drive it — opening one on a console is a dead end
     * with no way back. Cycling the options in place keeps it operable.
     */
    cycleSelect(el, direction) {
        const count = el.options.length;
        if (count < 2)
            return;
        el.selectedIndex = (el.selectedIndex + direction + count) % count;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        this.pad.triggerRumble(HAPTIC.navigate.weak, HAPTIC.navigate.strong, HAPTIC.navigate.ms);
    }
    focus(el) {
        if (this.lastFocus === el)
            return;
        this.lastFocus?.classList.remove('nav-focus');
        this.lastFocus = el;
        el.classList.add('nav-focus');
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        this.pad.triggerRumble(HAPTIC.navigate.weak, HAPTIC.navigate.strong, HAPTIC.navigate.ms);
    }
    confirm() {
        const el = this.current();
        if (!el) {
            this.focusFirst();
            return;
        }
        if (isTextInput(el)) {
            // Console browsers *sometimes* raise their own soft keyboard for a
            // focused field, and a desktop browser with a pad plugged in never does.
            // Relying on that left the callsign and room-code fields unfillable from
            // a controller, which is the whole game behind two text boxes. The UI
            // owns an on-screen keyboard; this asks for it.
            el.focus();
            document.dispatchEvent(new CustomEvent('gb:text-entry', { detail: { id: el.id } }));
            return;
        }
        if (el instanceof HTMLSelectElement) {
            // Never open the native popup — see `cycleSelect`.
            this.cycleSelect(el, 1);
            return;
        }
        el.click();
    }
    /**
     * B / Circle: the back action of whatever is on screen.
     *
     * Scoped and searched for the first *visible* match, not simply the first in
     * the document. The old version took `querySelector` — the first match
     * anywhere — and then declined to click it if it was hidden, so B did nothing
     * at all on any screen whose back button was not the first in the file. Worse,
     * with a modal open it could reach past the modal to the screen underneath:
     * pressing B to close the on-screen keyboard walked the player back out of
     * character select.
     */
    back() {
        for (const el of this.navScope().querySelectorAll('[data-nav-back]')) {
            if (!el.hidden && isVisible(el)) {
                el.click();
                return;
            }
        }
    }
    /**
     * "Lock gamepad focus to the browser window."
     *
     * On Xbox Edge and the PlayStation browser, gamepad events only reach the
     * page while the page itself holds focus — otherwise the system UI eats
     * them. Going fullscreen and pulling focus back to the document is what
     * actually makes that stick, and it is what the on-screen prompt asks the
     * player to press Menu/Options for.
     */
    lockFocus() {
        window.focus();
        document.body.focus?.();
        const el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) {
            void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
                /* refused (not a user gesture, or unsupported) — focus alone still helps */
            });
        }
        this.focusFirst();
        document.dispatchEvent(new CustomEvent('gb:focus-locked'));
    }
}
function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}
/**
 * Lower is better; Infinity means "not in this direction".
 *
 * The perpendicular offset is weighted heavily so the ring prefers the element
 * directly ahead over one that is marginally closer but off to the side.
 */
function directionalScore(dir, from, to) {
    const dx = to.cx - from.cx;
    const dy = to.cy - from.cy;
    const EPSILON = 4;
    switch (dir) {
        case 'up':
            return to.bottom <= from.top + EPSILON ? -dy + Math.abs(dx) * 2.2 : Infinity;
        case 'down':
            return to.top >= from.bottom - EPSILON ? dy + Math.abs(dx) * 2.2 : Infinity;
        case 'left':
            return to.right <= from.left + EPSILON ? -dx + Math.abs(dy) * 2.2 : Infinity;
        case 'right':
            return to.left >= from.right - EPSILON ? dx + Math.abs(dy) * 2.2 : Infinity;
    }
}
/**
 * On screen and occupying space.
 *
 * `getClientRects` rather than `offsetParent`, which is **null for anything
 * positioned `fixed`** — the on-screen keyboard is a fixed overlay, so an
 * offsetParent test declared it invisible and the focus ring stayed on the form
 * behind it while the keyboard sat in front, unusable.
 */
function isVisible(el) {
    return el.getClientRects().length > 0;
}
function isRange(el) {
    return el instanceof HTMLInputElement && el.type === 'range';
}
function isTextInput(el) {
    return el instanceof HTMLInputElement && ['text', 'search', 'url', 'email', 'number'].includes(el.type);
}
//# sourceMappingURL=GamepadNavigator.js.map