// ipad.js
// Strudel side of the iPad relative-encoder controller (a MIDI Fighter Twister
// in software). Talks JSON over a WebSocket to my-patterns/ipad-control/relay.mjs.
//
// Relative mode: the iPad never sends a position, only a delta. Strudel owns the
// authoritative value, so there is no takeover jump and no bank-switch jump, and
// the iPad is a pure display fed from here.
//
// Usage in the REPL:
//   $: s("bd*4, hh*8").lpf(k('lpf', 200, 4000)).gain(k('gain', 0, 1, {init: .8}))
//   $: s("cp*2").gain(tog('cp'))            — toggle tile, 1 when on
//
// A tile appears on the iPad the moment a k()/tog() is queried, labeled with its
// id, so the controller UI is generated from your pattern code.
//
//   ipad()            — reconnect / show status
//   ipad('192.168.1.x') — point at a relay on another host
//   ipadClear()       — forget all tiles + saved values

import { ref } from '@strudel/core';

const STORE_KEY = 'strudel-ipad-state';
const PER_BANK = 16;
const NUM_BANKS = 4;
const STALE_MS = 2000; // a control not queried for this long is dimmed on the iPad

const controls = new Map();
let ws = null;
let wsUrl = null;
let schemaDirty = true;
let valuesDirty = true;
let saveTimer = null;
let loggedFailure = false;

// ---------- persistence (mirrors what @strudel/midi does for CC state) ----------

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

const store = loadStore();

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const [id, c] of controls) out[id] = c.v;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch {
      // quota / private mode — losing knob positions is not worth throwing over
    }
  }, 800);
}

// ---------- value mapping ----------

// Controls store v in 0..1. toValue() maps that into the user's range.
// Wide ranges default to exponential so filter sweeps feel right.
function toValue(c) {
  if (c.curve === 'exp') {
    const lo = Math.max(c.min, 1e-6);
    return lo * Math.pow(c.max / lo, c.v);
  }
  return c.min + c.v * (c.max - c.min);
}

function fromValue(c, real) {
  if (c.curve === 'exp') {
    const lo = Math.max(c.min, 1e-6);
    return Math.log(Math.max(real, lo) / lo) / Math.log(c.max / lo);
  }
  return (real - c.min) / (c.max - c.min || 1);
}

function fmt(n) {
  if (!isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 10000) return (n / 1000).toFixed(0) + 'k';
  if (a >= 1000) return trim((n / 1000).toFixed(2)) + 'k';
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  if (a >= 1) return trim(n.toFixed(2));
  return trim(n.toFixed(3)).replace(/^(-?)0\./, '$1.');
}

const trim = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

// ---------- control registry ----------

// Knobs and toggles have separate slot pools: knobs fill the 4x4 grid across 4
// banks, toggles fill the global strip along the bottom.
function nextSlot(type) {
  const limit = type === 'tog' ? 8 : PER_BANK * NUM_BANKS;
  const taken = new Set([...controls.values()].filter((c) => c.type === type).map((c) => c.bank * PER_BANK + c.slot));
  for (let i = 0; i < limit; i++) if (!taken.has(i)) return i;
  return limit - 1;
}

function ensure(id, type, opts) {
  let c = controls.get(id);
  if (!c) {
    const idx = opts.bank != null && opts.slot != null ? opts.bank * PER_BANK + opts.slot : nextSlot(type);
    c = {
      id,
      type,
      name: opts.name ?? id,
      bank: Math.floor(idx / PER_BANK),
      slot: idx % PER_BANK,
      min: 0,
      max: 1,
      curve: 'lin',
      v: store[id] ?? 0,
      active: false,
      seen: 0,
    };
    controls.set(id, c);
    schemaDirty = true;
  }
  return c;
}

// Called on every query of the returned ref (~20Hz while the pattern runs), which
// is how the iPad knows which tiles are actually live right now.
function touch(c) {
  c.seen = performance.now();
  if (!c.active) {
    c.active = true;
    schemaDirty = true;
  }
}

/**
 * Relative encoder tile. Returns a pattern that reads the live value at query time.
 * @param {string} id tile id, also its label
 * @param {number} min
 * @param {number} max
 * @param {object} [opts] {init, curve: 'lin'|'exp', name, bank, slot}
 */
export function k(id, min = 0, max = 1, opts = {}) {
  const c = ensure(id, 'k', opts);
  // Anything spanning more than ~3 octaves feels wrong linear (a 200..4000 filter
  // would sit at 2.1k at half travel instead of ~900).
  const curve = opts.curve ?? (min > 0 && max / min >= 8 ? 'exp' : 'lin');
  if (c.min !== min || c.max !== max || c.curve !== curve || c.name !== (opts.name ?? id)) {
    c.min = min;
    c.max = max;
    c.curve = curve;
    c.name = opts.name ?? id;
    schemaDirty = true;
  }
  if (store[id] === undefined && !c.inited) {
    c.v = opts.init !== undefined ? Math.min(1, Math.max(0, fromValue(c, opts.init))) : 0.5;
    c.inited = true;
    valuesDirty = true;
  }
  return ref(() => {
    touch(c);
    return toValue(c);
  });
}

/** Toggle tile. Returns 1 when on, 0 when off. */
export function tog(id, opts = {}) {
  const c = ensure(id, 'tog', opts);
  if (store[id] === undefined && !c.inited) {
    c.v = opts.init ? 1 : 0;
    c.inited = true;
  }
  return ref(() => {
    touch(c);
    return c.v >= 0.5 ? 1 : 0;
  });
}

/** Inverted toggle — 1 when OFF. Handy as a mute: .gain(ntog('d1')) */
export function ntog(id, opts = {}) {
  const c = ensure(id, 'tog', opts);
  return ref(() => {
    touch(c);
    return c.v >= 0.5 ? 0 : 1;
  });
}

export function ipadClear() {
  controls.clear();
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // nothing saved yet, or storage unavailable
  }
  for (const key of Object.keys(store)) delete store[key];
  schemaDirty = true;
  console.log('[ipad] cleared');
}

// ---------- transport ----------

function schema() {
  const now = performance.now();
  return {
    t: 'schema',
    banks: NUM_BANKS,
    perBank: PER_BANK,
    controls: [...controls.values()].map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      bank: c.bank,
      slot: c.slot,
      v: c.v,
      display: c.type === 'k' ? fmt(toValue(c)) : c.v >= 0.5 ? 'on' : 'off',
      active: now - c.seen < STALE_MS,
    })),
  };
}

function values() {
  const now = performance.now();
  const v = {};
  for (const [id, c] of controls) {
    v[id] = { v: c.v, display: c.type === 'k' ? fmt(toValue(c)) : c.v >= 0.5 ? 'on' : 'off' };
    const active = now - c.seen < STALE_MS;
    if (active !== c.active) {
      c.active = active;
      schemaDirty = true;
    }
  }
  return { t: 'values', v };
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function onMessage(msg) {
  const c = controls.get(msg.id);
  switch (msg.t) {
    case 'delta':
      if (!c) return;
      c.v = Math.min(1, Math.max(0, c.v + msg.d));
      valuesDirty = true;
      saveSoon();
      break;
    case 'toggle':
      if (!c) return;
      c.v = msg.v ? 1 : 0;
      valuesDirty = true;
      saveSoon();
      break;
    case 'reset':
      if (!c) return;
      c.v = c.type === 'tog' ? 0 : 0.5;
      valuesDirty = true;
      saveSoon();
      break;
    case 'hello':
      schemaDirty = true;
      break;
  }
}

function connect(host) {
  // https pages can only open wss:// sockets (mixed content), so follow the page.
  const scheme = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws';
  // The relay listens http/ws on 9000 (iPad) and https/wss on 9001 (this tab).
  const port = scheme === 'wss' ? 9001 : 9000;
  wsUrl = `${scheme}://${host ?? globalThis.location?.hostname ?? 'localhost'}:${port}`;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    return;
  }
  ws.onopen = () => {
    loggedFailure = false;
    console.log(`[ipad] connected to relay at ${wsUrl}`);
    send({ t: 'hello', role: 'strudel' });
    schemaDirty = true;
    valuesDirty = true;
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      // ignore malformed frames rather than killing the socket
    }
  };
  ws.onclose = () => {
    if (!loggedFailure) {
      loggedFailure = true;
      console.log(`[ipad] relay not reachable at ${wsUrl} — start it with: node my-patterns/ipad-control/relay.mjs`);
    }
    ws = null;
    setTimeout(() => connect(host), 3000);
  };
  ws.onerror = () => ws?.close();
}

/** Reconnect, optionally against a different host. */
export function ipad(host) {
  ws?.close();
  ws = null;
  connect(host);
  return `[ipad] connecting to ${host ?? 'localhost'}:9000`;
}

if (typeof window !== 'undefined') {
  connect();
  // ~30Hz push. Cheap: a few hundred bytes per frame.
  setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    const v = values(); // also refreshes the active flags schema() reports
    if (schemaDirty) {
      schemaDirty = false;
      send(schema());
    }
    send(v);
  }, 33);

  Object.assign(window, { k, tog, ntog, ipad, ipadClear });
}
