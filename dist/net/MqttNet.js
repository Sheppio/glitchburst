import mqtt from 'mqtt';
import { NET } from '../config.js';
import { Emitter } from '../util.js';
/** Translate an MQTT filter (`+` single level, `#` multi level) into a regex. */
function filterToRegex(filter) {
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
    events = new Emitter();
    client = null;
    routes = [];
    _status = 'idle';
    willTopic = null;
    willPayload = '';
    get status() {
        return this._status;
    }
    get connected() {
        return this.client?.connected === true;
    }
    /** Register the Last Will before connecting so an ungraceful exit still de-lists the player. */
    setWill(topic, payload) {
        this.willTopic = topic;
        this.willPayload = payload;
    }
    async connect(url, clientId) {
        this.disconnect();
        this.setStatus('connecting');
        const opts = {
            clientId,
            clean: true,
            keepalive: NET.keepaliveSec,
            connectTimeout: NET.connectTimeoutMs,
            reconnectPeriod: NET.reconnectMs,
            protocolVersion: 4,
            ...(this.willTopic
                ? { will: { topic: this.willTopic, payload: this.willPayload, qos: 0, retain: false } }
                : {}),
        };
        const client = mqtt.connect(url, opts);
        this.client = client;
        client.on('message', (topic, payload) => {
            const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
            for (const route of this.routes) {
                if (route.regex.test(topic))
                    route.handler(topic, text);
            }
            this.events.emit('message', { topic, payload: text });
        });
        client.on('reconnect', () => this.setStatus('reconnecting'));
        client.on('offline', () => this.setStatus('offline'));
        client.on('close', () => {
            if (this._status === 'online')
                this.setStatus('offline');
        });
        client.on('error', (err) => this.setStatus('error', err.message));
        await new Promise((resolve, reject) => {
            const onConnect = () => {
                cleanup();
                this.setStatus('online');
                // Re-arm every subscription: a clean session keeps nothing across reconnects.
                for (const route of this.routes)
                    client.subscribe(route.pattern, { qos: 0 });
                resolve();
            };
            const onError = (err) => {
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
            for (const route of this.routes)
                client.subscribe(route.pattern, { qos: 0 });
        });
    }
    subscribe(pattern, handler) {
        const route = { pattern, regex: filterToRegex(pattern), handler };
        this.routes.push(route);
        this.client?.subscribe(pattern, { qos: 0 });
        return () => {
            this.routes = this.routes.filter((r) => r !== route);
            if (!this.routes.some((r) => r.pattern === pattern))
                this.client?.unsubscribe(pattern);
        };
    }
    /** Fire-and-forget. Publishing while offline is a no-op rather than an error. */
    publish(topic, payload, retain = false) {
        if (!this.client?.connected)
            return;
        this.client.publish(topic, payload, { qos: 0, retain });
    }
    disconnect() {
        if (!this.client)
            return;
        const client = this.client;
        this.client = null;
        try {
            client.end(true);
        }
        catch {
            /* the socket is already gone; nothing to clean up */
        }
        this.setStatus('idle');
    }
    setStatus(status, detail) {
        if (this._status === status && !detail)
            return;
        this._status = status;
        this.events.emit('status', { status, detail });
    }
}
//# sourceMappingURL=MqttNet.js.map