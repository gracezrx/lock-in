// Streaks, weekly numbers and silly achievements, all worked out from what Lock In already
// keeps (sessions, coach cards, finished to-dos, bombs). Pure functions; the app stores which
// ones you've unlocked and when.
import type { AchievementView, CrewStats, InterventionRecord, SessionRecord } from '../shared/types';
import type { CrewEvent } from './crew/crew';

export interface AchievementCtx {
  now: number;
  sessions: SessionRecord[];
  interventions: InterventionRecord[];
  /** When to-dos were finished. */
  doneAts: number[];
  /** When the to-do watchdog roasted you. */
  todoRoastAts: number[];
  crewEvents: CrewEvent[];
  /** You're the most roasted in your crew this week (with at least 3). */
  roastTop?: boolean;
}

/** A day counts toward a streak with this many focused minutes. */
export const STREAK_MIN = 25;

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hourOf = (t: number) => new Date(t).getHours();

/** Monday, 00:00, of this week. */
export function weekStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

const finished = (s: SessionRecord) => s.endedBy === 'timer' && !!s.endedAt;

export function focusByDay(sessions: SessionRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) m.set(dayOf(s.startedAt), (m.get(dayOf(s.startedAt)) ?? 0) + s.focusSec / 60);
  return m;
}

function prevDay(day: string): string {
  const [y, mo, d] = day.split('-').map(Number);
  return dayOf(new Date(y, mo - 1, d - 1, 12).getTime());
}

/** Days in a row with 25+ focused minutes, ending today (or yesterday, if today isn't there yet). */
export function streak(sessions: SessionRecord[], now: number): number {
  const by = focusByDay(sessions);
  const ok = (d: string) => (by.get(d) ?? 0) >= STREAK_MIN;
  let day = dayOf(now);
  if (!ok(day)) day = prevDay(day);
  let n = 0;
  while (ok(day)) {
    n++;
    day = prevDay(day);
  }
  return n;
}

export function longestStreak(sessions: SessionRecord[]): number {
  const days = [...focusByDay(sessions)].filter(([, m]) => m >= STREAK_MIN).map(([d]) => d).sort();
  let best = 0;
  let run = 0;
  let last = '';
  for (const d of days) {
    run = last && prevDay(d) === last ? run + 1 : 1;
    best = Math.max(best, run);
    last = d;
  }
  return best;
}

/** Bombs that landed, red and yellow cards, and to-do roasts since Monday. */
export function roastedThisWeek(ctx: AchievementCtx): number {
  const from = weekStart(ctx.now);
  return (
    ctx.crewEvents.filter((e) => e.type === 'received' && e.outcome !== 'bounced' && e.at >= from).length +
    ctx.interventions.filter((i) => i.level >= 3 && i.startedAt >= from).length +
    ctx.todoRoastAts.filter((t) => t >= from).length
  );
}

export function crewStats(ctx: AchievementCtx, unlockedCount: number): CrewStats {
  const today = dayOf(ctx.now);
  const from = weekStart(ctx.now);
  const sum = (list: SessionRecord[]) => Math.round(list.reduce((a, s) => a + s.focusSec, 0) / 60);
  return {
    todayMin: sum(ctx.sessions.filter((s) => dayOf(s.startedAt) === today)),
    weekMin: sum(ctx.sessions.filter((s) => s.startedAt >= from)),
    streak: streak(ctx.sessions, ctx.now),
    roastedWeek: roastedThisWeek(ctx),
    bombsThrownWeek: ctx.crewEvents.filter((e) => e.type === 'thrown' && e.at >= from).length,
    achievements: unlockedCount,
  };
}

/** Three YouTube relapses before noon, and you still finished a session by early afternoon. */
function relapseSurvivor(ctx: AchievementCtx): boolean {
  const morning = new Map<string, number[]>();
  for (const i of ctx.interventions) {
    if (!/youtube|youtu\.be/i.test(i.distraction) || hourOf(i.startedAt) >= 12) continue;
    const d = dayOf(i.startedAt);
    morning.set(d, [...(morning.get(d) ?? []), i.startedAt]);
  }
  for (const [day, times] of morning) {
    if (times.length < 3) continue;
    const third = times.sort((a, b) => a - b)[2];
    if (ctx.sessions.some((s) => finished(s) && dayOf(s.endedAt!) === day && s.endedAt! >= third && hourOf(s.endedAt!) < 14)) return true;
  }
  return false;
}

function perDay(times: number[]): number {
  const m = new Map<string, number>();
  for (const t of times) m.set(dayOf(t), (m.get(dayOf(t)) ?? 0) + 1);
  return Math.max(0, ...m.values());
}

export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  check: (c: AchievementCtx) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first-lock', name: 'First lock', desc: 'Finish your first focus session.', check: (c) => c.sessions.some(finished) },
  { id: 'relapse-survivor', name: 'Relapse survivor', desc: 'Survived 3 YouTube relapses before lunch.', check: relapseSurvivor },
  { id: 'clean-sheet', name: 'Clean sheet', desc: 'A 50-minute session with zero drifts.', check: (c) => c.sessions.some((s) => finished(s) && s.plannedMin >= 50 && s.interventions === 0) },
  { id: 'iron-butt', name: 'Iron butt', desc: '90 minutes locked in without a single drift.', check: (c) => c.sessions.some((s) => finished(s) && s.plannedMin >= 90 && s.interventions === 0) },
  { id: 'early-bird', name: 'Early bird', desc: 'Finish a session before 8 am.', check: (c) => c.sessions.some((s) => finished(s) && hourOf(s.endedAt!) >= 4 && hourOf(s.endedAt!) < 8) },
  { id: 'night-owl', name: 'Night owl', desc: 'Finish a session after midnight.', check: (c) => c.sessions.some((s) => finished(s) && hourOf(s.endedAt!) < 4) },
  { id: 'deep-diver', name: 'Deep diver', desc: 'Four hours locked in, in one day.', check: (c) => Math.max(0, ...focusByDay(c.sessions).values()) >= 240 },
  { id: 'three-peat', name: 'Three-peat', desc: 'Lock in three days in a row.', check: (c) => longestStreak(c.sessions) >= 3 },
  { id: 'week-of-steel', name: 'Week of steel', desc: 'Lock in seven days in a row.', check: (c) => longestStreak(c.sessions) >= 7 },
  { id: 'terminator', name: 'To-do terminator', desc: 'Finish 10 to-dos in one day.', check: (c) => perDay(c.doneAts) >= 10 },
  { id: 'comeback-kid', name: 'Comeback kid', desc: 'Back to work within a minute of a red card.', check: (c) => c.interventions.some((i) => i.level >= 4 && i.secToReturn !== undefined && i.secToReturn <= 60 && i.worked !== false) },
  { id: 'bomb-squad', name: 'Bomb squad', desc: 'Throw all 3 bombs in one day.', check: (c) => perDay(c.crewEvents.filter((e) => e.type === 'thrown').map((e) => e.at)) >= 3 },
  {
    id: 'took-the-hit',
    name: 'Took the hit',
    desc: 'Got bombed and locked in within 2 minutes.',
    check: (c) => c.crewEvents.some((e) => e.type === 'received' && e.outcome !== 'bounced' && c.sessions.some((s) => s.startedAt >= e.at && s.startedAt - e.at <= 120_000)),
  },
  {
    id: 'return-to-sender',
    name: 'Return to sender',
    desc: 'Bomb back whoever bombed you, within 10 minutes.',
    check: (c) => c.crewEvents.some((r) => r.type === 'received' && c.crewEvents.some((t) => t.type === 'thrown' && t.other === r.other && t.at > r.at && t.at - r.at <= 600_000)),
  },
  { id: 'roast-magnet', name: 'Roast magnet', desc: 'Most roasted in your crew this week.', check: (c) => !!c.roastTop },
];

/**
 * Which achievements are newly earned. The very first time (no record yet) everything you've
 * already earned is filed quietly, so an update doesn't fire a dozen toasts at once.
 */
export function evaluate(ctx: AchievementCtx, unlocked: Record<string, number> | null): { unlocked: Record<string, number>; fresh: AchievementDef[]; backfilled: number } {
  const first = unlocked === null;
  const out = { ...(unlocked ?? {}) };
  const fresh: AchievementDef[] = [];
  for (const a of ACHIEVEMENTS) {
    if (out[a.id]) continue;
    let ok = false;
    try {
      ok = a.check(ctx);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    out[a.id] = ctx.now;
    if (!first) fresh.push(a);
  }
  return { unlocked: out, fresh, backfilled: first ? Object.keys(out).length : 0 };
}

export function achievementViews(unlocked: Record<string, number>): AchievementView[] {
  return ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, desc: a.desc, unlockedAt: unlocked[a.id] }));
}
