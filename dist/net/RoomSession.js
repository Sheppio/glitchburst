import { HORDE, NET } from '../config.js';
import { Emitter } from '../util.js';
import { decodeHeartbeat, decodePresence, encodeHeartbeat, encodePresence } from './codec.js';
import { DEFAULT_COLOUR, resolveColours } from '../sim/palette.js';
import { Topics, segment } from './topics.js';
/**
 * Room membership and authority.
 *
 * There is no server, so "who is in charge" is something the clients have to
 * agree on by themselves. The rule is deliberately boring, because boring rules
 * converge: **the alive player with the lowest id is the host.** Ids are
 * time-prefixed (see `makePlayerId`), so in practice that is the player who
 * joined first, and every client computes the same answer from the same roster
 * without any negotiation round-trip.
 *
 * The host proves it is alive twice a second. Miss `hostTimeoutMs` worth of
 * heartbeats and every client independently re-runs the same sort; exactly one
 * of them finds itself at the front and promotes. If two clients ever claim the
 * host role at once (a partition healing, say), the higher id yields the moment
 * it hears the lower one's heartbeat.
 */
export class RoomSession {
    net;
    roomId;
    playerId;
    name;
    cls;
    colour;
    events = new Emitter();
    peers = new Map();
    unsubs = [];
    timers = [];
    lastHostBeat = 0;
    /** When the roster tick last ran, so a gap can be told from a timeout. */
    lastTickAt = 0;
    beatSeq = 0;
    _hostId = null;
    _isHost = false;
    joined = false;
    announcedFull = false;
    /**
     * Whether a run is in progress, as opposed to the room sitting in its lobby.
     *
     * Published on the host's heartbeat, which is what pulls everyone into a run
     * together and, because it repeats twice a second, what lets someone who
     * joins late walk straight into the match already underway.
     */
    running = false;
    /** Set by the game each tick so the heartbeat can carry live stats. */
    hostStatsProvider = () => ({
        enemyCount: 0,
        wave: 0,
        paused: false,
        score: 0,
        running: false,
        kills: 0,
        seconds: 0,
    });
    constructor(net, roomId, playerId, name, cls, colour = DEFAULT_COLOUR) {
        this.net = net;
        this.roomId = roomId;
        this.playerId = playerId;
        this.name = name;
        this.cls = cls;
        this.colour = colour;
    }
    get hostId() {
        return this._hostId;
    }
    get isHost() {
        return this._isHost;
    }
    /** Squad size, 1-4, counting this client. */
    get squadSize() {
        return Math.min(this.aliveIds.length, HORDE.maxPlayers);
    }
    /** Everyone currently believed alive, including this client. */
    get aliveIds() {
        const ids = [this.playerId];
        for (const p of this.peers.values())
            ids.push(p.id);
        return ids.sort();
    }
    /**
     * Change how this client appears to the room, and say so immediately.
     *
     * Presence already republishes on a timer, but a lobby edit that took up to
     * `NET.presenceMs` to show up on everyone else's roster would read as broken:
     * the player changes program, looks at the squad list, and sees their old one
     * still sitting there.
     *
     * The will is deliberately left alone. It carries `alive: 0` and exists only
     * to de-list this client on a crash, which the id does — the name and class
     * in it are never read for anything.
     */
    setIdentity(name, cls, colour = this.colour) {
        if (name === this.name && cls === this.cls && colour === this.colour)
            return;
        this.name = name;
        this.cls = cls;
        this.colour = colour;
        this.announcePresence();
    }
    /** What this client asked for, before the room's clashes are settled. */
    get claimedColour() {
        return this.colour;
    }
    /**
     * Who ends up wearing what, across the whole room.
     *
     * Computed from presence on every client rather than agreed between them —
     * see `resolveColours`. Recomputed on demand rather than cached: the roster
     * changes from three different events and a stale colour map is the kind of
     * bug that only shows up with three people in a room.
     */
    resolvedColours() {
        const claims = [{ id: this.playerId, colour: this.colour }];
        for (const peer of this.peers.values())
            claims.push({ id: peer.id, colour: peer.colour });
        return resolveColours(claims);
    }
    /** This client's colour after clashes are settled. */
    get colourId() {
        return this.resolvedColours()[this.playerId] ?? this.colour;
    }
    join() {
        if (this.joined)
            return;
        this.joined = true;
        // The will fires if this tab crashes or the network drops: peers de-list us
        // immediately instead of waiting out the presence timeout.
        this.net.setWill(Topics.presence(this.roomId, this.playerId), encodePresence({
            id: this.playerId, name: this.name, cls: this.cls,
            colour: this.colour, host: 0, alive: 0,
        }));
        this.unsubs.push(this.net.subscribe(Topics.presenceAll(this.roomId), (topic, payload) => {
            this.onPresence(segment(topic, 0), payload);
        }), this.net.subscribe(Topics.hostBeat(this.roomId), (_t, payload) => this.onHeartbeat(payload)));
        this.announcePresence();
        this.timers.push(window.setInterval(() => this.announcePresence(), NET.presenceMs), window.setInterval(() => this.tick(), 250), window.setInterval(() => this.beat(), 1000 / NET.heartbeatHz));
        // Give the room a moment to answer before claiming authority; if nobody
        // heartbeats in that window we are alone and become host by default.
        this.lastHostBeat = performance.now();
        window.setTimeout(() => {
            if (!this._hostId)
                this.evaluateHost('initial');
        }, 900);
    }
    leave() {
        if (!this.joined)
            return;
        this.joined = false;
        this.net.publish(Topics.presence(this.roomId, this.playerId), encodePresence({
            id: this.playerId, name: this.name, cls: this.cls,
            colour: this.colour, host: 0, alive: 0,
        }));
        for (const t of this.timers)
            window.clearInterval(t);
        this.timers = [];
        for (const u of this.unsubs)
            u();
        this.unsubs = [];
        this.peers.clear();
        this._isHost = false;
        this._hostId = null;
    }
    announcePresence() {
        if (!this.joined)
            return;
        this.net.publish(Topics.presence(this.roomId, this.playerId), encodePresence({
            id: this.playerId,
            name: this.name,
            cls: this.cls,
            colour: this.colour,
            host: this._isHost ? 1 : 0,
            alive: 1,
        }));
    }
    onPresence(id, payload) {
        if (!id || id === this.playerId)
            return;
        const msg = decodePresence(id, payload);
        if (!msg)
            return;
        if (!msg.alive) {
            if (this.peers.delete(id)) {
                this.events.emit('peerLeave', { id });
                this.events.emit('roster', { peers: [...this.peers.values()] });
                // Losing the host is exactly what the election exists for.
                if (this._hostId === id)
                    this.evaluateHost('election');
            }
            return;
        }
        const existing = this.peers.get(id);
        const record = {
            id,
            name: msg.name,
            cls: msg.cls,
            colour: msg.colour,
            claimsHost: msg.host === 1,
            lastSeen: performance.now(),
        };
        this.peers.set(id, record);
        if (!existing) {
            this.events.emit('peerJoin', { peer: record });
            this.events.emit('roster', { peers: [...this.peers.values()] });
            // A newcomer needs to know who is in charge without waiting for a beat.
            if (this._isHost)
                this.beat();
        }
        // Two clients claiming authority at once, healed over presence.
        //
        // The heartbeat already does this, and the heartbeat is the *only* thing
        // that did — which meant a split brain persisted for exactly as long as
        // those beats failed to arrive, and the two halves of the room simulated
        // separate hordes on separate waves the whole time. Presence is the channel
        // every client publishes on, host or not, once a second; acting on the
        // claim it has always carried costs nothing and closes that window.
        //
        // Same rule as the heartbeat, and deliberately only the unambiguous half:
        // the lower id wins, so step down. The other client is already running a
        // simulation, so there is no gap where nobody is.
        if (record.claimsHost)
            this.resolveHostClaim(id);
    }
    /** Somebody else says they are host. Decide whether that outranks us. */
    resolveHostClaim(id) {
        if (this._isHost) {
            if (id >= this.playerId)
                return;
            this._isHost = false;
            this._hostId = id;
            this.events.emit('hostChange', { hostId: id, isHost: false, reason: 'yield' });
            this.announcePresence();
            return;
        }
        // Not host, and nobody we know of is: adopt the claimant rather than sit
        // hostless until the next beat happens to land.
        if (this._hostId === null) {
            this._hostId = id;
            this.events.emit('hostChange', { hostId: id, isHost: false, reason: 'election' });
        }
    }
    onHeartbeat(payload) {
        const hb = decodeHeartbeat(payload);
        if (!hb)
            return;
        if (hb.hostId === this.playerId)
            return;
        this.lastHostBeat = performance.now();
        // Carries the pause flag, so a client joining a paused room learns about it
        // within one heartbeat instead of running while everyone else is frozen.
        this.events.emit('hostStats', {
            enemyCount: hb.enemyCount,
            wave: hb.wave,
            paused: hb.paused,
            score: hb.score,
            running: hb.running,
            kills: hb.kills,
            seconds: hb.seconds,
        });
        // Split brain: the lower id always wins, so step down immediately.
        if (this._isHost && hb.hostId < this.playerId) {
            this._isHost = false;
            this._hostId = hb.hostId;
            this.events.emit('hostChange', { hostId: hb.hostId, isHost: false, reason: 'yield' });
            this.announcePresence();
            return;
        }
        if (!this._isHost && this._hostId !== hb.hostId) {
            this._hostId = hb.hostId;
            this.events.emit('hostChange', { hostId: hb.hostId, isHost: false, reason: 'election' });
        }
    }
    beat() {
        if (!this._isHost || !this.joined)
            return;
        const stats = this.hostStatsProvider();
        this.net.publish(Topics.hostBeat(this.roomId), encodeHeartbeat(this.playerId, ++this.beatSeq, { ...stats, running: this.running }));
    }
    tick() {
        if (!this.joined)
            return;
        const now = performance.now();
        // Were we even running? A frozen or throttled tab wakes up with every
        // timeout already blown through no fault of the room — see
        // `NET.stallForgivenessMs`. Forgive the gap, hand everyone a fresh window,
        // and say so on the way past: our own presence is just as stale to them.
        const gap = this.lastTickAt === 0 ? 0 : now - this.lastTickAt;
        this.lastTickAt = now;
        if (gap > NET.stallForgivenessMs) {
            for (const peer of this.peers.values())
                peer.lastSeen = now;
            this.lastHostBeat = now;
            this.announcePresence();
            return;
        }
        let dropped = false;
        for (const [id, peer] of this.peers) {
            if (now - peer.lastSeen > NET.presenceTimeoutMs) {
                this.peers.delete(id);
                this.events.emit('peerLeave', { id });
                dropped = true;
                if (this._hostId === id)
                    this.evaluateHost('election');
            }
        }
        if (dropped)
            this.events.emit('roster', { peers: [...this.peers.values()] });
        if (!this._isHost && now - this.lastHostBeat > NET.hostTimeoutMs)
            this.evaluateHost('election');
        this.checkCapacity();
    }
    /**
     * Room capacity, resolved the same way the host is: sort the alive ids and
     * take a rank. A client ranked fifth or later knows it is the overflow and
     * stands down on its own — no gatekeeper, and every client independently
     * agrees on which four are in, because they all sort the same list.
     */
    checkCapacity() {
        const rank = this.aliveIds.indexOf(this.playerId);
        if (rank < HORDE.maxPlayers) {
            this.announcedFull = false;
            return;
        }
        if (this.announcedFull)
            return;
        this.announcedFull = true;
        this.events.emit('roomFull', { capacity: HORDE.maxPlayers });
    }
    /**
     * The election itself: sort the alive ids, take the front. Every client runs
     * this against its own roster and reaches the same conclusion, so no votes
     * are exchanged and there is no window where the AI loop stops running.
     */
    evaluateHost(reason) {
        const winner = this.aliveIds[0] ?? this.playerId;
        const becameHost = winner === this.playerId;
        if (becameHost && !this._isHost) {
            this._isHost = true;
            this._hostId = this.playerId;
            this.lastHostBeat = performance.now();
            this.events.emit('hostChange', { hostId: this.playerId, isHost: true, reason });
            this.announcePresence();
            this.beat();
            return;
        }
        if (becameHost)
            return;
        // Somebody else wins. Clearing `_isHost` matters as much as recording who:
        // the old code updated `_hostId` and left `_isHost` set, which left this
        // client publishing heartbeats claiming authority while the scene had
        // already torn down its simulation on the back of the same event. No path
        // reached that state at the time; adding a second trigger for elections
        // would have made it reachable.
        const wasHost = this._isHost;
        if (!wasHost && this._hostId === winner)
            return;
        this._isHost = false;
        this._hostId = winner;
        this.events.emit('hostChange', { hostId: winner, isHost: false, reason });
        if (wasHost)
            this.announcePresence();
    }
}
//# sourceMappingURL=RoomSession.js.map