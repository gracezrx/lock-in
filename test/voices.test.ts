import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICKS, SUGGESTED, VoiceCatalog, describe as describeVoice, fromLibrary, libraryUrl, previewLine, safeSampleUrl, voiceError } from '../src/main/voices';

type Call = { url: string; method: string; body?: string; key?: string };

function fakeHttp(routes: Record<string, (url: URL) => { status?: number; body: unknown }>, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: init?.body as string | undefined, key: headers['xi-api-key'] });
    const route = Object.keys(routes).find((r) => url.pathname.startsWith(r));
    if (!route) return new Response('nope', { status: 404 });
    const r = routes[route](url);
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
}

test('the picks are real ElevenLabs default voices with unique ids, and every personality has one', () => {
  assert.ok(PICKS.length >= 6 && PICKS.length <= 10);
  assert.equal(new Set(PICKS.map((p) => p.id)).size, PICKS.length);
  for (const p of PICKS) assert.match(p.id, /^[A-Za-z0-9]{20}$/);
  for (const id of Object.values(SUGGESTED)) assert.ok(PICKS.some((p) => p.id === id));
  assert.ok(PICKS.some((p) => p.id === 'pNInz6obpgDQGcFmaJgB'), 'the old default stays pickable');
});

test('preview lines use your name and the coach personality', () => {
  assert.match(previewLine('sassy', 'Grace'), /^Hey Grace, .*babe\.$/);
  assert.match(previewLine('gentle'), /^Hi, it's your Lock In coach/);
  assert.match(previewLine('drill', 'Grace'), /^Grace! /);
  assert.ok(previewLine('firm', 'Grace').startsWith("Grace, it's"));
});

test('listing: picks get sample clips from your account, your own voices are listed, defaults are not repeated', async () => {
  const calls: Call[] = [];
  const cat = new VoiceCatalog({
    key: () => 'k',
    log: () => undefined,
    http: fakeHttp(
      {
        '/v2/voices': (u) =>
          u.searchParams.get('next_page_token')
            ? { body: { voices: [{ voice_id: 'zzz', name: 'Zed', category: 'generated', labels: { accent: 'irish', gender: 'male' } }], has_more: false } }
            : {
                body: {
                  voices: [
                    { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', category: 'premade', preview_url: 'https://storage.googleapis.com/a/jessica.mp3' },
                    { voice_id: 'aaa', name: 'My clone', category: 'cloned', labels: { accent: 'american', gender: 'female' } },
                    { voice_id: 'bbb', name: 'Zara - The Warm Conversationalist', category: 'professional', description: 'Warm and real', labels: {} },
                    { voice_id: 'ccc', name: 'Old default', category: 'premade' },
                  ],
                  has_more: true,
                  next_page_token: 'p2',
                },
              },
      },
      calls,
    ),
  });
  const list = await cat.list();
  assert.equal(list.hasKey, true);
  assert.equal(list.error, undefined);
  assert.equal(list.picks.length, PICKS.length);
  assert.equal(list.picks.find((p) => p.name === 'Jessica')?.previewUrl, 'https://storage.googleapis.com/a/jessica.mp3');
  assert.deepEqual(list.mine.map((v) => v.name), ['My clone', 'Zara', 'Zed']);
  assert.equal(list.mine.find((v) => v.name === 'Zara')?.vibe, 'Warm and real');
  assert.equal(list.mine.find((v) => v.name === 'Zed')?.accent, 'Irish');
  assert.equal(list.mine.find((v) => v.name === 'My clone')?.vibe, 'A voice you cloned.');
  assert.equal(calls.length, 2, 'two pages');
  assert.equal(calls[0].key, 'k');
  await cat.list();
  assert.equal(calls.length, 2, 'cached');
});

test('listing without a key or with a read-blocked key still shows the picks', async () => {
  const none = await new VoiceCatalog({ key: () => undefined, log: () => undefined }).list();
  assert.equal(none.hasKey, false);
  assert.equal(none.picks.length, PICKS.length);
  const blocked = await new VoiceCatalog({
    key: () => 'k',
    log: () => undefined,
    http: fakeHttp({ '/v2/voices': () => ({ status: 401, body: { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission voices_read' } } }) }),
  }).list();
  assert.equal(blocked.picks.length, PICKS.length);
  assert.match(blocked.error ?? '', /Voices set to Read/);
});

test('Voice Library search asks for natural English conversational voices, or your search', () => {
  const a = new URL(libraryUrl({}));
  assert.equal(a.pathname, '/v1/shared-voices');
  assert.equal(a.searchParams.get('use_cases'), 'conversational');
  assert.equal(a.searchParams.get('language'), 'en');
  assert.equal(a.searchParams.get('page_size'), '12');
  const b = new URL(libraryUrl({ search: ' raspy ', gender: 'female', accent: 'british', page: 2 }));
  assert.equal(b.searchParams.get('search'), 'raspy');
  assert.equal(b.searchParams.get('use_cases'), null);
  assert.equal(b.searchParams.get('gender'), 'female');
  assert.equal(b.searchParams.get('accent'), 'british');
  assert.equal(b.searchParams.get('page'), '2');
});

test('library voices: names cleaned, descriptions from labels, owner kept for adding', async () => {
  const v = fromLibrary({ voice_id: 'v1', public_owner_id: 'o1', name: 'Hope - upbeat and clear', accent: 'american', gender: 'female', descriptive: 'upbeat', use_case: 'conversational', age: 'young', cloned_by_count: 4321, free_users_allowed: false, is_added_by_user: false });
  assert.equal(v.name, 'Hope');
  assert.equal(v.vibe, 'Upbeat, Young, Conversational');
  assert.equal(v.ownerId, 'o1');
  assert.equal(v.paidOnly, true);
  assert.equal(v.uses, 4321);
  assert.equal(v.added, false);
  assert.equal(describeVoice({ description: 'x'.repeat(200) }).length, 108);

  const cat = new VoiceCatalog({
    key: () => 'k',
    log: () => undefined,
    http: fakeHttp({
      '/v1/shared-voices': () => ({ body: { voices: [{ voice_id: 'v1', public_owner_id: 'o1', name: 'Hope' }, { voice_id: 'v1', public_owner_id: 'o1', name: 'Hope' }, { voice_id: 'v2', name: 'No owner' }], has_more: true } }),
    }),
  });
  const r = await cat.search({});
  assert.deepEqual(r.voices.map((x) => x.id), ['v1']);
  assert.equal(r.hasMore, true);
});

test('adding a library voice: success, already added, and a key without write access', async () => {
  const calls: Call[] = [];
  const ok = new VoiceCatalog({ key: () => 'k', log: () => undefined, http: fakeHttp({ '/v1/voices/add/': () => ({ body: { voice_id: 'new1' } }) }, calls) });
  assert.deepEqual(await ok.add('o1', 'v1', 'Hope'), { ok: true, voiceId: 'new1' });
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[0].url.endsWith('/v1/voices/add/o1/v1'));
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { new_name: 'Hope' });

  const already = new VoiceCatalog({ key: () => 'k', log: () => undefined, http: fakeHttp({ '/v1/voices/add/': () => ({ status: 400, body: { detail: { message: 'Voice already exists in your library' } } }) }) });
  assert.equal((await already.add('o1', 'v1', 'Hope')).ok, true);

  const readOnly = new VoiceCatalog({ key: () => 'k', log: () => undefined, http: fakeHttp({ '/v1/voices/add/': () => ({ status: 401, body: { detail: { status: 'missing_permissions', message: 'missing the permission voices_write' } } }) }) });
  const r = await readOnly.add('o1', 'v1', 'Hope');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /Add to my voices/);
});

test('only ElevenLabs sample files are fetched for previews', () => {
  assert.equal(safeSampleUrl('https://storage.googleapis.com/eleven-public-prod/x.mp3'), true);
  assert.equal(safeSampleUrl('https://api.elevenlabs.io/v1/x.mp3'), true);
  assert.equal(safeSampleUrl('http://storage.googleapis.com/x.mp3'), false);
  assert.equal(safeSampleUrl('https://evil.example.com/x.mp3'), false);
  assert.equal(safeSampleUrl(undefined), false);
  assert.match(voiceError(429, '', 'search'), /busy/);
});
