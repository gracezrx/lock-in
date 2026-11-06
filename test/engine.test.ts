import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriftEngine, type DriftEvent } from '../src/main/engine/drift';
import { Classifier, type LabelCache, type ModelLabeler } from '../src/main/engine/classifier';
import { domainOf, domainMatches, redact, normalizeTitle } from '../src/main/engine/domain';
import { Session } from '../src/main/engine/session';
import { buildDefaultProfile } from '../src/shared/templates';
import type { Label, LabeledSample, Profile, Sample } from '../src/shared/types';

function sample(over: Partial<Sample> = {}): Sample {
  return { t: 0, app: 'Google Chrome', browser: true, idleSec: 0, mediaPlaying: false, inCall: false, isPrivate: false, ...over };
}

function labeled(label: Label, over: Partial<LabeledSample> = {}): LabeledSample {
  return { ...sample(), label, weight: 1, itemKey: 'x', source: 'rule', ...over };
}

/** Run n one-second ticks and collect events with the second they fired at. */
function run(engine: DriftEngine, s: (i: number) => LabeledSample, n: number, start = 0): { at: number; e: DriftEvent }[] {
  const out: { at: number; e: DriftEvent }[] = [];
  for (let i = 0; i < n; i++) {
    const t = start + i;
    for (const e of engine.tick({ ...s(t), t: t * 1000 }, 1)) out.push({ at: t, e });
  }
  return out;
}

test('domain helpers', () => {
  assert.equal(domainOf('https://www.youtube.com/watch?v=1'), 'youtube.com');
  assert.equal(domainOf('chrome://newtab'), undefined);
  assert.equal(domainOf('not a url'), undefined);
  assert.ok(domainMatches('m.youtube.com', 'youtube.com'));
  assert.ok(!domainMatches('notyoutube.com', 'youtube.com'));
  assert.equal(redact('Mail from grace@example.com about 4155551234'), 'Mail from [email] about [number]');
  assert.equal(normalizeTitle('(3) Lofi beats - YouTube'), 'lofi beats');
});

test('pure distraction at 5-minute tolerance hits levels at 2, 5, 7.5 and 10 minutes plus grace', () => {
  const e = new DriftEngine(5);
  const events = run(e, () => labeled('distraction', { weight: 1 }), 700);
  const levels = events.filter((x) => x.e.type === 'level').map((x) => ({ at: x.at, level: (x.e as { level: number }).level }));
  // 60 s grace, then 1 drift-second per second: drift starts at t=60, so 120 → L1 at t=179, 300 → L2 at t=359, 450 → t=509, 600 → t=659.
  assert.deepEqual(levels.map((l) => l.level), [1, 2, 3, 4]);
  assert.deepEqual(levels.map((l) => l.at), [179, 359, 509, 659]);
});

test('a quick lookup inside the grace period costs nothing', () => {
  const e = new DriftEngine(5);
  run(e, () => labeled('distraction'), 50);
  assert.equal(e.drift, 0);
  run(e, () => labeled('work'), 10, 50);
  assert.equal(e.drift, 0);
  assert.equal(e.level, 0);
});

test('work drains drift twice as fast as distraction builds it', () => {
  const e = new DriftEngine(5);
  run(e, () => labeled('distraction'), 160); // 100 drift-seconds
  assert.equal(e.drift, 100);
  run(e, () => labeled('work'), 30, 160);
  assert.equal(e.drift, 40);
});

test('two straight minutes of work after an intervention resets the level', () => {
  const e = new DriftEngine(2);
  run(e, () => labeled('distraction'), 120);
  assert.ok(e.level >= 1);
  const ev = run(e, () => labeled('work'), 130, 120);
  assert.ok(ev.some((x) => x.e.type === 'recovered'));
  assert.equal(e.level, 0);
});

test('idle with a video playing builds drift at 1.5x even on a neutral page', () => {
  const e = new DriftEngine(5);
  run(e, () => labeled('neutral', { idleSec: 120, mediaPlaying: true }), 100);
  assert.equal(e.drift, 150);
});

test('reading a work doc while idle is free for 10 minutes', () => {
  const e = new DriftEngine(5);
  run(e, () => labeled('work', { idleSec: 90 }), 600);
  assert.equal(e.drift, 0);
});

test('away for 15 minutes triggers one check-in and no drift', () => {
  const e = new DriftEngine(5);
  const ev = run(e, () => labeled('distraction', { idleSec: 400 }), 1000);
  assert.equal(ev.filter((x) => x.e.type === 'away_checkin').length, 1);
  assert.equal(e.drift, 0);
});

test('six quick trips into distractions within 10 minutes fires level 2', () => {
  const e = new DriftEngine(10);
  let fired: DriftEvent | undefined;
  for (let trip = 0; trip < 6; trip++) {
    const ev = run(e, () => labeled('distraction'), 20, trip * 60);
    run(e, () => labeled('work'), 40, trip * 60 + 20);
    fired = fired ?? ev.find((x) => x.e.type === 'level')?.e;
  }
  assert.deepEqual(fired, { type: 'level', level: 2, reason: 'pattern' });
});

test('a third call-out in one session jumps straight to level 4', () => {
  const e = new DriftEngine(2);
  const levels: number[] = [];
  for (let round = 0; round < 3; round++) {
    const ev = run(e, () => labeled('distraction'), 300, round * 1000);
    for (const x of ev) if (x.e.type === 'level') levels.push(x.e.level);
    e.acknowledge();
    run(e, () => labeled('work'), 10, round * 1000 + 300);
  }
  // Rounds 1 and 2 climb 1→4 (each passing 3); round 3 goes 1, 2, then 4 instead of 3.
  assert.deepEqual(levels.slice(-3), [1, 2, 4]);
});

test('paused engine (break) ignores samples', () => {
  const e = new DriftEngine(2);
  e.paused = true;
  run(e, () => labeled('distraction'), 500);
  assert.equal(e.drift, 0);
  assert.equal(e.level, 0);
});

function makeClassifier(profile: Profile, labeler?: ModelLabeler, now = { t: 0 }) {
  const cache: LabelCache = {};
  const c = new Classifier(() => profile, cache, () => {}, { titlesStayLocal: () => false, now: () => now.t, minDwellMs: 5000, minGapMs: 0 }, labeler);
  return { c, cache, now };
}

test('classifier uses profile rules for apps and sites', () => {
  const p = buildDefaultProfile('engineer');
  const { c } = makeClassifier(p);
  assert.equal(c.classify(sample({ app: 'Cursor', browser: false })).label, 'work');
  assert.equal(c.classify(sample({ domain: 'github.com', url: 'https://github.com/x' })).label, 'work');
  const yt = c.classify(sample({ domain: 'youtube.com', title: 'Funny cats' }));
  assert.equal(yt.label, 'distraction');
  assert.equal(yt.weight, 1.5);
  assert.equal(c.classify(sample({ app: 'Steam', browser: false })).label, 'distraction');
  assert.equal(c.classify(sample({ app: 'Finder', browser: false })).label, 'neutral');
  assert.equal(c.classify(sample({ isPrivate: true })).label, 'private');
  assert.equal(c.classify(sample({ inCall: true, domain: 'youtube.com' })).label, 'work');
});

test('gray rules make YouTube tutorials work', () => {
  const p = buildDefaultProfile('engineer');
  p.grayRules = [{ domain: 'youtube.com', workIfTitleContains: ['tutorial'] }];
  const { c } = makeClassifier(p);
  assert.equal(c.classify(sample({ domain: 'youtube.com', title: 'Rust tutorial for beginners - YouTube' })).label, 'work');
  assert.equal(c.classify(sample({ domain: 'youtube.com', title: 'Top 10 fails' })).label, 'distraction');
});

test('user labels beat profile rules', () => {
  const p = buildDefaultProfile('founder');
  const { c } = makeClassifier(p);
  const s = sample({ domain: 'reddit.com', title: 'r/startups' });
  assert.equal(c.classify(s).label, 'distraction');
  c.setUserLabel(s, 'work');
  assert.equal(c.classify(s).label, 'work');
  assert.equal(c.classify(sample({ domain: 'old.reddit.com' })).label, 'work');
});

test('unknown items ask the model once after 5 seconds, then use the cache', async () => {
  const p = buildDefaultProfile('founder');
  let calls = 0;
  const labeler: ModelLabeler = async () => {
    calls++;
    return { label: 'work', confidence: 0.9, reason: 'pricing research' };
  };
  const clock = { t: 0 };
  const { c } = makeClassifier(p, labeler, clock);
  c.modelEnabled = true;
  const s = sample({ domain: 'paddle.com', title: 'Pricing' });
  assert.equal(c.classify(s).label, 'neutral');
  clock.t = 2000;
  c.classify(s);
  assert.equal(calls, 0);
  clock.t = 6000;
  c.classify(s);
  c.classify(s);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls, 1);
  const after = c.classify(s);
  assert.equal(after.label, 'work');
  assert.equal(after.source, 'cache');
});

test('session tracks focus, drift, spans and last work context', () => {
  const spans: unknown[] = [];
  const sess = new Session('ship the deck', 25, 5, (s) => spans.push(s), null, 0);
  const work = labeled('work', { app: 'Keynote', browser: false, documentPath: '/Users/g/deck.key', title: 'deck.key' });
  for (let i = 0; i < 30; i++) sess.tick({ ...work, t: i * 1000 });
  const yt = labeled('distraction', { domain: 'youtube.com', title: 'cats' });
  for (let i = 30; i < 60; i++) sess.tick({ ...yt, t: i * 1000 });
  const rec = sess.end('user', 60_000);
  assert.equal(rec.focusSec, 30);
  assert.equal(rec.driftSec, 30);
  assert.equal(rec.topDistractions['youtube.com'], 30);
  assert.equal(sess.lastWork?.documentPath, '/Users/g/deck.key');
  assert.equal(spans.length, 2);
});
