import { BROKERS } from '../config.js';
import type { HudSnapshot } from '../render/GameScene.js';
import { CLASSES, CLASS_ORDER } from '../sim/classes.js';
import type { ClassId } from '../types.js';
import type { SettingsStore, InputSettings } from '../input/settings.js';
import type { NetStatus } from '../net/MqttNet.js';

export type ScreenId = 'menu' | 'join' | 'class' | 'settings' | 'connecting' | 'hud';

export interface UICallbacks {
  onCreateRoom(name: string): void;
  onJoinRoom(name: string, roomCode: string, brokerUrl: string): void;
  onDeploy(cls: ClassId): void;
  onLeave(): void;
  onCancelConnect(): void;
}

interface ToggleDef {
  key: keyof InputSettings;
  title: string;
  detail: string;
}

const TOGGLES: ToggleDef[] = [
  {
    key: 'autoFire',
    title: 'Auto-fire',
    detail: 'Weapons discharge automatically whenever they come off cooldown. No trigger needed.',
  },
  {
    key: 'autoAim',
    title: 'Auto-aim',
    detail: 'The weapon angle tracks the nearest live enemy in range. Manual aim returns when nothing is near.',
  },
  {
    key: 'forceTouchControls',
    title: 'On-screen sticks',
    detail: 'Show the virtual joysticks and ability button. On by default for touch devices.',
  },
  {
    key: 'southpaw',
    title: 'Southpaw layout',
    detail: 'Swap the movement and aim halves of the screen.',
  },
  {
    key: 'vibration',
    title: 'Haptics',
    detail: 'Controller rumble and device vibration on damage and ability use.',
  },
];

/**
 * The DOM overlay: menu, room entry, character select, settings and the HUD.
 *
 * Deliberately not drawn in Phaser. Real DOM means real focus management, real
 * text inputs with the platform's own soft keyboard, and a controller focus
 * ring that `GamepadNavigator` can drive with no game-specific widget code —
 * which is what makes the whole front end usable on a console without a
 * virtual pointer.
 */
export class UI {
  private screens = new Map<ScreenId, HTMLElement>();
  private selectedClass: ClassId = 'overclocker';
  private bannerTimer = 0;
  private current: ScreenId = 'menu';

  constructor(
    private root: HTMLElement,
    private settings: SettingsStore,
    private callbacks: UICallbacks,
  ) {
    for (const el of root.querySelectorAll<HTMLElement>('[data-screen]')) {
      this.screens.set(el.dataset['screen'] as ScreenId, el);
    }

    this.buildBrokerList();
    this.buildClassGrid();
    this.buildToggles();
    this.wireButtons();
    this.detectConsolePlatform();

    document.addEventListener('gb:focus-locked', () => {
      this.toast('Gamepad focus locked to the browser window.', 'good');
    });
  }

  get screen(): ScreenId {
    return this.current;
  }

  get callsign(): string {
    return this.input('input-callsign').value.trim() || 'ANON';
  }

  show(screen: ScreenId): void {
    this.current = screen;
    for (const [id, el] of this.screens) el.hidden = id !== screen;
    // The HUD is an overlay on live gameplay; every other screen is modal.
    this.root.classList.toggle('in-game', screen === 'hud');
  }

  setRoomCode(code: string): void {
    this.text('room-code-label', code);
    this.text('hud-room', code);
  }

  setNetStatus(status: NetStatus, detail?: string): void {
    const pill = this.el('net-status');
    pill.textContent = status;
    pill.className = `pill ${
      status === 'online' ? 'pill-online' : status === 'error' || status === 'offline' ? 'pill-error' : 'pill-idle'
    }`;
    if (detail) this.text('connect-detail', detail);
  }

  setScheme(label: string): void {
    this.text('scheme-pill', label);
  }

  setGamepadConnected(connected: boolean): void {
    document.body.classList.toggle('gamepad-active', connected);
    if (connected) this.toast('Controller detected — D-Pad to navigate, A to select.', 'good');
  }

  setConnectDetail(detail: string): void {
    this.text('connect-detail', detail);
  }

  /* -------------------------------------------------------------- the HUD */

  updateHud(s: HudSnapshot): void {
    this.text('hud-wave', String(s.wave));
    this.text('hud-enemies', String(s.enemies));
    this.text('hud-score', String(s.score));
    this.text('hud-players', `${s.players}/4`);
    this.text('hud-host', s.isHost ? 'THIS CLIENT' : s.hostName);

    const pct = s.maxHp > 0 ? Math.max(0, Math.min(1, s.hp / s.maxHp)) : 0;
    const fill = this.el('health-fill');
    fill.style.width = `${pct * 100}%`;
    fill.classList.toggle('low', pct < 0.35);
    this.text('health-text', s.downed ? `REBOOTING ${s.respawnIn.toFixed(1)}s` : `${s.hp} / ${s.maxHp}`);

    const ability = this.el('ability-chip');
    ability.classList.toggle('ready', s.abilityReady);
    this.text('ability-name', s.abilityName);
    this.text('ability-state', s.abilityReady ? 'READY' : `${s.abilityRemaining.toFixed(1)}s`);

    this.renderSquad(s.squad);
  }

  private renderSquad(squad: HudSnapshot['squad']): void {
    const host = this.el('hud-squad');
    // Rebuilding four rows per frame is cheap, but touching the DOM when
    // nothing changed is not — so bail if the signature is identical.
    const signature = squad.map((p) => `${p.id}:${p.hp}:${p.isHost}`).join('|');
    if (host.dataset['sig'] === signature) return;
    host.dataset['sig'] = signature;

    host.replaceChildren(
      ...squad.map((p) => {
        const def = CLASSES[p.cls] ?? CLASSES.overclocker;
        const row = document.createElement('div');
        row.className = `squad-row${p.isSelf ? ' is-self' : ''}${p.hp <= 0 ? ' is-down' : ''}`;
        row.style.setProperty('--accent', def.cssColour);

        const name = document.createElement('span');
        name.className = 'squad-name';
        name.textContent = p.name;
        if (p.isHost) {
          const mark = document.createElement('span');
          mark.className = 'host-mark';
          mark.textContent = '★';
          mark.title = 'Running the horde simulation';
          name.appendChild(mark);
        }

        const hp = document.createElement('span');
        hp.className = 'squad-hp';
        hp.textContent = `${p.hp}/${p.maxHp}`;

        row.append(name, hp);
        return row;
      }),
    );
  }

  banner(text: string, sub?: string): void {
    const el = this.el('hud-banner');
    this.text('hud-banner-text', text);
    this.text('hud-banner-sub', sub ?? '');
    el.hidden = false;
    // Restart the CSS animation on a repeat banner.
    el.style.animation = 'none';
    void el.offsetHeight;
    el.style.animation = '';

    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 1800);
  }

  toast(message: string, tone: 'info' | 'good' | 'warn' = 'info'): void {
    const host = this.el('toasts');
    const toast = document.createElement('div');
    toast.className = `toast${tone === 'info' ? '' : ` ${tone}`}`;
    toast.textContent = message;
    host.appendChild(toast);
    window.setTimeout(() => toast.remove(), 3600);
  }

  /* ------------------------------------------------------------ construction */

  private buildBrokerList(): void {
    const select = this.el('select-broker') as HTMLSelectElement;
    select.replaceChildren(
      ...BROKERS.map((broker) => {
        const option = document.createElement('option');
        option.value = broker.url;
        option.textContent = broker.label;
        return option;
      }),
    );
  }

  private buildClassGrid(): void {
    const grid = this.el('class-grid');
    grid.replaceChildren(
      ...CLASS_ORDER.map((id) => {
        const def = CLASSES[id];
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'class-card';
        card.style.setProperty('--accent', def.cssColour);
        card.setAttribute('aria-pressed', String(id === this.selectedClass));
        card.dataset['cls'] = id;

        card.innerHTML = `
          <span class="class-role">${def.role}</span>
          <div class="class-name">${def.name}</div>
          <p class="class-blurb">${def.blurb}</p>
          <div class="class-stats">
            <span>HP <b>${def.maxHp}</b></span>
            <span>SPD <b>${Math.round(def.speed / 10)}</b></span>
          </div>
          <div class="class-stats" style="margin-top:6px">
            <span>${def.weapon.name}</span>
          </div>
        `;

        card.addEventListener('click', () => this.selectClass(id));
        return card;
      }),
    );
  }

  private selectClass(id: ClassId): void {
    this.selectedClass = id;
    for (const card of this.root.querySelectorAll<HTMLElement>('.class-card')) {
      card.setAttribute('aria-pressed', String(card.dataset['cls'] === id));
    }
  }

  private buildToggles(): void {
    const list = this.el('toggle-list');
    list.replaceChildren(
      ...TOGGLES.map((def) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'toggle';
        button.dataset['key'] = def.key;

        const copy = document.createElement('div');
        copy.className = 'toggle-copy';
        copy.innerHTML = `<strong>${def.title}</strong><span>${def.detail}</span>`;

        const knob = document.createElement('span');
        knob.className = 'switch';

        button.append(copy, knob);
        button.addEventListener('click', () => {
          this.settings.set(def.key, !this.settings.current[def.key] as never);
          this.syncToggles();
        });
        return button;
      }),
    );

    const range = this.input('range-deadzone');
    range.value = String(this.settings.current.deadzone);
    range.addEventListener('input', () => {
      const value = Number(range.value);
      this.settings.set('deadzone', value);
      this.text('deadzone-value', value.toFixed(2));
    });

    this.syncToggles();
  }

  private syncToggles(): void {
    const settings = this.settings.current;
    for (const button of this.root.querySelectorAll<HTMLElement>('.toggle')) {
      const key = button.dataset['key'] as keyof InputSettings;
      button.setAttribute('aria-pressed', String(Boolean(settings[key])));
    }
    this.text('deadzone-value', settings.deadzone.toFixed(2));
  }

  private wireButtons(): void {
    this.on('btn-create', () => this.callbacks.onCreateRoom(this.callsign));
    this.on('btn-join-screen', () => this.show('join'));
    this.on('btn-settings', () => this.show('settings'));
    this.on('btn-settings-back', () => this.show(this.current === 'settings' ? 'menu' : this.current));
    this.on('btn-join-back', () => this.show('menu'));
    this.on('btn-class-back', () => this.show('menu'));
    this.on('btn-cancel-connect', () => this.callbacks.onCancelConnect());
    this.on('btn-deploy', () => this.callbacks.onDeploy(this.selectedClass));
    this.on('btn-leave', () => this.callbacks.onLeave());

    this.on('btn-join', () => {
      const code = this.input('input-room').value.trim().toUpperCase();
      if (code.length < 3) {
        this.toast('Enter the four-character room code.', 'warn');
        return;
      }
      const broker = (this.el('select-broker') as HTMLSelectElement).value;
      this.callbacks.onJoinRoom(this.callsign, code, broker);
    });

    // Enter submits whichever field the player is in — expected on desktop,
    // and it is also what a console soft keyboard's "done" key sends.
    this.input('input-room').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.el('btn-join').click();
    });
    // The callsign now lives on the character-select screen, so Enter there
    // means "deploy", not "create a room".
    this.input('input-callsign').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.el('btn-deploy').click();
    });
  }

  /**
   * Console and handheld detection, used only to decide whether to show the
   * gamepad-focus prompt before a pad has actually reported itself. Xbox and
   * PlayStation identify themselves in the UA; the Steam Deck does not, so it
   * is inferred from its distinctive 1280x800 touch-capable panel.
   */
  private detectConsolePlatform(): void {
    const ua = navigator.userAgent;
    const named = /Xbox|PlayStation|Nintendo|SteamDeck|Valve/i.test(ua);
    const deckShaped =
      /Linux/i.test(ua) && screen.width === 1280 && screen.height === 800 && navigator.maxTouchPoints > 0;

    if (named || deckShaped) document.body.classList.add('console-platform');
  }

  /* --------------------------------------------------------------- helpers */

  private el(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (!found) throw new Error(`UI element #${id} is missing from index.html`);
    return found;
  }

  private input(id: string): HTMLInputElement {
    return this.el(id) as HTMLInputElement;
  }

  private text(id: string, value: string): void {
    const el = this.el(id);
    if (el.textContent !== value) el.textContent = value;
  }

  private on(id: string, handler: () => void): void {
    this.el(id).addEventListener('click', handler);
  }
}
