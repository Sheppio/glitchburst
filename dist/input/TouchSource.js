import { EMPTY_SAMPLE } from './sources.js';
const MAX_RADIUS = 62;
/**
 * Touch scheme (requirement 1c).
 *
 * The screen is split in two. The movement half spawns a floating stick
 * wherever the thumb lands — fixed-position sticks are the single most common
 * reason mobile twin-stick controls feel bad, because the thumb never starts in
 * the same place twice. The other half doubles as an aim stick and a fire
 * button, so a player who turns off auto-aim still has full manual control;
 * with the assists on (the mobile default) that half can be ignored entirely.
 */
export class TouchSource {
    host;
    id = 'touch';
    label = 'Touch';
    layer;
    move;
    aim;
    abilityButton;
    abilityHeld = false;
    /** See KeyboardMouseSource: a tap can land entirely between two polls. */
    abilityLatched = false;
    fireTapUntil = 0;
    touched = false;
    enabled = false;
    constructor(host) {
        this.host = host;
        this.layer = document.createElement('div');
        this.layer.className = 'touch-layer';
        this.layer.hidden = true;
        this.move = this.makeStick('touch-stick move');
        this.aim = this.makeStick('touch-stick aim');
        this.abilityButton = document.createElement('button');
        this.abilityButton.className = 'touch-ability';
        this.abilityButton.type = 'button';
        this.abilityButton.innerHTML = '<span>ABILITY</span>';
        this.abilityButton.addEventListener('pointerdown', this.onAbilityDown);
        this.abilityButton.addEventListener('pointerup', this.onAbilityUp);
        this.abilityButton.addEventListener('pointercancel', this.onAbilityUp);
        this.layer.appendChild(this.abilityButton);
        host.appendChild(this.layer);
        this.layer.addEventListener('pointerdown', this.onDown);
        this.layer.addEventListener('pointermove', this.onMove);
        this.layer.addEventListener('pointerup', this.onUp);
        this.layer.addEventListener('pointercancel', this.onUp);
    }
    /** Shown only in-game, and only when the device (or the player) wants it. */
    setEnabled(enabled) {
        this.enabled = enabled;
        this.layer.hidden = !enabled;
        if (!enabled) {
            this.release(this.move);
            this.release(this.aim);
            this.abilityHeld = false;
            this.abilityLatched = false;
        }
    }
    setSouthpaw(southpaw) {
        this.layer.classList.toggle('southpaw', southpaw);
    }
    /** Reflect the ability cooldown on the button itself. */
    setAbilityReady(ready, remainingSec) {
        this.abilityButton.classList.toggle('cooling', !ready);
        this.abilityButton.dataset['cd'] = ready ? '' : remainingSec.toFixed(1);
    }
    available() {
        return this.enabled;
    }
    poll(_ctx) {
        if (!this.enabled)
            return EMPTY_SAMPLE;
        const mx = this.move.x / MAX_RADIUS;
        const my = this.move.y / MAX_RADIUS;
        const aimActive = this.aim.pointerId !== null;
        const aimMag = Math.hypot(this.aim.x, this.aim.y);
        const active = this.touched;
        this.touched = false;
        return {
            moveX: mx,
            moveY: my,
            aim: aimActive && aimMag > 8 ? Math.atan2(this.aim.y, this.aim.x) : null,
            // Holding the aim half fires; a quick tap fires a short burst too.
            firing: aimActive || performance.now() < this.fireTapUntil,
            ability: this.abilityHeld || this.takeAbilityLatch(),
            active: active || aimActive || this.move.pointerId !== null,
        };
    }
    destroy() {
        this.layer.remove();
    }
    /* ------------------------------------------------------------- internals */
    makeStick(className) {
        const root = document.createElement('div');
        root.className = className;
        root.hidden = true;
        const ring = document.createElement('div');
        ring.className = 'touch-stick-ring';
        const nub = document.createElement('div');
        nub.className = 'touch-stick-nub';
        root.append(ring, nub);
        this.layer.appendChild(root);
        return { pointerId: null, originX: 0, originY: 0, x: 0, y: 0, root, nub };
    }
    /** Left half is movement unless southpaw flips it. */
    zoneFor(clientX) {
        const midpoint = this.host.clientWidth / 2;
        const leftIsMove = !this.layer.classList.contains('southpaw');
        const onLeft = clientX < midpoint;
        return onLeft === leftIsMove ? this.move : this.aim;
    }
    onDown = (e) => {
        if (!this.enabled)
            return;
        if (e.target === this.abilityButton)
            return;
        const stick = this.zoneFor(e.clientX);
        if (stick.pointerId !== null)
            return;
        e.preventDefault();
        this.layer.setPointerCapture(e.pointerId);
        stick.pointerId = e.pointerId;
        stick.originX = e.clientX;
        stick.originY = e.clientY;
        stick.x = 0;
        stick.y = 0;
        stick.root.hidden = false;
        stick.root.style.left = `${e.clientX}px`;
        stick.root.style.top = `${e.clientY}px`;
        stick.nub.style.transform = 'translate(-50%, -50%)';
        this.touched = true;
        if (stick === this.aim)
            this.fireTapUntil = performance.now() + 120;
    };
    onMove = (e) => {
        const stick = this.move.pointerId === e.pointerId ? this.move : this.aim.pointerId === e.pointerId ? this.aim : null;
        if (!stick)
            return;
        e.preventDefault();
        let dx = e.clientX - stick.originX;
        let dy = e.clientY - stick.originY;
        const mag = Math.hypot(dx, dy);
        if (mag > MAX_RADIUS) {
            dx = (dx / mag) * MAX_RADIUS;
            dy = (dy / mag) * MAX_RADIUS;
        }
        stick.x = dx;
        stick.y = dy;
        stick.nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        this.touched = true;
    };
    onUp = (e) => {
        if (this.move.pointerId === e.pointerId)
            this.release(this.move);
        else if (this.aim.pointerId === e.pointerId)
            this.release(this.aim);
    };
    release(stick) {
        if (stick.pointerId !== null) {
            try {
                this.layer.releasePointerCapture(stick.pointerId);
            }
            catch {
                /* the pointer is already gone */
            }
        }
        stick.pointerId = null;
        stick.x = 0;
        stick.y = 0;
        stick.root.hidden = true;
    }
    takeAbilityLatch() {
        const latched = this.abilityLatched;
        this.abilityLatched = false;
        return latched;
    }
    onAbilityDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.abilityHeld = true;
        this.abilityLatched = true;
        this.touched = true;
    };
    onAbilityUp = (e) => {
        e.stopPropagation();
        this.abilityHeld = false;
    };
}
//# sourceMappingURL=TouchSource.js.map