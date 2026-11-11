import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Bridge, BRIDGE_PORT } from '../src/main/sensors/bridge';

const URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { origin });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

test('bridge: rejects web pages, accepts the extension, tracks the tab, round-trips commands', async () => {
  const bridge = new Bridge(() => {}, () => {});
  bridge.start();
  await wait(100);
  try {
    await assert.rejects(connect('https://evil.example'), /401|403|HTTP/);

    const ext = await connect('chrome-extension://abcdefghijklmnop');
    ext.send(JSON.stringify({ type: 'hello', browser: 'Chrome' }));
    ext.send(JSON.stringify({ type: 'tab', tabId: 3, windowId: 1, url: 'https://youtube.com/watch?v=x', title: 'Cats', audible: true, playing: false, incognito: false, focused: true }));
    ext.send(JSON.stringify({ type: 'media', tabId: 3, playing: true }));
    await wait(100);
    assert.equal(bridge.connected, true);
    const tab = bridge.activeTab();
    assert.equal(tab?.url, 'https://youtube.com/watch?v=x');
    assert.equal(tab?.playing, true);

    // The fake extension acknowledges every command it receives.
    const got: string[] = [];
    ext.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'cmd') {
        got.push(m.cmd);
        ext.send(JSON.stringify({ type: 'ack', id: m.id, ok: true }));
      }
    });
    assert.equal(await bridge.send({ cmd: 'pause_media' }), true);
    assert.equal(await bridge.send({ cmd: 'block_domain', domain: 'youtube.com' }), true);
    assert.deepEqual(got, ['pause_media', 'block_domain']);
    ext.close();
    await wait(100);
    assert.equal(bridge.connected, false);
    assert.equal(await bridge.send({ cmd: 'unblock_all' }), false);
  } finally {
    bridge.stop();
  }
});

test('bridge: Lock In Extended can call the app and gets its state pushed', async () => {
  const calls: [string, unknown[]][] = [];
  const bridge = new Bridge(() => {}, () => {}, () => '1.0.0', async (method, args) => {
    calls.push([method, args]);
    if (method === 'nope') throw new Error("That isn't something the extension can do.");
    return { method, n: args.length };
  });
  bridge.start();
  await wait(100);
  try {
    // An old extension: coached, never sent state, can't call.
    const old = await connect('chrome-extension://old');
    old.send(JSON.stringify({ type: 'hello', browser: 'Chrome', version: '0.3.0' }));
    await wait(80);
    assert.equal(bridge.extended, false);

    const ext = await connect('chrome-extension://new');
    const inbox: { type: string; id?: string; ok?: boolean; value?: unknown; error?: string; state?: unknown }[] = [];
    ext.on('message', (raw) => inbox.push(JSON.parse(String(raw))));
    ext.send(JSON.stringify({ type: 'hello', browser: 'Chrome', version: '1.0.0', caps: ['call', 'state'] }));
    await wait(80);
    assert.equal(bridge.extended, true);

    ext.send(JSON.stringify({ type: 'call', id: 7, method: 'session:start', args: [{ goal: 'Deck', minutes: 25 }] }));
    ext.send(JSON.stringify({ type: 'call', id: 8, method: 'nope', args: [] }));
    await wait(120);
    assert.deepEqual(calls[0], ['session:start', [{ goal: 'Deck', minutes: 25 }]]);
    const r7 = inbox.find((m) => m.type === 'result' && m.id === '7');
    const r8 = inbox.find((m) => m.type === 'result' && m.id === '8');
    assert.deepEqual(r7?.value, { method: 'session:start', n: 1 });
    assert.equal(r7?.ok, true);
    assert.equal(r8?.ok, false);
    assert.match(String(r8?.error), /isn't something/);

    // State goes only to extensions that asked for it.
    let oldGotState = false;
    old.on('message', (raw) => {
      if (JSON.parse(String(raw)).type === 'state') oldGotState = true;
    });
    bridge.pushState({ hello: 1 } as never);
    await wait(80);
    assert.deepEqual(inbox.find((m) => m.type === 'state')?.state, { hello: 1 });
    assert.equal(oldGotState, false);
    ext.close();
    old.close();
  } finally {
    bridge.stop();
  }
});
