import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, crewStats, evaluate, longestStreak, roastedThisWeek, streak, weekStart, type AchievementCtx } from '../src/main/achievements';
import type { InterventionRecord, SessionRecord } from '../src/shared/types';

const at = (s: string) => new Date(s).getTime();
let n = 0;
function session(start: string, min: number, o: Partial<SessionRecord> = {}): SessionRecord {
  const s = at(start);
  return {
    id: `s${++n}`, goal: 'Deck', plannedMin: min, startedAt: s, endedAt: s + min * 60_000, endedBy: 'timer',
    focusSec: min * 60, driftSec: 0, neutralSec: 0, awaySec: 0, breakSec: 0, maxLevel: 0, interventions: 0, topDistractions: {}, ...o,
  };
}
function card(time: string, distraction: string, o: Partial<InterventionRecord> = {}): InterventionRecord {
  return { id: `i${++n}`, sessionId: 'x', level: 3, trigger: 'score', distraction, startedAt: at(time), ...o };
}
const ctx = (o: Partial<AchievementCtx>): AchievementCtx => ({ now: at('2026-10-28T18:00:00'), sessions: [], interventions: [], doneAts: [], todoRoastAts: [], crewEvents: [], ...o });
const earned = (c: AchievementCtx) => Object.keys(evaluate(c, {}).unlocked).sort();

test('streaks count days with 25 focused minutes in a row, through today or yesterday', () => {
  const s = [session('2026-10-25T10:00', 30), session('2026-10-26T10:00', 50), session('2026-10-27T09:00', 20), session('2026-10-27T15:00', 10)];
  assert.equal(streak(s, at('2026-10-27T20:00')), 3, 'two short sessions add up');
  assert.equal(streak(s, at('2026-10-28T09:00')), 3, "today isn't done yet: count from yesterday");
  assert.equal(streak(s, at('2026-10-29T09:00')), 0, 'missed a day');
  assert.equal(longestStreak([...s, session('2026-10-20T10:00', 40)]), 3);
});

test('weeks start on Monday', () => {
  assert.equal(new Date(weekStart(at('2026-10-28T18:00'))).getDay(), 1);
  assert.equal(weekStart(at('2026-10-26T00:30')), at('2026-10-26T00:00'));
  assert.equal(weekStart(at('2026-11-01T23:00')), at('2026-10-26T00:00'), 'Sunday is the end of the week');
});

test('"Survived 3 YouTube relapses before lunch"', () => {
  const relapses = [card('2026-10-27T09:10', 'youtube.com'), card('2026-10-27T10:05', 'm.youtube.com'), card('2026-10-27T11:30', 'youtube.com')];
  const survived = session('2026-10-27T11:00', 50);
  assert.ok(earned(ctx({ interventions: relapses, sessions: [survived] })).includes('relapse-survivor'));
  assert.ok(!earned(ctx({ interventions: relapses.slice(0, 2), sessions: [survived] })).includes('relapse-survivor'), 'only two');
  assert.ok(!earned(ctx({ interventions: relapses, sessions: [{ ...survived, endedBy: 'user' }] })).includes('relapse-survivor'), 'gave up');
  const afternoon = relapses.map((i) => ({ ...i, startedAt: i.startedAt + 4 * 3_600_000 }));
  assert.ok(!earned(ctx({ interventions: afternoon, sessions: [session('2026-10-27T16:00', 50)] })).includes('relapse-survivor'), 'after lunch');
});

test('session achievements', () => {
  const got = earned(ctx({ sessions: [session('2026-10-27T05:30', 90), session('2026-10-28T01:00', 25, { startedAt: at('2026-10-28T00:40'), endedAt: at('2026-10-28T01:05') }), session('2026-10-26T10:00', 240)] }));
  for (const id of ['first-lock', 'clean-sheet', 'iron-butt', 'early-bird', 'night-owl', 'deep-diver', 'three-peat']) assert.ok(got.includes(id), id);
  assert.ok(!got.includes('week-of-steel'));
  const drifty = earned(ctx({ sessions: [session('2026-10-27T10:00', 90, { interventions: 2 })] }));
  assert.ok(drifty.includes('first-lock') && !drifty.includes('iron-butt') && !drifty.includes('clean-sheet'));
});

test('to-dos, red cards and bombs', () => {
  const ten = Array.from({ length: 10 }, (_, i) => at('2026-10-27T09:00') + i * 600_000);
  assert.ok(earned(ctx({ doneAts: ten })).includes('terminator'));
  assert.ok(earned(ctx({ interventions: [card('2026-10-27T10:00', 'reddit.com', { level: 4, secToReturn: 40, worked: true })] })).includes('comeback-kid'));
  const t = at('2026-10-27T15:00');
  const got = earned(
    ctx({
      crewEvents: [
        { type: 'received', at: t, other: 'sam', outcome: 'hit' },
        { type: 'thrown', at: t + 300_000, other: 'sam', outcome: 'hit' },
        { type: 'thrown', at: t + 400_000, other: 'lee' },
        { type: 'thrown', at: t + 500_000, other: 'lee' },
      ],
      sessions: [session('2026-10-27T15:01', 25)],
      roastTop: true,
    }),
  );
  for (const id of ['bomb-squad', 'took-the-hit', 'return-to-sender', 'roast-magnet']) assert.ok(got.includes(id), id);
});

test('the first check files what you already earned quietly; later ones announce', () => {
  const c = ctx({ sessions: [session('2026-10-27T10:00', 50)] });
  const first = evaluate(c, null);
  assert.deepEqual(first.fresh, []);
  assert.equal(first.backfilled, 2);
  const later = evaluate({ ...c, sessions: [...c.sessions, session('2026-10-28T10:00', 90)] }, first.unlocked);
  assert.deepEqual(later.fresh.map((a) => a.id), ['iron-butt']);
  assert.equal(evaluate(c, later.unlocked).fresh.length, 0, 'never twice');
  assert.equal(new Set(ACHIEVEMENTS.map((a) => a.id)).size, ACHIEVEMENTS.length);
});

test('the weekly numbers friends see', () => {
  const c = ctx({
    sessions: [session('2026-10-28T09:00', 50), session('2026-10-26T09:00', 30), session('2026-10-24T09:00', 60)],
    interventions: [card('2026-10-27T10:00', 'x'), card('2026-10-27T11:00', 'y', { level: 2 }), card('2026-10-20T10:00', 'z')],
    todoRoastAts: [at('2026-10-28T12:00')],
    crewEvents: [{ type: 'received', at: at('2026-10-27T15:00'), other: 'sam', outcome: 'hit' }, { type: 'received', at: at('2026-10-27T16:00'), other: 'sam', outcome: 'bounced' }, { type: 'thrown', at: at('2026-10-27T16:00'), other: 'lee' }],
  });
  assert.equal(roastedThisWeek(c), 3, 'a yellow card, a to-do roast, one bomb that landed');
  assert.deepEqual(crewStats(c, 4), { todayMin: 50, weekMin: 80, streak: 1, roastedWeek: 3, bombsThrownWeek: 1, achievements: 4 });
});
