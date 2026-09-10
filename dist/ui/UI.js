import { BROKERS } from '../config.js';
import { CLASSES, CLASS_ORDER, isClassId } from '../sim/classes.js';
/** Where the player's callsign and last class are remembered between visits. */
const CALLSIGN_KEY = 'glitchburst.callsign';
const CLASS_KEY = 'glitchburst.class';
const TOGGLES = [
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
/**
 * Last class played, restored on load.
 *
 * Validated against the class table rather than trusted: stored values outlive
 * code, and a class removed in a later build must not leave the selector
 * pointing at something that no longer exists.
 */
function readStoredClass() {
    try {
        const saved = localStorage.getItem(CLASS_KEY);
        if (saved && isClassId(saved))
            return saved;
    }
    catch {
        /* storage unavailable */
    }
    return 'overclocker';
}
export class UI {
    root;
    settings;
    callbacks;
    screens = new Map();
    selectedClass = readStoredClass();
    bannerTimer = 0;
    current = 'menu';
    constructor(root, settings, callbacks) {
        this.root = root;
        this.settings = settings;
        this.callbacks = callbacks;
        for (const el of root.querySelectorAll('[data-screen]')) {
            this.screens.set(el.dataset['screen'], el);
        }
        this.restoreCallsign();
        this.buildBrokerList();
        this.buildClassGrid();
        this.buildToggles();
        this.wireButtons();
        this.detectConsolePlatform();
        document.addEventListener('gb:focus-locked', () => {
            this.toast('Gamepad focus locked to the browser window.', 'good');
        });
    }
    get screen() {
        return this.current;
    }
    get callsign() {
        return this.input('input-callsign').value.trim() || 'ANON';
    }
    /**
     * Remember the callsign across reloads.
     *
     * Stored on input rather than on deploy, so a name typed and then abandoned
     * mid-flow is still there next time — the failure mode this fixes is retyping
     * your name on every refresh, and half-finished attempts count.
     */
    restoreCallsign() {
        const field = this.input('input-callsign');
        try {
            const saved = localStorage.getItem(CALLSIGN_KEY);
            if (saved)
                field.value = saved;
        }
        catch {
            // Private browsing, or storage blocked. An empty field is a fine default.
        }
        field.addEventListener('input', () => {
            try {
                localStorage.setItem(CALLSIGN_KEY, field.value.trim().slice(0, 14));
            }
            catch {
                /* nothing to do — this session just will not remember it */
            }
        });
    }
    show(screen) {
        this.current = screen;
        for (const [id, el] of this.screens)
            el.hidden = id !== screen;
        // The HUD is an overlay on live gameplay; every other screen is modal.
        this.root.classList.toggle('in-game', screen === 'hud');
    }
    setRoomCode(code) {
        this.text('room-code-label', code);
        this.text('hud-room', code);
    }
    setNetStatus(status, detail) {
        const pill = this.el('net-status');
        pill.textContent = status;
        pill.className = `pill ${status === 'online' ? 'pill-online' : status === 'error' || status === 'offline' ? 'pill-error' : 'pill-idle'}`;
        if (detail)
            this.text('connect-detail', detail);
    }
    setScheme(label) {
        this.text('scheme-pill', label);
    }
    setGamepadConnected(connected) {
        document.body.classList.toggle('gamepad-active', connected);
        if (connected)
            this.toast('Controller detected — D-Pad to navigate, A to select.', 'good');
    }
    setConnectDetail(detail) {
        this.text('connect-detail', detail);
    }
    /* -------------------------------------------------------------- the HUD */
    updateHud(s) {
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
        this.text('chips-count', `${s.chips} / ${s.chipsPerPowerUp}`);
        this.el('chips-fill').style.width = `${(s.chips / Math.max(1, s.chipsPerPowerUp)) * 100}%`;
        this.renderUpgrades(s.upgrades);
        // Pause is host-only: peers see the veil but get no control, because the
        // horde they would be resuming does not run on their machine.
        const pauseButton = this.el('btn-pause');
        pauseButton.hidden = !s.canPause;
        pauseButton.textContent = s.paused ? 'Resume' : 'Pause';
        const veil = this.el('pause-veil');
        if (veil.hidden === s.paused)
            veil.hidden = !s.paused;
        if (s.paused) {
            this.text('pause-by', s.canPause ? 'You paused the room' : `Paused by ${s.pausedBy || 'the host'}`);
            this.el('btn-resume').hidden = !s.canPause;
            this.text('pause-hint', s.canPause ? 'Esc or P · Start on a controller' : 'Waiting for the host to resume');
        }
        this.el('chip-autoaim').setAttribute('aria-pressed', String(this.settings.current.autoAim));
        this.el('chip-autofire').setAttribute('aria-pressed', String(this.settings.current.autoFire));
        this.renderSquad(s.squad);
    }
    /** Stack counts per upgrade. Dimmed until the player owns at least one. */
    renderUpgrades(upgrades) {
        const host = this.el('upgrade-stacks');
        const signature = upgrades.map((u) => `${u.short}${u.stacks}`).join('|');
        if (host.dataset['sig'] === signature)
            return;
        host.dataset['sig'] = signature;
        host.replaceChildren(...upgrades.map((u) => {
            const chip = document.createElement('span');
            chip.className = `upgrade-stack${u.stacks > 0 ? ' owned' : ''}`;
            chip.style.setProperty('--accent', u.cssColour);
            chip.textContent = u.stacks > 0 ? `${u.short} ×${u.stacks}` : u.short;
            return chip;
        }));
    }
    renderSquad(squad) {
        const host = this.el('hud-squad');
        // Rebuilding four rows per frame is cheap, but touching the DOM when
        // nothing changed is not — so bail if the signature is identical.
        const signature = squad.map((p) => `${p.id}:${p.hp}:${p.isHost}`).join('|');
        if (host.dataset['sig'] === signature)
            return;
        host.dataset['sig'] = signature;
        host.replaceChildren(...squad.map((p) => {
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
        }));
    }
    banner(text, sub) {
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
    toast(message, tone = 'info') {
        const host = this.el('toasts');
        const toast = document.createElement('div');
        toast.className = `toast${tone === 'info' ? '' : ` ${tone}`}`;
        toast.textContent = message;
        host.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3600);
    }
    /* ------------------------------------------------------------ construction */
    buildBrokerList() {
        const select = this.el('select-broker');
        select.replaceChildren(...BROKERS.map((broker) => {
            const option = document.createElement('option');
            option.value = broker.url;
            option.textContent = broker.label;
            return option;
        }));
    }
    buildClassGrid() {
        const grid = this.el('class-grid');
        grid.replaceChildren(...CLASS_ORDER.map((id) => {
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
        }));
    }
    selectClass(id) {
        this.selectedClass = id;
        try {
            localStorage.setItem(CLASS_KEY, id);
        }
        catch {
            /* storage unavailable — the choice simply will not survive a reload */
        }
        for (const card of this.root.querySelectorAll('.class-card')) {
            card.setAttribute('aria-pressed', String(card.dataset['cls'] === id));
        }
    }
    buildToggles() {
        const list = this.el('toggle-list');
        list.replaceChildren(...TOGGLES.map((def) => {
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
                this.settings.set(def.key, !this.settings.current[def.key]);
                this.syncToggles();
            });
            return button;
        }));
        const range = this.input('range-deadzone');
        range.value = String(this.settings.current.deadzone);
        range.addEventListener('input', () => {
            const value = Number(range.value);
            this.settings.set('deadzone', value);
            this.text('deadzone-value', value.toFixed(2));
        });
        this.syncToggles();
    }
    syncToggles() {
        const settings = this.settings.current;
        for (const button of this.root.querySelectorAll('.toggle')) {
            const key = button.dataset['key'];
            button.setAttribute('aria-pressed', String(Boolean(settings[key])));
        }
        this.text('deadzone-value', settings.deadzone.toFixed(2));
    }
    wireButtons() {
        this.on('btn-create', () => this.callbacks.onCreateRoom(this.callsign));
        this.on('btn-join-screen', () => this.show('join'));
        this.on('btn-settings', () => this.show('settings'));
        this.on('btn-settings-back', () => this.show(this.current === 'settings' ? 'menu' : this.current));
        this.on('btn-join-back', () => this.show('menu'));
        this.on('btn-class-back', () => this.show('menu'));
        this.on('btn-cancel-connect', () => this.callbacks.onCancelConnect());
        this.on('btn-deploy', () => this.callbacks.onDeploy(this.selectedClass));
        this.on('btn-leave', () => this.callbacks.onLeave());
        // Assists are the difference between playable and unplayable on a phone,
        // so they are reachable mid-match rather than only from the settings menu.
        this.on('btn-pause', () => this.callbacks.onTogglePause());
        this.on('btn-resume', () => this.callbacks.onTogglePause());
        this.on('chip-autoaim', () => this.settings.toggle('autoAim'));
        this.on('chip-autofire', () => this.settings.toggle('autoFire'));
        this.on('btn-join', () => {
            const code = this.input('input-room').value.trim().toUpperCase();
            if (code.length < 3) {
                this.toast('Enter the four-character room code.', 'warn');
                return;
            }
            const broker = this.el('select-broker').value;
            this.callbacks.onJoinRoom(this.callsign, code, broker);
        });
        // Enter submits whichever field the player is in — expected on desktop,
        // and it is also what a console soft keyboard's "done" key sends.
        this.input('input-room').addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                this.el('btn-join').click();
        });
        // The callsign now lives on the character-select screen, so Enter there
        // means "deploy", not "create a room".
        this.input('input-callsign').addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                this.el('btn-deploy').click();
        });
    }
    /**
     * Console and handheld detection, used only to decide whether to show the
     * gamepad-focus prompt before a pad has actually reported itself. Xbox and
     * PlayStation identify themselves in the UA; the Steam Deck does not, so it
     * is inferred from its distinctive 1280x800 touch-capable panel.
     */
    detectConsolePlatform() {
        const ua = navigator.userAgent;
        const named = /Xbox|PlayStation|Nintendo|SteamDeck|Valve/i.test(ua);
        const deckShaped = /Linux/i.test(ua) && screen.width === 1280 && screen.height === 800 && navigator.maxTouchPoints > 0;
        if (named || deckShaped)
            document.body.classList.add('console-platform');
    }
    /* --------------------------------------------------------------- helpers */
    el(id) {
        const found = document.getElementById(id);
        if (!found)
            throw new Error(`UI element #${id} is missing from index.html`);
        return found;
    }
    input(id) {
        return this.el(id);
    }
    text(id, value) {
        const el = this.el(id);
        if (el.textContent !== value)
            el.textContent = value;
    }
    on(id, handler) {
        this.el(id).addEventListener('click', handler);
    }
}
//# sourceMappingURL=UI.js.map