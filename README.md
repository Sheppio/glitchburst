# GLITCHBURST

<!-- version -->**v0.2.27**<!-- /version --> — the build currently on Pages.

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
npm test           # 383 tests: simulation, codec, single client, mobile, controller, two clients
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
│            (Progression.ts owns chips/power-ups; pool.ts the shared pool)
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

#### Not splitting the room in two

A room that quietly becomes two rooms is the worst failure this architecture
has, because nothing about it looks broken. Both halves keep playing, each on
its own wave, and the only visible symptom is the wave number disagreeing.
Reported from a four-client session: two clients hit System Failure seconds
apart while the other two carried on.

The trigger is the browser, not the network. **A tab that is not in front has
its update loop frozen and its timers throttled** — and somebody testing
multiplayer has four clients open and at most one of them in front. A client
that wakes after a spell in the background finds a roster it last heard from a
minute ago, and the naive response is a catastrophe: drop everyone, find itself
alone, promote itself to host of a room that already has one.

Three things close that off, and all three are about not treating silence as
evidence:

- **Time we spent asleep is not evidence about anybody else.** The roster tick
  measures the gap since the last tick. More than two seconds means *this*
  client stopped running, so every peer gets a fresh window instead of being
  dropped on a clock that was not moving.
- **The presence timeout is a backstop, not the mechanism.** Real departures are
  covered instantly by the Last Will and by an explicit `alive: 0` on the way
  out, which leaves the timeout catching only clients that are alive but quiet.
  Five seconds of quiet is something a browser hands out for free, so it is
  fifteen now.
- **Split brains heal over presence, not just the heartbeat.** Presence carries
  a host claim, every client publishes it every second, and — until this bug —
  nothing read it. The heartbeat was the only thing that could resolve two
  clients both claiming authority, so a split persisted for exactly as long as
  those beats failed to arrive. Same rule as before, second channel: the lower
  ID wins, and the other steps down.

The reboot rules had a matching hole. A squad has **no death limit at all** —
you come back for as long as somebody is standing — so a long co-op run racks up
deaths freely. Measuring that total against the solo pool of three the instant
the roster shrinks ends the run on the spot, which is precisely what the players
saw. The solo pool is now rebased at the moment a client actually becomes alone:
three reboots from then, not a bill for a co-op run that teammates already paid.

### Bandwidth: batching the horde

At the 100-enemy cap, one message per enemy at 20 Hz is 2,000 messages a second.
No public broker will carry that. Instead the host sends **one message for the
entire horde**, 20 times a second:

```
tds/room/<room>/horde/positions
e1,918,540,d,1l;e2,1177,1289,6,t;e3,1812,934,d,1l;…
 │   │   │  │ └── health (base36)
 │   │   │  └───── kind and level, packed (base36)
 │   └───┴──────── position, rounded to whole world pixels
 └──────────────── enemy id
```

Kind and level share one field: `kind + (level - 1) * 6`. A separate level
field would have cost two bytes per enemy — 200 at the cap, which pushed the
snapshot over the 40 KB/s budget the codec exists to respect. Packed, levels 1-6
cost **nothing at all** and only a full field of level 7 adds anything.

Measured at the cap: **1,851 bytes** per snapshot versus 5,092 as JSON (64%
smaller), or ~36 KB/s at 20 Hz — 1,951 B in the worst case where all 100 are
level 7. Positions round to whole pixels because peers interpolate anyway, so
the sub-pixel precision would be discarded on arrival.

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

**Scoring is the squad's, and rides on the death event.** The host is the only
machine that *resolves* a kill, so crediting from its own step result credited a
peer's kills on a machine that was not the peer: a peer's score never left zero
however much it killed. Every client now counts every kill from the death event
— the same broadcast that already plays the burst and drops the chips, so a kill
is observed in exactly one place on the host and on peers alike.

One shared total rather than a personal one, because this is co-op with a single
SCORE readout: two clients showing different numbers for it reads as a bug
whichever number is "right". That also means nothing local may contribute to it,
so collecting a chip no longer awards a point — chips have their own counter and
their own purpose, and a per-player pickup folded into a room total is
un-syncable by construction.

Events are QoS 0, so a dropped death would otherwise leave a peer permanently
behind — the horde snapshot is complete state and self-corrects, but a score
built only from events does not. The host's running total therefore rides the
**heartbeat** twice a second and peers adopt it. Absent is transmitted as `null`
rather than `0`: zero is a legitimate score, and adopting it every beat would
wipe the board.

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

Rounds fade out over the last third of their lifetime rather than blinking out
of existence at maximum range — which reads as a glitch, and hides where a
weapon actually stops being useful.

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

### The camera and the HUD

The HUD is an opaque overlay, and the camera used to be bounded to the arena
exactly — so at a wall it stopped dead and a player pinned against the bottom
edge was drawn *underneath* the bottom strip, along with whatever was eating
them. The camera's bounds are now padded by the strips' own heights, so the
arena edge comes to rest just clear of them; what scrolls into view beyond the
wall is empty ground, and the HUD is sitting on exactly that.

The heights are **measured, not assumed**: the strips reflow with the viewport,
shrink on a phone, and grow when the reboot counter appears. A `ResizeObserver`
on the two strips tells the renderer when they change — including on first
layout, which matters because the scene is created while the HUD is still
hidden and therefore measures as zero. Deliberately not a timer: Phaser's clock
advances on the same capped delta as `update`, so on a slow renderer a 400 ms
repeat fired roughly every two seconds and the camera spent that long bounded
wrong.

**Zoom** is a settings slider, 60% to 140%. Mostly a phone concern — a six-inch
screen showing a monitor's slice of arena is a keyhole. A screen-space inset is
worth `inset / zoom` in world units, so the camera padding scales with it; and
anything pinned to the camera is un-scaled by hand, because Phaser's zoom
multiplies everything it draws, `scrollFactor(0)` included, so the vignette and
the edge markers would otherwise grow and shrink with the arena instead of
staying put as screen furniture.

### Off-screen markers

The arena is 2400x1600 and the camera shows a fraction of it, so most of the
time your squad is somewhere you cannot see. Small chevrons sit at the screen
edge pointing at **teammates**, tinted with their class colour so a glance tells
you *who* is over there, and at **power-ups** in a muted grey — worth knowing
about, not worth pulling your eye off whatever is shooting at you. A downed
teammate is dimmed rather than hidden: that is the one you most want to find.

A marker is placed where the ray from the middle of the screen to the target
crosses an *inset* rectangle. On the edge itself half the arrow is clipped by
the viewport, which reads as a rendering fault rather than as a pointer. They
are screen-space (`setScrollFactor(0)`), and cleared entirely while paused or
after a run ends — arrows frozen over a summary card are just clutter.

Squad health bars are listed **you first, then the host, then join order**.
Your own bar is the one you glance at mid-fight, so it holds still at the top
rather than shuffling as people come and go; the host is next because theirs is
the connection the whole room's horde depends on. Join order for the rest comes
free from the player ids, which are time-prefixed — the same property the host
election relies on. Insertion order into the remotes map would have been
"whoever's first packet arrived", which is stable enough to look deliberate and
arbitrary enough to differ between two clients looking at the same room.

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

| | HP (level 1) | From wave | Behaviour |
| --- | --- | --- | --- |
| **Skittering Glitch Bug** | 30 | 1 | charges straight in |
| **Rogue Firewall Drone** | 58 | 3 | hovers at ~300px, strafes, fires |
| **Packet Wraith** | 26 | 4 | fast, weaves — hard to lead, not hard to kill |
| **Spore Node** | 78 | 6 | bursts into two Glitch Bugs when killed |
| **Trojan Tank** | 265 | 8 | walks through everything |
| **Ransom Brute** | 540 | 12 | very slow, very heavy, drops well |

Kinds are **introduced over time**, and each wave draws from a **subset of two
or three** of what is unlocked rather than a uniform blend of everything. Wave
one is only Glitch Bugs. A wave of weaving wraiths reads differently to a wave
of spore nodes; "a bit of each, always" reads as nothing. A kind unlocking on a
given wave is always in that wave's roster, so no debut is missed.

### Levels

Every enemy carries a **level, 1 to 7**, drawn as a coloured pip at the centre
of its body — violet at 1 through to red at 7.

This is difficulty made *visible*. Waves used to get harder through a health
multiplier nobody could see: the same Glitch Bug that died in one shot at wave 2
took four at wave 20 and looked identical, which reads as your weapon getting
worse rather than the malware getting tougher. Now you can see what is walking
at you before you commit to shooting it.

Health is geometric in level — **×1.35 per level**, so level 7 is 5.4× a level 1
of the same kind. Geometric because the damage upgrade is now endless and
therefore grows *linearly*: a linear health curve would never catch up and a run
would have no end. Levels advance every four waves, reaching 7 at wave 25, and
each spawn has a ~22% chance of rolling one step off its wave's base so a wave
is a mix rather than a uniform wall.

Rewards scale too, but **sub-linearly** — ×1.5 per level against ×1.35 health.
Without that the economy would invert exactly as the game speeds up; keeping it
below the health curve means tough targets pay more per kill but fodder is still
the better chips-per-second, so both stay worth shooting.

The pip is always drawn on a white disc with a dark rim. It has to be read
against six different body colours, in peripheral vision, while something else
is shooting at you — on white it only ever has to contrast with white. Cyan
stands in for the textbook rainbow's indigo, which is indistinguishable from
blue at pip size and would cost a whole level of information.

Textures are generated per kind *and* level: 42 of them, drawn once at boot. One
body sprite plus a tinted pip sprite per enemy would double the display list at
the 100-enemy cap and add a position to sync every frame, to save texture memory
we are not short of.

## Progression

Dead malware drops **compute chips**. A set converts into a **power-up** that
materialises beside you; walking into it grants a stacking upgrade. Firewall
Drones (6%), Trojan Tanks (22%) and Ransom Brutes (30%) can also drop one
outright, so committing to a tank while a wave closes is a decision rather than
a chore.

Each power-up costs **one more chip than the last** — 8, 9, 10, 11 … with no
ceiling. A ceiling would flatten the last third of the curve back into the
plateau the rising price exists to remove.

| Upgrade | Per stack | Cap | Why |
| --- | --- | --- | --- |
| **Payload Boost** (damage) | +9% | **none** | Endless. It scales one multiplier and costs nothing per frame, so there is no reason to stop it — and since enemy health climbs geometrically with level, a linearly growing damage stat is what keeps a long run a contest instead of a formality. |
| **Pipeline Boost** (fire rate) | +5.5% | 16 | Fire rate multiplies *live bullets* — the one per-frame cost that scales with an upgrade rather than with the horde. |
| **Clock Boost** (speed) | +4.5% | 12 | Movement speed changes what the collision code has to cope with. Enough of it and a player crosses more than an enemy radius per frame, which is the tunnelling bug bullets already needed swept collision to fix. |
| **Self Repair** (regen) | +0.55 hp/s | 12 | Regeneration that outpaces incoming damage removes the fail state, and a horde shooter with no fail state is a screensaver. |
| **Heap Expansion** (max hp) | +16 hp | **256 total** | Capped on the *stat*, not the stack count — see below. |

**Heap Expansion is bounded by a ceiling rather than a stack cap**, because the
classes do not start level: the same four stacks take the Glitcher from 90 to
154 and the Fireman from 190 to 254. A stack cap would be generous to the tank
and nearly meaningless to the glass cannon. A ceiling of **256** instead leaves
the Fireman a modest four stacks and the Glitcher a run-defining ten, so the
upgrade is worth most to whoever needs it most.

The stack that crosses the ceiling is allowed and simply gives what is left,
rather than being refused — a power-up that announces itself, plays its sound
and does nothing reads as a bug. Past that point the roll stops offering it.
The extra capacity also arrives **filled**: headroom you have to earn back is
felt as nothing at the moment you take it, and this is the one upgrade whose
job is to save your life.

### Nothing outruns you forever

A horde shooter has one degenerate strategy and this game had it: every chasing
enemy is slower than every class, the arena is 2400x1600, and a player who stops
shooting and runs in circles is never caught. With auto-move on that runs
literally forever — a lone self-driving client circling with a tail of hostiles
behind it, wave frozen, nothing resolving.

**An enemy's speed grows with its own time on the field.** Nothing for the first
18 seconds, then +5% of base per second, to a ceiling of 2.1x at 40 seconds.
Raising base speeds instead would have made every wave harder from its first
second, punishing the ordinary case to fix the pathological one; ageing only
bites when nothing is dying, which is exactly when the stalemate exists.

The ceiling is chosen so the fastest chaser ends up *just* past a fully upgraded
player's top speed — 487 against 447 — while the slowest ends at 97 and remains
no threat to anyone who is actually playing. A first pass at 12s/6%/2.4x caught a
circling kiter hard, 27% of the final twenty seconds in contact. That is more
pressure than the problem deserves: the complaint is a stalemate that never ends,
not one that ends slowly.

Enraged enemies wash warm and grow about 12%, and the field growls once as a
wave crosses the threshold — once, not ninety times, because they age together
and the sound throttles itself. The wash is deliberately not a red multiply,
which would flood the level pip at the centre of every enemy — and that pip is
the only thing telling a player which of two identical drones is the dangerous
one. It leans orange rather than pink for a second reason: the low-health
warning below is red, and two different red signals on one screen is one signal
too many. The tell is derived locally from when a client first saw the enemy
rather than being put on the wire, so it costs nothing in a 20 Hz snapshot
carrying up to a hundred of them.

### Knowing you are in trouble

Being hit and being *about to die* are different facts and were drawn the same
way. A hit fired `cameras.flash` — the whole playfield tinted red for 90ms —
which at any real rate of incoming fire is most of the time, and which hid the
arena behind the thing that was hurting you at the moment you most needed to see
it. A hit now flashes a **hard red frame** at the screen edge instead, 2.5% of
the smaller screen dimension so the ring is even rather than thick down the
sides of a wide monitor, and the playfield stays clear.

That leaves the full-screen red for the one thing worth colouring a whole screen
over. Health is a number in the corner of a screen whose middle is where you are
actually looking, which is a poor place for the one fact that decides whether
you should be backing off. Below 30% the frame itself says so: a red wash at the
screen edge, breathing rather than steady, because a static red border stops
being read after a few seconds and the whole point is that it keeps being read.
Underneath it an alarm pulses, and **the interval is the information** — it
roughly doubles in rate between a quarter health and nearly dead, so how much
trouble you are in is audible without reading anything.

Reusing the existing vignette texture for this was the obvious move and it does
not work. That one is tuned to be almost imperceptible — stacked rings at 0.02
alpha each — because its job is to stop a uniformly bright rectangle reading as
flat. Tinted red and faded in, it reached an effective alpha of about 0.015
against a near-white arena, which is to say nothing at all. The warning gets its
own texture, drawn as a canvas radial gradient rather than stacked rings,
because the falloff *is* the effect: rings band, and their alpha is hard to
predict where they overlap.

The first version that was actually visible then went too far and flooded the
whole frame pink, which drowned the enemies. What ships is a rim with a clear
centre — the player is in there and has to stay readable.

Two other things that could hurt you made no sound at all. **Incoming drone fire
was silent**, so a shot from off screen was a health bar dropping for no
announced reason, which reads as the game cheating rather than as a shot you
missed; it now chirps *upward*, where every weapon in the player's hands falls,
so it never registers as your own gun. And a **reboot** had no answer to the
death sound that preceded it.

Damage being endless is the answer to "I reach fully optimised too soon": there
is no such state to reach. Once the four bounded lines are full every power-up
is damage, forever, at a price that keeps climbing.

Rolls are weighted toward whatever you have least of, so a long run broadens a
build instead of dumping a twelfth damage stack on someone who has never seen a
speed boost.

### The shape of a run

Modelled against a perfect solo Overclocker — every chip collected, every shot
landed — the time to clear a wave against the time the wave is given:

| Wave | 1-8 | 9-12 | 13 | 14-30 |
| --- | --- | --- | --- | --- |
| Ratio | 0.17 → 0.61 | 0.81 → 0.98 | **1.17** | 0.76 - 1.04, sawtooth |

Comfortable, then holding the line, then behind for the first time at wave 13 —
by which point power-ups have started landing. After that every level-up spikes
the ratio and the accumulating damage stacks grind it back down. It never
inverts, so the run stays a contest indefinitely rather than being won.

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

## The lobby

A room is a **place**, not a single match. Creating or joining one lands you in
a staging area with the room code, the roster, and — for the host — a Start
button. Runs are created and destroyed inside that room; the broker connection
and the roster outlive them, which is what makes coming back to a populated
lobby possible at all rather than a round trip through the main menu.

**The host's heartbeat carries whether the room is playing.** Everyone who is
not already in a run and hears `running` starts one, which makes the start
button and the entire late-join story the same mechanism: someone arriving
mid-match sees the flag within half a second and walks straight into the wave,
which the horde snapshot then materialises around them. Only the host can start,
for the same reason only the host can pause — the horde exists on exactly one
machine, and a peer "starting" would be asking for a simulation nobody is
running.

Callsign and program are **editable in the staging area**, not just on the way
in. That is the natural moment to change them: waiting for the squad before the
first run, and — after a wipe drops everyone back here — deciding the Fireman
was the wrong call. The edit goes straight back out on presence rather than
waiting for the next republish, because the roster everyone reads is built from
presence, and a player who changes program and still sees their old one on the
squad list will reasonably conclude it did not work.

Both the character screen's card grid and the staging area's picker write
through one selection, so they cannot drift apart.

### Colour is who, not what

Colour used to mean class. That was fine while a class was the only thing
distinguishing one chassis from another, and wrong the moment two people in a
room picked the same program: two identical cyan circles in a swarm of a hundred
enemies, and neither player able to tell which one they were driving.

**Players pick their own colour from a palette of eight, and no two players in a
room can wear the same one.** The room holds four, so a clash always has
somewhere to go. The picker strikes out what the rest of the squad is already
wearing, which is what stops clashes arising; the resolver below is what settles
the ones that do.

There is no server to arbitrate, so the rule has to be one every client can
apply alone and arrive at the same answer — the same constraint the host
election works under. Two properties do it:

- **Seniority.** Claims are settled in ascending player id, and ids are
  time-prefixed, so the earliest joiner keeps what they asked for and a newcomer
  who picks a taken colour is the one who moves. Nobody's colour changes under
  them because somebody else walked in.
- **Determinism.** The displaced player takes the next free entry walking
  forward from their choice, wrapping. No randomness and no negotiation, so
  every client — including the displaced one — computes the same result from the
  same presence list without a message being sent.

A player's colour therefore rides on presence as a *claim*; what gets drawn is
always the resolved answer. The claim is on the 20 Hz player packet too, purely
as a fallback for a sprite that somehow appears before its presence does.

The chassis colour is **baked into the texture, not tinted**: the sprite is
mostly white — a white disc inside a coloured ring — and a tint multiplies the
whole image, which would take the body down with the ring and leave a flat
coloured blob. Four classes × eight colours is 32 small textures, generated once
at boot, the same trade already made for the 42 enemy textures.

Each roster row carries its **class glyph**. The in-game chassis cannot be
reused for this: every class draws the same sprite and differs only in colour
and radius, which is fine at arm's length in a moving arena and useless in a
list of four programs. So each class gets a mark built from the one thing the
sprite does establish — a disc inside a coloured ring — with its behaviour drawn
inside: a beam leaving the muzzle and running off the edge for the Overclocker,
three rays off the same muzzle for the Fireman, a second ring offset behind the
first for the Glitcher's decoy, a cross inside the ring for the Encoder's field.
Everything is stroked in `currentColor`, so the row sets the colour once and the
glyph inherits it — and with colour now carrying player identity, the glyph is
what carries the program. **Colour says who, the glyph says what.** The in-game
squad bars wear both for the same reason. The picker is a `select`
cycled **in place** by the pad: a native dropdown is drawn by the browser
chrome, where a controller cannot reach, and opening one on a console is a dead
end with no way back.

### The debrief

A finished run is **frozen, not veiled**: the host tick is stopped and the
update loop returns early, because a horde still swarming behind the summary is
both a distraction and, on the host, a match nobody is playing still being
simulated and broadcast.

The HUD's Pause and Leave sit **above** the veils, so a paused player can always
get out — but both go away at System Failure. There is nothing left to pause,
and a Leave floating over the card competes with the card's own way out.

The summary is **the squad's, never per player**. This is a co-op game; splitting
it turns "how did we do" into "who carried", which is the wrong question to
leave a room on. The numbers come from two places for a reason:

| | Source | Why |
| --- | --- | --- |
| Rounds fired, chips, upgrades, reboots | each client publishes its own, once a second; everyone sums | only your own client knows them |
| Kills, wave, uptime, score | the host, on the heartbeat | counted locally from QoS-0 events they drift apart, and a group summary that differs per screen is not a group summary |

The run clock reads `performance.now()` rather than Phaser's frame delta.
Phaser smooths and caps the delta it hands to `update` — correct for a
simulation, wrong for a stopwatch: at the ~4fps a software renderer manages it
reported about 55ms a frame however long the frame really took, and timed a
ten-second run at two.

Hit rate is capped at 100%. Kills arrive from the host while shots are summed
across clients, so a late publish can briefly make kills the larger number, and
a card claiming 140% reads as broken even though nothing is wrong.

## Reboots

Solo and squad play fail differently, so they get different rules.

**Solo** spends a pool of **three reboots**; the fourth death ends the run.
Unlimited reboots on your own means the run has no stakes and never resolves —
you grind until bored rather than losing.

**In a squad** reboots are not counted at all. You come back for as long as
*somebody* is still standing, and a **wipe** is what ends the run. The pressure
comes from your friends rather than from a token count, and it makes the last
player alive obviously important.

A wipe is a property of the **room**, and is re-checked every frame while you
are down rather than only at the instant you die. Asking once, on death, made
the run end at different times on different clients: whoever died second saw no
one standing and ended, while the first player — merely *rebooting*, not out —
served their reboot, came back, and only discovered the wipe the next time they
died, fifteen seconds later. Re-checked continuously, every client reaches the
same answer within one player broadcast, and the failure screen appears on all
of them together.

A reboot restores **full** health. A partial one drops you straight back into
the wave that just killed you, which usually spends the next life on nothing.

Health also regenerates slowly on its own, but **only after four seconds without
being hit**. Regen that ticks during a fight turns every engagement into a
damage race the player generally wins; regen that waits until you have
disengaged rewards backing off, which is the decision worth encouraging when
outnumbered. The Self Repair upgrade adds to that rate.

The wait differs by mode, for the same reason the life rules do.

**Solo is a flat three seconds**, every time. The pool of three reboots is
already the escalating cost — each death is measurably closer to the end of the
run — and stacking a rising timer on top charges twice for the same mistake, in
the worst currency there is: sitting watching.

**In a squad each reboot takes longer than the last** — five seconds, then
eight, then eleven, capped at twenty. There reboots are not counted at all, so
the timer *is* the cost: a flat delay would make dying nearly free by the tenth
time, while a rising one lets a bad run compound without ever hard-stopping a
team that is still fighting.

### Coming back somewhere survivable

A reboot never drops you back inside the swarm. If the nearest hostile is within
**300px**, you are relocated to the closest point that is clear of them.

Same reasoning as the full-health restore: materialising inside the ring that
just killed you spends the reboot on nothing, and at the enemy cap the odds of
your corpse being surrounded are high. 300px buys over a second even against the
fastest kind — enough to pick a direction.

The search is rings expanding from where you fell, first clear point wins, so
the usual result is a short hop rather than a trip to the far corner: you come
back near your squad and near whatever you were defending. If *nothing* within
range is clear — a hundred enemies cover a lot of arena — you get the roomiest
spot found rather than the spot you died on. Clearance is measured off the enemy
sprites rather than the simulation, so a peer with no `HordeEngine` computes the
same answer from what is actually on its screen.

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

### Waves stream in

A wave does not land as a block. Its spawns are spread across **40% of its own
window**, so the wave builds instead of arriving.

Dropping thirty enemies into existence in a single frame closes the ring around
the player instantly, and there is no moment where they are reacting to
anything — they are simply surrounded. Streamed, the same wave is pressure that
grows, which can be read and fallen back from. Wave one opens with a single
enemy and reaches eleven about six seconds later, leaving most of its window to
fight in.

A fraction rather than a fixed rate keeps the stream proportional: a wave of
eighty gets a longer window and therefore a longer trickle, not eighty enemies
crammed into the same six seconds.

The early-clear rule needs a guard because of this. An empty field *while a wave
is still arriving* means the player killed the leading edge, not that they
cleared the wave — advancing there would drop the next wave on top of the rest
of this one, which is the exact pile-on the streaming exists to prevent. So the
next wave can only be pulled forward once the current one has fully landed.

## Difficulty (1–4 players)

Two independent dials, applied per wave from the live roster:

- **Wave size** × `1 + 0.45 × (players − 1)` → 1.0× solo, **2.35× at four**.
- **Enemy health** × `1 + 0.12 × (players − 1)`, plus 4% per wave on top of the
  level multiplier. Deliberately
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

The mouse gets a **reticle** over the arena rather than the usual arrow. An
arrow's hotspot is its tip with the body trailing down and right, so what you
are aiming at sits under the cursor's decoration rather than under its point —
fine for clicking a button, poor for pointing a weapon. The reticle is
symmetrical and centred on its hotspot, so the target is inside the ring. It is
drawn black for the near-white arena, on a white halo so it stays readable
crossing a Trojan Tank's hull or a health bar. Menus keep an ordinary pointer.

### Accessibility

- **Auto-fire** — the weapon discharges whenever it comes off cooldown.
- **Auto-aim** — the angle tracks the nearest enemy in range, handing manual aim
  back when nothing is near.

Both default **on** for touch devices, which reduces the mobile scheme to a
single movement stick.

### Auto-move (self-driving client)

A third toggle, **Auto-move**, hands movement to the game as well. With all
three on the client plays hands-off.

It exists for testing the multiplayer half. Rooms need bodies in them, and a
second tab that stands still is a poor stand-in for a player: it never leaves
its spawn ring, never collects a chip, never earns a power-up and never reboots
— so precisely the wire traffic worth testing is the traffic it does not
generate. Left alone for two minutes a self-driving client reaches wave 8, banks
200-odd chips, takes seven upgrades and spends its reboots.

The policy lives in `sim/autopilot.ts`, pure and headlessly testable. Two bands,
chosen by the distance to the nearest hostile, and shopping on top of both:

| | Behaviour |
| --- | --- |
| **Crowded** (< 240px) | find a way out, tilted toward loot where the way out allows |
| **Otherwise** | drift off anything closing in; close in when out of weapon range |
| **Always** | go and collect, as long as the trip costs no safety |

The first band is the interesting one. Summing repulsion vectors is the obvious
approach and it fails exactly when it matters: surrounded, the pushes cancel,
the sum collapses to nothing, and the bot stands still in the middle of the
swarm. Measured, that was **half** of a 90-second run spent in contact range.

So under real pressure it stops averaging and starts choosing — sample sixteen
headings, look ahead along each, take the one that ends up furthest from
everything. That walks out through the gap in an encirclement instead of
pressing into the middle of it, and it drops contact time to **14%** for a bot
with no weapon at all. The score is scaled by how far each step actually gets
after clamping to the arena, which is what stops the bot picking a heading
straight into a wall: cornering itself is the other classic way a retreating bot
dies.

#### Shopping

Surviving is not the same as getting anywhere: a bot that kites beautifully and
banks nothing reaches the same wave every run, because damage is the only thing
that clears a wave faster than the next one arrives. So the bot buys its own
progression.

It picks one target rather than summing pulls — chips on opposite sides cancel,
and a bot steered by the average of its options walks between them and collects
neither. Targets are scored on value over distance, where value counts a chip's
neighbours (a cluster is one trip for several chips) and an upgrade is worth ten
chips, just over the going rate. Distance is the walk that actually remains
after the magnet takes over, so a chip already inside the magnet is never chased
— it is coming anyway. A pickup that cannot be reached before it expires is
declined outright.

Safety then multiplies the score, and the rule is deliberately relative: **a
detour is fine as long as it does not bring the bot closer to a hostile than it
is already standing.** That replaced a flat "no looting while threatened" gate
which was both too strict — a chip at your feet in a safe direction was refused
— and too blunt: a chip fifty pixels behind a drone was fine as long as the
drone was 241px away, and the bot walked straight through it.

Over a seeded 60-second run against a live horde with loot scattered across the
arena:

| | Chips banked | Upgrades taken | Time in contact |
| --- | --- | --- | --- |
| Before | 27 / 40 | **0 / 2** | 3% |
| After | **38 / 40** | **2 / 2** | 5% |

Both upgrades used to sit on the floor for their full 45 seconds and expire. The
two extra points of contact time are what the shopping costs, and they are the
reason the safety term exists at all.

#### Not vibrating

The policy re-decides from scratch every frame, and two of its choices are
discrete: the escape band picks one of sixteen sampled headings, and the bands
themselves switch on a hard distance threshold. An enemy hovering near that
threshold, or two escape headings scoring within a hair of each other, makes the
answer flip frame to frame. Measured over a seeded run, the raw heading changed
direction by an average of **25 degrees per frame** and reversed outright — more
than 90 degrees in a single frame — **531 times a minute**. On screen that is a
player vibrating rather than running, and peers interpolating it from 20 Hz
snapshots see it worse.

An 80ms exponential ease on the output takes that to **3.7 degrees and 15
reversals**, at no measurable cost to survival. Two details earn their keep: it
is exponential so the same turn takes the same wall-clock time at 30fps and 144,
and the blend is *not* renormalised — both inputs are at most unit length, so a
hard reversal passes through a near-zero magnitude and the bot slows, turns and
accelerates instead of teleporting its velocity.

The frame time comes from `performance.now()`, for the third time in this
codebase. Phaser smooths and caps the delta it hands to `update`, so a starved
renderer at 5fps still reports 15ms a frame; feeding that to an exponential
smoother stretched an 80ms ease into a second of real time, and the self-driving
client visibly crawled away from a standing start. The run clock and the
HUD-resize watcher hit the same wall.

Real input always wins — any stick or key deflection overrides the autopilot
that frame, so a human can take a self-driving client back without first
visiting the settings screen. The toggle is also on the in-game HUD, beside
auto-aim and auto-fire.

### Console & handheld

Tuned for Xbox Edge, the PlayStation browser and the Steam Deck:

- **Stick-drift filter.** A fixed **0.15 per-axis** threshold zeroes each axis
  before anything reads it, then a radial deadzone shapes the remaining travel.
  Per-axis kills drift; radial stops diagonals outrunning cardinals.
- **Haptics.** `triggerRumble(weak, strong, durationMs)` over the Gamepad
  Haptics API, with presets fired on **taking damage** and **activating an
  ability** (plus lighter taps for shots, kills and menu focus).
- **Text entry.** An on-screen keyboard, because a controller has no keys and
  the callsign and room code are the game's front door. The keys are ordinary
  buttons in a grid, so the focus ring already knows how to move across them.
- **Every control operable.** Left/right on a focused slider adjusts it rather
  than walking the ring off it, and a dropdown cycles in place — a native
  `select` popup is drawn by the browser chrome, which a pad cannot drive at
  all, so opening one on a console is a dead end with no way back.
- **Modal scoping.** The ring is confined to the topmost open overlay, so it
  cannot wander from a pause card onto the HUD behind it, and B closes the
  overlay rather than the screen underneath.
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

383 checks across five suites. The browser suites vendor Phaser locally and
swap MQTT for a loopback stub that relays over `BroadcastChannel`, so two tabs
share one "broker" and a real multi-client room can be tested offline.

- **`sim.test.mjs`** (252) — codec round-trips, truncation tolerance, payload
  size at the cap, enemy cap, difficulty scaling, wave pacing, damage
  attribution, steering, decoy priority, host adoption, shockwave, progression
  and upgrade caps, deterministic drop rolls, turn-rate limiting, the auto-aim
  scoring formula, enemy levels and their health/reward curves, wave streaming
  and the tempo floor, the autopilot's steering bands and its survival against a
  live horde, and the audio volume curve.
- **`smoke.test.mjs`** (51) — menus, settings persistence and migration, Phaser
  boot, election, 20 Hz batching, attacker-authority kills, point-blank hits,
  chip pickup and conversion, turn rate, abilities, pause, settings over a live
  match, and broadcast rate under a starved renderer.
- **`gamepad.test.mjs`** (16) — the whole front end driven by a virtual pad and
  nothing else: no click, no keypress. Menu to match, the on-screen keyboard,
  the pause card, a slider, and back out again.
- **`mobile.test.mjs`** (15) — an emulated Pixel with a touchscreen and no
  mouse: taps through the whole flow, and hit-tests that nothing invisible is
  covering the buttons.
- **`multiplayer.test.mjs`** (49) — two clients: election, peer unpacking,
  mid-game join, interpolation, squad scaling, seeing each other's fire, pause
  propagation, **host failover** with the horde carried through, a split brain
  healing over presence with the heartbeat silenced, and a frozen tab waking up
  without dropping the room.

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
- Scene teardown listened only for Phaser's `SHUTDOWN`, but destroying the
  *game* emits `DESTROY` instead — so the host's 20 Hz interval outlived the
  destroyed game, stepped a dead scene, and kept publishing the old horde into
  the room. Retrying inherited the previous run's wave as its opening one.
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

## Sound

Everything is **synthesised in the browser** — there is no audio file in the
repository and nothing to download. Same reasoning as the textures: the game
stays a handful of static files with no assets to fetch, no CORS surface and
nothing to license. It also suits the setting; a mainframe should bleep rather
than play recorded gunfire.

Effects are a few oscillators and an envelope, built and discarded per shot.
Each weapon is pitched differently so four players in a room sound distinct, and
the chip pickup climbs in pitch as a set fills, so the run-up to a power-up is
audible. Anything that can fire many times a frame is rate-limited — auto-fire
plus a hundred dying enemies would otherwise stack hundreds of oscillators a
second and sum into noise rather than reading as events.

The music is an Am–F–C–G arpeggio scheduled with the standard Web Audio
lookahead: a timer wakes every 25 ms and places notes on the *audio* clock up to
150 ms ahead. `setInterval` alone drifts by tens of milliseconds under load,
which is instantly audible as wobbling rhythm, but it is fine for deciding what
to schedule next.

Browsers refuse to start audio without a user gesture, so the context is created
on the first click, tap or keypress and everything no-ops until then. Music
starts when a match does, not on the menu — opening a shared link should not
ambush someone at work.

### Volume

Both channels are **sliders**, not switches, and settings is reachable from the
pause veil as well as the menu — mid-match is when you actually discover the
music is too loud.

Slider position is squared before it reaches the gain node. A gain control wired
straight through spends its bottom quarter going from silent to loud and its top
half doing nothing audible, because loudness is roughly logarithmic in
amplitude; squaring puts half-travel at about **-12 dB**, which reads as
"noticeably quieter" rather than "barely moved". Full travel is a per-channel
reference level rather than 1.0, which is how music stays a bed under the
effects at equal slider positions.

Zero is mute, and it means it: `destination()` returns null, so a muted channel
builds **no oscillators at all** rather than building them and multiplying by
zero. Muting the music stops the scheduler outright — and sliding it back up
from the pause screen has to restart it, which is the one bit of state that
cannot be expressed as gain alone.

## A note on performance

Profiled at the worst case the game can reach — 100 enemies, a full 220-chip
pool, bullets in flight — every per-frame method together costs about **1.2 ms**
against a 16.7 ms budget:

| method | per call |
| --- | --- |
| `updateLocalPlayer` | 0.64 ms |
| `updateBullets` | 0.51 ms |
| `pushHud` | 0.20 ms |
| `nearestEnemy` | 0.16 ms |
| `updateChips` | 0.07 ms |

Frame spikes under headless software rendering are SwiftShader, not game logic.
Optimising this hot path would be busywork — if something does get slow later,
measure before assuming it is the JS.

## Deployment

GitHub Pages is set to **deploy from a branch**: `main`, folder `/ (root)`.
`.nojekyll` is present so nothing is filtered. To deploy: `npm run build`,
commit `dist/`, push.

CI (`.github/workflows/ci.yml`) deliberately **does not deploy**. The browser
suites are timing sensitive on shared runners, and a slow runner should not be
able to stop the site going up. CI does fail the build if committed `dist/` has
drifted from `src/`, which is the one way this layout could silently ship stale
code.
