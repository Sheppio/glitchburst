import { Emitter } from '../util.js';
const STORAGE_KEY = 'glitchburst.input.v1';
export const DEFAULT_SETTINGS = {
    autoFire: false,
    autoAim: false,
    autoAimRange: 620,
    deadzone: 0.15,
    forceTouchControls: false,
    southpaw: false,
    vibration: true,
    sfx: true,
    music: true,
};
/**
 * Input accessibility settings.
 *
 * Auto-fire and auto-aim are the pair that makes the game playable one-thumbed,
 * so they are first-class toggles rather than a debug flag — on a touch device
 * both default to on (see `detectDefaults`), which reduces the mobile control
 * scheme to a single movement stick.
 */
export class SettingsStore {
    events = new Emitter();
    state;
    constructor() {
        this.state = { ...DEFAULT_SETTINGS, ...detectDefaults(), ...load() };
    }
    get current() {
        return this.state;
    }
    set(key, value) {
        if (this.state[key] === value)
            return;
        this.state = { ...this.state, [key]: value };
        save(this.state);
        this.events.emit('change', { settings: this.state });
    }
    toggle(key) {
        this.set(key, !this.state[key]);
    }
}
/** Touch-primary devices get the assists switched on out of the box. */
function detectDefaults() {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    return coarse ? { autoFire: true, autoAim: true, forceTouchControls: true } : {};
}
function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    }
    catch {
        // Private browsing, or storage disabled. Defaults are a fine answer.
        return {};
    }
}
function save(settings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
    catch {
        /* nothing to do — the session just won't remember these */
    }
}
/**
 * Haptic presets. Intent-named so call sites read as game events rather than
 * motor values, and so the whole game's feel can be retuned from one place.
 */
export const HAPTIC = {
    /** Local player took a hit — victim-authority damage. Sharp, mostly low-end. */
    damage: { weak: 0.35, strong: 0.85, ms: 160 },
    /** Class active ability fired. Crisper and shorter, so it reads as *your* action. */
    ability: { weak: 0.9, strong: 0.45, ms: 110 },
    /** Weapon fired — deliberately tiny; auto-fire would otherwise buzz constantly. */
    shot: { weak: 0.12, strong: 0.0, ms: 28 },
    /** A kill you were credited with. */
    kill: { weak: 0.25, strong: 0.15, ms: 60 },
    /** Menu focus moved. */
    navigate: { weak: 0.08, strong: 0.0, ms: 18 },
};
//# sourceMappingURL=settings.js.map