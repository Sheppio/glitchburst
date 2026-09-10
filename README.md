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
npm test           # 141 tests: simulation, codec, single client, mobile, two clients
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

| | Role | DPS | HP | Range | Ability |
| --- | --- | --- | --- | --- | --- |
| **Overclocker** | DPS | 116 | 100 | 825 | +90% fire rate, +35% speed for 5s |
| **Fireman** | Tank | 90 | 190 | 246 | Purge Pulse — knockback + stun in 265px |
| **Glitcher** | Utility | 69 | 90 | 765 | Decoy Hologram — the horde chases it for 5s |
| **Encoder** | Support | 59 | 120 | 658 | Checksum Field — heals allies inside for 8s |

Those figures are on the class-select cards. The quoted DPS discounts spread
weapons by a pellet-connection factor, so the Fireman reads 90 rather than its
paper 150 — that only lands with all seven pellets on one target at point-blank.
One definition in `classes.ts` feeds both the card and the auto-aim scorer, so
the number shown is the number the game reasons with.

Classes are **data**: a `ClassDef` drives the weapon entirely, and abilities
dispatch on one `switch`. A fifth class is a table entry plus one case.

The decoy's pull is a flat *distance discount*, not a multiplier — a multiplier
is useless exactly when the ability matters, since no plausible factor makes a
decoy 700px away beat a player the enemy is already touching.

### Reading the fight

Enemy health bars appear **only once an enemy has been damaged**. A bar over
every enemy would be noise — at the cap that is a hundred of them — and the
thing a player actually wants to spot is the one that is nearly dead. Hiding
them at full health makes a visible bar *mean* something: a target worth
finishing, and a legible record of what the rest of the squad has softened up.

Max health is not on the wire, since it scales with wave and squad size; peers
infer it from the highest value they have seen. That is exact for any enemy the
client watched spawn, and briefly optimistic for one that was already damaged
when they joined.

## Enemies

| | HP | Speed | Behaviour |
| --- | --- | --- | --- |
| **Skittering Glitch Bug** | 30 | fast | charges straight in |
| **Rogue Firewall Drone** | 58 | medium | hovers at ~300px, strafes, fires |
| **Trojan Tank** | 265 | slow | walks through everything |

## Progression

Dead malware drops **compute chips**. Ten convert into a **power-up** that
materialises beside you; walking into it grants a stacking upgrade — damage
(+18%), movement speed (+8%) or fire rate (+11%), each capped. Firewall Drones
(6%) and Trojan Tanks (22%) can also drop one outright, so committing to a tank
while a wave closes is a decision rather than a chore.

Rolls are weighted toward whatever you have least of, so a long run broadens a
build instead of dumping a twelfth damage stack on someone who has never seen a
speed boost.

**Chips never touch the wire.** Every client spawns them independently from
death events it already receives, and each player collects their own. The
obvious alternative — host owns the loot, clients ask to pick it up — is worse
in every dimension that matters: a round trip on the most tactile interaction in
the game, arbitration when two players reach the same chip, and pickups feeling
laggy on exactly the connection already struggling. Per-player costs nothing,
removes the race, and is better co-op design: nobody competes with their squad
for loot. Drop counts are fixed per kind and both the scatter and the rare-drop
roll derive from the enemy id, so every client produces the same pile.

Chips accelerate toward you without damping once they latch on. That asymmetry
is deliberate: you have a top speed and a chip does not, so a chip can never be
outrun.

## Wave pacing

A fixed interval cannot work here. Wave size grows linearly and enemy health
grows with it, so the damage a wave represents grows roughly **quadratically**.
Against a constant timer, the DPS needed to keep up outruns any possible player
by about wave five and the field saturates at the enemy cap shortly after — the
original 14-second timer needed 154 DPS by wave 5 and 289 by wave 8, against a
best case of 116. No amount of skill closes a quadratic gap.

So the timer scales with the size of the wave it is pacing, and clearing the
field early pulls the next wave forward, subject to a five-second floor.
Required DPS then grows roughly linearly, and the game responds to how you are
actually doing: play well and waves come faster (and so do chips), struggle and
the full window is there to recover in.

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

## Pause

The host can freeze the whole room — **Esc** or **P**, Start/Options on a pad,
or the Pause button. Pause is a property of the room rather than of a client,
because the horde only exists on one machine: a peer that stopped rendering
locally would still be walked into by enemies the host kept simulating. So the
host owns the flag, broadcasts it, and stops stepping; everyone else freezes
because the snapshots stop changing. The flag also rides on the heartbeat, so a
client joining a paused room learns about it within 500 ms.

Peers see the veil but get no resume control. Leave stays clickable while
paused.

## Aiming

The chassis **turns at a fixed rate** rather than snapping to the aim angle, and
shots leave along the barrel's actual facing — so it is a mechanic, not an
animation: you cannot snap-fire behind you, and auto-aim visibly swings onto its
target. Tunable via `PLAYER.turnRateRpm` (default 240 RPM: four turns a second,
a 180-degree spin in 133 ms).

Auto-aim scores every candidate by **how long it would take to eliminate**, not
by distance. Nearest-enemy is the obvious rule and the wrong one — it abandons
an enemy you are one shot from killing the moment something healthier wanders
closer, so damage smears across a crowd and nothing dies. Three costs, all in
seconds so they simply add:

```
score = timeToAim + timeToReach + timeToKill + rangePenalty
```

An enemy at 5% health has a near-zero `timeToKill` and keeps the lock even once
something healthier gets nearer. The held target gets a 28% discount so
near-equal candidates cannot flip-flop and leave the barrel jittering between
two enemies while hitting neither. Targets beyond weapon range are penalised
rather than excluded — facing a distant threat beats facing nothing.

It lives in `sim/targeting.ts` as pure functions with the constants in
`TARGETING`, so the formula is unit tested and tunable directly.

## Seeing the rest of the squad

Clients broadcast **trigger pulls, not projectiles** — origin and angle only,
batched at the player-state cadence and published only when there is something
to send. Pellet count, spread, speed and lifetime are rebuilt from the shooter's
class, which every client already knows, so a seven-pellet blast is one
fourteen-byte record rather than seven messages (~140 B/s per player against the
horde stream's 36 KB/s).

Remote rounds are explicitly **inert**: zero damage, no collision test. Under
attacker authority only the shooter's client decides whether its rounds
connected, so anything else would double-resolve every hit.

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

141 checks across four suites. The browser suites vendor Phaser locally and
swap MQTT for a loopback stub that relays over `BroadcastChannel`, so two tabs
share one "broker" and a real multi-client room can be tested offline.

- **`sim.test.mjs`** (75) — codec round-trips, truncation tolerance, payload
  size at the cap, enemy cap, difficulty scaling, wave pacing, damage
  attribution, steering, decoy priority, host adoption, shockwave, progression
  and upgrade caps, deterministic drop rolls, turn-rate limiting, and the
  auto-aim scoring formula.
- **`smoke.test.mjs`** (25) — menus, persistence, Phaser boot, election, 20 Hz
  batching, attacker-authority kills, point-blank hits, chip pickup and
  conversion, turn rate, abilities, pause, and broadcast rate under a starved
  renderer.
- **`mobile.test.mjs`** (14) — an emulated Pixel with a touchscreen and no
  mouse: taps through the whole flow, and hit-tests that nothing invisible is
  covering the buttons.
- **`multiplayer.test.mjs`** (27) — two clients: election, peer unpacking,
  mid-game join, interpolation, squad scaling, seeing each other's fire, pause
  propagation, and **host failover** with the horde carried through.

These caught eight real bugs. The most instructive:

- A zero-magnitude deadzone produced `NaN` movement, which propagated into
  enemy spawns and made *every* bullet register a hit — `NaN` fails every
  bounds check it is given, including the one meant to reject a miss.
- The host tick was coupled to the render loop, which CI surfaced by running
  the game at 3 Hz on a software renderer.
- Every glow effect used additive blending, which is mathematically a no-op on
  a white background. Bullets were invisible.
- The on-screen stick overlay was enabled on the front end, where it sat on top
  of the menu and swallowed every tap on a phone. `mobile.test.mjs` now
  hit-tests `elementFromPoint` on the buttons for exactly this reason.
- A `hidden` full-screen overlay still intercepted clicks, because an author
  `display` rule beats the `hidden` attribute.
- Bullets moved *before* being tested for collision, so a round covering 13px a
  frame could start in front of an enemy and end behind it having never been
  measured as touching. At the Overclocker's 1500 px/s that is 25px a frame —
  wider than a Glitch Bug, so it tunnelled straight through them. Collision now
  sweeps the whole step.
- Rounds spawned at the barrel tip, so an enemy pressed against the player sat
  nearer than the muzzle and the shot spawned past it. Since auto-aim targets
  the nearest enemy, the one thing you could never hit was the thing eating you.
- The chip magnet damped velocity every frame *including while pulling*, capping
  chips below player run speed. They could be outrun.
- Waves were mathematically unclearable from wave 5 (see **Wave pacing**).

Two CI-only failures were also instructive: the scene clamps `dt` to 50ms a
frame, so on a slow renderer wall time and simulated time diverge badly — at
11fps a 900ms sleep is barely 500ms of game time, less than one Fireman fire
interval. Timing assertions poll for outcomes rather than sleeping.

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
