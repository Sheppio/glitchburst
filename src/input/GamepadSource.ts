import { applyDeadzone, EMPTY_SAMPLE, filterAxis, HARDWARE_DEADZONE } from './sources.js';
import type { InputSource, PollContext, SourceSample } from './sources.js';

const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;

/** Standard Gamepad mapping. Xbox names first, PlayStation equivalent in the comment. */
export const BTN = {
  A: 0, // Cross
  B: 1, // Circle
  X: 2, // Square
  Y: 3, // Triangle
  LB: 4, // L1
  RB: 5, // R1
  LT: 6, // L2
  RT: 7, // R2
  VIEW: 8, // Share / Create
  MENU: 9, // Options / Start
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

/**
 * Whether a button is down.
 *
 * Analogue triggers report a `value` and may never set `pressed`; digital ones
 * only set `pressed`. Reading both is what makes L2/R2 work across the pads and
 * firmwares that disagree about which they are.
 */
const held = (button: GamepadButton | undefined): boolean =>
  button ? button.value > 0.35 || button.pressed : false;

/** Edge-triggered menu input, consumed by `ui/GamepadNavigator`. */
export interface NavPulse {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  back: boolean;
  menu: boolean;
  /** True while any pad is connected, so the UI can show controller hints. */
  connected: boolean;
}

const NAV_REPEAT_DELAY = 420;
const NAV_REPEAT_RATE = 130;

/**
 * Twin-stick scheme over the HTML5 Gamepad API (requirement 1b), tuned for
 * living-room and handheld browsers: Xbox Edge, the PlayStation web browser,
 * and the Steam Deck's Chrome/Edge flatpaks.
 *
 * The Gamepad API has no events for stick movement — a snapshot is only valid
 * for the frame you asked for it — so this polls `getGamepads()` fresh on every
 * call rather than caching a pad reference. Console browsers also hand out and
 * revoke pad slots aggressively when the system UI takes focus, which is why
 * `pad()` re-resolves the index instead of trusting the one it was given.
 */
export class GamepadSource implements InputSource {
  readonly id = 'pad' as const;
  readonly label = 'Controller';

  private index: number | null = null;
  /** Sticky: once the right stick has aimed, keep that angle when it recentres. */
  private lastAim = 0;
  private navHeld = new Map<number, number>();
  private navRepeat = new Map<number, number>();

  constructor() {
    window.addEventListener('gamepadconnected', this.onConnect);
    window.addEventListener('gamepaddisconnected', this.onDisconnect);
  }

  available(): boolean {
    return this.pad() !== null;
  }

  get connected(): boolean {
    return this.pad() !== null;
  }

  /** Pad identifier string, e.g. for showing Xbox vs PlayStation glyphs. */
  get padId(): string {
    return this.pad()?.id ?? '';
  }

  poll(ctx: PollContext): SourceSample {
    const pad = this.pad();
    if (!pad) return EMPTY_SAMPLE;

    // Drift filter first, feel curve second. See `sources.ts`.
    const lx = filterAxis(pad.axes[AXIS_LEFT_X] ?? 0);
    const ly = filterAxis(pad.axes[AXIS_LEFT_Y] ?? 0);
    const rx = filterAxis(pad.axes[AXIS_RIGHT_X] ?? 0);
    const ry = filterAxis(pad.axes[AXIS_RIGHT_Y] ?? 0);

    const dz = Math.max(HARDWARE_DEADZONE, ctx.settings.deadzone);
    const left = applyDeadzone(lx, ly, dz);
    const right = applyDeadzone(rx, ry, dz);

    if (right.mag > 0) this.lastAim = Math.atan2(right.y, right.x);

    // The PlayStation browser reports R2 as an axis on some firmwares, so the
    // right stick at full deflection is accepted as a fire intent too.
    const firing =
      held(pad.buttons[BTN.RT]) || pad.buttons[BTN.RB]?.pressed === true || right.mag > 0.85;

    // Triggers as a pair: right shoots, left is the ability. That is where a
    // player's fingers already are, and it is what every shooter on a console
    // has taught them to expect. A and L1 stay wired to it as well — they were
    // the original binding, and taking them away would break the muscle memory
    // of anyone who has been playing with them.
    const ability =
      held(pad.buttons[BTN.LT]) ||
      pad.buttons[BTN.A]?.pressed === true ||
      pad.buttons[BTN.LB]?.pressed === true;

    return {
      moveX: left.x,
      moveY: left.y,
      aim: this.lastAim,
      firing,
      ability,
      active: left.mag > 0 || right.mag > 0 || firing || ability,
    };
  }

  /**
   * Reusable haptics entry point (Gamepad Haptics API).
   *
   * Every browser that ships this exposes `dual-rumble`; Chromium also accepts
   * `trigger-rumble` on some pads, but no console browser does, so this sticks
   * to the one effect that works everywhere. Unsupported pads reject the
   * promise, which is a no-op rather than an error — haptics are a garnish and
   * must never break a frame.
   *
   * @param weakIntensity   0..1, the high-frequency motor (buzz)
   * @param strongIntensity 0..1, the low-frequency motor (thump)
   * @param durationMs      how long to run the effect
   */
  triggerRumble(weakIntensity: number, strongIntensity: number, durationMs: number): void {
    const actuator = this.actuator();
    if (!actuator) return;
    void actuator
      .playEffect?.('dual-rumble', {
        startDelay: 0,
        duration: Math.max(1, Math.round(durationMs)),
        weakMagnitude: clamp01(weakIntensity),
        strongMagnitude: clamp01(strongIntensity),
      })
      .catch(() => {
        /* effect type unsupported on this pad — nothing to recover from */
      });
  }

  stopRumble(): void {
    this.actuator()?.reset?.().catch(() => undefined);
  }

  /**
   * Start / Options, edge-triggered, on its own latch.
   *
   * The pause key is read by the game scene while `readNav` is read by the menu
   * navigator, and both can be live at once — paused, with the pause card open.
   * Sharing one latch made it a race: whichever polled first that frame
   * consumed the edge and the other saw nothing, so pressing Start to resume
   * either resumed or silently went fullscreen depending on rAF ordering. A
   * separate latch lets both observe the same physical button independently.
   */
  readPause(): boolean {
    const pad = this.pad();
    if (!pad) {
      this.pauseHeld = false;
      return false;
    }
    const down = pad.buttons[BTN.MENU]?.pressed === true;
    const pressed = down && !this.pauseHeld;
    this.pauseHeld = down;
    return pressed;
  }

  /**
   * Edge-detected menu navigation, so the front end is fully playable from the
   * pad without a virtual cursor. The D-pad and the left stick both drive it,
   * with key-repeat so holding a direction scrolls a long list.
   */
  readNav(): NavPulse {
    const pad = this.pad();
    if (!pad) {
      this.navHeld.clear();
      this.navRepeat.clear();
      return { up: false, down: false, left: false, right: false, confirm: false, back: false, menu: false, connected: false };
    }

    const lx = filterAxis(pad.axes[AXIS_LEFT_X] ?? 0);
    const ly = filterAxis(pad.axes[AXIS_LEFT_Y] ?? 0);
    const stickThreshold = 0.55;

    const down = (button: number, stick = false): boolean =>
      pad.buttons[button]?.pressed === true || stick;

    return {
      up: this.edge(BTN.DPAD_UP, down(BTN.DPAD_UP, ly < -stickThreshold), true),
      down: this.edge(BTN.DPAD_DOWN, down(BTN.DPAD_DOWN, ly > stickThreshold), true),
      left: this.edge(BTN.DPAD_LEFT, down(BTN.DPAD_LEFT, lx < -stickThreshold), true),
      right: this.edge(BTN.DPAD_RIGHT, down(BTN.DPAD_RIGHT, lx > stickThreshold), true),
      confirm: this.edge(BTN.A, down(BTN.A), false),
      back: this.edge(BTN.B, down(BTN.B), false),
      menu: this.edge(BTN.MENU, down(BTN.MENU), false),
      connected: true,
    };
  }

  destroy(): void {
    window.removeEventListener('gamepadconnected', this.onConnect);
    window.removeEventListener('gamepaddisconnected', this.onDisconnect);
  }

  /* ------------------------------------------------------------- internals */

  private pauseHeld = false;

  /** True on the press edge, then again on the repeat schedule while held. */
  private edge(button: number, isDown: boolean, repeat: boolean): boolean {
    const now = performance.now();
    const since = this.navHeld.get(button);

    if (!isDown) {
      this.navHeld.delete(button);
      this.navRepeat.delete(button);
      return false;
    }
    if (since === undefined) {
      this.navHeld.set(button, now);
      return true;
    }
    if (!repeat) return false;

    const held = now - since;
    if (held < NAV_REPEAT_DELAY) return false;
    const ticks = Math.floor((held - NAV_REPEAT_DELAY) / NAV_REPEAT_RATE);
    const lastTick = this.navRepeat.get(button) ?? -1;
    if (ticks > lastTick) {
      this.navRepeat.set(button, ticks);
      return true;
    }
    return false;
  }

  private actuator(): GamepadHapticActuator | null {
    const pad = this.pad();
    if (!pad) return null;
    // `vibrationActuator` is the modern path; `hapticActuators[0]` is the older
    // Firefox shape. Either is fine — both expose playEffect.
    const modern = (pad as Gamepad & { vibrationActuator?: GamepadHapticActuator }).vibrationActuator;
    if (typeof modern?.playEffect === 'function') return modern;
    const legacy = (pad as Gamepad & { hapticActuators?: GamepadHapticActuator[] }).hapticActuators?.[0];
    return typeof legacy?.playEffect === 'function' ? legacy : null;
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.index !== null) {
      const known = pads[this.index];
      if (known?.connected) return known;
      this.index = null;
    }
    for (const pad of pads) {
      if (pad?.connected) {
        this.index = pad.index;
        return pad;
      }
    }
    return null;
  }

  private onConnect = (e: Event): void => {
    this.index = (e as GamepadEvent).gamepad.index;
  };

  private onDisconnect = (): void => {
    this.index = null;
    this.navHeld.clear();
    this.navRepeat.clear();
  };
}

/**
 * Structural shape of the haptics actuator.
 *
 * Declared here rather than relying on lib.dom: the built-in type varies by
 * TypeScript version and by browser, and both the modern `vibrationActuator`
 * and Firefox's older `hapticActuators[0]` need to satisfy it. Both members are
 * optional so a partial implementation can be feature-detected rather than
 * assumed.
 */
interface GamepadHapticActuator {
  playEffect?(type: string, params: object): Promise<string>;
  reset?(): Promise<string>;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
