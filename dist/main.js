import * as Phaser from 'phaser';
import { BROKERS, WORLD } from './config.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import { MqttNet } from './net/MqttNet.js';
import { RoomSession } from './net/RoomSession.js';
import { BootScene } from './render/BootScene.js';
import { GameScene } from './render/GameScene.js';
import { GamepadNavigator } from './ui/GamepadNavigator.js';
import { UI } from './ui/UI.js';
import { sanitizeName } from './net/codec.js';
import { makePlayerId, makeRoomCode } from './util.js';
/**
 * Application shell.
 *
 * Wires the four independent pieces together and owns nothing else:
 *
 *   input/  →  device abstraction        (no knowledge of the network)
 *   net/    →  MQTT transport + room     (no knowledge of Phaser)
 *   sim/    →  authoritative horde       (no knowledge of either)
 *   render/ →  Phaser scenes             (the only place Phaser appears)
 *
 * That separation is the point of the architecture: the game rules and the
 * netcode are plain modules, so the renderer is replaceable and the simulation
 * is testable headlessly.
 */
const uiRoot = document.getElementById('ui-root');
const gameRoot = document.getElementById('game-root');
if (!uiRoot || !gameRoot)
    throw new Error('index.html is missing #ui-root or #game-root');
const settings = new SettingsStore();
const net = new MqttNet();
const input = new InputManager(document.body, settings);
const playerId = makePlayerId();
let game = null;
let room = null;
let pendingRoomCode = '';
let pendingBrokerUrl = BROKERS[0].url;
let connecting = false;
const ui = new UI(uiRoot, settings, {
    onCreateRoom(name) {
        pendingRoomCode = makeRoomCode();
        pendingBrokerUrl = BROKERS[0].url;
        ui.setRoomCode(pendingRoomCode);
        ui.show('class');
        ui.toast(`Room ${pendingRoomCode} created. Share the code or the link.`, 'good');
        writeRoomToUrl(pendingRoomCode);
        void name;
    },
    onJoinRoom(_name, code, brokerUrl) {
        pendingRoomCode = code;
        pendingBrokerUrl = brokerUrl;
        ui.setRoomCode(code);
        ui.show('class');
        writeRoomToUrl(code);
    },
    onDeploy(cls) {
        void deploy(cls);
    },
    onLeave() {
        teardown();
        ui.show('menu');
        navigator_.start();
    },
    onCancelConnect() {
        connecting = false;
        teardown();
        ui.show('menu');
        navigator_.start();
    },
});
/** Menu navigation from a controller. Stopped in-game so A fires the ability. */
const navigator_ = new GamepadNavigator(input.gamepad, uiRoot);
navigator_.onConnection = (connected) => {
    ui.setGamepadConnected(connected);
    input.events.emit('schemeChange', { scheme: 'pad', label: 'Controller' });
};
input.events.on('schemeChange', ({ label }) => ui.setScheme(label));
net.events.on('status', ({ status, detail }) => {
    ui.setNetStatus(status, detail);
    if (status === 'error' && detail)
        ui.toast(`Broker error: ${detail}`, 'warn');
});
/* -------------------------------------------------------------- lifecycle */
async function deploy(cls) {
    if (connecting)
        return;
    connecting = true;
    ui.show('connecting');
    ui.setConnectDetail(`Opening WebSocket to ${hostOf(pendingBrokerUrl)}…`);
    navigator_.focusFirst();
    try {
        // MQTT client ids must be unique on a shared public broker, so the player
        // id — already unique and already the election key — is reused here.
        await net.connect(pendingBrokerUrl, `glitchburst-${playerId}`);
    }
    catch (err) {
        connecting = false;
        ui.show('menu');
        ui.toast(`Could not reach ${hostOf(pendingBrokerUrl)}. Try another broker.`, 'warn');
        console.error('[glitchburst] broker connect failed', err);
        return;
    }
    if (!connecting) {
        // Cancelled while the socket was opening.
        net.disconnect();
        return;
    }
    const name = sanitizeName(ui.callsign);
    ui.setConnectDetail('Joining room and resolving authority…');
    room = new RoomSession(net, pendingRoomCode, playerId, name, cls);
    room.join();
    const sceneInit = {
        net,
        room,
        input,
        settings,
        classId: cls,
        playerName: name,
        onHud: (snapshot) => ui.updateHud(snapshot),
        onBanner: (text, sub) => ui.banner(text, sub),
    };
    room.events.on('hostChange', ({ isHost, reason }) => {
        if (reason === 'initial' && isHost)
            ui.toast('You are the host — this client runs the horde.', 'good');
        else if (reason === 'election' && isHost)
            ui.toast('Host lost. Authority transferred to this client.', 'warn');
    });
    room.events.on('peerJoin', ({ peer }) => ui.toast(`${peer.name} connected.`));
    // Rooms hold four. A fifth arrival works this out for itself and backs out
    // rather than joining an overcrowded arena.
    room.events.on('roomFull', ({ capacity }) => {
        ui.toast(`Room ${pendingRoomCode} already holds ${capacity} players.`, 'warn');
        teardown();
        ui.show('menu');
        navigator_.start();
    });
    room.events.on('peerLeave', () => ui.toast('A player disconnected.', 'warn'));
    game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: gameRoot,
        backgroundColor: '#f2f5f9',
        scale: {
            mode: Phaser.Scale.RESIZE,
            autoCenter: Phaser.Scale.CENTER_BOTH,
            width: '100%',
            height: '100%',
        },
        render: { antialias: true, powerPreference: 'high-performance' },
        // The arena is fixed-size; the camera is bounded to it in GameScene.
        physics: undefined,
        scene: [BootScene, GameScene],
        callbacks: {
            preBoot: (instance) => instance.registry.set('sceneInit', sceneInit),
        },
    });
    // In-game the controller drives the character, so menu navigation stands down.
    navigator_.stop();
    document.body.classList.remove('nav-focus');
    ui.show('hud');
    ui.setRoomCode(pendingRoomCode);
    connecting = false;
}
function teardown() {
    room?.leave();
    room = null;
    net.disconnect();
    game?.destroy(true);
    game = null;
}
/* ------------------------------------------------------------------ misc */
/** Deep links: `?room=A7K2` prefills the join screen, so a code can be shared. */
function writeRoomToUrl(code) {
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url.toString());
}
function readRoomFromUrl() {
    const code = new URL(window.location.href).searchParams.get('room');
    if (!code)
        return;
    const field = document.getElementById('input-room');
    if (field)
        field.value = code.toUpperCase().slice(0, 6);
    ui.show('join');
    ui.toast(`Room ${code.toUpperCase()} loaded from link.`);
}
function hostOf(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return url;
    }
}
// Leaving the tab should de-list this player immediately rather than waiting
// for the presence timeout to expire.
window.addEventListener('pagehide', () => {
    room?.leave();
    net.disconnect();
});
ui.show('menu');
ui.setNetStatus('idle');
ui.setScheme(input.activeLabel);
navigator_.start();
readRoomFromUrl();
// The arena size is a compile-time constant; surface it for anyone poking at
// the console, alongside the pieces worth inspecting live.
Object.assign(window, {
    glitchburst: {
        get room() {
            return room;
        },
        get game() {
            return game;
        },
        net,
        input,
        settings,
        world: WORLD,
        playerId,
    },
});
//# sourceMappingURL=main.js.map