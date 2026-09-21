# iPad controller for Strudel

A software MIDI Fighter Twister: a 4×4 grid of **relative** encoder tiles, 4 banks
(64 params), a strip of toggles, and a FINE button. Tiles are generated from your
pattern code — write `k('lpf', 200, 4000)` and a tile labeled `lpf` appears.

## Run it

```sh
node my-patterns/ipad-control/relay.mjs   # prints the URLs to open
npm run repl                              # Strudel, as usual
```

### Test it on the mac first — no iPad needed

Open **http://localhost:9000** in a second browser window on the mac. A mouse
fires the same `pointerdown/move/up` events as a finger, so drags, banks,
toggles, arcs and the FINE button all work. Put it beside the Strudel tab and you
can develop the whole thing without touching the iPad. The only things you can't
test this way are multitouch and how the drag *feels*.

### Then the iPad

Open the printed `http://<your-mac>.local:9000` in Safari, then Share →
**Add to Home Screen** and launch from there for fullscreen with no browser chrome.

Nothing is hosted anywhere. The relay binds `0.0.0.0`, so it is reachable on your
mac's LAN address, and the iPad talks to it directly over your router. No cloud,
no domain, no port forwarding — the traffic never leaves the building.

Requirements and gotchas:

- **Both devices on the same wifi.** Not one on 5 GHz and one on a guest SSID.
- **Guest networks won't work.** Most routers enable client isolation on them,
  which blocks device-to-device traffic. Use your normal network.
- **Prefer the `.local` name over the IP.** DHCP reassigns the IP (this mac has
  already moved from `.5` to `.27`), but the Bonjour name is stable.
- **Set iPad Auto-Lock to Never** (Settings → Display & Brightness). The Screen
  Wake Lock API needs a secure context, so it works on `localhost` but not over
  plain HTTP on the LAN, and the screen will otherwise sleep mid-set.
- If you ever run Strudel from `strudel.cc` instead of locally, the browser will
  block `ws://` from an HTTPS page. Run it locally.

## Use it

```js
$: s("bd*4, hh*8")
  .lpf(k('lpf', 200, 4000))
  .room(k('room', 0, 0.8))
  .gain(k('gain', 0, 1, { init: 0.8 }))

$: s("cp*2").gain(tog('cp'))        // toggle tile
$: s("rim*8").gain(ntog('mute'))    // inverted — 1 when OFF
```

| gesture | effect |
|---|---|
| drag anywhere on a tile | change value (velocity-scaled) |
| FINE | 0.12× for precision |
| double-tap a tile | reset to centre |
| A/B/C/D | bank switch — never jumps, nothing is absolute |

Values persist in `localStorage` and survive a reload, same as `@strudel/midi`
does for CC state. `ipadClear()` wipes them.

`k()` options: `{ init, curve: 'lin'|'exp', name, bank, slot }`. Ranges spanning
more than ~3 octaves default to exponential, so `k('lpf', 200, 4000)` sits at
~900 Hz at half travel rather than 2.1k.

## How it works

The iPad **never sends a position, only a delta**. Strudel holds the authoritative
value and echoes it back at 30 Hz for display. That is what removes the takeover
jump you get from absolute faders on glass, and the jump on bank switches.

```
iPad  --{t:'delta'|'toggle'|'reset'}-->  relay.mjs  -->  ipad.js in the Strudel tab
iPad  <--{t:'schema'|'values'}---------  relay.mjs  <--
```

`k()` returns a `ref()` pattern (`@strudel/core`), read at query time — the same
mechanism `midin` uses, so no re-evaluation is needed to hear a change. The ref
accessor also marks the control live, which is why tiles dim when their pattern
stops running.

`relay.mjs` has no dependencies (`ws` is not hoisted to the repo root, and the
RFC6455 subset needed here is small). It also serves `public/`.

## Latency

Dominated by Strudel's scheduler, not the network: `cyclist.mjs` schedules every
event `latency = 0.1` seconds ahead and `zyklus.mjs` queries on a ~50 ms tick, so
a move lands **100–150 ms later, quantized to the event grid**. Wifi adds ~2–5 ms.
A wired Twister would feel the same, for the same reason.

If you want to remove wifi jitter for a gig, an iPad USB-C → Ethernet adapter puts
this same WebSocket on copper. That is for reliability, not speed.
