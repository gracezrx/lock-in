// Watches active screen time against to-do progress. Pure logic, unit tested.
//  - Active time = seconds with input in the last minute, all day (not only in sessions).
//  - After `noProgressMin` active minutes with open tasks and nothing finished: roast.
//  - Each further roast comes sooner (x0.5, then x0.33) and hotter (severity 1 → 3).
//  - Finishing any task resets everything and can trigger a celebration.
import type { Task, TodoSettings } from '../../shared/types';
import { dayKey } from './day';
import type { TodoSnapshot } from './providers';

export interface WatchState {
  day: string;
  activeSec: number;
  sinceProgressSec: number;
  nextRoastAtSec: number;
  roastsToday: number;
  roastsSinceProgress: number;
  doneIds: string[];
  snoozeUntil: number;
}

export type WatchEvent =
  | { type: 'roast'; severity: 1 | 2 | 3; activeMin: number; sinceProgressMin: number; open: number; overdue: number; done: number; top?: Task }
  | { type: 'win'; task: Task; done: number; open: number };

const FACTORS = [1, 0.5, 0.33];

export function freshState(now: number, cfg: Pick<TodoSettings, 'noProgressMin'>): WatchState {
  return {
    day: dayKey(now),
    activeSec: 0,
    sinceProgressSec: 0,
    nextRoastAtSec: cfg.noProgressMin * 60,
    roastsToday: 0,
    roastsSinceProgress: 0,
    doneIds: [],
    snoozeUntil: 0,
  };
}

export class TodoWatchdog {
  state: WatchState;
  private primed: boolean;
  private snapshot: TodoSnapshot | null = null;
  private topOf: (open: Task[]) => Task | undefined;

  constructor(saved: WatchState | null, now: number, cfg: TodoSettings, topOf: (open: Task[]) => Task | undefined) {
    this.state = saved && saved.day === dayKey(now) ? saved : freshState(now, cfg);
    // With a saved list of today's finished tasks we can tell new ones apart; otherwise learn silently first.
    this.primed = !!saved && saved.day === dayKey(now);
    this.topOf = topOf;
  }

  private roll(now: number, cfg: TodoSettings): void {
    if (this.state.day !== dayKey(now)) {
      this.state = freshState(now, cfg);
      this.primed = false;
    }
  }

  overdueCount(now: number): number {
    if (!this.snapshot) return 0;
    const d = new Date(now);
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return this.snapshot.open.filter((t) => t.due && t.due < today).length;
  }

  /** Finished today, as the list reports it now (rows that stopped being tasks drop out). */
  get doneCount(): number {
    return this.snapshot ? this.snapshot.doneToday.length : this.state.doneIds.length;
  }

  get openTasks(): Task[] {
    return this.snapshot?.open ?? [];
  }

  /** Finished today, newest first. */
  get doneTasks(): Task[] {
    return [...(this.snapshot?.doneToday ?? [])].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  /** Called after every fetch. Returns at most one celebration. */
  onSnapshot(snap: TodoSnapshot, now: number, cfg: TodoSettings): WatchEvent[] {
    this.roll(now, cfg);
    this.snapshot = snap;
    const known = new Set(this.state.doneIds);
    const fresh = snap.doneToday.filter((t) => !known.has(t.id));
    for (const t of fresh) this.state.doneIds.push(t.id);
    if (!this.primed) {
      this.primed = true;
      return [];
    }
    if (!fresh.length) return [];
    this.progress(cfg);
    if (!cfg.celebrate) return [];
    const latest = fresh.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
    return [{ type: 'win', task: latest, done: this.doneCount, open: snap.open.length }];
  }

  /** You finished something (also called when a task is ticked inside Lock In). */
  progress(cfg: Pick<TodoSettings, 'noProgressMin'>): void {
    this.state.sinceProgressSec = 0;
    this.state.roastsSinceProgress = 0;
    this.state.nextRoastAtSec = cfg.noProgressMin * 60;
  }

  snooze(minutes: number, now: number): void {
    this.state.snoozeUntil = now + minutes * 60_000;
  }

  /** Seconds of active time until the next roast, or undefined when none is coming. */
  secondsToRoast(cfg: TodoSettings): number | undefined {
    if (!cfg.roastsEnabled || !this.openTasks.length || this.state.roastsToday >= cfg.maxRoastsPerDay) return undefined;
    const at = this.state.roastsSinceProgress === 0 ? cfg.noProgressMin * 60 : this.state.nextRoastAtSec;
    return Math.max(0, at - this.state.sinceProgressSec);
  }

  /**
   * Called every second. `idleSec` is time since the last keyboard or mouse input.
   * `allowed` is false while a roast would be rude (in a call, coach muted, focused in a session).
   */
  tick(idleSec: number, dtSec: number, now: number, cfg: TodoSettings, allowed: boolean): WatchEvent[] {
    this.roll(now, cfg);
    if (idleSec >= 60) return [];
    this.state.activeSec += dtSec;
    this.state.sinceProgressSec += dtSec;
    if (!allowed || now < this.state.snoozeUntil) return [];
    const left = this.secondsToRoast(cfg);
    if (left === undefined || left > 0) return [];

    const severity = Math.min(3, this.state.roastsSinceProgress + 1) as 1 | 2 | 3;
    this.state.roastsToday += 1;
    this.state.roastsSinceProgress += 1;
    const factor = FACTORS[Math.min(this.state.roastsSinceProgress, FACTORS.length - 1)];
    this.state.nextRoastAtSec = this.state.sinceProgressSec + Math.max(10, cfg.noProgressMin * factor) * 60;
    return [
      {
        type: 'roast',
        severity,
        activeMin: Math.round(this.state.activeSec / 60),
        sinceProgressMin: Math.round(this.state.sinceProgressSec / 60),
        open: this.openTasks.length,
        overdue: this.overdueCount(now),
        done: this.doneCount,
        top: this.topOf(this.openTasks),
      },
    ];
  }
}
