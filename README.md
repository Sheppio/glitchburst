# GLITCHBURST

A co-op top-down horde shooter that runs entirely in the browser. **No game server.**
Every client talks to a public MQTT broker over WebSockets, and one of them
volunteers to run the horde.

> Cyber-Pop Mainframe: a clean white-and-silver digital interface, neon accents,
> and a colourful malware infestation that bursts into pixel debris and leaked
> data strings when you kill it.

**[▶ Play](https://sheppio.github.io/glitchburst/)** — create a room, share the
link, up to four players.

---

## Stack, and why

| Choice | Reason |
| --- | --- |
| **Phaser 3.90** | Arcade-style 2D with WebGL batching, a particle system, camera FX, native Gamepad + multi-touch input, and a mature example corpus. Confined to `src/render/` so it stays replaceable. |
| **TypeScript, `tsc` only** | No bundler. `tsc` emits plain ES modules to `dist/`, which is committed. |
| **CDN import map** | `phaser` and `mqtt` resolve to jsDelivr at runtime, so there is nothing to install to *play*. |
| **MQTT.js 5.15 over WSS** | GitHub Pages is HTTPS, so plaintext `ws://` is blocked as mixed content. Every broker endpoint must be `wss://`. |
| **GitHub Pages** | The whole game is static files. Push to `main` and it deploys. |

## Running it

Playing needs nothing but a web server:

```bash
npm run serve      # http://localhost:8080
```

Developing needs the compiler:

```bash
npm install
npm run watch      # tsc --watch, rebuilding dist/ on save
npm test           # 64 tests: simulation, codec, single client, two clients
```

`dist/` is committed on purpose — it is what GitHub Pages serves.
**Rebuild and commit it with any change to `src/`.**

---

## Architecture

```
src/
├── net/      MQTT transport, topic map, wire codec, room + host election
├── sim/      authoritative horde AI, enemy stats, class definitions
├── input/    keyboard/mouse, gamepad, touch → one unified Intent
├── render/   Phaser scenes, procedural textures, effects, interpolation
├── ui/       DOM overlay: menu, class select, settings, HUD, gamepad nav
└── main.ts   wiring
```

`net/`, `sim/` and `input/` contain **no Phaser imports**. That is not
decoration — it is what lets `test/sim.test.mjs` run the entire horde
simulation headlessly in Node, and what lets a promoted peer start simulating
without inheriting any renderer state.

### Distributed host

There is no authority to hand out roles, so the clients derive it from a rule
that always converges:

> **The alive player with the lowest ID is the host.**

Player IDs are time-prefixed, so in practice that is whoever joined first. Every
client sorts the same roster and reaches the same answer with no negotiation.

The host heartbeats twice a second on `…/host/heartbeat`. Miss 2.5 seconds of
them and every client independently re-runs the sort; exactly one finds itself
at the front and promotes. The promoted peer **adopts** the enemies already on
its screen rather than clearing the board, so the horde keeps running through
the handover. If two clients ever claim the role at once, the higher ID stands
down the moment it hears the lower one's heartbeat.

Disconnects are also covered by an MQTT **Last Will** on the presence topic, so
a closed tab de-lists instantly instead of waiting out the timeout.

### Bandwidth: batching the horde

At the 100-enemy cap, one message per enemy at 20 Hz is 2,000 messages a second.
No public broker will carry that. Instead the host sends **one message for the
entire horde**, 20 times a second:

```
tds/room/<room>/horde/positions
e1,918,540,1,1l;e2,1177,1289,0,t;e3,1812,934,1,1l;…
 │   │   │  │ └── health (base36)
 │   │   │  └───── kind: 0 bug, 1 drone, 2 tank
 │   └───┴──────── position, rounded to whole world pixels
 └──────────────── enemy id
```

Measured at the cap: **1,851 bytes** per snapshot versus 4,492 as JSON (59%
smaller), or ~36 KB/s at 20 Hz. Positions round to whole pixels because peers
interpolate anyway, so the sub-pixel precision would be discarded on arrival.

Deaths, drone shots and wave banners batch the same way onto `…/horde/events`.

The host's tick is a **fixed 20 Hz timer, not the render loop**. Tying the
simulation to `requestAnimationFrame` would make the whole room's experience a
function of the host's graphics card — a host rendering at 8 fps would broadcast
at 8 Hz and simulate in 125 ms steps, and every peer would see a stuttering
horde through no fault of their own. There is a regression test for exactly
this: it CPU-throttles the renderer to ~14 fps and asserts the broadcast holds
at 20 Hz.

Because the host now refreshes its own enemies at 20 Hz too, it interpolates
them on the same path a peer does — one movement code path, and host and peers
cannot drift apart visually.

### Mid-game joins

Peers never simulate. They unpack the snapshot and — critically — **spawn any
enemy ID they do not recognise**. That single rule is the entire join story: a
player connecting during wave 7 receives the next snapshot 50 ms later and
materialises the whole horde at once, with no handshake and no state transfer.

The snapshot is complete state, so anything *missing* from it is dead — which
also cleans up kills whose death event was dropped.

### Hit detection: split authority

| Event | Decided by | Why |
| --- | --- | --- |
| Malware hits **you** | your own client, then broadcasts its health | zero latency to the thing that hurt you; nobody else can rule that you were hit |
| **You** hit malware | your client detects it and reports damage; the host applies it | the shooter sees its own hits instantly; enemy health still has exactly one owner |

Damage reports are coalesced per enemy over a 60 ms window, so a 7-pellet
shotgun blast is one message, not seven. The host is the only place enemy health
changes — and when the host shoots, it routes through the same queue rather than
mutating directly, so there is one code path, not two.

Healing follows the same logic in reverse: the Encoder's field is broadcast, and
each client heals *itself* while standing in it.

### Lag compensation

Snapshots land every 50 ms; frames happen every 16. Peers glide sprites toward
their targets with a **framerate-independent** factor:

```ts
smoothing(base, deltaMs) = 1 - (1 - base) ** (deltaMs / (1000/60))
```

The naive `pos += (target - pos) * 0.2` converges twice as fast at 144 Hz as at
60, so two players would literally see different games. Beyond a snap distance
the sprite jumps instead — that far a jump means a teleport really happened, and
smoothing across it would draw an enemy sliding through arena it was never in.

Enemy AI steers **straight at the nearest target** — no navmesh, no A*, no
line-of-sight. The only concession is a uniform-grid separation pass so the
horde spreads out instead of stacking, which stays ~O(n) at the cap.

---

## Classes

| | Role | Weapon | Ability |
| --- | --- | --- | --- |
| **Overclocker** | DPS | Overclocked Laser — piercing beam | +90% fire rate, +35% speed for 5s |
| **Fireman** | Tank | EMP Shotgun — 7 pellets, short range | Purge Pulse — knockback + stun in 265px |
| **Glitcher** | Utility | Fork Bomb SMG | Decoy Hologram — the horde chases it for 5s |
| **Encoder** | Support | Parity Lance | Checksum Field — heals allies inside for 8s |

Classes are **data**: a `ClassDef` drives the weapon entirely, and abilities
dispatch on one `switch`. A fifth class is a table entry plus one case.

The decoy's pull is a flat *distance discount*, not a multiplier — a multiplier
is useless exactly when the ability matters, since no plausible factor makes a
decoy 700px away beat a player the enemy is already touching.

## Enemies

| | HP | Speed | Behaviour |
| --- | --- | --- | --- |
| **Skittering Glitch Bug** | 30 | fast | charges straight in |
| **Rogue Firewall Drone** | 58 | medium | hovers at ~300px, strafes, fires |
| **Trojan Tank** | 265 | slow | walks through everything |

## Difficulty (1–4 players)

Two independent dials, applied per wave from the live roster:

- **Wave size** × `1 + 0.45 × (players − 1)` → 1.0× solo, **2.35× at four**.
- **Enemy health** × `1 + 0.12 × (players − 1)`, plus 9% per wave. Deliberately
  gentle: pushed harder it would punish the squad for grouping up, which is the
  opposite of what co-op should reward. Solo gets a further 10% discount.

Both track the roster live, so a player leaving eases the *next* wave rather
than leaving four players' worth of malware chasing one survivor. A downed
player counts the same way — the horde stops targeting them and difficulty
relaxes until they reboot. Decoys are excluded from the count entirely; baiting
the horde must not make the horde bigger.

A fifth arrival works out that it is the overflow (same sort as the election)
and backs out on its own.

---

## Controls

| | Move | Aim | Fire | Ability |
| --- | --- | --- | --- | --- |
| **Keyboard & mouse** | WASD / arrows | pointer | left click | Space / E / Shift |
| **Controller** | left stick | right stick | RT / RB | A / Cross, LB |
| **Touch** | left thumb (floating stick) | right thumb | right thumb | on-screen button |

Whichever device was used most recently owns the character — picking up a
controller mid-run just works.

### Accessibility

- **Auto-fire** — the weapon discharges whenever it comes off cooldown.
- **Auto-aim** — the angle tracks the nearest enemy in range, handing manual aim
  back when nothing is near.

Both default **on** for touch devices, which reduces the mobile scheme to a
single movement stick.

### Console & handheld

Tuned for Xbox Edge, the PlayStation browser and the Steam Deck:

- **Stick-drift filter.** A fixed **0.15 per-axis** threshold zeroes each axis
  before anything reads it, then a radial deadzone shapes the remaining travel.
  Per-axis kills drift; radial stops diagonals outrunning cardinals.
- **Haptics.** `triggerRumble(weak, strong, durationMs)` over the Gamepad
  Haptics API, with presets fired on **taking damage** and **activating an
  ability** (plus lighter taps for shots, kills and menu focus).
- **Full menu navigation.** D-pad or left stick moves a focus ring, A/Cross
  commits, B backs out — no virtual cursor. Navigation is *spatial* (compares
  bounding boxes), so the focus ring goes where you're looking on the class grid
  rather than following DOM order.
- **Focus prompt.** Console browsers only route gamepad input to the page while
  the page holds focus, so the menu says so, and **Menu/Options** goes fullscreen
  and pulls focus back.

---

## Topic map

All topics are under `tds/room/<roomId>/`:

| Topic | Published by | Rate |
| --- | --- | --- |
| `presence/<playerId>` | each player (+ Last Will) | 1 Hz |
| `host/heartbeat` | the host | 2 Hz |
| `player/<playerId>/state` | that player only | 15 Hz, plus immediately on damage |
| `horde/positions` | the host | 20 Hz, whole horde batched |
| `horde/events` | the host | 20 Hz, deaths / shots / waves |
| `enemy/<enemyId>/damage` | any shooter | coalesced, 60 ms window |
| `ability` | any player | on use |

Everything is **QoS 0**. This is a realtime game: a snapshot that arrives late is
worse than one that never arrives, because a fresher one is already behind it.

### A note on public brokers

The default endpoints (HiveMQ, EMQX, Mosquitto) are unauthenticated. **Anyone
can subscribe to your room topic**, there is no delivery ordering, and all three
rate-limit. Room codes are namespaced to make collisions unlikely, which is fine
for a game — just don't build anything that needs privacy on top of it.

---

## Tests

```bash
npm test
```

64 checks across three suites. The browser suites vendor Phaser locally and
swap MQTT for a loopback stub that relays over `BroadcastChannel`, so two tabs
share one "broker" and a real multi-client room can be tested offline.

- **`sim.test.mjs`** (31) — codec round-trips, truncation tolerance, payload
  size at the cap, enemy cap, difficulty scaling, damage attribution, steering,
  decoy priority, host adoption, shockwave.
- **`smoke.test.mjs`** (15) — menus, Phaser boot, election, 20 Hz batching,
  attacker-authority kills, abilities, and broadcast rate under a starved
  renderer.
- **`multiplayer.test.mjs`** (18) — two clients: election, peer unpacking,
  mid-game join, interpolation, squad scaling, and **host failover** with the
  horde carried through.

These caught five real bugs, including a zero-magnitude deadzone that produced
`NaN` movement — which propagated into enemy spawns and made *every* bullet
register a hit, because `NaN` fails every bounds check it is given — and the
host tick being coupled to the render loop, which CI surfaced by running the
game at 3 Hz on a software renderer.

### Known limitations

- Browsers throttle timers in background tabs, so a host that switches away
  slows its own simulation. The step clamps `dt` so the horde cannot teleport on
  return, but the room will run slowly until the host comes back. Election does
  not currently cover this case, because a throttled host still heartbeats.
- Public brokers give no delivery guarantees. Snapshots are full state, so a
  dropped one self-heals on the next tick; a dropped *damage report*, however,
  is simply lost.

## Deployment

GitHub Pages is set to **deploy from a branch**: `main`, folder `/ (root)`.
`.nojekyll` is present so nothing is filtered. To deploy: `npm run build`,
commit `dist/`, push.

CI (`.github/workflows/ci.yml`) deliberately **does not deploy**. The browser
suites are timing sensitive on shared runners, and a slow runner should not be
able to stop the site going up. CI does fail the build if committed `dist/` has
drifted from `src/`, which is the one way this layout could silently ship stale
code.
