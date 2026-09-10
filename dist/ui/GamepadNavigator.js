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
            if (nav.menu)
                this.lockFocus();
        }
        this.raf = requestAnimationFrame(this.tick);
    };
    /* ------------------------------------------------------------- internals */
    /** Everything on the *visible* screen that can take focus, in DOM order. */
    focusables() {
        const nodes = this.root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [data-nav]');
        return [...nodes].filter((el) => {
            if (el.hasAttribute('data-nav-skip'))
                return false;
            // offsetParent is null for anything inside a hidden screen.
            if (el.offsetParent === null)
                return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
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
        // A text field owns left/right so the player can move the caret.
        if (isTextInput(from) && (dir === 'left' || dir === 'right'))
            return;
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
        // Nothing in that direction: wrap to the far side, which is what a console
        // list is expected to do rather than dead-ending.
        if (!best) {
            const sorted = [...items].sort((a, b) => axisOf(dir, rectOf(a)) - axisOf(dir, rectOf(b)));
            best = dir === 'up' || dir === 'left' ? sorted[sorted.length - 1] : sorted[0];
        }
        if (best && best !== from)
            this.focus(best);
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
            // Console browsers open their own soft keyboard when a field is focused
            // and activated; this is the gesture that triggers it.
            el.focus();
            el.click();
            return;
        }
        el.click();
    }
    back() {
        const el = this.root.querySelector('[data-nav-back]:not([hidden])');
        if (el && el.offsetParent !== null)
            el.click();
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
function axisOf(dir, r) {
    return dir === 'up' || dir === 'down' ? r.cy : r.cx;
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
function isTextInput(el) {
    return el instanceof HTMLInputElement && ['text', 'search', 'url', 'email', 'number'].includes(el.type);
}
//# sourceMappingURL=GamepadNavigator.js.map