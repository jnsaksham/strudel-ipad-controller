#!/usr/bin/env node
// relay.mjs
// Serves the iPad controller page and relays JSON between it and the Strudel tab.
//
//   node my-patterns/ipad-control/relay.mjs
//
// Zero dependencies on purpose: `ws` is not hoisted to the repo root, and the
// RFC6455 subset we need (small, unfragmented text frames) is short enough to inline.
//
// iPad  -> {t:'delta'|'toggle'|'reset', id, ...}  -> Strudel
// Strudel -> {t:'schema'|'values', ...}           -> iPad

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 9000);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC6455 magic string

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// ---------- static ----------

// Opt-in TLS: a browser page served over https cannot open a ws:// socket
// (mixed content), so when Strudel runs over https the relay must too.
//   SSL_CERT=... SSL_KEY=... node my-patterns/ipad-control/relay.mjs
const SSL_CERT = process.env.SSL_CERT;
const SSL_KEY = process.env.SSL_KEY;
const SECURE = Boolean(SSL_CERT && SSL_KEY);

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
};

// Two listeners when TLS is configured:
//   PORT     http  — the iPad. iOS Safari will not open a wss:// socket against an
//                    untrusted self-signed cert, even after accepting the page warning.
//   PORT+1   https — the Strudel tab, which must be https for AudioWorklet and so can
//                    only speak wss.
// Both share one client set, so the iPad and the browser still see each other.
const server = http.createServer(handler);
const secureServer = SECURE
  ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, handler)
  : null;
const SECURE_PORT = PORT + 1;

// ---------- websocket ----------

const clients = new Set();

const handleUpgrade = (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${crypto
        .createHash('sha1')
        .update(key + GUID)
        .digest('base64')}\r\n\r\n`,
  );
  socket.setNoDelay(true); // Nagle would add up to 40ms to a 1-byte knob delta

  const client = { socket, role: '?' };
  clients.add(client);

  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = readFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.size);
      if (frame.opcode === 0x8) return drop(client);
      if (frame.opcode === 0x9) {
        socket.write(encode(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode !== 0x1) continue;
      handle(client, frame.payload.toString('utf8'));
    }
  });
  socket.on('error', () => drop(client));
  socket.on('close', () => drop(client));
};

server.on('upgrade', handleUpgrade);
secureServer?.on('upgrade', handleUpgrade);

function drop(client) {
  if (!clients.delete(client)) return;
  client.socket.destroy();
  log(`${client.role} disconnected`);
}

function handle(client, text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.t === 'hello') {
    client.role = msg.role === 'strudel' ? 'strudel' : 'ipad';
    log(`${client.role} connected`);
  }
  // Relay to the other side only, never echo back to the sender's own role.
  const target = client.role === 'strudel' ? 'ipad' : 'strudel';
  for (const c of clients) {
    if (c.role === target && c.socket.writable) c.socket.write(encode(Buffer.from(text), 0x1));
  }
}

// Parse one frame. Returns null if the buffer does not yet hold a complete frame.
function readFrame(b) {
  if (b.length < 2) return null;
  const opcode = b[0] & 0x0f;
  const masked = (b[1] & 0x80) !== 0;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < off + 2) return null;
    len = b.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (b.length < off + 8) return null;
    len = Number(b.readBigUInt64BE(off));
    off += 8;
  }
  const maskKey = masked ? b.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (b.length < off + len) return null;

  const payload = Buffer.from(b.subarray(off, off + len));
  if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
  return { opcode, payload, size: off + len };
}

// Server->client frames are never masked.
function encode(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

const log = (...a) => console.log('[relay]', ...a);

// No host argument: Node binds :: dual-stack, so IPv6 *and* IPv4 both work.
// Binding '0.0.0.0' makes it IPv4-only, and mDNS advertises this mac's IPv6
// addresses ahead of its IPv4 one — iOS prefers IPv6 and the connection hangs.
server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  log(`listening on :${PORT}`);
  log(`test on this mac:   http://localhost:${PORT}`);
  // Prefer the Bonjour name: the DHCP lease can hand out a different IP any time.
  const host = os.hostname().endsWith('.local') ? os.hostname() : `${os.hostname()}.local`;
  log(`open on the iPad:   http://${host}:${PORT}`);
  for (const ip of ips) log(`       or by IP:     http://${ip}:${PORT}`);
  if (SECURE) {
    secureServer.listen(SECURE_PORT);
    log(`https for strudel:  wss://${ips[0] ?? 'localhost'}:${SECURE_PORT}  (accept the cert at https://${ips[0] ?? 'localhost'}:${SECURE_PORT})`);
  }
  if (!ips.length) log('    (no LAN address found — is wifi on?)');
});
