// Everything you finished, kept for good: ticks seen in your list, ticks made in Lock In,
// and things you told the coach you did. Feeds "Done today" and the daily CSV export.
import { randomUUID } from 'node:crypto';
import { dayKey } from './day';

export type DoneSource = 'list' | 'lockin' | 'said' | 'typed';

export interface DoneEntry {
  id: string;
  at: number;
  /** The Lock In day (starts at 4 am), YYYY-MM-DD. */
  day: string;
  title: string;
  source: DoneSource;
  /** The task on your list, when it was one. */
  taskId?: string;
  project?: string;
  /** Where the task lives: "Google Sheets: Grace", "Apple Reminders"… */
  list?: string;
  removed?: boolean;
}

export interface DoneLogStore {
  append: (e: DoneEntry) => void;
  read: () => DoneEntry[];
}

export class DoneLog {
  private cache: Map<string, DoneEntry> | null = null;

  constructor(private s: DoneLogStore) {}

  private map(): Map<string, DoneEntry> {
    if (!this.cache) {
      this.cache = new Map();
      for (const e of this.s.read()) {
        if (e.removed) this.cache.delete(e.id);
        else this.cache.set(e.id, e);
      }
    }
    return this.cache;
  }

  all(): DoneEntry[] {
    return [...this.map().values()].sort((a, b) => a.at - b.at);
  }

  onDay(day: string): DoneEntry[] {
    return this.all().filter((e) => e.day === day);
  }

  add(e: Omit<DoneEntry, 'id' | 'day'> & { day?: string }): DoneEntry {
    const entry: DoneEntry = { ...e, id: randomUUID(), day: e.day ?? dayKey(e.at), title: e.title.trim().slice(0, 300) };
    this.s.append(entry);
    this.map().set(entry.id, entry);
    return entry;
  }

  remove(id: string): boolean {
    const e = this.map().get(id);
    if (!e) return false;
    this.s.append({ ...e, removed: true });
    this.map().delete(id);
    return true;
  }

  /** Was this list task already recorded as done on this day? */
  hasTask(day: string, taskId: string): boolean {
    for (const e of this.map().values()) if (e.day === day && e.taskId === taskId) return true;
    return false;
  }

  removeTask(day: string, taskId: string): void {
    for (const e of [...this.map().values()]) if (e.day === day && e.taskId === taskId) this.remove(e.id);
  }
}
