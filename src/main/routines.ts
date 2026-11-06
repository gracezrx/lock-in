// Routine scheduler. Pure logic, unit tested.
//  - Time routines fire once a day at their time, if you are at the computer within 90 minutes of it.
//  - Interval routines fire after N minutes of active screen time inside their daily window.
//  - Bedtime keeps nagging every 15 minutes (up to 4 times) while you stay on the computer.
//  - Snoozed routines fire again when the snooze ends.
import type { Routine } from '../shared/types';

export interface RoutineState {
  firedOn: Record<string, string>;
  accum: Record<string, number>;
  accumDay: string;
  snoozeUntil: Record<string, number>;
  followUps: Record<string, { count: number; nextAt: number }>;
}

export interface Fired {
  routine: Routine;
  /** 0 for the first time, 1+ for bedtime follow-ups. */
  followUp: number;
  snoozed: boolean;
}

const GRACE_MIN = 90;
const FOLLOW_UP_MIN = 15;
const MAX_FOLLOW_UPS = 4;

export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const dateKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function inWindow(cur: number, from: number, to: number): boolean {
  if (from === to) return true;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

export function emptyRoutineState(): RoutineState {
  return { firedOn: {}, accum: {}, accumDay: '', snoozeUntil: {}, followUps: {} };
}

export class RoutineScheduler {
  state: RoutineState;

  constructor(saved?: RoutineState | null) {
    this.state = { ...emptyRoutineState(), ...(saved ?? {}) };
  }

  snooze(id: string, minutes: number, now: number): void {
    this.state.snoozeUntil[id] = now + minutes * 60_000;
    delete this.state.followUps[id];
  }

  /**
   * A natural break (five minutes or more away): the screen-time count for these routines starts
   * over, so "stand up and stretch" never greets you as you sit back down (Stretchly does the same).
   */
  naturalBreak(ids: string[]): void {
    for (const id of ids) if (this.state.accum[id]) this.state.accum[id] = 0;
  }

  /** "I'm going to bed": stop follow-ups. */
  stopFollowUps(id: string): void {
    delete this.state.followUps[id];
    delete this.state.snoozeUntil[id];
  }

  /**
   * @param active  the user touched the keyboard or mouse in the last 2 minutes
   * @param allowedFor false while this routine would interrupt (a call, an open intervention, mute)
   */
  tick(routines: Routine[], now: Date, dtSec: number, active: boolean, allowedFor: (r: Routine) => boolean): Fired[] {
    const out: Fired[] = [];
    const t = now.getTime();
    const today = dateKey(now);
    const cur = now.getHours() * 60 + now.getMinutes();
    if (this.state.accumDay !== today) {
      this.state.accumDay = today;
      this.state.accum = {};
    }

    for (const r of routines) {
      if (!r.enabled) continue;
      const allowed = allowedFor(r);

      // Snoozed: fire again once the snooze ends.
      const snoozed = this.state.snoozeUntil[r.id];
      if (snoozed) {
        if (t >= snoozed && active && allowed) {
          delete this.state.snoozeUntil[r.id];
          out.push({ routine: r, followUp: 0, snoozed: true });
        }
        continue;
      }

      // Bedtime-style follow-ups.
      const fu = this.state.followUps[r.id];
      if (fu) {
        if (!active && t >= fu.nextAt) {
          delete this.state.followUps[r.id]; // they left: good night
        } else if (t >= fu.nextAt && allowed) {
          fu.count += 1;
          fu.nextAt = t + FOLLOW_UP_MIN * 60_000;
          out.push({ routine: r, followUp: fu.count, snoozed: false });
          if (fu.count >= MAX_FOLLOW_UPS) delete this.state.followUps[r.id];
        }
        continue;
      }

      const trig = r.trigger;
      if (!trig.days.includes(now.getDay())) continue;

      if (trig.type === 'time') {
        const at = minutesOf(trig.at);
        if (this.state.firedOn[r.id] === today) continue;
        if (cur < at || cur >= at + GRACE_MIN) continue;
        if (!active || !allowed) continue;
        this.state.firedOn[r.id] = today;
        if (r.kind === 'bedtime') this.state.followUps[r.id] = { count: 0, nextAt: t + FOLLOW_UP_MIN * 60_000 };
        out.push({ routine: r, followUp: 0, snoozed: false });
      } else {
        if (!active || !inWindow(cur, minutesOf(trig.from), minutesOf(trig.to))) continue;
        const acc = (this.state.accum[r.id] ?? 0) + dtSec;
        this.state.accum[r.id] = acc;
        if (acc >= trig.everyMin * 60 && allowed) {
          this.state.accum[r.id] = 0;
          out.push({ routine: r, followUp: 0, snoozed: false });
        }
      }
    }
    return out;
  }
}
