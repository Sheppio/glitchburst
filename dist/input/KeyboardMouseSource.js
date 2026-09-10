import { applyDeadzone, EMPTY_SAMPLE } from './sources.js';
const MOVE_KEYS = {
    KeyW: [0, -1], ArrowUp: [0, -1],
    KeyS: [0, 1], ArrowDown: [0, 1],
    KeyA: [-1, 0], ArrowLeft: [-1, 0],
    KeyD: [1, 0], ArrowRight: [1, 0],
};
const ABILITY_KEYS = new Set(['Space', 'KeyE', 'ShiftLeft', 'ShiftRight']);
/**
 * Desktop scheme: WASD/arrows move, the pointer sets the weapon angle relative
 * to the player's *screen* position, left mouse fires.
 */
export class KeyboardMouseSource {
    target;
    id = 'kbm';
    label = 'Keyboard & Mouse';
    keys = new Set();
    pointerX = 0;
    pointerY = 0;
    pointerDown = false;
    dirty = false;
    /**
     * Discrete presses are latched rather than sampled.
     *
     * Key events arrive on their own schedule; the game polls once a frame. A
     * quick tap can begin and end entirely between two polls, and a sampled-only
     * reading would drop it — the ability simply would not fire, intermittently,
     * which is the worst kind of input bug to diagnose. Latching guarantees every
     * press survives to exactly one poll.
     */
    abilityLatched = false;
    constructor(target) {
        this.target = target;
        window.addEventListener('keydown', this.onKeyDown, { passive: false });
        window.addEventListener('keyup', this.onKeyUp);
        window.addEventListener('blur', this.onBlur);
        target.addEventListener('pointermove', this.onPointerMove);
        target.addEventListener('pointerdown', this.onPointerDown);
        window.addEventListener('pointerup', this.onPointerUp);
        target.addEventListener('contextmenu', this.onContextMenu);
    }
    available() {
        return true;
    }
    poll(ctx) {
        let mx = 0;
        let my = 0;
        for (const code of this.keys) {
            const vec = MOVE_KEYS[code];
            if (vec) {
                mx += vec[0];
                my += vec[1];
            }
        }
        const move = applyDeadzone(mx, my, 0);
        let ability = this.abilityLatched;
        this.abilityLatched = false;
        for (const code of ABILITY_KEYS) {
            if (this.keys.has(code))
                ability = true;
        }
        const aim = Math.atan2(this.pointerY - ctx.playerScreenY, this.pointerX - ctx.playerScreenX);
        const active = this.dirty;
        this.dirty = false;
        return {
            ...EMPTY_SAMPLE,
            moveX: move.x,
            moveY: move.y,
            aim,
            firing: this.pointerDown,
            ability,
            active: active || move.mag > 0 || this.pointerDown,
        };
    }
    destroy() {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
        window.removeEventListener('blur', this.onBlur);
        this.target.removeEventListener('pointermove', this.onPointerMove);
        this.target.removeEventListener('pointerdown', this.onPointerDown);
        window.removeEventListener('pointerup', this.onPointerUp);
        this.target.removeEventListener('contextmenu', this.onContextMenu);
    }
    onKeyDown = (e) => {
        // Don't eat typing in the room-code and callsign fields.
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)
            return;
        if (MOVE_KEYS[e.code] || ABILITY_KEYS.has(e.code))
            e.preventDefault();
        // Ignore auto-repeat: holding the key must not re-trigger the ability.
        if (ABILITY_KEYS.has(e.code) && !e.repeat)
            this.abilityLatched = true;
        this.keys.add(e.code);
        this.dirty = true;
    };
    onKeyUp = (e) => {
        this.keys.delete(e.code);
    };
    /** Alt-tabbing away must not leave a key stuck down. */
    onBlur = () => {
        this.keys.clear();
        this.pointerDown = false;
        this.abilityLatched = false;
    };
    onPointerMove = (e) => {
        if (e.pointerType === 'touch')
            return;
        this.pointerX = e.clientX;
        this.pointerY = e.clientY;
        this.dirty = true;
    };
    onPointerDown = (e) => {
        if (e.pointerType === 'touch' || e.button !== 0)
            return;
        // Clicks on the HUD are UI, not weapon fire. Without this, pressing Leave
        // or an assist chip also discharges the gun.
        if (e.target instanceof Element && e.target.closest('button, input, select, .class-card'))
            return;
        this.pointerX = e.clientX;
        this.pointerY = e.clientY;
        this.pointerDown = true;
        this.dirty = true;
    };
    onPointerUp = (e) => {
        if (e.pointerType === 'touch')
            return;
        this.pointerDown = false;
    };
    onContextMenu = (e) => {
        e.preventDefault();
    };
}
//# sourceMappingURL=KeyboardMouseSource.js.map