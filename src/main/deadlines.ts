// Deadlines: things due on a date. On the day they are pinned at the top of Lock In; before
// that you are reminded once 3 days out, twice 2 days out and three times the day before,
// until it is done. Pure logic plus a small store, unit tested.
import { randomUUID } from 'node:crypto';
import type { Deadline, Persona } from '../shared/types';

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Whole calendar days from today until the due date (0 = today, negative = overdue). */
export function daysUntil(due: string, now: number): number {
  const [y, m, d] = due.split('-').map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((target - start) / 86_400_000);
}

/** Reminder times for each day before the deadline. */
export const SLOTS: Record<number, string[]> = {
  3: ['10:00'],
  2: ['10:00', '15:00'],
  1: ['10:00', '14:00', '18:00'],
};

export interface ReminderState {
  [id: string]: { day: string; count: number; lastAt: number };
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Has a due time passed (or the day ended)? */
export function isOverdue(d: Deadline, now: number): boolean {
  const left = daysUntil(d.due, now);
  if (left < 0) return true;
  if (left > 0 || !d.time) return false;
  const t = new Date(now);
  return t.getHours() * 60 + t.getMinutes() > minutesOf(d.time);
}

/**
 * Which reminder is due now for this deadline, if any: { n, of, daysLeft }.
 * Reminders that were missed (computer asleep, in a meeting) catch up, but at least 45 minutes apart.
 */
export function reminderDue(d: Deadline, state: ReminderState, now: number): { n: number; of: number; daysLeft: number } | null {
  if (d.done) return null;
  const daysLeft = daysUntil(d.due, now);
  const slots = SLOTS[daysLeft];
  if (!slots) return null;
  const today = ymd(now);
  const st = state[d.id]?.day === today ? state[d.id] : { day: today, count: 0, lastAt: 0 };
  const t = new Date(now);
  const nowMin = t.getHours() * 60 + t.getMinutes();
  const passed = slots.filter((s) => minutesOf(s) <= nowMin).length;
  if (st.count >= passed || st.count >= slots.length) return null;
  if (st.lastAt && now - st.lastAt < 45 * 60_000) return null;
  return { n: st.count + 1, of: slots.length, daysLeft };
}

export function markReminded(d: Deadline, state: ReminderState, now: number): void {
  const today = ymd(now);
  const st = state[d.id]?.day === today ? state[d.id] : { day: today, count: 0, lastAt: 0 };
  state[d.id] = { day: today, count: st.count + 1, lastAt: now };
}

const when = (d: Deadline, daysLeft: number) => {
  const day = daysLeft === 1 ? 'tomorrow' : `in ${daysLeft} days`;
  if (!d.time) return day;
  const [h, m] = d.time.split(':').map(Number);
  const t = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${t}`;
};

/** The words for a reminder, by personality, getting sharper as it gets closer. */
export function reminderLine(d: Deadline, r: { n: number; of: number; daysLeft: number }, persona: Persona): { title: string; body: string } {
  const t = `"${d.title}"`;
  const w = when(d, r.daysLeft);
  const title = r.daysLeft === 1 ? `Due tomorrow: ${d.title}` : `Due ${w}: ${d.title}`;
  const last = r.daysLeft === 1 && r.n === r.of;
  const lines: Record<Persona, string> = {
    sassy:
      r.daysLeft === 3 ? `${t} is due ${w}. Plenty of time, which is exactly what you said last time.` :
      r.daysLeft === 2 ? (r.n === 1 ? `${t}, ${w}. Tick tock, babe.` : `Still ${t}. Still not done. Two days.`) :
      r.n === 1 ? `${t} is due ${w}. Today is the day you actually do it.` :
      last ? `Last call: ${t} is due ${w} and it is still not done. Respectfully, what is going on?` :
      `Reminder ${r.n} of ${r.of}: ${t} ${w}. Have you started? Be honest.`,
    gentle:
      r.daysLeft === 3 ? `Heads-up: ${t} is due ${w}. A small start today makes it easy.` :
      r.daysLeft === 2 ? `${t} is due ${w}. Want to give it a focused block?` :
      last ? `${t} is due ${w}. Let's get it over the line tonight.` :
      `${t} is due ${w}. Today is a good day to finish it.`,
    firm:
      r.daysLeft === 3 ? `${t}: due ${w}. Schedule the work.` :
      r.daysLeft === 2 ? `${t}: due ${w}. Start it.` :
      last ? `${t}: due ${w}. Finish it now.` :
      `${t}: due ${w}. Work on it today.`,
    drill:
      r.daysLeft === 3 ? `${t}! ${w}! Get moving!` :
      r.daysLeft === 2 ? `${t} in two days! Why is it not done?` :
      last ? `${t} is due ${w}! Final warning! Lock in now!` :
      `${t} is due ${w}! Report progress!`,
  };
  return { title, body: lines[persona] };
}

export interface DeadlineStore {
  load: () => Deadline[];
  save: (d: Deadline[]) => void;
  loadState: () => ReminderState;
  saveState: (s: ReminderState) => void;
}

export class Deadlines {
  private items: Deadline[];
  private state: ReminderState;

  constructor(private s: DeadlineStore) {
    this.items = s.load();
    this.state = s.loadState();
  }

  all(): Deadline[] {
    return [...this.items].sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due) || (a.time ?? '99').localeCompare(b.time ?? '99'));
  }

  open(): Deadline[] {
    return this.all().filter((d) => !d.done);
  }

  get(id: string): Deadline | undefined {
    return this.items.find((d) => d.id === id);
  }

  add(p: { title: string; due: string; time?: string; taskId?: string; project?: string }, now = Date.now()): Deadline {
    const d: Deadline = {
      id: randomUUID(),
      title: p.title.trim().slice(0, 200),
      due: p.due,
      time: p.time || undefined,
      done: false,
      createdAt: now,
      taskId: p.taskId,
      project: p.project,
    };
    this.items.push(d);
    this.s.save(this.items);
    return d;
  }

  update(id: string, patch: Partial<Pick<Deadline, 'title' | 'due' | 'time' | 'done'>>, now = Date.now()): Deadline | undefined {
    const d = this.get(id);
    if (!d) return undefined;
    Object.assign(d, patch);
    if (patch.done !== undefined) d.doneAt = patch.done ? now : undefined;
    if (patch.due) delete this.state[id];
    this.s.save(this.items);
    this.s.saveState(this.state);
    return d;
  }

  remove(id: string): void {
    this.items = this.items.filter((d) => d.id !== id);
    delete this.state[id];
    this.s.save(this.items);
    this.s.saveState(this.state);
  }

  /** Due today or overdue and not done: pinned at the top of Lock In. */
  pinned(now = Date.now()): Deadline[] {
    return this.open().filter((d) => daysUntil(d.due, now) <= 0);
  }

  /** The next reminder to show, if one is due (and records it). */
  nextReminder(now = Date.now()): { d: Deadline; r: { n: number; of: number; daysLeft: number } } | null {
    for (const d of this.open()) {
      const r = reminderDue(d, this.state, now);
      if (r) {
        markReminded(d, this.state, now);
        this.s.saveState(this.state);
        return { d, r };
      }
    }
    return null;
  }

  /** "Pitch deck (tomorrow), Tax form (Friday)" for the coach. */
  summary(now = Date.now()): string {
    const open = this.open().slice(0, 6);
    if (!open.length) return '';
    return open
      .map((d) => {
        const left = daysUntil(d.due, now);
        const w = left < 0 ? 'overdue' : left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
        return `"${d.title}" (${w})`;
      })
      .join(', ');
  }
}
