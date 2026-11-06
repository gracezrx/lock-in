// Every to-do, every day: what was on your list (open or done) and what you finished, one
// small file per day in todo-days/. The done log only knows what you finished; this also
// keeps what was still open, so you can see (and export, and take elsewhere) how each day went.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../shared/types';
import type { DoneEntry } from './donelog';

export interface TodoDayRow {
  key: string;
  title: string;
  status: 'open' | 'done';
  due?: string;
  project?: string;
  priority?: number;
  /** Where it lives: "Apple Reminders", "Google Sheets: Grace"… */
  list?: string;
  firstSeen: number;
  lastSeen: number;
  doneAt?: number;
  /** How it got done: ticked in your list, in Lock In, or told to the coach. */
  source?: DoneEntry['source'];
}

export interface TodoDay {
  day: string;
  updatedAt: number;
  rows: TodoDayRow[];
}

/** Folds what's on your list right now, and what you've finished today, into the day's record. */
export function mergeDay(prev: TodoDay | null, day: string, now: number, open: Task[], done: DoneEntry[], list: string): TodoDay {
  const rows = new Map<string, TodoDayRow>((prev?.rows ?? []).map((r) => [r.key, { ...r }]));
  const doneKey = (e: DoneEntry) => (e.taskId ? `t:${e.taskId}` : `d:${e.id}`);
  const doneKeys = new Set(done.map(doneKey));
  for (const t of open) {
    const key = `t:${t.id}`;
    const r = rows.get(key) ?? { key, title: t.title, status: 'open' as const, firstSeen: now, lastSeen: now };
    Object.assign(r, { title: t.title, due: t.due, project: t.project, priority: t.priority, list, lastSeen: now });
    if (!doneKeys.has(key)) {
      r.status = 'open';
      delete r.doneAt;
      delete r.source;
    }
    rows.set(key, r);
  }
  for (const e of done) {
    const key = doneKey(e);
    const r = rows.get(key) ?? { key, title: e.title, status: 'done' as const, firstSeen: e.at, lastSeen: e.at };
    Object.assign(r, { title: e.title, status: 'done', doneAt: e.at, source: e.source, project: e.project ?? r.project, list: e.list ?? r.list ?? list, lastSeen: Math.max(r.lastSeen, e.at) });
    rows.set(key, r);
  }
  return { day, updatedAt: now, rows: [...rows.values()].sort((a, b) => a.firstSeen - b.firstSeen || a.title.localeCompare(b.title)) };
}

const NAME = /^\d{4}-\d{2}-\d{2}\.json$/;

export class TodoHistory {
  private last = new Map<string, string>();

  constructor(private dir: string) {}

  private folder(): string {
    return join(this.dir, 'todo-days');
  }

  read(day: string): TodoDay | null {
    try {
      return JSON.parse(readFileSync(join(this.folder(), `${day}.json`), 'utf8')) as TodoDay;
    } catch {
      return null;
    }
  }

  /** Updates today's file. Writes when something changed, and at most every 10 minutes otherwise. */
  record(now: number, day: string, open: Task[], done: DoneEntry[], list: string): boolean {
    const prev = this.read(day);
    const next = mergeDay(prev, day, now, open, done, list);
    const sig = JSON.stringify(next.rows.map((r) => [r.key, r.title, r.status, r.due, r.project, r.doneAt]));
    const was = this.last.get(day) ?? (prev ? JSON.stringify(prev.rows.map((r) => [r.key, r.title, r.status, r.due, r.project, r.doneAt])) : '');
    if (sig === was && prev && now - prev.updatedAt < 10 * 60_000) return false;
    if (!next.rows.length && !prev) return false;
    mkdirSync(this.folder(), { recursive: true });
    const file = join(this.folder(), `${day}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 1));
    renameSync(`${file}.tmp`, file);
    this.last.set(day, sig);
    return true;
  }

  /** Every day on record, oldest first. */
  all(): TodoDay[] {
    if (!existsSync(this.folder())) return [];
    return readdirSync(this.folder())
      .filter((f) => NAME.test(f))
      .sort()
      .map((f) => this.read(f.slice(0, 10)))
      .filter((d): d is TodoDay => !!d && Array.isArray(d.rows));
  }
}
