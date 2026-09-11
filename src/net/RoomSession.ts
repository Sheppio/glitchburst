import { HORDE, NET } from '../config.js';
import type { ClassId, PlayerId, RoomId } from '../types.js';
import { Emitter } from '../util.js';
import { decodeHeartbeat, decodePresence, encodeHeartbeat, encodePresence } from './codec.js';
import type { MqttNet } from './MqttNet.js';
import { Topics, segment } from './topics.js';

export interface PeerRecord {
  id: PlayerId;
  name: string;
  cls: string;
  claimsHost: boolean;
  lastSeen: number;
}

export interface RoomEvents extends Record<string, unknown> {
  roster: { peers: PeerRecord[] };
  peerJoin: { peer: PeerRecord };
  peerLeave: { id: PlayerId };
  /** Fired whenever authority moves — including the initial claim on room creation. */
  hostChange: { hostId: PlayerId | null; isHost: boolean; reason: 'initial' | 'election' | 'yield' };
  /** Host-authored liveness data, useful for the HUD on peers. */
  hostStats: { enemyCount: number; wave: number; paused: boolean; score: number | null };
  /** This client arrived at a room that already holds a full squad of four. */
  roomFull: { capacity: number };
}

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
  readonly events = new Emitter<RoomEvents>();
  readonly peers = new Map<PlayerId, PeerRecord>();

  private unsubs: Array<() => void> = [];
  private timers: number[] = [];
  private lastHostBeat = 0;
  private beatSeq = 0;
  private _hostId: PlayerId | null = null;
  private _isHost = false;
  private joined = false;
  private announcedFull = false;

  /** Set by the game each tick so the heartbeat can carry live stats. */
  hostStatsProvider: () => { enemyCount: number; wave: number; paused: boolean; score: number } = () => ({
    enemyCount: 0,
    wave: 0,
    paused: false,
    score: 0,
  });

  constructor(
    private net: MqttNet,
    readonly roomId: RoomId,
    readonly playerId: PlayerId,
    private name: string,
    private cls: ClassId,
  ) {}

  get hostId(): PlayerId | null {
    return this._hostId;
  }

  get isHost(): boolean {
    return this._isHost;
  }

  /** Squad size, 1-4, counting this client. */
  get squadSize(): number {
    return Math.min(this.aliveIds.length, HORDE.maxPlayers);
  }

  /** Everyone currently believed alive, including this client. */
  get aliveIds(): PlayerId[] {
    const ids = [this.playerId];
    for (const p of this.peers.values()) ids.push(p.id);
    return ids.sort();
  }

  setClass(cls: ClassId): void {
    this.cls = cls;
    this.announcePresence();
  }

  join(): void {
    if (this.joined) return;
    this.joined = true;

    // The will fires if this tab crashes or the network drops: peers de-list us
    // immediately instead of waiting out the presence timeout.
    this.net.setWill(
      Topics.presence(this.roomId, this.playerId),
      encodePresence({ id: this.playerId, name: this.name, cls: this.cls, host: 0, alive: 0 }),
    );

    this.unsubs.push(
      this.net.subscribe(Topics.presenceAll(this.roomId), (topic, payload) => {
        this.onPresence(segment(topic, 0), payload);
      }),
      this.net.subscribe(Topics.hostBeat(this.roomId), (_t, payload) => this.onHeartbeat(payload)),
    );

    this.announcePresence();
    this.timers.push(
      window.setInterval(() => this.announcePresence(), NET.presenceMs),
      window.setInterval(() => this.tick(), 250),
      window.setInterval(() => this.beat(), 1000 / NET.heartbeatHz),
    );

    // Give the room a moment to answer before claiming authority; if nobody
    // heartbeats in that window we are alone and become host by default.
    this.lastHostBeat = performance.now();
    window.setTimeout(() => {
      if (!this._hostId) this.evaluateHost('initial');
    }, 900);
  }

  leave(): void {
    if (!this.joined) return;
    this.joined = false;
    this.net.publish(
      Topics.presence(this.roomId, this.playerId),
      encodePresence({ id: this.playerId, name: this.name, cls: this.cls, host: 0, alive: 0 }),
    );
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.peers.clear();
    this._isHost = false;
    this._hostId = null;
  }

  private announcePresence(): void {
    if (!this.joined) return;
    this.net.publish(
      Topics.presence(this.roomId, this.playerId),
      encodePresence({
        id: this.playerId,
        name: this.name,
        cls: this.cls,
        host: this._isHost ? 1 : 0,
        alive: 1,
      }),
    );
  }

  private onPresence(id: PlayerId, payload: string): void {
    if (!id || id === this.playerId) return;
    const msg = decodePresence(id, payload);
    if (!msg) return;

    if (!msg.alive) {
      if (this.peers.delete(id)) {
        this.events.emit('peerLeave', { id });
        this.events.emit('roster', { peers: [...this.peers.values()] });
        // Losing the host is exactly what the election exists for.
        if (this._hostId === id) this.evaluateHost('election');
      }
      return;
    }

    const existing = this.peers.get(id);
    const record: PeerRecord = {
      id,
      name: msg.name,
      cls: msg.cls,
      claimsHost: msg.host === 1,
      lastSeen: performance.now(),
    };
    this.peers.set(id, record);

    if (!existing) {
      this.events.emit('peerJoin', { peer: record });
      this.events.emit('roster', { peers: [...this.peers.values()] });
      // A newcomer needs to know who is in charge without waiting for a beat.
      if (this._isHost) this.beat();
    }
  }

  private onHeartbeat(payload: string): void {
    const hb = decodeHeartbeat(payload);
    if (!hb) return;
    if (hb.hostId === this.playerId) return;

    this.lastHostBeat = performance.now();
    // Carries the pause flag, so a client joining a paused room learns about it
    // within one heartbeat instead of running while everyone else is frozen.
    this.events.emit('hostStats', {
      enemyCount: hb.enemyCount, wave: hb.wave, paused: hb.paused, score: hb.score,
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

  private beat(): void {
    if (!this._isHost || !this.joined) return;
    const stats = this.hostStatsProvider();
    this.net.publish(
      Topics.hostBeat(this.roomId),
      encodeHeartbeat(
        this.playerId, ++this.beatSeq, stats.enemyCount, stats.wave, stats.paused, stats.score,
      ),
    );
  }

  private tick(): void {
    if (!this.joined) return;
    const now = performance.now();

    let dropped = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > NET.presenceTimeoutMs) {
        this.peers.delete(id);
        this.events.emit('peerLeave', { id });
        dropped = true;
        if (this._hostId === id) this.evaluateHost('election');
      }
    }
    if (dropped) this.events.emit('roster', { peers: [...this.peers.values()] });

    if (!this._isHost && now - this.lastHostBeat > NET.hostTimeoutMs) this.evaluateHost('election');

    this.checkCapacity();
  }

  /**
   * Room capacity, resolved the same way the host is: sort the alive ids and
   * take a rank. A client ranked fifth or later knows it is the overflow and
   * stands down on its own — no gatekeeper, and every client independently
   * agrees on which four are in, because they all sort the same list.
   */
  private checkCapacity(): void {
    const rank = this.aliveIds.indexOf(this.playerId);
    if (rank < HORDE.maxPlayers) {
      this.announcedFull = false;
      return;
    }
    if (this.announcedFull) return;
    this.announcedFull = true;
    this.events.emit('roomFull', { capacity: HORDE.maxPlayers });
  }

  /**
   * The election itself: sort the alive ids, take the front. Every client runs
   * this against its own roster and reaches the same conclusion, so no votes
   * are exchanged and there is no window where the AI loop stops running.
   */
  private evaluateHost(reason: 'initial' | 'election'): void {
    const winner = this.aliveIds[0] ?? this.playerId;
    const becameHost = winner === this.playerId;

    if (becameHost && !this._isHost) {
      this._isHost = true;
      this._hostId = this.playerId;
      this.lastHostBeat = performance.now();
      this.events.emit('hostChange', { hostId: this.playerId, isHost: true, reason });
      this.announcePresence();
      this.beat();
    } else if (!becameHost && this._hostId !== winner) {
      this._hostId = winner;
      this.events.emit('hostChange', { hostId: winner, isHost: false, reason });
    }
  }
}
