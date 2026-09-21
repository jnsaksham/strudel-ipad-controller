// app.js — iPad relative-encoder surface for Strudel.
//
// Every tile is a drag surface: touch anywhere on it and drag vertically. We send
// deltas only; Strudel owns the value and echoes it back for display. That is what
// removes both the takeover jump and the bank-switch jump.

const TRAVEL = 420; // px of drag for full range at 1x
const ACCEL_K = 1.35; // how hard velocity scales the delta
const ACCEL_MAX = 5;
const FINE = 0.12; // SHIFT multiplier
const TAP_MS = 250; // below this, with little movement, it is a tap
const DBL_MS = 350;

const PER_BANK = 16;
const COLS = 4;
const MAX_TOGS = 8;

const gridEl = document.getElementById('grid');
const railEl = document.getElementById('rail');
const stripEl = document.getElementById('strip');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');

let schema = { banks: 4, perBank: PER_BANK, controls: [] };
let bank = 0;
let shift = false;
let ws = null;

const tiles = new Map(); // id -> {el, fill, val, type}
const drags = new Map(); // pointerId -> drag state
const pending = new Map(); // id -> accumulated delta awaiting flush
const local = new Map(); // id -> optimistic value, overwritten by server echo

// ---------- transport ----------

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    status('connected');
    send({ t: 'hello', role: 'ipad' });
  };
  ws.onmessage = (e) => {
    lastFromStrudel = Date.now(); // only the Strudel side ever sends us anything
    const msg = JSON.parse(e.data);
    if (msg.t === 'schema') {
      schema = msg;
      render();
    } else if (msg.t === 'values') {
      update(msg.v);
    }
  };
  ws.onclose = () => {
    status('reconnecting…');
    setTimeout(connect, 1000);
  };
  ws.onerror = () => ws.close();
}

const status = (s) => (statusEl.textContent = s);

// The three ways this screen can legitimately be empty, told apart so you never
// have to guess which half of the chain is down.
let lastFromStrudel = 0;

function updateHint() {
  const knobs = schema.controls.filter((c) => c.type === 'k').length;
  let html = '';
  if (!ws || ws.readyState !== 1) {
    html = '<b>Relay offline</b><div>Run <code>node my-patterns/ipad-control/relay.mjs</code></div>';
  } else if (Date.now() - lastFromStrudel > 2500) {
    html = '<b>Strudel not connected</b><div>Open <code>http://localhost:4321</code> and reload it (Cmd+Shift+R)</div>';
  } else if (!knobs) {
    html = "<b>No controls yet</b><div>Play a pattern using <code>k('lpf', 200, 4000)</code> in Strudel</div>";
  }
  hintEl.innerHTML = html;
  hintEl.classList.toggle('show', !!html);
}
setInterval(updateHint, 1000);

// ---------- rendering ----------

const R = 44;
const C = 2 * Math.PI * R;
const SWEEP = 0.75; // 270° knob arc, gap at the bottom

function knobSvg() {
  return `<svg viewBox="0 0 100 100">
    <circle class="track" cx="50" cy="50" r="${R}" stroke-width="7"
            stroke-dasharray="${SWEEP * C} ${C}"/>
    <circle class="fill" cx="50" cy="50" r="${R}" stroke-width="7"
            stroke-dasharray="0 ${C}"/>
  </svg>`;
}

function render() {
  const byBank = schema.controls.filter((c) => c.type === 'k' && c.bank === bank);
  const togs = schema.controls.filter((c) => c.type === 'tog').slice(0, MAX_TOGS);

  tiles.clear();
  gridEl.innerHTML = '';
  for (let slot = 0; slot < PER_BANK; slot++) {
    const c = byBank.find((x) => x.slot === slot);
    const el = document.createElement('div');
    el.className = c ? 'tile' : 'tile empty';
    if (c) {
      el.innerHTML = `${knobSvg()}<div class="name"></div><div class="val"></div>`;
      el.querySelector('.name').textContent = c.name;
      tiles.set(c.id, {
        el,
        fill: el.querySelector('.fill'),
        val: el.querySelector('.val'),
        type: 'k',
      });
      bindKnob(el, c.id);
    }
    gridEl.appendChild(el);
  }

  stripEl.innerHTML = '';
  for (const c of togs) {
    const el = document.createElement('div');
    el.className = 'tog';
    el.textContent = c.name;
    tiles.set(c.id, { el, type: 'tog' });
    bindToggle(el, c.id);
    stripEl.appendChild(el);
  }

  railEl.innerHTML = '';
  for (let b = 0; b < schema.banks; b++) {
    const el = document.createElement('div');
    el.className = 'btn' + (b === bank ? ' sel' : '');
    el.textContent = 'ABCD'[b];
    el.addEventListener('pointerdown', () => {
      bank = b;
      render();
    });
    railEl.appendChild(el);
  }
  const sh = document.createElement('div');
  sh.className = 'btn shift' + (shift ? ' sel' : '');
  sh.textContent = 'FINE';
  sh.addEventListener('pointerdown', () => {
    shift = !shift;
    sh.classList.toggle('sel', shift);
  });
  railEl.appendChild(sh);

  updateHint();
  update(Object.fromEntries(schema.controls.map((c) => [c.id, { v: c.v, display: c.display }])));
  for (const c of schema.controls) tiles.get(c.id)?.el.classList.toggle('stale', !c.active);
}

function update(values) {
  for (const [id, { v, display }] of Object.entries(values)) {
    const t = tiles.get(id);
    if (!t) continue;
    // A finger on the tile wins until it lifts, so the display never fights the drag.
    const held = t.el.classList.contains('held');
    const vv = held ? (local.get(id) ?? v) : v;
    if (!held) local.set(id, v);
    paint(t, vv, held ? null : display);
  }
  for (const c of schema.controls) tiles.get(c.id)?.el.classList.toggle('stale', !c.active);
}

function paint(t, v, display) {
  if (t.type === 'tog') {
    t.el.classList.toggle('on', v >= 0.5);
    return;
  }
  t.fill.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, v)) * SWEEP * C} ${C}`);
  if (display != null) t.val.textContent = display;
}

// ---------- gestures ----------

function bindKnob(el, id) {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('held');
    drags.set(e.pointerId, { id, el, y: e.clientY, t: e.timeStamp, down: e.timeStamp, moved: 0 });
  });

  el.addEventListener('pointermove', (e) => {
    const d = drags.get(e.pointerId);
    if (!d) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events) {
      const dy = d.y - ev.clientY; // up = increase
      const dt = Math.max(1, ev.timeStamp - d.t);
      d.y = ev.clientY;
      d.t = ev.timeStamp;
      d.moved += Math.abs(dy);
      // Velocity-scaled: a slow drag stays fine, a flick covers the range.
      const accel = Math.min(ACCEL_MAX, 1 + (Math.abs(dy) / dt) * ACCEL_K);
      queue(id, (dy / TRAVEL) * accel * (shift ? FINE : 1));
    }
  });

  const end = (e) => {
    const d = drags.get(e.pointerId);
    if (!d) return;
    drags.delete(e.pointerId);
    el.classList.remove('held');
    if (d.moved < 8 && e.timeStamp - d.down < TAP_MS) {
      if (el._lastTap && e.timeStamp - el._lastTap < DBL_MS) {
        send({ t: 'reset', id });
        el._lastTap = 0;
      } else {
        el._lastTap = e.timeStamp;
      }
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function bindToggle(el, id) {
  el.addEventListener('pointerdown', () => {
    const on = !el.classList.contains('on');
    el.classList.toggle('on', on); // optimistic, server echo confirms
    send({ t: 'toggle', id, v: on });
  });
}

// Accumulate deltas and flush once per frame, so ten fingers at 120Hz still
// produce at most one small message per frame.
function queue(id, d) {
  pending.set(id, (pending.get(id) ?? 0) + d);
  local.set(id, Math.max(0, Math.min(1, (local.get(id) ?? 0) + d)));
  const t = tiles.get(id);
  if (t) paint(t, local.get(id), null);
}

function flush() {
  for (const [id, d] of pending) send({ t: 'delta', id, d });
  pending.clear();
  requestAnimationFrame(flush);
}
requestAnimationFrame(flush);

// ---------- iPad housekeeping ----------

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    // wake lock is best-effort; Safari refuses it when the tab is backgrounded
  }
}
keepAwake();
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());

connect();
render();
