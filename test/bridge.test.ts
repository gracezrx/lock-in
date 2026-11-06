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
