import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Attention, DEFAULT_ATTENTION, outcomeOf, thinning, type AttentionSettings, type Card, type Signals } from '../src/main/attention';
import { RoutineScheduler } from '../src/main/routines';
import type { Routine } from '../src/shared/types';

const T0 = new Date(2026, 9, 27, 10, 0).getTime();
const MIN = 60_000;

/** A test bench: a gate, a clock, and the cards that went out. */
function bench(over: Partial<AttentionSettings> = {}) {
  const sent: string[] = [];
  const cfg = { ...DEFAULT_ATTENTION, ...over };
  const a = new Attention({ lastActiveAt: T0 }, () => cfg);
  let now = T0;
  let done = 0;
  const sig = (o: Partial<Signals> = {}): Signals => ({ now, day: '2026-10-27', idleSec: 0, calm: true, inSession: false, inMeeting: false, todosDone: done, ...o });
  const card = (key: string, o: Partial<Card> = {}): Card => ({ key, kind: o.kind ?? key, when: 'pause', holdMin: 30, send: () => (sent.push(key), true), ...o });
  return {
    a,
    sent,
    cfg,
    card,
    at: () => now,
    /** Move the clock and tick once. */
    step: (ms: number, o: Partial<Signals> = {}) => {
      now += ms;
      return a.tick(sig(o));
    },
    /** Tick every 10 s for a while. */
    run: (ms: number, o: Partial<Signals> = {}) => {
      for (let t = 0; t < ms; t += 10_000) {
        now += 10_000;
        a.tick(sig(o));
      }
    },
    finishTodo: () => done++,
  };
}

test('a card that can wait waits for a natural pause, then goes out once you have settled', () => {
  const b = bench();
  b.step(1000); // working
  b.a.offer(b.card('water'), b.at());
  b.run(5 * MIN);
  assert.deepEqual(b.sent, [], 'not in the middle of things');
  // Away for 8 minutes (idle climbs), then back.
  b.run(8 * MIN, { idleSec: 9999 });
  assert.equal(b.step(1000, { idleSec: 0 }), 'back');
  b.step(5000);
  assert.deepEqual(b.sent, [], 'not the second you sit down');
  b.step(20_000);
  assert.deepEqual(b.sent, ['water']);
});

test('finishing a to-do, or a session ending, is a pause too', () => {
  const b = bench();
  b.step(1000);
  b.a.offer(b.card('lunch'), b.at());
  b.finishTodo();
  assert.equal(b.step(1000), 'todo-done');
  b.run(30_000);
  assert.deepEqual(b.sent, ['lunch']);

  const c = bench();
  c.step(1000, { inSession: true, calm: false });
  c.a.offer(c.card('midday'), c.at());
  c.run(10 * MIN, { inSession: true, calm: false });
  assert.deepEqual(c.sent, [], 'never during a session');
  assert.equal(c.step(1000), 'session-end');
  c.run(30_000);
  assert.deepEqual(c.sent, ['midday']);
});

test('the wait is bounded: no pause in time, and it goes out anyway (or is dropped when stale)', () => {
  const b = bench();
  b.step(1000);
  b.a.offer(b.card('water', { holdMin: 30 }), b.at());
  b.a.offer(b.card('eyes', { holdMin: 10, dropIfStale: true }), b.at());
  b.run(29 * MIN);
  assert.deepEqual(b.sent, []);
  b.run(2 * MIN);
  assert.deepEqual(b.sent, ['water']);
  assert.deepEqual(b.a.waiting(), [], 'the eye break went stale and was dropped');
});

test('a natural break makes "stand up" pointless: it is dropped, and so are others in its family', () => {
  const b = bench();
  b.step(1000);
  b.a.offer(b.card('stretch', { mootOn: ['back'], family: 'move' }), b.at());
  b.a.offer(b.card('water'), b.at());
  b.run(8 * MIN, { idleSec: 9999 });
  b.step(1000);
  assert.deepEqual(b.a.waiting(), ['water']);

  const c = bench();
  c.step(1000);
  c.a.offer(c.card('goal:breaks', { when: 'soon', family: 'move' }), c.at());
  c.a.offer(c.card('stretch', { family: 'move' }), c.at());
  c.run(MIN);
  assert.deepEqual(c.sent, ['goal:breaks']);
  assert.deepEqual(c.a.waiting(), [], 'one "get up" card is enough');
});

test('one shared budget: a gap after any card, and a daily cap', () => {
  const b = bench({ minGapMin: 20, maxPerDay: 2, pauses: false });
  b.step(1000);
  b.a.offer(b.card('a', { when: 'soon' }), b.at());
  b.a.offer(b.card('b', { when: 'soon' }), b.at());
  b.a.offer(b.card('c', { when: 'soon' }), b.at());
  b.run(MIN);
  assert.deepEqual(b.sent, ['a']);
  b.run(15 * MIN);
  assert.deepEqual(b.sent, ['a'], 'still in the gap');
  b.run(6 * MIN);
  assert.deepEqual(b.sent, ['a', 'b']);
  b.run(60 * MIN);
  assert.deepEqual(b.sent, ['a', 'b'], 'two a day');

  // Someone else's card (a roast, a meeting heads-up) starts the gap too.
  const c = bench({ pauses: false });
  c.step(1000);
  c.a.cardShown(undefined, true, c.at());
  c.a.offer(c.card('water', { when: 'soon' }), c.at());
  c.run(10 * MIN);
  assert.deepEqual(c.sent, []);
  c.run(11 * MIN);
  assert.deepEqual(c.sent, ['water']);
});

test('not when it would interrupt: a call, a meeting, mute, or you are away', () => {
  const b = bench({ pauses: false });
  b.step(1000);
  b.a.offer(b.card('water', { when: 'soon' }), b.at());
  b.run(MIN, { calm: false });
  b.run(MIN, { idleSec: 300 });
  assert.deepEqual(b.sent, []);
  b.step(1000);
  assert.deepEqual(b.sent, ['water']);
});

test('cards you keep ignoring come less often; acting on one brings them back', () => {
  const b = bench({ pauses: false, minGapMin: 1 });
  const cycle = (outcome: 'ignored' | 'acted' | 'dismissed') => {
    const r = b.a.offer(b.card('water', { kind: 'routine:hydrate', when: 'soon' }), b.at());
    b.run(2 * MIN);
    if (r === 'waiting') {
      b.a.cardShown('water', true, b.at());
      b.a.resolve('water', outcome, b.at());
    }
    return r;
  };
  assert.equal(cycle('ignored'), 'waiting');
  assert.equal(cycle('dismissed'), 'waiting');
  // Two in a row: every other one is skipped.
  assert.equal(cycle('ignored'), 'skipped');
  assert.equal(cycle('ignored'), 'waiting');
  assert.equal(b.a.state.stats['routine:hydrate'].streak, 3);
  assert.equal(cycle('ignored'), 'skipped');
  assert.equal(cycle('ignored'), 'waiting');
  // Four in a row: two of every three are skipped.
  assert.equal(cycle('acted'), 'skipped');
  assert.equal(cycle('acted'), 'skipped');
  assert.equal(cycle('acted'), 'waiting');
  assert.equal(b.a.state.stats['routine:hydrate'].streak, 0, 'acted: back to normal');
  assert.equal(cycle('acted'), 'waiting');
  const st = b.a.state.stats['routine:hydrate'];
  assert.equal(st.shown, 6);
  assert.equal(st.acted, 2);
  assert.equal(st.ignored + st.dismissed, 4);
});

test('a card covered by the next one, or left alone, was ignored; a snooze is neutral', () => {
  const b = bench({ pauses: false, minGapMin: 1 });
  b.step(1000);
  b.a.offer(b.card('noticed', { when: 'soon' }), b.at());
  b.run(MIN);
  b.a.cardShown('noticed', true, b.at());
  b.a.cardShown(undefined, true, b.at()); // a roast covers it
  assert.equal(b.a.state.stats.noticed.ignored, 1);

  b.a.offer(b.card('noticed', { when: 'soon' }), b.at());
  b.run(2 * MIN);
  b.a.cardShown('noticed', true, b.at());
  b.run(16 * MIN); // nobody touched it
  assert.equal(b.a.state.stats.noticed.ignored, 2);

  b.a.reset('noticed');
  b.a.offer(b.card('noticed', { when: 'soon' }), b.at());
  b.run(2 * MIN);
  b.a.cardShown('noticed', true, b.at());
  b.a.resolve('noticed', outcomeOf('goal-later:x'), b.at());
  assert.equal(b.a.state.stats.noticed.streak, 0);
  assert.equal(outcomeOf('snooze:r1:15'), 'snoozed');
  assert.equal(outcomeOf('water'), 'acted');
  assert.equal(outcomeOf('dismiss'), 'acted', 'a button press is an answer');
});

test('a card that went out some other way (no corner card) teaches nothing', async () => {
  const b = bench({ pauses: false });
  b.step(1000);
  b.a.offer(b.card('water', { when: 'soon', send: () => false }), b.at());
  b.run(MIN);
  await Promise.resolve();
  await Promise.resolve();
  b.a.cardShown(undefined, true, b.at());
  assert.equal(b.a.state.stats.water.ignored, 0);
});

test('arriving: back after hours away, and a new day resets the count', () => {
  const b = bench();
  b.step(1000);
  b.run(3 * 3_600_000, { idleSec: 99_999 });
  assert.equal(b.step(1000), 'arrive');
  b.a.state.sentToday = 5;
  b.step(1000, { day: '2026-10-28' });
  assert.equal(b.a.state.sentToday, 0);
});

test('the first activity after a restart counts as arriving', () => {
  const a = new Attention(null, () => DEFAULT_ATTENTION);
  assert.equal(a.tick({ now: T0, day: '2026-10-27', idleSec: 0, calm: true, inSession: false, inMeeting: false, todosDone: 0 }), 'arrive');
  assert.equal(a.tick({ now: T0 + 1000, day: '2026-10-27', idleSec: 0, calm: true, inSession: false, inMeeting: false, todosDone: 0 }), null);
});

test('thinning steps', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(thinning), [0, 0, 1, 1, 2, 2, 3, 3]);
});

// ---- natural breaks reset the stretch count (like Stretchly) ----

test('a natural break starts the stretch count over', () => {
  const r: Routine = { id: 'stretch', kind: 'stretch', name: 'Stand up and stretch', enabled: true, trigger: { type: 'interval', everyMin: 50, from: '00:00', to: '00:00', days: [0, 1, 2, 3, 4, 5, 6] } } as Routine;
  const s = new RoutineScheduler();
  const at = new Date(2026, 9, 27, 10, 0);
  let fired = 0;
  for (let i = 0; i < 45 * 60; i++) fired += s.tick([r], at, 1, true, () => true).length;
  assert.equal(fired, 0);
  s.naturalBreak(['stretch']);
  for (let i = 0; i < 10 * 60; i++) fired += s.tick([r], at, 1, true, () => true).length;
  assert.equal(fired, 0, 'without the reset it would have fired at 50 minutes');
  for (let i = 0; i < 41 * 60; i++) fired += s.tick([r], at, 1, true, () => true).length;
  assert.equal(fired, 1);
});
