import { Emitter } from '../util.js';
import { GamepadSource } from './GamepadSource.js';
import { KeyboardMouseSource } from './KeyboardMouseSource.js';
import { TouchSource } from './TouchSource.js';
/**
 * The abstraction layer every other system reads.
 *
 * Three devices go in; one `Intent` comes out. Nothing downstream of this class
 * knows whether the player is on a mouse, a controller or a thumb — which is
 * what makes auto-aim and auto-fire a two-line change here instead of a
 * special case in the shooting code.
 *
 * Scheme selection is implicit: whichever device reported activity most
 * recently owns the character. Picking up a controller mid-run just works, and
 * so does dropping it and grabbing the mouse again.
 */
export class InputManager {
    settings;
    events = new Emitter();
    keyboard;
    gamepad;
    touch;
    /** Set by the game scene once enemies exist. */
    aimAssist = null;
    /** Set by the game scene. Drives the character when `autoMove` is on. */
    moveAssist = null;
    sources;
    lastActive = new Map();
    scheme = 'kbm';
    lastAim = 0;
    abilityWasDown = false;
    /**
     * The on-screen sticks are a full-screen overlay, so they must exist only
     * while a match is running. Left enabled on the front end they sit on top of
     * the menu and silently swallow every tap — the buttons look fine and simply
     * never respond.
     */
    inGame = false;
    constructor(host, settings) {
        this.settings = settings;
        this.keyboard = new KeyboardMouseSource(host);
        this.gamepad = new GamepadSource();
        this.touch = new TouchSource(host);
        this.sources = [this.keyboard, this.gamepad, this.touch];
        this.touch.setSouthpaw(settings.current.southpaw);
        settings.events.on('change', ({ settings: s }) => {
            this.syncTouchLayer();
            this.touch.setSouthpaw(s.southpaw);
        });
        this.syncTouchLayer();
    }
    /** Called when a match starts and ends. Gates the on-screen stick overlay. */
    setInGame(inGame) {
        this.inGame = inGame;
        this.syncTouchLayer();
    }
    syncTouchLayer() {
        this.touch.setEnabled(this.inGame && this.settings.current.forceTouchControls);
    }
    get activeScheme() {
        return this.scheme;
    }
    get activeLabel() {
        return this.sources.find((s) => s.id === this.scheme)?.label ?? 'Keyboard & Mouse';
    }
    /**
     * @param playerScreen where the player is drawn, for pointer-relative aiming
     * @param playerWorld  where the player is in the arena, for auto-aim lookups
     */
    update(playerScreen, playerWorld) {
        const settings = this.settings.current;
        const ctx = {
            playerScreenX: playerScreen.x,
            playerScreenY: playerScreen.y,
            settings,
        };
        const now = performance.now();
        let chosen = null;
        for (const source of this.sources) {
            if (!source.available())
                continue;
            const sample = source.poll(ctx);
            if (sample.active)
                this.lastActive.set(source.id, now);
            if (source.id === this.scheme)
                chosen = sample;
            else if (sample.active && this.shouldSwitch(source.id, now)) {
                this.setScheme(source.id);
                chosen = sample;
            }
        }
        // The active scheme's device may have been unplugged since last frame.
        if (!chosen) {
            const fallback = this.sources.find((s) => s.available());
            if (fallback) {
                this.setScheme(fallback.id);
                chosen = fallback.poll(ctx);
            }
        }
        const sample = chosen ?? { moveX: 0, moveY: 0, aim: null, firing: false, ability: false, active: false };
        // --- Auto-aim (requirement 1d) --------------------------------------
        // Overrides the stick/pointer angle only while a target is in range; with
        // nothing to shoot at, manual aim is handed straight back to the player.
        let aim = sample.aim ?? this.lastAim;
        let aiming = sample.aim !== null;
        if (settings.autoAim && this.aimAssist) {
            const target = this.aimAssist(playerWorld, settings.autoAimRange);
            if (target) {
                aim = Math.atan2(target.y - playerWorld.y, target.x - playerWorld.x);
                aiming = true;
            }
        }
        this.lastAim = aim;
        // --- Auto-fire (requirement 1d) -------------------------------------
        // The weapon's own cooldown still governs the rate; this only removes the
        // requirement to hold a button.
        const firing = sample.firing || settings.autoFire;
        // --- Autopilot --------------------------------------------------------
        // Takes the character over completely, so a client can play itself. Real
        // input still wins: any stick or key deflection this frame overrides it,
        // which means a human can grab a self-driving client without first going
        // to the settings screen.
        let { moveX, moveY } = sample;
        let autoAbility = false;
        if (settings.autoMove && this.moveAssist && Math.hypot(moveX, moveY) < 0.05) {
            const drive = this.moveAssist();
            moveX = drive.x;
            moveY = drive.y;
            autoAbility = drive.ability;
        }
        const abilityDown = sample.ability || autoAbility;
        const abilityPressed = abilityDown && !this.abilityWasDown;
        this.abilityWasDown = abilityDown;
        // Clamp the movement vector: diagonal keyboard input would otherwise be
        // 1.41x faster than cardinal.
        const mag = Math.hypot(moveX, moveY);
        if (mag > 1) {
            moveX /= mag;
            moveY /= mag;
        }
        return { moveX, moveY, aim, aiming, firing, abilityPressed };
    }
    /**
     * Reusable haptics hook. Routes to the pad's dual-rumble motors when a
     * controller is driving, and to the device vibrator on touch, so a single
     * call site covers every platform.
     *
     * Callers pass intent, not hardware values: see `HAPTIC` for the presets the
     * game actually fires (taking damage, activating an ability).
     */
    triggerRumble(weakIntensity, strongIntensity, durationMs) {
        if (!this.settings.current.vibration)
            return;
        // Always rumble a connected pad, even if the player last touched a key —
        // a console player holding the controller should feel their own hits.
        if (this.gamepad.connected) {
            this.gamepad.triggerRumble(weakIntensity, strongIntensity, durationMs);
        }
        if (this.scheme === 'touch') {
            navigator.vibrate?.(Math.round(durationMs));
        }
    }
    /** True when a pad is present, so the UI can show controller prompts. */
    get gamepadConnected() {
        return this.gamepad.connected;
    }
    destroy() {
        for (const source of this.sources)
            source.destroy();
        this.events.clear();
    }
    /** Debounced so a drifting stick can't fight the mouse for control. */
    shouldSwitch(candidate, now) {
        const currentActivity = this.lastActive.get(this.scheme) ?? 0;
        return candidate !== this.scheme && now - currentActivity > 250;
    }
    setScheme(scheme) {
        if (this.scheme === scheme)
            return;
        this.scheme = scheme;
        this.events.emit('schemeChange', { scheme, label: this.activeLabel });
    }
}
//# sourceMappingURL=InputManager.js.map