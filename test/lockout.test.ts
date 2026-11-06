import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOMB_LOCKOUT_MIN, Lockout, distractionDomains } from '../src/main/lockout';

const T0 = Date.parse('2026-11-01T15:00:00');
const MIN = 60_000;
const yt = { app: 'Google Chrome', domain: 'youtube.com', browser: true, label: 'distraction' as const };
const steam = { app: 'Steam', label: 'distraction' as const };
const docs = { app: 'Google Chrome', domain: 'docs.google.com', browser: true, label: 'work' as const };

test('a bomb locks distractions for 5 minutes, then lets go once', () => {
  const l = new Lockout();
  l.start('Grace', T0);
  assert.equal(BOMB_LOCKOUT_MIN, 5);
  assert.ok(l.active(T0 + 4 * MIN));
  assert.equal(l.leftSec(T0 + 4 * MIN), 60);
  assert.equal(l.expire(T0 + 4 * MIN), false);
  assert.equal(l.expire(T0 + 5 * MIN), true);
  assert.equal(l.expire(T0 + 5 * MIN + 1000), false);
  assert.equal(l.act(steam, T0 + 6 * MIN, true), null);
});

test('distracting sites are blocked (or the browser hidden without the extension), apps hidden, work left alone', () => {
  const l = new Lockout();
  l.start('Grace', T0);
  assert.deepEqual(l.act(yt, T0 + 1000, true), { kind: 'block-site', domain: 'youtube.com' });
  assert.deepEqual(l.act(steam, T0 + 1000, true), { kind: 'hide-app', app: 'Steam' });
  assert.equal(l.act(docs, T0 + 1000, true), null);
  assert.equal(l.act({ app: 'Notes', label: 'neutral' }, T0 + 1000, true), null);
  const noExt = new Lockout();
  noExt.start('Grace', T0);
  assert.deepEqual(noExt.act(yt, T0, false), { kind: 'hide-app', app: 'Google Chrome' });
});

test('it does not hammer: the same app or site is acted on again only after a pause', () => {
  const l = new Lockout();
  l.start('Grace', T0);
  assert.ok(l.act(steam, T0, true));
  assert.equal(l.act(steam, T0 + 1000, true), null);
  assert.ok(l.act(steam, T0 + 3000, true));
  assert.ok(l.notice(T0));
  assert.equal(l.notice(T0 + 10_000), false);
  assert.ok(l.notice(T0 + 50_000));
});

test('a second bomb pushes the end out, never pulls it in', () => {
  const l = new Lockout();
  l.start('Grace', T0);
  l.start('Sam', T0 + 3 * MIN);
  assert.equal(l.state?.until, T0 + 8 * MIN);
  assert.equal(l.state?.from, 'Sam');
  assert.equal(l.state?.startedAt, T0);
});

test('the sites to block: your distractions and ones you marked, minus work', () => {
  const d = distractionDomains(
    { 'youtube.com': 1.5, 'www.reddit.com': 1.2, 'news.ycombinator.com': 1 },
    { 'site:twitch.tv': { label: 'distraction', source: 'user', updatedAt: 0 }, 'site:linear.app': { label: 'work', source: 'user', updatedAt: 0 }, 'app:Steam': { label: 'distraction', source: 'user', updatedAt: 0 } },
    ['ycombinator.com'],
  );
  assert.deepEqual(d, ['reddit.com', 'twitch.tv', 'youtube.com']);
});
