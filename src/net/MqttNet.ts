import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import { NET } from '../config.js';
import { Emitter } from '../util.js';

export type NetStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'error';

export interface NetEvents extends Record<string, unknown> {
  status: { status: NetStatus; detail?: string };
  /** Raw delivery, already routed to any matching pattern subscriber. */
  message: { topic: string; payload: string };
}

type RouteHandler = (topic: string, payload: string) => void;

interface Route {
  pattern: string;
  regex: RegExp;
  handler: RouteHandler;
}

/** Translate an MQTT filter (`+` single level, `#` multi level) into a regex. */
function filterToRegex(filter: string): RegExp {
  const escaped = filter
    .split('/')
    .map((seg) => (seg === '+' ? '[^/]+' : seg === '#' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}

/**
 * Thin transport layer over MQTT.js.
 *
 * The rest of the game never touches the MQTT client directly — it subscribes
 * to topic *patterns* and gets decoded strings. Everything is QoS 0: this is a
 * realtime game, and a snapshot that arrives late is worse than one that never
 * arrives at all, since a fresher one is already 50 ms behind it.
 */
export class MqttNet {
  readonly events = new Emitter<NetEvents>();
  private client: MqttClient | null = null;
  private routes: Route[] = [];
  private _status: NetStatus = 'idle';
  private willTopic: string | null = null;
  private willPayload = '';

  get status(): NetStatus {
    return this._status;
  }

  get connected(): boolean {
    return this.client?.connected === true;
  }

  /** Register the Last Will before connecting so an ungraceful exit still de-lists the player. */
  setWill(topic: string, payload: string): void {
    this.willTopic = topic;
    this.willPayload = payload;
  }

  async connect(url: string, clientId: string): Promise<void> {
    this.disconnect();
    this.setStatus('connecting');

    const opts: IClientOptions = {
      clientId,
      clean: true,
      keepalive: NET.keepaliveSec,
      connectTimeout: NET.connectTimeoutMs,
      reconnectPeriod: NET.reconnectMs,
      protocolVersion: 4,
      ...(this.willTopic
        ? { will: { topic: this.willTopic, payload: this.willPayload, qos: 0 as const, retain: false } }
        : {}),
    };

    const client = mqtt.connect(url, opts);
    this.client = client;

    client.on('message', (topic: string, payload: Uint8Array) => {
      const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
      for (const route of this.routes) {
        if (route.regex.test(topic)) route.handler(topic, text);
      }
      this.events.emit('message', { topic, payload: text });
    });

    client.on('reconnect', () => this.setStatus('reconnecting'));
    client.on('offline', () => this.setStatus('offline'));
    client.on('close', () => {
      if (this._status === 'online') this.setStatus('offline');
    });
    client.on('error', (err: Error) => this.setStatus('error', err.message));

    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        cleanup();
        this.setStatus('online');
        // Re-arm every subscription: a clean session keeps nothing across reconnects.
        for (const route of this.routes) client.subscribe(route.pattern, { qos: 0 });
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Broker did not respond in time.'));
      }, NET.connectTimeoutMs);
      const cleanup = () => {
        window.clearTimeout(timer);
        client.off('connect', onConnect);
        client.off('error', onError);
      };
      client.once('connect', onConnect);
      client.once('error', onError);
    });

    // Later reconnects must re-subscribe too, and this listener outlives the promise.
    client.on('connect', () => {
      this.setStatus('online');
      for (const route of this.routes) client.subscribe(route.pattern, { qos: 0 });
    });
  }

  subscribe(pattern: string, handler: RouteHandler): () => void {
    const route: Route = { pattern, regex: filterToRegex(pattern), handler };
    this.routes.push(route);
    this.client?.subscribe(pattern, { qos: 0 });
    return () => {
      this.routes = this.routes.filter((r) => r !== route);
      if (!this.routes.some((r) => r.pattern === pattern)) this.client?.unsubscribe(pattern);
    };
  }

  /** Fire-and-forget. Publishing while offline is a no-op rather than an error. */
  publish(topic: string, payload: string, retain = false): void {
    if (!this.client?.connected) return;
    this.client.publish(topic, payload, { qos: 0, retain });
  }

  disconnect(): void {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      client.end(true);
    } catch {
      /* the socket is already gone; nothing to clean up */
    }
    this.setStatus('idle');
  }

  private setStatus(status: NetStatus, detail?: string): void {
    if (this._status === status && !detail) return;
    this._status = status;
    this.events.emit('status', { status, detail });
  }
}
