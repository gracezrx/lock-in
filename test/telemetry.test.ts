import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telemetry, FLUSH_MS, type TelemetryDeps } from '../src/main/telemetry';
import type { LabeledSample } from '../src/shared/types';

function setup(over: Partial<TelemetryDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-tel-'));
  const sent: { url: string; headers: Record<string, string>; body: { payload?: Record<string, unknown>; p_install_id?: string } }[] = [];
  let ok = true;
  let now = new Date('2026-11-13T10:00:00').getTime();
  const flags = { on: true, apps: false };
  const t = new Telemetry({
    dir,
    version: '0.4.0',
    osVersion: 'macOS 15.1',
    enabled: () => flags.on,
    shareApps: () => flags.apps,
    traits: () => ({ persona: 'sassy', claude_key: true }),
    now: () => now,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return { ok, status: ok ? 200 : 500 } as Response;
    }) as unknown as typeof fetch,
    ...over,
  });
  return { t, dir, sent, flags, setOk: (v: boolean) => (ok = v), tick: (ms: number) => (now += ms) };
}

const S = (o: Partial<LabeledSample>): LabeledSample => ({ t: 0, app: 'Figma', browser: false, idleSec: 0, mediaPlaying: false, inCall: false, isPrivate: false, label: 'work', weight: 1, itemKey: 'x', source: 'rule', ...o });

test('telemetry: one random install id, kept on disk', () => {
  const a = setup();
  assert.match(a.t.installId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(readFileSync(join(a.dir, 'telemetry.json'), 'utf8')).installId, a.t.installId);
  const again = new Telemetry({ dir: a.dir, version: '1', osVersion: 'x', enabled: () => true, shareApps: () => false, traits: () => ({}) });
  assert.equal(again.installId, a.t.installId);
});

test('telemetry: events and counted actions go to the ingest function with the publishable key', async () => {
  const { t, sent } = setup();
  t.track('session_started', { minutes: 50, pomodoro: false, goal: 'x'.repeat(500) });
  t.action('session:start');
  t.action('session:start');
  t.action('todos:add', 'phone');
  t.action('settings:get'); // a read, not a feature
  t.action('setup:status');
  assert.ok(await t.flush());
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/rest\/v1\/rpc\/ingest$/);
  assert.match(sent[0].headers.apikey, /^sb_publishable_/);
  const p = sent[0].body.payload!;
  assert.equal(p.install_id, t.installId);
  assert.equal(p.app_version, '0.4.0');
  assert.deepEqual(p.traits, { persona: 'sassy', claude_key: true });
  const events = p.events as { name: string; props: Record<string, unknown> }[];
  assert.equal(events[0].name, 'session_started');
  assert.equal((events[0].props.goal as string).length, 80, 'long strings are cut');
  const ui = events.filter((e) => e.name === 'ui').map((e) => e.props);
  assert.deepEqual(ui, [{ action: 'session:start', from: 'mac', count: 2 }, { action: 'todos:add', from: 'phone', count: 1 }]);
  assert.deepEqual(p.usage, []);
  // Sent once: the next flush has nothing left of it.
  await t.flush();
  assert.deepEqual(sent[1].body.payload!.events, []);
});

test('telemetry: app usage only when shared; titles and URLs never; private stays private', async () => {
  const { t, sent, flags } = setup();
  t.sample(S({ app: 'Figma', title: 'Secret plan.fig' }), 1, true, 0);
  await t.flush();
  assert.deepEqual(sent[0].body.payload!.usage, [], 'not shared yet');
  flags.apps = true;
  for (let i = 0; i < 90; i++) t.sample(S({ app: 'Google Chrome', bundleId: 'com.google.Chrome', browser: true, domain: 'www.youtube.com', url: 'https://www.youtube.com/watch?v=abc', title: 'Cats', label: 'distraction' }), 1, true, 0);
  t.sample(S({ app: '1Password', label: 'private' }), 2, false, 0);
  t.sample(S({ app: 'Chrome', browser: true, domain: 'bank.com', isPrivate: true, label: 'work' }), 3, false, 0);
  t.sample(S({ app: 'Slack', label: 'neutral' }), 1, false, 500); // away from the Mac
  t.sample(S({ app: 'Slack', label: 'away' }), 1, false, 0);
  await t.flush();
  const usage = sent[1].body.payload!.usage as Record<string, unknown>[];
  const text = JSON.stringify(sent[1].body);
  assert.doesNotMatch(text, /Cats|watch\?v|Secret plan|bank\.com|1Password/);
  const yt = usage.find((u) => u.domain === 'youtube.com')!;
  assert.deepEqual(yt, { day: '2026-11-13', app: 'Google Chrome', bundle_id: 'com.google.Chrome', domain: 'youtube.com', label: 'distraction', in_session: true, seconds: 90 });
  const priv = usage.filter((u) => u.app === '(private)');
  assert.equal(priv.reduce((a, u) => a + (u.seconds as number), 0), 5);
  assert.ok(priv.every((u) => u.label === 'private' && u.domain === '' && u.bundle_id === ''));
  assert.ok(!usage.some((u) => u.app === 'Slack'), 'idle and away time is not counted');
  assert.equal(sent[1].body.payload!.share_apps, true);
});

test('telemetry: offline keeps everything for later; quitting saves it to disk', async () => {
  const a = setup();
  a.flags.apps = true;
  a.t.track('coach_level', { level: 2 });
  a.t.sample(S({ app: 'Figma' }), 3, false, 0);
  a.setOk(false);
  assert.equal(await a.t.flush(), false);
  a.t.saveQueue();
  const b = new Telemetry({ dir: a.dir, version: '1', osVersion: 'x', enabled: () => true, shareApps: () => true, traits: () => ({}), fetch: a.t['d'].fetch });
  a.setOk(true);
  assert.ok(await b.flush());
  const p = a.sent.at(-1)!.body.payload!;
  assert.deepEqual((p.events as { name: string }[]).map((e) => e.name), ['coach_level']);
  assert.equal((p.usage as { seconds: number }[])[0].seconds, 3);
});

test('telemetry: off means nothing is collected or sent; forget deletes this install', async () => {
  const { t, sent, flags, tick } = setup();
  flags.on = false;
  t.track('session_started');
  t.action('session:start');
  t.sample(S({}), 1, false, 0);
  assert.equal(t.due(), false);
  assert.equal(await t.flush(), false);
  assert.equal(sent.length, 0);
  flags.on = true;
  assert.ok(t.due());
  await t.flush();
  assert.equal(t.due(), false);
  tick(FLUSH_MS);
  assert.ok(t.due());
  assert.ok(await t.forget());
  assert.match(sent.at(-1)!.url, /rpc\/forget$/);
  assert.equal(sent.at(-1)!.body.p_install_id, t.installId);
});

test('telemetry: a new day counts as an active day', async () => {
  const { t, sent, tick } = setup();
  t.sample(null, 1, false, 0);
  tick(24 * 3600_000);
  t.sample(null, 1, false, 0);
  await t.flush();
  assert.deepEqual((sent[0].body.payload!.events as { name: string }[]).map((e) => e.name), ['day_active']);
});
