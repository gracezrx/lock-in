import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rhythm, focusPace, goalHit, goalName, goalsForCoach, ideasPrompt, lastMinOf, notice, parseIdeas, tune, viewGoal, type DayFacts } from '../src/main/goals';
import type { Goal } from '../src/shared/types';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const key = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;

/** A plain working day: 8 hours at the computer, breaks taken, water drunk, off by 10 pm. */
const day = (d: number, over: Partial<DayFacts> = {}): DayFacts => ({
  day: key(d),
  tracked: true,
  activeMin: 480,
  longestMin: 50,
  breaks: 6,
  water: 6,
  lastMin: 22 * 60,
  focusMin: 240,
  driftMin: 5,
  sessions: 3,
  firstSessionMin: 9 * 60 + 30,
  todosDone: 3,
  meetingMin: 60,
  checked: [],
  ...over,
});
const goal = (kind: Goal['kind'], target: number, over: Partial<Goal> = {}): Goal => ({ id: `g-${kind}`, kind, target, days: 'every', createdAt: at(1, 9), source: 'you', ...over });
/** Mon 19 to Sun 25 October 2026. */
const week = (over: (d: number) => Partial<DayFacts>) => [19, 20, 21, 22, 23, 24, 25].map((d) => day(d, over(d)));

// ---- rhythm ----

test('rhythm counts a long stretch, and a break when you come back after five minutes away', () => {
  const r = new Rhythm();
  let t = at(26, 9);
  for (let i = 0; i < 130; i++, t += 60_000) r.tick(t, 0, 60);
  const d = r.day(key(26));
  assert.equal(Math.round(d.activeMin), 130);
  assert.equal(d.breaks, 0);
  assert.ok(d.longestMin >= 128, `longest ${d.longestMin}`);
  assert.ok(r.stretchMin(t) >= 128);
  // Ten minutes away: those ticks report idle time and count for nothing.
  for (let i = 0; i < 10; i++, t += 60_000) r.tick(t, (i + 1) * 60, 60);
  assert.equal(r.stretchMin(t), 0, 'on a break');
  r.tick(t, 0, 60);
  assert.equal(d.breaks, 1);
  assert.ok(r.stretchMin(t) < 1, 'a new stretch');
  assert.ok(d.longestMin >= 128, 'the longest stretch stays');
  assert.equal(r.logWater(t), 1);
  assert.equal(r.logWater(t + 1000), 2);
});

test('rhythm: a short pause is not a break, and 1 am still belongs to the night before', () => {
  const r = new Rhythm();
  let t = at(26, 23);
  for (let i = 0; i < 60; i++, t += 60_000) r.tick(t, 0, 60);
  // Three minutes reading without touching anything.
  for (let i = 0; i < 3; i++, t += 60_000) r.tick(t, 60 + i * 60, 60);
  for (let i = 0; i < 70; i++, t += 60_000) r.tick(t, 0, 60);
  const d = r.days[key(26)];
  assert.equal(d.breaks, 0);
  assert.ok(d.longestMin > 120);
  assert.equal(r.days[key(27)], undefined, 'past midnight is still the 26th');
  const last = lastMinOf(d)!;
  assert.ok(last > 1440 + 60 && last < 1440 + 90, `last ${last}`);
});

test('rhythm keeps about four months', () => {
  const r = new Rhythm();
  for (let i = 0; i < 150; i++) r.tick(new Date(2026, 0, 1 + i, 12).getTime(), 0, 60);
  const kept = Object.keys(r.toJSON());
  assert.equal(kept.length, 120);
  assert.equal(kept[0], '2026-01-31');
});

// ---- measuring goals ----

test('goals are judged only on days there is something to judge', () => {
  assert.equal(goalHit(goal('focus', 3), day(20, { focusMin: 185 })), true);
  assert.equal(goalHit(goal('focus', 3), day(20, { focusMin: 150 })), false);
  assert.equal(goalHit(goal('focus', 3), day(20, { activeMin: 30, focusMin: 0 })), null, 'a day off');
  assert.equal(goalHit(goal('focus', 3, { days: 'weekdays' }), day(24, { focusMin: 0 })), null, 'Saturday');
  assert.equal(goalHit(goal('breaks', 60), day(20, { tracked: false, longestMin: 0 })), null, 'before Lock In watched breaks');
  assert.equal(goalHit(goal('breaks', 60), day(20, { longestMin: 65 })), true, 'a little grace');
  assert.equal(goalHit(goal('breaks', 60), day(20, { longestMin: 140 })), false);
  assert.equal(goalHit(goal('water', 6), day(20, { water: 4 })), false);
  assert.equal(goalHit(goal('drift', 20), day(20, { sessions: 0 })), null);
  assert.equal(goalHit(goal('custom', 0, { id: 'c1', title: 'Ship it' }), day(20, { checked: ['c1'] })), true);
  assert.equal(goalHit(goal('custom', 0, { id: 'c1', title: 'Ship it' }), day(20, { activeMin: 0 })), false, 'custom counts even on a quiet day');
});

test('bedtime handles nights past midnight', () => {
  const by2330 = goal('bedtime', 23 * 60 + 30);
  const byHalfPast12 = goal('bedtime', 30);
  assert.equal(goalHit(by2330, day(20, { lastMin: 23 * 60 })), true);
  assert.equal(goalHit(by2330, day(20, { lastMin: 1440 + 10 })), false, 'off at 00:10');
  assert.equal(goalHit(byHalfPast12, day(20, { lastMin: 1440 + 10 })), true);
  assert.equal(goalHit(byHalfPast12, day(20, { lastMin: 1440 + 90 })), false, 'off at 1:30');
  assert.equal(goalHit(by2330, day(20, { lastMin: undefined })), null);
});

test('a goal on the page: progress in words, a bar, and the last week', () => {
  const past = week(() => ({ focusMin: 200 }));
  const today = day(26, { focusMin: 70, water: 4 });
  const focus = viewGoal(goal('focus', 3), today, past, at(26, 16), 0);
  assert.equal(focus.name, 'Focus 3 hours a day');
  assert.match(focus.progress, /of 3 h/);
  assert.equal(focus.status, '1 h 50 min to go');
  assert.equal(focus.tone, 'behind', 'past 3 pm and under half');
  assert.equal(focus.week.length, 7);
  assert.equal(focus.week.at(-1)!.label, 'Today');
  assert.equal(focus.hits, 6);
  assert.equal(focus.of, 6);
  const water = viewGoal(goal('water', 6), today, past, at(26, 12), 0);
  assert.equal(water.progress, '4 of 6');
  assert.equal(water.status, '2 more glasses to go');
  assert.equal(viewGoal(goal('water', 5), today, past, at(26, 12), 0).status, '1 more glass to go');
  const paused = viewGoal(goal('water', 6, { paused: true }), today, past, at(26, 12), 0);
  assert.equal(paused.tone, 'idle');
  assert.equal(paused.status, 'Paused');
});

test('breaks goal follows the stretch you are in', () => {
  const g = goal('breaks', 60);
  const fresh = viewGoal(g, day(26, { longestMin: 40 }), [], at(26, 11), 20);
  assert.equal(fresh.tone, 'ok');
  assert.equal(fresh.status, 'Next break in 40 min');
  const long = viewGoal(g, day(26, { longestMin: 75 }), [], at(26, 11), 75);
  assert.equal(long.tone, 'behind');
  assert.equal(long.status, 'Time to get up for five minutes');
});

test('bedtime is not "behind" in the morning, only late in the evening', () => {
  const g = goal('bedtime', 23 * 60);
  assert.equal(viewGoal(g, day(26), [day(25)], at(26, 9), 0).tone, 'ok');
  const late = viewGoal(g, day(26), [day(25)], at(26, 23, 20), 0);
  assert.equal(late.tone, 'behind');
  assert.match(late.status, /time to wrap up/);
  const soon = viewGoal(g, day(26), [day(25)], at(26, 22), 0);
  assert.match(soon.status, /^1 h until/);
});

test('goal names read like sentences', () => {
  assert.equal(goalName(goal('focus', 2.5, { days: 'weekdays' })), 'Focus 2.5 hours on weekdays');
  assert.equal(goalName(goal('focus', 1)), 'Focus 1 hour a day');
  assert.equal(goalName(goal('water', 1)), 'Drink water 1 time a day');
  assert.equal(goalName(goal('todos', 3, { days: 'weekdays' })), 'Finish 3 to-dos on weekdays');
  assert.equal(goalName(goal('custom', 0, { title: '  Ship the Captain launch ' })), 'Ship the Captain launch');
});

// ---- noticing patterns ----

const base = { openTodos: 2, overdue: 0, goals: [] as Goal[], memo: {}, now: at(26, 12) };

test('no suggestions until there are a few days to go on', () => {
  assert.deepEqual(notice({ ...base, past: [day(24, { longestMin: 200 }), day(25, { longestMin: 200 })] }), []);
});

test('long stretches without breaks: suggests a break goal, with the numbers', () => {
  const past = week((d) => ({ longestMin: d % 2 ? 190 : 140 }));
  const s = notice({ ...base, past });
  const b = s.find((x) => x.kind === 'breaks');
  assert.ok(b, JSON.stringify(s));
  assert.ok(b.target >= 45 && b.target <= 90, `target ${b.target}`);
  assert.match(b.evidence, /^On 7 of your last 7 days you went 2 hours or more without a 5-minute break\. Longest: 3 h 10 min/);
  assert.equal(b.source, 'noticed');
  // Not when you already have one, and not after "Don't suggest this".
  assert.equal(notice({ ...base, past, goals: [goal('breaks', 60)] }).find((x) => x.kind === 'breaks'), undefined);
  assert.equal(notice({ ...base, past, memo: { breaks: { never: true } } }).find((x) => x.kind === 'breaks'), undefined);
  assert.equal(notice({ ...base, past, memo: { breaks: { until: at(27, 12) } } }).find((x) => x.kind === 'breaks'), undefined, 'not now');
  assert.ok(notice({ ...base, past, memo: { breaks: { until: at(25, 12) } } }).find((x) => x.kind === 'breaks'), '"not now" runs out');
  // A paused goal doesn't count as having one.
  assert.ok(notice({ ...base, past, goals: [goal('breaks', 60, { paused: true })] }).find((x) => x.kind === 'breaks'));
});

test('breaks and water need tracked days', () => {
  const past = week(() => ({ tracked: false, longestMin: 0, water: 0 }));
  const s = notice({ ...base, past });
  assert.equal(s.find((x) => x.kind === 'breaks' || x.kind === 'water' || x.kind === 'bedtime'), undefined);
});

test('long days with no water logged: suggests water', () => {
  const s = notice({ ...base, past: week(() => ({ water: 0, activeMin: 540 })) });
  const w = s.find((x) => x.kind === 'water');
  assert.ok(w);
  assert.equal(w.target, 8, 'long days get more');
});

test('overdoing it: suggests a stop time, and never "focus more"', () => {
  const past = week((d) => ({ activeMin: 660, lastMin: 1440 + 60 + d, focusMin: 30 }));
  const s = notice({ ...base, past });
  const bed = s.find((x) => x.kind === 'bedtime');
  assert.ok(bed, JSON.stringify(s));
  assert.equal(s[0].kind, 'bedtime', 'rest comes first');
  assert.equal(s.find((x) => x.kind === 'focus'), undefined);
  assert.equal(s.find((x) => x.kind === 'start'), undefined);
  // About an hour earlier than usual (median 1:22 am), on the half hour.
  assert.equal(bed.target, 30);
  assert.match(bed.evidence, /^You were on the computer after 1 am on 7 of your last 7 nights/);
  assert.match(bed.evidence, /10 hours or more on 7 of your last 7 days\.$/);
});

test('not much focused time on weekdays: a modest focus goal', () => {
  const past = week((d) => ({ focusMin: 40, firstSessionMin: d % 3 ? 15 * 60 : undefined, sessions: d % 3 ? 1 : 0, meetingMin: 30 }));
  const s = notice({ ...base, past });
  const f = s.find((x) => x.kind === 'focus');
  assert.ok(f, JSON.stringify(s));
  assert.equal(f.days, 'weekdays');
  assert.ok(f.target >= 1 && f.target <= 2, `a step, not a leap: ${f.target}`);
  assert.match(f.evidence, /focused about 0\.7 of them/);
  const st = s.find((x) => x.kind === 'start');
  assert.ok(st, 'starts after 1 pm too');
  assert.ok(st.target >= 7.5 * 60 && st.target <= 12 * 60);
  assert.ok(s.length <= 3);
});

test('focus that is fine is left alone', () => {
  const s = notice({ ...base, past: week(() => ({ focusMin: 240 })) });
  assert.equal(s.find((x) => x.kind === 'focus'), undefined);
});

test('a lot of drifting: a drift budget naming the usual culprit', () => {
  const s = notice({ ...base, past: week(() => ({ driftMin: 50, topDistraction: 'youtube.com' })) });
  const d = s.find((x) => x.kind === 'drift');
  assert.ok(d);
  assert.equal(d.target, 30);
  assert.match(d.evidence, /about 50 minutes a day.*mostly youtube\.com/);
});

test('a to-do list that is not moving', () => {
  const s = notice({ ...base, openTodos: 12, overdue: 3, past: week(() => ({ todosDone: 0 })) });
  const t = s.find((x) => x.kind === 'todos');
  assert.ok(t);
  assert.equal(t.target, 2);
  assert.match(t.evidence, /12 still open \(3 overdue\)/);
  assert.match(t.evidence, /^You finished almost no to-dos on weekdays this week/);
  assert.equal(notice({ ...base, openTodos: 2, past: week(() => ({ todosDone: 0 })) }).find((x) => x.kind === 'todos'), undefined, 'a short list is fine');
});

test('a healthy week suggests nothing', () => {
  assert.deepEqual(notice({ ...base, past: week(() => ({})) }), []);
});

// ---- ideas from the coach ----

test('coach ideas are checked: known kinds, sensible targets, one per kind', () => {
  const text = `Here you go:
[{"kind":"breaks","target":50,"days":"every","evidence":"You went 3 hours without a break on Tuesday.","why":"Fresher afternoons."},
 {"kind":"bedtime","target":"23:30","evidence":"Off after 1 am four nights.","why":"Sleep."},
 {"kind":"breaks","target":40},
 {"kind":"focus","target":2.3,"days":"weekdays","evidence":"About 1 focused hour a day.","why":"A step up."},
 {"kind":"meditate","target":10},
 {"kind":"water","target":40}]`;
  const ideas = parseIdeas(text, []);
  assert.deepEqual(ideas.map((i) => [i.kind, i.target, i.days]), [['breaks', 50, 'every'], ['bedtime', 23 * 60 + 30, 'every'], ['focus', 2.5, 'weekdays']]);
  assert.equal(ideas[0].source, 'coach');
  assert.equal(ideas[0].id, 'coach-breaks');
  assert.equal(ideas[1].name, goalName({ kind: 'bedtime', target: 23 * 60 + 30, days: 'every' }));
  assert.deepEqual(parseIdeas(text, [goal('breaks', 60)]).map((i) => i.kind), ['bedtime', 'focus'], 'skips kinds you already have');
  assert.deepEqual(parseIdeas('no json here', []), []);
  assert.deepEqual(parseIdeas('[{"kind":"start","target":"9am"}]', []), []);
});

test('the coach sees numbers, never titles or sites', () => {
  const p = ideasPrompt(week(() => ({ topDistraction: 'youtube.com' })), [goal('water', 6)], 'Founder');
  assert.match(p, /Role: Founder/);
  assert.match(p, /Current goals: Drink water 6 times a day/);
  assert.equal(p.split('\n').filter((l) => /^2026-10-/.test(l)).length, 7);
  assert.doesNotMatch(p, /youtube/);
});

test('the coach knows your goals and how today is going', () => {
  const v = viewGoal(goal('water', 6, { why: 'headaches' }), day(26, { water: 2 }), [], at(26, 12), 0);
  const line = goalsForCoach([v, { ...v, id: 'x', paused: true }]);
  assert.equal(line, 'Their daily habits (beta): Drink water 6 times a day (why: headaches): 2 of 6, 4 more glasses to go.');
  assert.equal(goalsForCoach([]), '');
});

// ---- big goals ----

const big = (title: string, over: Partial<Goal> = {}): Goal => goal('custom', 0, { id: `b-${title}`, title, ...over });
const did = (...texts: string[]) => texts.map((text) => ({ kind: 'todo' as const, text }));

test('a big goal moves forward when something you did counts toward it', () => {
  const g = big('Fundraise well', { counts: ['investors', 'pitch deck', 'Sequoia'] });
  assert.equal(goalHit(g, day(20, { items: did('Email the investors') })), true);
  assert.equal(goalHit(g, day(20, { items: [{ kind: 'meeting', text: 'Call with Sequoia' }] })), true);
  assert.equal(goalHit(g, day(20, { items: did('Fix Lock In') })), false);
  assert.equal(goalHit(g, day(20, { items: did('Fix Lock In'), checked: [g.id] })), true, 'or you said so');
  // Without a list, the words of its title count (fundraising, fundraiser…).
  assert.equal(goalHit(big('Fundraise well'), day(20, { items: [{ kind: 'session', text: 'Fundraising deck' }] })), true);
});

test('a big goal on the page: days left, what moved it, and the next step on your list', () => {
  const g = big('Fundraise well', { counts: ['investors', 'deck'], until: '2026-12-15', why: 'Runway' });
  const past = week((d) => (d % 2 ? { items: did(`Investor update ${d}`) } : {}));
  const v = viewGoal(g, day(26, { items: did('Send the deck to Sam') }), past, at(26, 12), 0, ['Book flights', 'Finish the deck appendix', 'Reply to investors']);
  assert.equal(v.progress, 'Moved it forward today');
  assert.equal(v.tone, 'done');
  assert.equal(v.daysLeft, 50);
  assert.equal(v.status, '50 days left · 3 of the last 6 days');
  assert.equal(v.nextStep, 'Finish the deck appendix');
  assert.deepEqual(v.moved!.slice(0, 2).map((m) => [m.label, m.text]), [['Today', 'Send the deck to Sam'], ['Sun', 'Investor update 25']]);
  assert.deepEqual(v.terms, ['investors', 'deck']);
  const fresh = viewGoal(big('Launch cool side products'), day(26), [], at(26, 12), 0);
  assert.equal(fresh.progress, 'Not yet today');
  assert.equal(fresh.pct, null);
  const line = goalsForCoach([v]);
  assert.match(line, /^Their big goals \(keep these in view, and ask about them when it fits\): Fundraise well \(why: Runway\): 50 days left, moved it forward on 3 of the last 6 days, moved it forward today, next step on their list: "Finish the deck appendix", latest: "Send the deck to Sam" \(today\)\.$/);
});

// ---- looking ahead, and keeping goals the right size ----

test('focus pace: where you would be by now at an even pace through your day', () => {
  // 3 h goal, day 9:00 to 18:30, it's 1:45 pm (half way): 1.5 h expected.
  const p = focusPace({ focusMin: 40, targetH: 3, nowMin: 13 * 60 + 45, startMin: 9 * 60, endMin: 18 * 60 + 30 });
  assert.equal(Math.round(p.expectedMin), 90);
  assert.equal(Math.round(p.behindMin), 50);
  assert.equal(p.leftMin, 140);
  assert.equal(p.dayLeftMin, 285);
  // A late starter is judged on their own day, not 9 to 5.
  const late = focusPace({ focusMin: 40, targetH: 3, nowMin: 13 * 60 + 45, startMin: 12 * 60, endMin: 22 * 60 });
  assert.ok(late.behindMin < 0, 'ahead of pace');
  // Past the end of the day the whole goal is expected.
  assert.equal(focusPace({ focusMin: 0, targetH: 2, nowMin: 20 * 60 }).expectedMin, 120);
});

const old = (g: Goal): Goal => ({ ...g, createdAt: at(1, 9) });

test('a goal you keep hitting gets a small step up', () => {
  const g = old(goal('focus', 3));
  const s = tune([g], week(() => ({ focusMin: 200 })), at(26, 12));
  assert.equal(s.length, 1);
  assert.equal(s[0].goalId, g.id);
  assert.equal(s[0].change, 'raise');
  assert.equal(s[0].target, 3.5);
  assert.equal(s[0].name, 'Focus 3.5 hours a day');
  assert.match(s[0].evidence, /on 7 of your last 7 goal days/);
  assert.equal(tune([old(goal('water', 6))], week(() => ({ water: 7 })), at(26, 12))[0].target, 7);
  assert.equal(tune([old(goal('drift', 20))], week(() => ({ driftMin: 5 })), at(26, 12))[0].target, 15);
});

test('a goal that keeps being out of reach gets a step you can hit', () => {
  const s = tune([old(goal('focus', 4))], week(() => ({ focusMin: 90 })), at(26, 12));
  assert.equal(s[0].change, 'ease');
  assert.equal(s[0].target, 3, 'never more than an hour down at once');
  assert.match(s[0].evidence, /out of reach: 0 of your last 7 goal days, about 1\.5 focused hours on a usual day/);
  assert.equal(tune([old(goal('focus', 3))], week(() => ({ focusMin: 100 })), at(26, 12))[0].target, 2);
  assert.equal(tune([old(goal('water', 8))], week(() => ({ water: 2 })), at(26, 12))[0].target, 3);
  assert.equal(tune([old(goal('bedtime', 23 * 60))], week(() => ({ lastMin: 1440 + 60 })), at(26, 12))[0].target, 23 * 60 + 30);
  assert.equal(tune([old(goal('bedtime', 23 * 60 + 45))], week(() => ({ lastMin: 1440 + 60 })), at(26, 12))[0].target, 15, 'past midnight wraps');
});

test('goals are left alone when new, recently changed, paused, in between, or without enough days', () => {
  const hit = week(() => ({ focusMin: 200 }));
  assert.deepEqual(tune([goal('focus', 3, { createdAt: at(24, 9) })], hit, at(26, 12)), [], 'set two days ago');
  assert.deepEqual(tune([old(goal('focus', 3, { changedAt: at(23, 9) }))], hit, at(26, 12)), [], 'changed this week');
  assert.deepEqual(tune([old(goal('focus', 3, { paused: true }))], hit, at(26, 12)), []);
  assert.deepEqual(tune([old(goal('focus', 3))], week((d) => ({ focusMin: d % 2 ? 200 : 100 })), at(26, 12)), [], 'some days yes, some no: fine as it is');
  assert.deepEqual(tune([old(goal('focus', 3))], [day(24, { focusMin: 200 }), day(25, { focusMin: 200 })], at(26, 12)), []);
  assert.deepEqual(tune([old(goal('custom', 0, { title: 'Ship it' }))], hit, at(26, 12)), []);
  assert.deepEqual(tune([old(goal('breaks', 60))], hit, at(26, 12)), [], 'no "more breaks" push');
  // Two at once: only the one that matters most.
  assert.equal(tune([old(goal('focus', 3)), old(goal('water', 8))], week(() => ({ focusMin: 200, water: 1 })), at(26, 12)).length, 1);
});
