// A stand-in for ntfy.sh on your own machine, for testing crews with two copies of Lock In
// (scripts/demo/crew-e2e.sh). It speaks the part of ntfy's protocol Lock In uses: POST a message
// to /<topic>, subscribe over a WebSocket at /<topic>/ws?since=… (a duration like 30s/10m/12h,
// or a message id), messages as {id, time, event: "message", topic, message}. Like ntfy.sh, a
// message over 4,096 bytes isn't delivered as text, so the test fails loudly if Lock In sends one.
//   node scripts/demo/crew-relay.mjs [port]
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

const PORT = Number(process.argv[2] || 8787);
const LIMIT = 4096;
const topics = new Map();
const topic = (name) => topics.get(name) ?? topics.set(name, { msgs: [], subs: new Set() }).get(name);
let biggest = 0;

function since(t, param) {
  const now = Date.now() / 1000;
  const m = /^(\d+)([smhd])$/.exec(param || '');
  if (m) return t.msgs.filter((x) => x.time >= now - Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]]);
  if (param === 'all') return t.msgs;
  const i = t.msgs.findIndex((x) => x.id === param);
  return i >= 0 ? t.msgs.slice(i + 1) : [];
}

const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url || '/').split('?')[0].slice(1));
  if (req.method !== 'POST' || !name || name.includes('/')) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const bytes = Buffer.byteLength(body);
    biggest = Math.max(biggest, bytes);
    if (bytes > LIMIT) {
      console.log(`TOO BIG ${bytes} bytes on ${name}`);
      res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'message too large' }));
      return;
    }
    const t = topic(name);
    const msg = { id: randomBytes(6).toString('hex'), time: Math.floor(Date.now() / 1000), expires: Math.floor(Date.now() / 1000) + 43200, event: 'message', topic: name, message: body };
    t.msgs.push(msg);
    for (const ws of t.subs) ws.send(JSON.stringify(msg));
    console.log(`message ${bytes} bytes on ${name.slice(0, 8)}… to ${t.subs.size} (largest so far ${biggest})`);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(msg));
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://x');
  const m = /^\/([^/]+)\/ws$/.exec(url.pathname);
  if (!m) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const name = decodeURIComponent(m[1]);
    const t = topic(name);
    ws.send(JSON.stringify({ id: randomBytes(6).toString('hex'), time: Math.floor(Date.now() / 1000), event: 'open', topic: name }));
    for (const msg of since(t, url.searchParams.get('since'))) ws.send(JSON.stringify(msg));
    t.subs.add(ws);
    console.log(`subscriber on ${name.slice(0, 8)}… (${t.subs.size})`);
    ws.on('close', () => t.subs.delete(ws));
  });
});

setInterval(() => {
  for (const [name, t] of topics) for (const ws of t.subs) ws.send(JSON.stringify({ id: randomBytes(6).toString('hex'), time: Math.floor(Date.now() / 1000), event: 'keepalive', topic: name }));
}, 30_000).unref();

server.listen(PORT, '127.0.0.1', () => console.log(`relay on http://127.0.0.1:${PORT}`));
