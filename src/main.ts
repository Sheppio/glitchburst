import * as Phaser from 'phaser';
import { BROKERS, WORLD } from './config.js';
import { AudioBus } from './audio/AudioBus.js';
import { Music } from './audio/Music.js';
import { Sfx } from './audio/Sfx.js';
import { InputManager } from './input/InputManager.js';
import { SettingsStore } from './input/settings.js';
import { MqttNet } from './net/MqttNet.js';
import { RoomSession } from './net/RoomSession.js';
import { BootScene } from './render/BootScene.js';
import { GameScene } from './render/GameScene.js';
import type { GameSceneInit, HudSnapshot } from './render/GameScene.js';
import type { ClassId } from './types.js';
import { GamepadNavigator } from './ui/GamepadNavigator.js';
import { UI } from './ui/UI.js';
import { sanitizeName } from './net/codec.js';
import { isClassId } from './sim/classes.js';
import { orderSquad } from './render/squadOrder.js';
import type { LobbyMember } from './ui/UI.js';
import { VERSION } from './version.js';
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
if (!uiRoot || !gameRoot) throw new Error('index.html is missing #ui-root or #game-root');

const settings = new SettingsStore();

/**
 * Audio.
 *
 * The context cannot be created until the player interacts — browsers refuse to
 * start audio without a gesture — so the bus stays dormant and the first click,
 * tap or keypress brings it up. Everything downstream no-ops until then.
 */
const audio = new AudioBus();
const sfx = new Sfx(audio);
const music = new Music(audio);

const unlockAudio = () => {
  audio.unlock();
  applyVolumes();
};

const applyVolumes = () => {
  audio.setVolume('sfx', settings.current.sfxVolume);
  audio.setVolume('music', settings.current.musicVolume);
};

/**
 * Music follows the level, not just the match.
 *
 * The scheduler is real work — a 25ms interval building oscillators — so a
 * muted track is stopped outright rather than left running into a zero gain.
 * That makes the level a start/stop signal too: sliding music back up from the
 * pause screen has to bring the scheduler back with it.
 */
const syncMusic = () => {
  if (game && settings.current.musicVolume > 0) music.start();
  else music.stop();
};
for (const event of ['pointerdown', 'keydown', 'touchstart'] as const) {
  window.addEventListener(event, unlockAudio, { passive: true });
}

settings.events.on('change', () => {
  applyVolumes();
  syncMusic();
});
const net = new MqttNet();
const input = new InputManager(document.body, settings);
const playerId = makePlayerId();

let game: Phaser.Game | null = null;
let room: RoomSession | null = null;
let pendingRoomCode = '';
let pendingBrokerUrl = BROKERS[0]!.url;
let connecting = false;
let lastClass: ClassId = 'overclocker';

const ui = new UI(uiRoot, settings, {
  onCreateRoom(name) {
    pendingRoomCode = makeRoomCode();
    pendingBrokerUrl = BROKERS[0]!.url;
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

  onStartRun() {
    startRun();
  },

  onReturnToLobby() {
    endRun();
    ui.setLobby(lobbyRoster(), room?.isHost ?? false);
    ui.show('lobby');
    navigator_.start();
  },

  onLeave() {
    teardown();
    ui.show('menu');
    navigator_.start();
  },


  onTogglePause() {
    const scene = game?.scene.getScene('game') as GameScene | undefined;
    scene?.togglePause();
  },

  /**
   * A menu opened or closed over a live match.
   *
   * The pad drives the character in-game, so menu navigation stands down on
   * deploy — which leaves every mid-match menu unreachable from a controller
   * unless it asks for navigation back. The pause card, the failure screen and
   * settings all do.
   */
  onMenuVisible(visible) {
    if (visible) {
      navigator_.start();
      navigator_.focusFirst();
      return;
    }
    // Stand down only when there is a character for the pad to drive. Closing
    // a menu with no match behind it — the failure screen handing back to the
    // lobby — must leave navigation running, or the controller goes dead on a
    // perfectly ordinary menu screen.
    if (game) {
      navigator_.stop();
      document.body.classList.remove('nav-focus');
    } else {
      navigator_.start();
    }
  },

  onCancelConnect() {
    connecting = false;
    teardown();
    ui.show('menu');
    navigator_.start();
  },
}, sfx);

/** Menu navigation from a controller. Stopped in-game so A fires the ability. */
const navigator_ = new GamepadNavigator(input.gamepad, uiRoot);
navigator_.onConnection = (connected) => {
  ui.setGamepadConnected(connected);
  input.events.emit('schemeChange', { scheme: 'pad', label: 'Controller' });
};

// A freshly shown screen puts the ring on its first control, so a controller
// player is never left with focus on something that is no longer on screen.
document.addEventListener('gb:screen-shown', () => {
  if (navigator_.connected) navigator_.focusFirst();
});

input.events.on('schemeChange', ({ label }) => ui.setScheme(label));
net.events.on('status', ({ status, detail }) => {
  ui.setNetStatus(status, detail);
  if (status === 'error' && detail) ui.toast(`Broker error: ${detail}`, 'warn');
});

/* -------------------------------------------------------------- lifecycle */

async function deploy(cls: ClassId): Promise<void> {
  if (connecting) return;
  connecting = true;
  lastClass = cls;

  ui.show('connecting');
  ui.setConnectDetail(`Opening WebSocket to ${hostOf(pendingBrokerUrl)}…`);
  navigator_.focusFirst();

  try {
    // MQTT client ids must be unique on a shared public broker, so the player
    // id — already unique and already the election key — is reused here.
    await net.connect(pendingBrokerUrl, `glitchburst-${playerId}`);
  } catch (err) {
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

  room.events.on('hostChange', ({ isHost, reason }) => {
    if (reason === 'initial' && isHost) ui.toast('You are the host — this client runs the horde.', 'good');
    else if (reason === 'election' && isHost) ui.toast('Host lost. Authority transferred to this client.', 'warn');
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

  // The lobby roster is just the room's presence list, which already carries
  // every player's name and class.
  const refreshLobby = (): void => {
    if (!room) return;
    ui.setLobby(lobbyRoster(), room.isHost);
  };
  for (const event of ['roster', 'peerJoin', 'peerLeave', 'hostChange'] as const) {
    room.events.on(event, refreshLobby);
  }

  /**
   * A run in progress pulls everyone in.
   *
   * The host's heartbeat carries whether the room is playing, twice a second,
   * so this is also the whole late-join story: someone arriving mid-match sees
   * `running` within half a second and walks straight into the wave, which the
   * horde snapshot then materialises for them.
   */
  room.events.on('hostStats', ({ running }) => {
    if (running === true && !game) startRun();
  });

  ui.setRoomCode(pendingRoomCode);
  refreshLobby();
  ui.show('lobby');
  connecting = false;
}

/** The room's presence list, as the lobby wants to read it. */
function lobbyRoster(): LobbyMember[] {
  const session = room;
  if (!session) return [];
  const me: LobbyMember = {
    id: playerId,
    name: sanitizeName(ui.callsign),
    cls: lastClass,
    isSelf: true,
    isHost: session.isHost,
  };
  const others: LobbyMember[] = [...session.peers.values()].map((peer) => ({
    id: peer.id,
    name: peer.name,
    cls: isClassId(peer.cls) ? peer.cls : 'overclocker',
    isSelf: false,
    isHost: session.hostId === peer.id,
  }));
  // Same order as the in-game squad bars, so the roster does not reshuffle
  // between the lobby and the match.
  return orderSquad([me, ...others]);
}

/**
 * Boot the match.
 *
 * Split from `deploy` so the room outlives any single run: the broker
 * connection and the presence roster are set up once, and a run is created and
 * destroyed inside them. That is what makes returning to a populated lobby
 * afterwards possible at all.
 */
function startRun(): void {
  if (!room || game) return;

  const name = sanitizeName(ui.callsign);
  const sceneInit: GameSceneInit = {
    net,
    room,
    input,
    settings,
    classId: lastClass,
    playerName: name,
    sfx,
    onHud: (snapshot: HudSnapshot) => ui.updateHud(snapshot),
    onBanner: (text, sub) => ui.banner(text, sub),
  };

  // The host is the one that declares the room to be playing; peers follow.
  if (room.isHost) room.running = true;

  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: gameRoot as HTMLElement,
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
  // The on-screen sticks belong to the match, not the menu.
  input.setInGame(true);
  // Music belongs to the match. Starting it on the menu ambushes anyone who
  // opened a shared link somewhere they would rather not be making noise.
  unlockAudio();
  syncMusic();
  ui.show('hud');
  ui.setRoomCode(pendingRoomCode);
}

/**
 * End the run but keep the room.
 *
 * The Phaser game is disposable; the broker connection and the roster are not.
 * Tearing both down together is what used to make "play again" a round trip
 * through the main menu.
 */
function endRun(): void {
  music.stop();
  input.setInGame(false);
  if (room?.isHost) room.running = false;
  game?.destroy(true);
  game = null;
}

function teardown(): void {
  endRun();
  room?.leave();
  room = null;
  net.disconnect();
}

/* ------------------------------------------------------------------ misc */

/** Deep links: `?room=A7K2` prefills the join screen, so a code can be shared. */
function writeRoomToUrl(code: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url.toString());
}

function readRoomFromUrl(): void {
  const code = new URL(window.location.href).searchParams.get('room');
  if (!code) return;
  const field = document.getElementById('input-room') as HTMLInputElement | null;
  if (field) field.value = code.toUpperCase().slice(0, 6);
  ui.show('join');
  ui.toast(`Room ${code.toUpperCase()} loaded from link.`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
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
Object.assign(window as unknown as Record<string, unknown>, {
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
    version: VERSION,
    audio,
    music,
    sfx,
  },
});
