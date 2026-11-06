import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { NtfyRelay, type RelayMessage } from '../src/main/crew/relay';
import { Crew, type CrewData, type LocalStatus } from '../src/main/crew/crew';
import { DEFAULT_CREW } from '../src/shared/templates';
import type { CrewSettings } from '../src/shared/types';

/** A small server that speaks ntfy's protocol: POST /<topic> publishes, /<topic>/ws?since= subscribes. */
function fakeNtfy(): Promise<{ url: string; server: Server; kick: () => void; posts: number }> {
  const topics = new Map<string, { id: string; time: number; event: 'message'; topic: string; message: string }[]>();
  const subs = new Map<string, Set<WebSocket>>();
  let seq = 0;
  const state = { posts: 0 };
  const server = createServer((req, res) => {
    const topic = decodeURIComponent((req.url ?? '/').slice(1));
    if (req.method !== 'POST' || !/^[\w-]+$/.test(topic)) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.posts++;
      const m = { id: `id${++seq}`, time: Math.floor(Date.now() / 1000), event: 'message' as const, topic, message: body };
      topics.set(topic, [...(topics.get(topic) ?? []), m]);
      for (const ws of subs.get(topic) ?? []) ws.send(JSON.stringify(m));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(m));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const m = /^\/([\w-]+)\/ws$/.exec(u.pathname);
    if (!m) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const topic = m[1];
      const since = u.searchParams.get('since') ?? '';
      if (!subs.has(topic)) subs.set(topic, new Set());
      subs.get(topic)!.add(ws);
      ws.on('close', () => subs.get(topic)!.delete(ws));
      ws.send(JSON.stringify({ id: 'open', time: 0, event: 'open', topic }));
      // Catch up: everything after a message id, or everything cached for a duration.
      const cached = topics.get(topic) ?? [];
      const from = since.startsWith('id') ? cached.findIndex((x) => x.id === since) + 1 : 0;
      for (const x of cached.slice(from)) ws.send(JSON.stringify(x));
      ws.send(JSON.stringify({ id: 'k', time: 0, event: 'keepalive', topic }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        server,
        kick: () => wss.clients.forEach((c) => c.terminate()),
        get posts() {
          return state.posts;
        },
      });
    }),
  );
}

const until = async (fn: () => boolean, ms = 8000, what = '') => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

function person(url: string, name: string) {
  const settings: CrewSettings = { ...DEFAULT_CREW, name, server: url };
  let data: CrewData | null = null;
  const local: LocalStatus = { state: 'free', since: Date.now(), stats: { todayMin: 1, weekMin: 2, streak: 0, roastedWeek: 0, bombsThrownWeek: 0, achievements: 0 } };
  const bombs: string[] = [];
  let crew!: Crew;
  const relay = new NtfyRelay({ server: () => settings.server, onMessage: (m: RelayMessage) => crew.receive(m), onState: (on, e) => crew.setConnection(on, e), log: () => undefined });
  crew = new Crew({
    settings: () => settings,
    saveSettings: (p) => Object.assign(settings, p),
    relay,
    load: () => data,
    save: (d) => (data = d),
    local: () => local,
    onBomb: (b) => {
      bombs.push(b.insult);
      return 'hit';
    },
    onChange: () => undefined,
    log: () => undefined,
  });
  return { crew, relay, settings, local, bombs };
}

test('two Lock Ins talk through an ntfy server: statuses, a bomb, and catching up after a dropped connection', async () => {
  const ntfy = await fakeNtfy();
  const grace = person(ntfy.url, 'Grace');
  const sam = person(ntfy.url, 'Sam');
  try {
    const code = grace.crew.create('Gremlins', 'Grace');
    sam.crew.join(code, 'Sam');
    await until(() => grace.relay.connected && sam.relay.connected, 8000, 'connecting');
    grace.crew.tick();
    sam.crew.tick();
    await until(() => grace.crew.view().members.length === 2 && sam.crew.view().members.length === 2, 3000, `statuses ${grace.crew.view().members.length} ${sam.crew.view().members.length} posts ${ntfy.posts}`);
    assert.equal(sam.settings.crewName, 'Gremlins');

    assert.deepEqual(await grace.crew.throwBomb(sam.crew.me, 'Close it. Whatever it is.'), { ok: true });
    await until(() => sam.bombs.length === 1, 8000, 'bomb lands');
    assert.equal(sam.bombs[0], 'Close it. Whatever it is.');
    await until(() => grace.crew.events().some((e) => e.outcome === 'hit'), 8000, 'hit reported');

    // The connection drops: both reconnect, and statuses flow again.
    ntfy.kick();
    await until(() => !sam.relay.connected, 8000, 'dropped');
    await until(() => sam.relay.connected && grace.relay.connected, 10000, 'reconnected');
    grace.local.state = 'locked';
    grace.crew.tick();
    await until(() => sam.crew.view().members.find((m) => !m.me)?.state === 'locked', 8000, 'status after reconnect');

    // Sam quits Lock In for a while; when he's back he catches up from the relay's cache.
    sam.crew.stop();
    grace.local.state = 'free';
    grace.crew.tick();
    await new Promise((r) => setTimeout(r, 100));
    sam.crew.start();
    await until(() => sam.crew.view().members.find((m) => !m.me)?.state === 'free', 8000, 'caught up');
    assert.equal(sam.bombs.length, 1, 'nothing replayed twice');
  } finally {
    grace.crew.stop();
    sam.crew.stop();
    ntfy.server.close();
  }
});
