import { Emitter } from '../util.js';

export interface InputSettings {
  /** Fire whenever the weapon is off cooldown, with no button held (requirement 1d). */
  autoFire: boolean;
  /** Snap the weapon angle to the nearest live enemy on screen (requirement 1d). */
  autoAim: boolean;
  /**
   * Let the client drive itself. With auto-fire and auto-aim it plays hands-off,
   * which is how a second body gets into a room for multiplayer testing.
   */
  autoMove: boolean;
  /** Auto-aim only considers enemies inside this world-space radius. */
  autoAimRange: number;
  /**
   * Radial deadzone for gamepad sticks, applied on top of the fixed 0.15
   * per-axis hardware drift filter in `sources.ts`. Never drops below it.
   */
  deadzone: number;
  /** Show the on-screen sticks even when a keyboard is present. */
  forceTouchControls: boolean;
  /** Left-handed layout: swaps the movement and aim zones on touch. */
  southpaw: boolean;
  vibration: boolean;
  /** Weapon, impact and pickup effects, 0–1. Zero is mute. */
  sfxVolume: number;
  /** Background music, 0–1. Zero is mute, and stops the scheduler entirely. */
  musicVolume: number;
  /**
   * Camera zoom. Below 1 pulls back and shows more arena, above 1 closes in.
   *
   * Mostly a phone concern: a 6-inch screen showing the same slice of arena as
   * a monitor is a keyhole, and being able to pull back is the difference
   * between reacting to a wave and being surprised by it.
   */
  zoom: number;
}

/** Numeric settings and the range each is clamped to when read back. */
export const RANGES = {
  autoAimRange: { min: 200, max: 1200 },
  deadzone: { min: 0.15, max: 0.45 },
  sfxVolume: { min: 0, max: 1 },
  musicVolume: { min: 0, max: 1 },
  zoom: { min: 0.6, max: 1.4 },
} as const satisfies Record<string, { min: number; max: number }>;

const STORAGE_KEY = 'glitchburst.input.v1';

export const DEFAULT_SETTINGS: InputSettings = {
  autoFire: false,
  autoAim: false,
  autoMove: false,
  autoAimRange: 620,
  deadzone: 0.15,
  forceTouchControls: false,
  southpaw: false,
  vibration: true,
  sfxVolume: 1,
  musicVolume: 1,
  zoom: 1,
};

export interface SettingsEvents extends Record<string, unknown> {
  change: { settings: InputSettings };
}

/**
 * Input accessibility settings.
 *
 * Auto-fire and auto-aim are the pair that makes the game playable one-thumbed,
 * so they are first-class toggles rather than a debug flag — on a touch device
 * both default to on (see `detectDefaults`), which reduces the mobile control
 * scheme to a single movement stick.
 */
export class SettingsStore {
  readonly events = new Emitter<SettingsEvents>();
  private state: InputSettings;

  constructor() {
    this.state = coerce({ ...DEFAULT_SETTINGS, ...detectDefaults(), ...load() });
  }

  get current(): Readonly<InputSettings> {
    return this.state;
  }

  set<K extends keyof InputSettings>(key: K, value: InputSettings[K]): void {
    if (this.state[key] === value) return;
    this.state = { ...this.state, [key]: value };
    save(this.state);
    this.events.emit('change', { settings: this.state });
  }

  toggle(key: 'autoFire' | 'autoAim' | 'autoMove' | 'forceTouchControls' | 'southpaw' | 'vibration'): void {
    this.set(key, !this.state[key]);
  }
}

/** Touch-primary devices get the assists switched on out of the box. */
function detectDefaults(): Partial<InputSettings> {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return coarse ? { autoFire: true, autoAim: true, forceTouchControls: true } : {};
}

function load(): Partial<InputSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? migrate(JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    // Private browsing, or storage disabled. Defaults are a fine answer.
    return {};
  }
}

/**
 * Bring a stored blob up to the current shape.
 *
 * Audio used to be a pair of on/off switches, so anyone who has played before
 * has `sfx: true` sitting in their storage. Reading that as a volume would be a
 * type error at best and a silently muted game at worst, so the old keys are
 * folded into the new ones and dropped. The storage key is deliberately *not*
 * bumped: a new key would be simpler but would also throw away the player's
 * callsign-adjacent preferences — deadzone, southpaw, assists — to fix audio.
 */
function migrate(raw: Record<string, unknown>): Partial<InputSettings> {
  const out = { ...raw };
  for (const [legacy, key] of [['sfx', 'sfxVolume'], ['music', 'musicVolume']] as const) {
    if (typeof out[legacy] === 'boolean') {
      if (out[key] === undefined) out[key] = out[legacy] ? 1 : 0;
      delete out[legacy];
    }
  }
  return out as Partial<InputSettings>;
}

/**
 * Clamp the numeric settings into their declared ranges.
 *
 * Storage outlives code and is trivially hand-editable, and these numbers now
 * reach a gain node and a deadzone divisor. A stray `NaN` here has already cost
 * us a day once (see the deadzone divide-by-zero), so nothing numeric leaves
 * this function unchecked.
 */
function coerce(state: InputSettings): InputSettings {
  const out = { ...state };
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const { min, max } = RANGES[key];
    const value = Number(out[key]);
    out[key] = !Number.isFinite(value) ? DEFAULT_SETTINGS[key] : value < min ? min : value > max ? max : value;
  }
  return out;
}

function save(settings: InputSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
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
} as const;
