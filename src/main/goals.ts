// Goals (beta). Three parts:
//   1. Rhythm: what your days look like, recorded from screen activity alone (no titles, no
//      sites): when you start and stop, how long you go without a break, and water you log.
//   2. Goals: targets Lock In can measure by itself (focus hours, breaks, water, bedtime,
//      start time, drift, to-dos), or "something else" you tick off yourself.
//   3. Noticing: rules that compare your last week or two to your own normal and suggest a
//      goal, with the numbers that led to it. Targets are a step better than usual, never a
//      leap, and when you're overdoing it they suggest rest, not more work.
import type { Goal, GoalDayMark, GoalKind, GoalSuggestion, GoalView, RhythmDay } from '../shared/types';
import { dayKey } from './todos/day';
import { daysLeft, daysLeftText, movedItems, termsOf, type DayItem } from './biggoals';

/** Away from the computer this long counts as a break. */
export const BREAK_MIN = 5;
/** A day counts when you were at the computer at least this long. */
const WORKED_MIN = 60;

// ---- rhythm ---------------------------------------------------------------------------------

export function emptyDay(day: string): RhythmDay {
  return { day, activeMin: 0, longestMin: 0, breaks: 0, water: [], hours: new Array(24).fill(0) };
}

/** Watches screen activity (idle time only) and keeps one small record per day. */
export class Rhythm {
  days: Record<string, RhythmDay>;
  private stretchStart: number | null = null;
  private lastActive = 0;

  constructor(saved: Record<string, RhythmDay> = {}) {
    this.days = saved;
  }

  day(day: string): RhythmDay {
    const d = (this.days[day] ??= emptyDay(day));
    d.hours ??= new Array(24).fill(0);
    d.water ??= [];
    return d;
  }

  /** Called every second or so with the system idle time. */
  tick(now: number, idleSec: number, dtSec: number): void {
    if (idleSec >= 60) return;
    const d = this.day(dayKey(now));
    const at = now - idleSec * 1000;
    d.activeMin += dtSec / 60;
    d.hours[new Date(now).getHours()] += dtSec / 60;
    d.first ??= at;
    d.last = Math.max(d.last ?? 0, at);
    // Back after five minutes or more away (or asleep): that was a break, and a new stretch starts.
    if (this.stretchStart === null || at - this.lastActive > BREAK_MIN * 60_000) {
      if (this.stretchStart !== null) d.breaks++;
      this.stretchStart = at;
    }
    this.lastActive = Math.max(this.lastActive, at);
    d.longestMin = Math.max(d.longestMin, (this.lastActive - this.stretchStart) / 60_000);
  }

  /** How long you've been going without a break (0 when you're on one). */
  stretchMin(now: number): number {
    if (this.stretchStart === null || now - this.lastActive > BREAK_MIN * 60_000) return 0;
    return (this.lastActive - this.stretchStart) / 60_000;
  }

  logWater(now: number): number {
    const d = this.day(dayKey(now));
    d.water.push(now);
    return d.water.length;
  }

  /** The days worth keeping (about four months), rounded for the file. */
  toJSON(): Record<string, RhythmDay> {
    const keys = Object.keys(this.days).sort().slice(-120);
    const out: Record<string, RhythmDay> = {};
    for (const k of keys) {
      const d = this.days[k];
      out[k] = { ...d, activeMin: Math.round(d.activeMin * 10) / 10, longestMin: Math.round(d.longestMin * 10) / 10, hours: d.hours.map((h) => Math.round(h * 10) / 10) };
    }
    return out;
  }
}

// ---- what each day looked like --------------------------------------------------------------

export interface DayFacts {
  day: string;
  /** Lock In was recording your rhythm that day (breaks, water and bedtimes need it). */
  tracked: boolean;
  activeMin: number;
  longestMin: number;
  breaks: number;
  water: number;
  /** Last activity as minutes after the day's midnight (past midnight is 1440 and up). */
  lastMin?: number;
  focusMin: number;
  driftMin: number;
  sessions: number;
  /** First focus session, minutes after midnight. */
  firstSessionMin?: number;
  todosDone: number;
  meetingMin: number;
  /** Big goals you ticked off that day. */
  checked: string[];
  topDistraction?: string;
  /** What you did that day, in words (to-dos finished, sessions, meetings), for big goals. */
  items?: DayItem[];
}

export const dateOf = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const isWeekday = (day: string) => {
  const w = dateOf(day).getDay();
  return w !== 0 && w !== 6;
};
const minutesOfDay = (ms: number, day: string) => {
  const t = new Date(ms);
  const base = dateOf(day);
  const extra = t.getDate() !== base.getDate() ? 1440 : 0;
  return t.getHours() * 60 + t.getMinutes() + extra;
};
/** Past midnight counts as late the same night: 00:30 is 1470. */
const nightMin = (m: number) => (m < 720 ? m + 1440 : m);

export function lastMinOf(r: RhythmDay | undefined): number | undefined {
  return r?.last ? minutesOfDay(r.last, r.day) : undefined;
}

export { minutesOfDay };

// ---- goals: names, values, progress ----------------------------------------------------------

export const clock = (m: number) => {
  const mm = ((Math.round(m) % 1440) + 1440) % 1440;
  const h = Math.floor(mm / 60);
  const d = new Date(2000, 0, 1, h, mm % 60);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
export const hrs = (min: number) => {
  const h = min / 60;
  return h >= 10 || Number.isInteger(h) ? `${Math.round(h)}` : (Math.round(h * 10) / 10).toString();
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dur = (min: number) => {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};

export function goalName(g: Pick<Goal, 'kind' | 'target' | 'title' | 'days'>): string {
  const wk = g.days === 'weekdays' ? ' on weekdays' : ' a day';
  switch (g.kind) {
    case 'focus':
      return `Focus ${hrs(g.target * 60)} ${g.target === 1 ? 'hour' : 'hours'}${wk}`;
    case 'breaks':
      return `A break at least every ${g.target} minutes`;
    case 'water':
      return `Drink water ${plural(g.target, 'time')} a day`;
    case 'bedtime':
      return `Off the computer by ${clock(g.target)}`;
    case 'start':
      return `Start focusing by ${clock(g.target)}${g.days === 'weekdays' ? ' on weekdays' : ''}`;
    case 'drift':
      return `Drift under ${g.target} minutes a day`;
    case 'todos':
      return `Finish ${plural(g.target, 'to-do')}${wk}`;
    default:
      return g.title?.trim() || 'Something else';
  }
}

/** Is this a day the goal counts on? */
export const goalDay = (g: Goal, day: string) => g.days !== 'weekdays' || isWeekday(day);

/** Did the goal hold on a finished day? null when there's nothing to judge (a day off). */
export function goalHit(g: Goal, f: DayFacts | undefined): boolean | null {
  if (!f || !goalDay(g, f.day)) return null;
  // A big goal moved forward: you said so, or something you did counts toward it.
  if (g.kind === 'custom') return f.checked.includes(g.id) || movedItems(g, f.items).length > 0;
  if (f.activeMin < WORKED_MIN) return null;
  if ((g.kind === 'breaks' || g.kind === 'water' || g.kind === 'bedtime') && !f.tracked) return null;
  switch (g.kind) {
    case 'focus':
      return f.focusMin >= g.target * 60 - 1;
    case 'breaks':
      // A little grace: finishing a sentence isn't failing.
      return f.longestMin <= g.target + 10;
    case 'water':
      return f.water >= g.target;
    case 'bedtime':
      // lastMin already runs past 1440 after midnight.
      return f.lastMin === undefined ? null : f.lastMin <= nightMin(g.target) + 5;
    case 'start':
      return f.firstSessionMin !== undefined && f.firstSessionMin <= g.target + 5;
    case 'drift':
      return f.sessions ? f.driftMin <= g.target : null;
    case 'todos':
      return f.todosDone >= g.target;
    default:
      return null;
  }
}

const SHORT_DAY = (day: string) => dateOf(day).toLocaleDateString([], { weekday: 'short' });

/** A goal on the page: today's progress in words, a bar where it helps, and the last 7 days. */
export function viewGoal(g: Goal, today: DayFacts, past: DayFacts[], now: number, stretchMin: number, openTodos: string[] = []): GoalView {
  const week: GoalDayMark[] = past.slice(-6).map((f) => ({ day: f.day, label: SHORT_DAY(f.day), hit: goalHit(g, f) }));
  const todayHit = goalHit(g, today);
  week.push({ day: today.day, label: 'Today', hit: todayHit === true ? true : null });
  const judged = week.slice(0, -1).filter((w) => w.hit !== null);
  const base = { ...g, name: goalName(g), week, hits: judged.filter((w) => w.hit).length, of: judged.length };
  const off = !goalDay(g, today.day);
  const nowMin = minutesOfDay(now, today.day);
  let progress = '';
  let pct: number | null = null;
  let status = '';
  let tone: GoalView['tone'] = 'ok';
  switch (g.kind) {
    case 'focus': {
      const v = today.focusMin;
      progress = `${hrs(v)} of ${hrs(g.target * 60)} h`;
      pct = Math.min(1, v / (g.target * 60));
      const left = g.target * 60 - v;
      tone = left <= 0 ? 'done' : nowMin > 15 * 60 && pct < 0.5 ? 'behind' : 'ok';
      status = left <= 0 ? 'Done for today' : `${dur(left)} to go`;
      break;
    }
    case 'breaks': {
      const s = Math.round(stretchMin);
      progress = s ? `${dur(s)} since your last break` : 'On a break, or just back';
      pct = Math.min(1, s / g.target);
      tone = s >= g.target ? 'behind' : today.longestMin > g.target + 10 ? 'behind' : 'ok';
      status = s >= g.target ? 'Time to get up for five minutes' : today.longestMin > g.target + 10 ? `Longest today: ${dur(today.longestMin)}` : `Next break in ${dur(g.target - s)}`;
      break;
    }
    case 'water': {
      const v = today.water;
      progress = `${v} of ${g.target}`;
      pct = Math.min(1, v / g.target);
      tone = v >= g.target ? 'done' : 'ok';
      const more = g.target - v;
      status = v >= g.target ? 'Done for today' : `${more} more ${more === 1 ? 'glass' : 'glasses'} to go`;
      break;
    }
    case 'bedtime': {
      const last = past.at(-1);
      const lastNight = last?.lastMin;
      progress = lastNight !== undefined && (last?.activeMin ?? 0) >= WORKED_MIN ? `Last night: off at ${clock(lastNight)}` : 'No night to go on yet';
      // Evening and past midnight only; the morning is far from bedtime.
      const evening = nowMin >= 18 * 60;
      const left = nightMin(g.target) - nowMin;
      tone = evening && left <= 0 ? 'behind' : 'ok';
      status = evening && left <= 0 ? `Past ${clock(g.target)}: time to wrap up` : evening && left <= 180 ? `${dur(left)} until ${clock(g.target)}` : `Tonight: off by ${clock(g.target)}`;
      break;
    }
    case 'start': {
      const v = today.firstSessionMin;
      progress = v !== undefined ? `Started at ${clock(v)}` : 'No session yet today';
      tone = v !== undefined ? (v <= g.target + 5 ? 'done' : 'ok') : nowMin > g.target ? 'behind' : 'ok';
      status = v !== undefined ? (v <= g.target + 5 ? 'On time' : 'Later than planned, still counts as a start') : nowMin > g.target ? `It's past ${clock(g.target)}: lock in on something small` : `Goal: ${clock(g.target)}`;
      break;
    }
    case 'drift': {
      const v = Math.round(today.driftMin);
      progress = `${v} of ${g.target} min`;
      pct = Math.min(1, v / g.target);
      tone = v > g.target ? 'behind' : 'ok';
      status = v > g.target ? 'Over for today' : `${g.target - v} min of slack left`;
      break;
    }
    case 'todos': {
      const v = today.todosDone;
      progress = `${v} of ${g.target}`;
      pct = Math.min(1, v / g.target);
      tone = v >= g.target ? 'done' : nowMin > 16 * 60 && v === 0 ? 'behind' : 'ok';
      status = v >= g.target ? 'Done for today' : `${plural(g.target - v, 'more')} to go`;
      break;
    }
    default: {
      const auto = movedItems(g, today.items);
      const done = today.checked.includes(g.id) || auto.length > 0;
      const left = daysLeft(today.day, g.until);
      progress = done ? 'Moved it forward today' : 'Not yet today';
      tone = done ? 'done' : 'ok';
      const of = base.of ? `${base.hits} of the last ${base.of} days` : '';
      status = [daysLeftText(left), of].filter(Boolean).join(' · ') || (done ? 'Nice.' : 'Tick it when you do something for it.');
      const moved: NonNullable<GoalView['moved']> = [];
      for (const f of [today, ...past.slice(-6).reverse()]) {
        const label = f.day === today.day ? 'Today' : SHORT_DAY(f.day);
        for (const i of movedItems(g, f.items).reverse()) moved.push({ day: f.day, label, kind: i.kind, text: i.text });
        if (f.checked.includes(g.id) && !movedItems(g, f.items).length) moved.push({ day: f.day, label, kind: 'you', text: 'You moved it forward' });
      }
      const terms = termsOf(g).filter((t) => t !== g.title);
      const next = openTodos.find((t) => movedItems(g, [{ kind: 'todo', text: t }]).length > 0);
      return { ...base, progress, pct: null, status, tone: g.paused ? 'idle' : off ? 'idle' : tone, daysLeft: left, moved: moved.slice(0, 6), nextStep: next, terms, ...(g.paused ? { status: 'Paused' } : off ? { status: 'Not a goal day' } : {}) };
    }
  }
  if (off) {
    tone = 'idle';
    status = 'Not a goal day';
  }
  if (g.paused) {
    tone = 'idle';
    status = 'Paused';
  }
  return { ...base, progress, pct, status, tone };
}

// ---- noticing patterns -------------------------------------------------------------------------------

export interface NoticeInput {
  /** Finished days, oldest first (today left out). */
  past: DayFacts[];
  openTodos: number;
  overdue: number;
  goals: Goal[];
  /** Suggestions you said "not now" to (until when) or "never" to. */
  memo: Record<string, { until?: number; never?: boolean }>;
  now: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Goals worth suggesting, strongest first (at most three), each with the numbers behind it. */
export function notice(input: NoticeInput): GoalSuggestion[] {
  const recent = input.past.slice(-7);
  const worked = recent.filter((f) => f.activeMin >= WORKED_MIN);
  // Breaks, water and bedtimes come from the rhythm Lock In records from now on.
  const tracked = worked.filter((f) => f.tracked);
  const out: (GoalSuggestion & { score: number })[] = [];
  const add = (s: Omit<GoalSuggestion, 'name' | 'source'> & { score: number }) => out.push({ ...s, name: goalName({ kind: s.kind, target: s.target, days: s.days }), source: 'noticed' });
  if (worked.length < 3) return [];
  const m = worked.length;
  const t = tracked.length;

  // Overdoing it: long days or late nights. Then rest comes first, and no "focus more".
  const long = worked.filter((f) => f.activeMin >= 600);
  const late = tracked.filter((f) => f.lastMin !== undefined && f.lastMin > 1440 + 60);
  const resting = long.length >= 3 || late.length >= 3;

  // 1. No breaks.
  const noBreak = tracked.filter((f) => f.longestMin >= 120);
  if (noBreak.length >= 3) {
    const worst = noBreak.reduce((a, b) => (b.longestMin > a.longestMin ? b : a));
    add({
      id: 'breaks',
      kind: 'breaks',
      target: clamp(round(median(noBreak.map((f) => f.longestMin)) * 0.45, 15), 45, 90),
      days: 'every',
      evidence: `On ${noBreak.length} of your last ${t} days you went 2 hours or more without a 5-minute break. Longest: ${dur(worst.longestMin)} on ${SHORT_DAY(worst.day)}.`,
      why: 'Short breaks keep your focus up in the afternoon, and your eyes and back will thank you. Lock In tells you when a stretch runs long.',
      score: noBreak.length / t + 0.3,
    });
  }

  // 2. Water: long days at the computer with little or none logged.
  const dry = tracked.filter((f) => f.activeMin >= 240 && f.water < 2);
  if (dry.length >= 3) {
    add({
      id: 'water',
      kind: 'water',
      target: mean(worked.map((f) => f.activeMin)) >= 480 ? 8 : 6,
      days: 'every',
      evidence: `On ${dry.length} of your last ${t} days you were at the computer 4 hours or more and logged water fewer than twice.`,
      why: 'Being even a little dehydrated makes focus slip. Log a glass from the reminder, the menu bar or your phone.',
      score: dry.length / t,
    });
  }

  // 3. Late nights and long days: a time to stop.
  if (resting) {
    const lasts = tracked.filter((f) => f.lastMin !== undefined).map((f) => Math.max(f.lastMin!, 18 * 60));
    const target = clamp(round((lasts.length ? median(lasts) : 23.5 * 60) - 60, 30), 22 * 60, 1440 + 90) % 1440;
    const bits = [
      late.length >= 3 ? `you were on the computer after 1 am on ${late.length} of your last ${t} nights (latest ${clock(Math.max(...late.map((f) => f.lastMin!)))})` : '',
      long.length >= 3 ? `${late.length >= 3 ? 'and ' : ''}you were at the computer 10 hours or more on ${long.length} of your last ${m} days` : '',
    ].filter(Boolean);
    add({
      id: 'bedtime',
      kind: 'bedtime',
      target,
      days: 'every',
      evidence: `${bits.join(', ').replace(/^./, (c) => c.toUpperCase())}.`,
      why: "Tired hours are slow hours. A set stop time protects tomorrow's focus, and Lock In gives you a heads-up 15 minutes before.",
      score: 1.2 + (late.length + long.length) / (2 * m),
    });
  }

  // 4. Not much focused time, on weekdays at the computer (meetings don't count against you).
  const weekdays = input.past.slice(-10).filter((f) => isWeekday(f.day) && f.activeMin >= 240);
  if (!resting && weekdays.length >= 3) {
    const focus = mean(weekdays.map((f) => f.focusMin));
    const free = mean(weekdays.map((f) => Math.max(60, f.activeMin - f.meetingMin)));
    if (focus < 120 && focus / free < 0.3) {
      const target = clamp(Math.max(round((focus * 1.5 + 30) / 60, 0.5), round(focus / 60 + 0.5, 0.5)), 1, 4);
      add({
        id: 'focus',
        kind: 'focus',
        target,
        days: 'weekdays',
        evidence: `On weekdays you're at the computer about ${hrs(free)} hours (not counting meetings) and focused about ${hrs(focus)} of them.`,
        why: `${hrs(target * 60)} focused hours is a step up from your usual, not a leap. Lock In checks in mid-afternoon if you're behind.`,
        score: 0.9 + (1 - focus / 120) * 0.4,
      });
    }
  }

  // 5. Drifting a lot in sessions.
  const sessionDays = recent.filter((f) => f.sessions > 0);
  if (sessionDays.length >= 3) {
    const drift = mean(sessionDays.map((f) => f.driftMin));
    if (drift >= 25) {
      const tops = sessionDays.map((f) => f.topDistraction).filter(Boolean) as string[];
      const top = tops.length ? [...tops].sort((a, b) => tops.filter((x) => x === b).length - tops.filter((x) => x === a).length)[0] : '';
      add({
        id: 'drift',
        kind: 'drift',
        target: Math.max(10, round(drift * 0.6, 5)),
        days: 'every',
        evidence: `Drifting took about ${Math.round(drift)} minutes a day of your focus sessions this week${top ? `, mostly ${top}` : ''}.`,
        why: 'A drift budget makes the next YouTube trip a choice instead of a reflex.',
        score: 0.7 + Math.min(0.5, drift / 120),
      });
    }
  }

  // 6. The to-do list isn't moving.
  const wdays = recent.filter((f) => isWeekday(f.day) && f.activeMin >= 120);
  if (wdays.length >= 3 && input.openTodos >= 5) {
    const done = mean(wdays.map((f) => f.todosDone));
    if (done < 1.5) {
      const target = clamp(Math.round(done) + 1, 2, 5);
      add({
        id: 'todos',
        kind: 'todos',
        target,
        days: 'weekdays',
        evidence: `${done < 0.5 ? 'You finished almost no to-dos on weekdays this week' : `You finished about ${Math.round(done * 10) / 10} to-dos a weekday`}, with ${input.openTodos} still open${input.overdue ? ` (${input.overdue} overdue)` : ''}.`,
        why: `${target} a day clears the list without a heroic weekend.`,
        score: 0.6 + (input.overdue ? 0.2 : 0),
      });
    }
  }

  // 7. Starting late (only when focus is also low, so it isn't just your rhythm).
  if (!resting && out.some((s) => s.kind === 'focus')) {
    const starts = weekdays.map((f) => f.firstSessionMin ?? 13 * 60 + 30);
    const lateStarts = starts.filter((v) => v > 13 * 60);
    if (lateStarts.length >= 3) {
      const target = clamp(round(median(starts) - 60, 30), 7 * 60 + 30, 12 * 60);
      add({
        id: 'start',
        kind: 'start',
        target,
        days: 'weekdays',
        evidence: `On ${lateStarts.length} of ${weekdays.length} weekdays your first focus session came after 1 pm, or not at all.`,
        why: 'Starting one small session earlier tends to pull the whole day forward.',
        score: 0.5,
      });
    }
  }

  const have = new Set(input.goals.filter((g) => !g.paused).map((g) => g.kind));
  return out
    .filter((s) => !have.has(s.kind))
    .filter((s) => {
      const memo = input.memo[s.id];
      return !memo?.never && !(memo?.until && memo.until > input.now);
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ score: _s, ...s }) => s);
}

// ---- looking ahead ---------------------------------------------------------------------------------

export interface PaceInput {
  /** Focused minutes so far today. */
  focusMin: number;
  /** The goal, in hours. */
  targetH: number;
  /** Minutes after midnight, now. */
  nowMin: number;
  /** When today started (first activity), minutes after midnight. */
  startMin?: number;
  /** When the working day usually ends, minutes after midnight (past midnight is 1440 and up). */
  endMin?: number;
}

/** Where you'd be by now at an even pace through your day, and how far behind that you are. */
export function focusPace(p: PaceInput): { expectedMin: number; behindMin: number; leftMin: number; dayLeftMin: number } {
  const start = p.startMin ?? 9 * 60;
  const end = Math.max(start + 4 * 60, p.endMin ?? 18 * 60 + 30);
  const frac = clamp((p.nowMin - start) / (end - start), 0, 1);
  const expectedMin = p.targetH * 60 * frac;
  return { expectedMin, behindMin: expectedMin - p.focusMin, leftMin: Math.max(0, p.targetH * 60 - p.focusMin), dayLeftMin: Math.max(0, end - p.nowMin) };
}

// ---- keeping goals the right size --------------------------------------------------------------------

const WEEK_MS = 7 * 86_400_000;

/**
 * Goals that have become easy get a small step up; goals that keep being out of reach get a
 * smaller step you can actually hit (a missed goal teaches you to ignore it). At most one at a
 * time, and only for a goal that has been the same for a week.
 */
export function tune(goals: Goal[], past: DayFacts[], now: number): GoalSuggestion[] {
  const out: (GoalSuggestion & { score: number })[] = [];
  for (const g of goals) {
    if (g.paused || g.kind === 'custom' || now - (g.changedAt ?? g.createdAt) < WEEK_MS) continue;
    const judged = past.slice(-10).map((f) => ({ f, hit: goalHit(g, f) })).filter((x) => x.hit !== null);
    if (judged.length < 5) continue;
    const hits = judged.filter((x) => x.hit).length;
    const rate = hits / judged.length;
    const of = `${hits} of your last ${judged.length} goal days`;
    const name = goalName(g);
    const push = (change: 'raise' | 'ease', target: number, evidence: string, why: string) => {
      if (target === g.target) return;
      const next = { ...g, target };
      out.push({ id: `tune:${g.id}:${change}`, kind: g.kind, target, days: g.days, name: goalName(next), evidence, why, source: 'noticed', goalId: g.id, change, score: change === 'ease' ? 1.4 - rate : rate });
    };
    if (rate >= 0.85) {
      const up = 'Small steps up keep a goal worth having once it’s easy.';
      if (g.kind === 'focus' && g.target < 10) push('raise', g.target + 0.5, `You hit “${name}” on ${of}.`, up);
      else if (g.kind === 'water' && g.target < 12) push('raise', g.target + 1, `You hit “${name}” on ${of}.`, up);
      else if (g.kind === 'todos' && g.target < 10) push('raise', g.target + 1, `You hit “${name}” on ${of}.`, up);
      else if (g.kind === 'drift' && g.target > 5) push('raise', Math.max(5, g.target - 5), `You stayed under ${g.target} minutes of drifting on ${of}.`, up);
    } else if (rate <= 0.25) {
      const days = judged.map((x) => x.f);
      const down = 'A goal you hit builds more than one you keep missing. You can step it back up later.';
      if (g.kind === 'focus' && g.target > 0.5) {
        const usual = median(days.map((f) => f.focusMin)) / 60;
        push('ease', clamp(Math.max(round(usual + 0.5, 0.5), g.target - 1), 0.5, g.target - 0.5), `“${name}” has been out of reach: ${of}, about ${hrs(usual * 60)} focused hours on a usual day.`, down);
      } else if (g.kind === 'water' && g.target > 2) {
        const usual = median(days.map((f) => f.water));
        push('ease', clamp(Math.round(usual) + 1, 2, g.target - 1), `“${name}” has been out of reach: ${of}, about ${Math.round(usual)} logged on a usual day.`, down);
      } else if (g.kind === 'todos' && g.target > 1) {
        push('ease', g.target - 1, `“${name}” has been out of reach: ${of}.`, down);
      } else if (g.kind === 'drift' && g.target < 180) {
        push('ease', g.target + 10, `“${name}” has been out of reach: ${of}.`, down);
      } else if (g.kind === 'breaks' && g.target < 180) {
        push('ease', Math.min(180, g.target + 15), `“${name}” has been out of reach: ${of}.`, down);
      } else if (g.kind === 'bedtime') {
        push('ease', (g.target + 30) % 1440, `“${name}” has been out of reach: ${of}.`, 'Half an hour later is a stop time you can keep. Then pull it back.');
      } else if (g.kind === 'start') {
        push('ease', Math.min(13 * 60, g.target + 30), `“${name}” has been out of reach: ${of}.`, down);
      }
    }
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, 1)
    .map(({ score: _s, ...s }) => s);
}

// ---- asking Claude for ideas --------------------------------------------------------------------------------

const RANGES: Record<Exclude<GoalKind, 'custom'>, [number, number]> = {
  focus: [0.5, 10],
  breaks: [20, 180],
  water: [2, 16],
  bedtime: [0, 1439],
  start: [300, 780],
  drift: [5, 180],
  todos: [1, 20],
};

/** The numbers Claude gets: one line per day, no titles or sites. */
export function ideasPrompt(past: DayFacts[], goals: Goal[], role: string): string {
  const rows = past.slice(-14).map((f) =>
    [f.day, SHORT_DAY(f.day), hrs(f.activeMin), hrs(f.focusMin), hrs(f.meetingMin), Math.round(f.longestMin), f.breaks, f.water, f.lastMin !== undefined ? clock(f.lastMin) : '-', f.firstSessionMin !== undefined ? clock(f.firstSessionMin) : '-', Math.round(f.driftMin), f.todosDone].join(' | '),
  );
  return `Role: ${role}
Current goals: ${goals.length ? goals.map((g) => goalName(g)).join('; ') : 'none'}

day | weekday | hours at computer | focused hours | meeting hours | longest stretch without a break (min) | breaks | water logged | last active | first focus session | drift min in sessions | to-dos done
${rows.join('\n')}`;
}

export const IDEAS_SYSTEM = `You are the coach in Lock In, a focus app. From the user's last two weeks, suggest up to 3 goals that would most help them, each a modest step from their own normal (never a leap). If they are overworking or up late, suggest rest before more work. Skip kinds they already have.
Allowed kinds and targets:
- focus: hours a day (0.5-10), days "weekdays" or "every"
- breaks: a break at least every N minutes (20-180)
- water: glasses a day (2-16)
- bedtime: off the computer by HH:MM (24-hour)
- start: first focus session by HH:MM (24-hour, 05:00-13:00)
- drift: under N minutes of drifting a day (5-180)
- todos: to-dos a day (1-20)
Answer with JSON only: [{"kind":"…","target":<number, or "HH:MM" for bedtime and start>,"days":"every"|"weekdays","evidence":"one sentence with their real numbers","why":"one short sentence on what it does for them"}]`;

/** Claude's ideas, checked: known kinds, sensible targets, real sentences. */
export function parseIdeas(text: string, goals: Goal[]): GoalSuggestion[] {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(a, b + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const have = new Set(goals.filter((g) => !g.paused).map((g) => g.kind));
  const out: GoalSuggestion[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const kind = String(r?.kind ?? '') as Exclude<GoalKind, 'custom'>;
    if (!(kind in RANGES) || have.has(kind) || out.some((o) => o.kind === kind)) continue;
    let target: number;
    if (kind === 'bedtime' || kind === 'start') {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(r.target ?? '').trim());
      if (!m) continue;
      target = Number(m[1]) * 60 + Number(m[2]);
    } else target = Number(r.target);
    const [lo, hi] = RANGES[kind];
    if (!Number.isFinite(target) || target < lo || target > hi) continue;
    if (kind === 'focus') target = Math.round(target * 2) / 2;
    else target = Math.round(target);
    const days = r.days === 'weekdays' ? 'weekdays' : 'every';
    const s = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 240) : '');
    out.push({ id: `coach-${kind}`, kind, target, days, name: goalName({ kind, target, days }), evidence: s(r.evidence), why: s(r.why), source: 'coach' });
    if (out.length >= 3) break;
  }
  return out;
}

/** One line per goal for the coach: what it is and how today is going. */
export function goalsForCoach(views: GoalView[]): string {
  const live = views.filter((v) => !v.paused);
  if (!live.length) return '';
  const big = live.filter((v) => v.kind === 'custom');
  const habits = live.filter((v) => v.kind !== 'custom');
  const parts: string[] = [];
  if (big.length)
    parts.push(
      `Their big goals (keep these in view, and ask about them when it fits): ${big
        .map((v) => {
          const bits = [daysLeftText(v.daysLeft).toLowerCase(), v.of ? `moved it forward on ${v.hits} of the last ${v.of} days` : '', v.progress.toLowerCase(), v.nextStep ? `next step on their list: "${v.nextStep}"` : '', v.moved?.[0] && v.moved[0].kind !== 'you' ? `latest: "${v.moved[0].text}" (${v.moved[0].label.toLowerCase()})` : ''].filter(Boolean);
          return `${v.name}${v.why ? ` (why: ${v.why})` : ''}: ${bits.join(', ')}`;
        })
        .join('; ')}.`,
    );
  if (habits.length) parts.push(`Their daily habits (beta): ${habits.map((v) => `${v.name}${v.why ? ` (why: ${v.why})` : ''}: ${v.progress.toLowerCase()}, ${v.status.toLowerCase().replace(/\.$/, '')}`).join('; ')}.`);
  return parts.join(' ');
}
