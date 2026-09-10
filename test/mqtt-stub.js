// Loopback MQTT broker. Same surface MqttNet uses, no network.
// Publishes are relayed over BroadcastChannel so several tabs share one "broker",
// which lets the test rig run a real multi-client room.
const clients = new Set();
const published = [];
globalThis.__published = published;

const channel = new BroadcastChannel('glitchburst-test-broker');
channel.onmessage = (e) => deliver(e.data.topic, e.data.payload);

function toRegex(filter) {
  return new RegExp('^' + filter.split('/').map(s =>
    s === '+' ? '[^/]+' : s === '#' ? '.*' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$');
}

function deliver(topic, payload) {
  const bytes = new TextEncoder().encode(payload);
  for (const c of clients) {
    if (!c.connected) continue;
    if (c.subs.some(s => s.regex.test(topic))) c.emit('message', topic, bytes);
  }
}

class StubClient {
  constructor(opts) {
    this.connected = false;
    this.subs = [];
    this.handlers = new Map();
    this.will = opts?.will ?? null;
    clients.add(this);
    setTimeout(() => { this.connected = true; this.emit('connect', {}); }, 5);
  }
  on(e, fn) { const a = this.handlers.get(e) ?? []; a.push(fn); this.handlers.set(e, a); return this; }
  once(e, fn) { const w = (...args) => { this.off(e, w); fn(...args); }; return this.on(e, w); }
  off(e, fn) { const a = this.handlers.get(e); if (a) this.handlers.set(e, a.filter(h => h !== fn)); return this; }
  emit(e, ...args) { for (const fn of [...(this.handlers.get(e) ?? [])]) fn(...args); }
  subscribe(topic) { this.subs.push({ topic, regex: toRegex(topic) }); return this; }
  unsubscribe(topic) { this.subs = this.subs.filter(s => s.topic !== topic); return this; }
  publish(topic, payload) {
    published.push({ topic, payload, t: performance.now() });
    deliver(topic, payload);
    channel.postMessage({ topic, payload });
    return this;
  }
  end() {
    // Fire the Last Will, exactly as a broker would on an ungraceful drop.
    if (this.will) {
      const payload = typeof this.will.payload === 'string'
        ? this.will.payload : new TextDecoder().decode(this.will.payload);
      deliver(this.will.topic, payload);
      channel.postMessage({ topic: this.will.topic, payload });
    }
    this.connected = false;
    clients.delete(this);
    return this;
  }
}

export default { connect: (_url, opts) => new StubClient(opts) };
