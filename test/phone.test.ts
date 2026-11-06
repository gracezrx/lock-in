import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneServer, type PhoneDevice } from '../src/main/phone/server';
import { PhoneChat } from '../src/main/phone/chat';
import { Talk } from '../src/main/talk/talk';
import { b64, hex, keyPair, randomBytes, seal, sealJson, sealParts, sharedKey, unb64, unseal, unsealJson, unsealParts, type RpcReply } from '../src/shared/seal';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import type { ElevenAgent } from '../src/main/talk/agent';
import type { Claude } from '../src/main/coach/llm';

test('sealed messages open only with the right key, and not after tampering', () => {
  const k = randomBytes(32);
  const box = sealJson(k, { hi: '你好' });
  assert.deepEqual(unsealJson(k, box), { hi: '你好' });
  assert.equal(unsealJson(randomBytes(32), box), null);
  const bad = box.slice();
  bad[40] ^= 1;
  assert.equal(unseal(k, bad), null);
  const parts = unsealParts<{ up: string }>(k, sealParts(k, { up: 'abc' }, new Uint8Array([1, 2, 3])))!;
  assert.deepEqual([parts.header.up, [...parts.body]], ['abc', [1, 2, 3]]);
  // Both sides of the key exchange end up with the same key.
  const a = keyPair();
  const b = keyPair();
  assert.deepEqual([...sharedKey(a.publicKey, b.secretKey)], [...sharedKey(b.publicKey, a.secretKey)]);
  assert.deepEqual([...unb64(b64(new Uint8Array([0, 250, 255, 7])))], [0, 250, 255, 7]);
});

async function setup(over: Partial<ConstructorParameters<typeof PhoneServer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-phone-'));
  writeFileSync(join(dir, 'phone.html'), '<!doctype html><title>Lock In</title>');
  let saved: PhoneDevice[] = [];
  const calls: [string, unknown[]][] = [];
  const uploads: { coach: string; data: string; name: string }[] = [];
  const server = new PhoneServer({
    port: 0,
    host: '127.0.0.1',
    file: (n) => (n === 'phone.html' ? join(dir, 'phone.html') : null),
    devices: { load: () => saved, save: (d) => (saved = d) },
    call: async (m, a) => {
      calls.push([m, a]);
      if (m === 'boom') throw new Error('nope');
      return { echo: a };
    },
    blob: (kind, id) => (kind === 'audio' && id === 'a1' ? Buffer.from('mp3 bytes') : null),
    upload: async (coach, path, name) => {
      uploads.push({ coach, data: readFileSync(path, 'utf8'), name });
      return { added: 1 };
    },
    uploadDir: join(dir, 'uploads'),
    log: () => undefined,
    macName: () => "Grace's MacBook Air",
    ...over,
  });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  return { server, base, calls, uploads, saved: () => saved, dir };
}

/** What the phone page does to pair. */
async function pairWith(base: string, code: string) {
  const hello = await fetch(`${base}/api/pair`);
  if (hello.status !== 200) return { status: hello.status, body: await hello.json() };
  const { pub } = (await hello.json()) as { pub: string };
  const kp = keyPair();
  const key = sharedKey(unb64(pub), kp.secretKey);
  const res = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ pub: b64(kp.publicKey), box: b64(sealJson(key, { code, name: '<b>iPhone</b>' })) }) });
  const body = (await res.json()) as { box?: string };
  const inner = body.box ? unsealJson<{ id: string; mac: string }>(key, unb64(body.box)) : null;
  return { status: res.status, body, key, inner };
}

const rpc = async (base: string, id: string, key: Uint8Array, m: string, a: unknown[] = [], over: { t?: number; n?: string } = {}) => {
  const res = await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'x-lockin-device': id }, body: sealJson(key, { t: over.t ?? Date.now(), n: over.n ?? hex(randomBytes(12)), m, a }) });
  if (res.status !== 200) return { status: res.status };
  return { status: 200, reply: unsealJson<RpcReply>(key, new Uint8Array(await res.arrayBuffer())) };
};

test('the page is served with a strict policy, and nothing outside it is', async () => {
  const s = await setup();
  try {
    const page = await fetch(`${s.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    for (const p of ['/../package.json', '/%2e%2e/secret', '/fonts/../../x', '/api/nothing', '/keys.json']) assert.notEqual((await fetch(`${s.base}${p}`)).status, 200, p);
    const m = (await (await fetch(`${s.base}/manifest.webmanifest`)).json()) as { display: string };
    assert.equal(m.display, 'standalone');
  } finally {
    s.server.stop();
  }
});

test('pairing: only with the code your Mac shows, 5 tries, then a fresh code is needed', async () => {
  const s = await setup();
  try {
    assert.equal((await pairWith(s.base, '123456')).status, 409, 'no code showing yet');
    const { code } = s.server.startPairing();
    const wrong = code === '000000' ? '000001' : '000000';
    const w1 = await pairWith(s.base, wrong);
    assert.deepEqual([w1.status, (w1.body as { left?: number }).left], [403, 4]);
    for (let i = 0; i < 3; i++) await pairWith(s.base, wrong);
    const w5 = await pairWith(s.base, wrong);
    assert.deepEqual([w5.status, (w5.body as { error?: string }).error], [403, 'too-many']);
    assert.equal((await pairWith(s.base, code)).status, 409, 'the code is gone after 5 wrong tries');

    const { code: c2 } = s.server.startPairing();
    const ok = await pairWith(s.base, c2);
    assert.equal(ok.status, 200);
    assert.equal(ok.inner?.mac, "Grace's MacBook Air");
    assert.equal(s.saved().length, 1);
    assert.equal(s.saved()[0].name, 'biPhoneb', 'no markup in names');
    assert.equal(s.server.pairingInfo, null, 'one code, one phone');
    assert.equal((await pairWith(s.base, c2)).status, 409);
    assert.ok(!('key' in s.server.list()[0]), 'keys never leave the server object');
  } finally {
    s.server.stop();
  }
});

test('requests: sealed, recent and never repeated', async () => {
  const s = await setup();
  try {
    s.server.startPairing();
    const { inner, key } = await pairWith(s.base, s.server.pairingInfo!.code);
    const id = inner!.id;
    const r = await rpc(s.base, id, key!, 'todos:get', [1, 'two']);
    assert.deepEqual(r.reply, { ok: true, r: { echo: [1, 'two'] } });
    assert.deepEqual((await rpc(s.base, id, key!, 'boom')).reply, { ok: false, e: 'nope' });
    // A captured request played again, an old one, the wrong key, or an unknown phone: all refused.
    const n = hex(randomBytes(12));
    assert.equal((await rpc(s.base, id, key!, 'x', [], { n })).status, 200);
    assert.equal((await rpc(s.base, id, key!, 'x', [], { n })).status, 401);
    assert.equal((await rpc(s.base, id, key!, 'x', [], { t: Date.now() - 60 * 60_000 })).status, 401);
    assert.equal((await rpc(s.base, id, randomBytes(32), 'x')).status, 401);
    assert.equal((await rpc(s.base, 'nobody', key!, 'x')).status, 401);
    assert.equal(s.calls.filter(([m]) => m === 'x').length, 1);
    // Removing the phone locks it out.
    s.server.remove(id);
    assert.equal((await rpc(s.base, id, key!, 'todos:get')).status, 401);
  } finally {
    s.server.stop();
  }
});

test('files arrive in sealed pieces, in order, and audio comes back sealed', async () => {
  const s = await setup();
  try {
    s.server.startPairing();
    const { inner, key } = await pairWith(s.base, s.server.pairingInfo!.code);
    const id = inner!.id;
    const send = async (up: string, i: number, last: boolean, body: string, name = 'Mum memo.m4a', size = 15) => {
      const res = await fetch(`${s.base}/api/upload`, { method: 'POST', headers: { 'x-lockin-device': id }, body: sealParts(key!, { t: Date.now(), n: hex(randomBytes(12)), up, i, last, name, size, coach: 'abc123abc123' }, new TextEncoder().encode(body)) });
      return unsealJson<RpcReply>(key!, new Uint8Array(await res.arrayBuffer()));
    };
    assert.equal((await send('aaaaaaaa1', 0, false, 'hello '))?.ok, true);
    assert.equal((await send('aaaaaaaa1', 2, false, 'oops'))?.ok, false, 'out of order');
    assert.equal((await send('aaaaaaaa1', 1, false, 'from '))?.ok, true);
    assert.deepEqual(await send('aaaaaaaa1', 2, true, 'mum'), { ok: true, r: { added: 1 } });
    assert.deepEqual(s.uploads, [{ coach: 'abc123abc123', data: 'hello from mum', name: 'Mum memo.m4a' }]);
    assert.equal((await send('bbbbbbbb2', 0, true, 'x', '../../evil.sh'))?.ok, true);
    assert.equal(s.uploads[1].name, '.._.._evil.sh'.replace(/^\.+/, ''), 'no paths in names');
    assert.equal((await send('cccccccc3', 0, true, 'x', 'big.mov', 400 * 1024 * 1024))?.ok, false, 'over 150 MB');

    const res = await fetch(`${s.base}/api/blob`, { method: 'POST', headers: { 'x-lockin-device': id }, body: sealJson(key!, { t: Date.now(), n: hex(randomBytes(12)), m: 'blob', a: ['audio', 'a1'] }) });
    assert.equal(new TextDecoder().decode(unseal(key!, new Uint8Array(await res.arrayBuffer()))!), 'mp3 bytes');
    const none = await fetch(`${s.base}/api/blob`, { method: 'POST', headers: { 'x-lockin-device': id }, body: sealJson(key!, { t: Date.now(), n: hex(randomBytes(12)), m: 'blob', a: ['audio', 'zz'] }) });
    assert.equal(none.status, 404);
  } finally {
    s.server.stop();
  }
});

test('talking from the phone: replies come back as text and as the coach’s voice', async () => {
  const logged: string[] = [];
  const chat = new PhoneChat(
    (hooks) =>
      new Talk({
        agent: {} as ElevenAgent,
        claude: { available: false } as Claude,
        hasVoiceKey: () => false,
        settings: () => DEFAULT_SETTINGS,
        persona: () => 'firm',
        context: () => ({ userName: 'Grace', persona: 'firm', profanityOk: false, situation: 'checkin', now: new Date(), status: '', openTasks: ['Email Sam'], doneToday: [], agenda: '' }),
        actions: {
          startFocus: () => 'ok',
          snooze: () => 'ok',
          route: async () => 'ok',
          addTodo: async () => 'ok',
          logDone: async (items) => {
            logged.push(String(items));
            return { ticked: [], added: [String(items)] };
          },
        },
        ...hooks,
        logTurn: () => undefined,
        log: () => undefined,
      }),
    async (text) => Buffer.from(`audio:${text}`),
  );
  const opening = await chat.start();
  assert.equal(opening[0].type, 'agent');
  assert.ok(opening.some((e) => e.type === 'audio'));
  const reply = await chat.say('sent the deck to Sam');
  assert.deepEqual(logged, ['sent the deck to Sam']);
  assert.ok(reply.some((e) => e.type === 'logged'));
  const said = reply.find((e) => e.type === 'agent') as { text: string };
  assert.match(said.text, /Logged/);
  const audio = reply.find((e) => e.type === 'audio') as { id: string };
  assert.equal(chat.sound(audio.id)?.toString(), `audio:${said.text}`);
  chat.end();
  // After it ends, saying something starts a new conversation without repeating the opener.
  const again = await chat.say('called the bank');
  assert.equal(again.filter((e) => e.type === 'agent').length, 1);
  chat.end();
});
