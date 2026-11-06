// Turns routines and to-do events into notifications: picks the words (Claude when
// available for the big moments, pre-written otherwise) and the buttons.
import type { ActionButton, NotifyKind, Persona, Profile, Routine, SessionRecord, Settings, Task } from '../../shared/types';
import type { NotifyPayload, Priority } from '../notify';
import type { WatchEvent } from '../todos/watchdog';
import { miscLine, roastLine, routineLine, spokenDuration, winLine, type LineCtx, type RoutineCtx } from './lines';
import { announceLine, type Claude } from './llm';

export interface AnnouncerDeps {
  notify: (p: NotifyPayload) => Promise<unknown>;
  claude: Claude;
  settings: () => Settings;
  profile: () => Profile;
  todos: () => { open: number; overdue: number; done: number; top?: Task } | null;
  /** Sessions finished in the last 7 days, for the weekly review. */
  weekSessions: () => SessionRecord[];
  log: (m: string) => void;
}

const WELLNESS = new Set<Routine['kind']>(['hydrate', 'stretch', 'eyes', 'lunch']);
const BIG = new Set<Routine['kind']>(['kickoff', 'midday', 'shutdown', 'weekly']);

function short(title: string, max = 38): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

function clock(now = new Date()): string {
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export class Announcer {
  constructor(private d: AnnouncerDeps) {}

  private persona(): Persona {
    return this.d.profile().persona;
  }

  /** Claude for the big moments when a key is set; otherwise (or on timeout) the pre-written line. */
  private async words(what: string, facts: string, fallback: string, useModel: boolean): Promise<string> {
    if (!useModel || !this.d.claude.available) return fallback;
    const st = this.d.settings();
    const line = await announceLine(this.d.claude, st, this.persona(), st.profanityOk, what, facts);
    return line && line.length > 8 ? line : fallback;
  }

  /** Resolves with the channels it went out on. */
  async routine(r: Routine, followUp: number, tag?: string): Promise<string[]> {
    const t = this.d.todos();
    const top = t?.top?.title;
    const week = r.kind === 'weekly' ? this.d.weekSessions() : [];
    const ctx: RoutineCtx = {
      active: '',
      done: t?.done ?? 0,
      open: t?.open ?? 0,
      overdue: t?.overdue ?? 0,
      top,
      time: clock(),
      minutes: r.minutes ?? 50,
      hours: Math.round((week.reduce((n, s) => n + s.focusSec, 0) / 3600) * 10) / 10,
      message: r.message,
      followUp,
    };
    const fallback = routineLine(r.kind, this.persona(), ctx);
    const facts = `Routine: ${r.name}. Time: ${ctx.time}. To-dos: ${ctx.open} open, ${ctx.done} done today, ${ctx.overdue} overdue${top ? `, top one "${top}"` : ''}.${r.kind === 'weekly' ? ` This week: ${ctx.hours} focused hours across ${week.length} sessions.` : ''}${r.message ? ` Their note: ${r.message}` : ''}`;
    const body = await this.words(`the "${r.name}" routine`, facts, fallback, BIG.has(r.kind) && followUp === 0);

    const kind: NotifyKind = r.kind === 'bedtime' ? 'bedtime' : WELLNESS.has(r.kind) ? 'wellness' : 'routine';
    const actions = this.routineActions(r, top);
    const p: NotifyPayload = {
      kind,
      title: followUp ? `${r.name} (again)` : r.name,
      body,
      actions,
      toastKind: kind === 'bedtime' ? 'bedtime' : kind === 'wellness' ? 'wellness' : 'routine',
      autoHideMs: r.kind === 'eyes' ? 25_000 : kind === 'wellness' ? 90_000 : undefined,
      priority: r.kind === 'bedtime' && followUp >= 2 ? 'high' : kind === 'wellness' ? 'low' : 'normal',
      tag,
    };
    if (r.kind === 'bedtime' && followUp >= 2) {
      p.extra = ['card', 'voice'];
      p.card = { cardName: 'Bedtime', tone: 'red', meta: ctx.time };
    }
    const sent = await this.d.notify(p);
    return Array.isArray(sent) ? (sent as string[]) : [];
  }

  private routineActions(r: Routine, top?: string): ActionButton[] {
    const lockTop = (min: number): ActionButton => ({ id: `start-top:${min}`, label: top ? `Lock in on “${short(top)}”` : `Lock in for ${min} minutes` });
    switch (r.kind) {
      case 'kickoff':
        return top ? [lockTop(50), { id: 'open:todos', label: 'See my list' }, { id: 'dismiss', label: 'Not now' }] : [{ id: 'open:home', label: 'Pick a goal' }, { id: 'dismiss', label: 'Not now' }];
      case 'deepwork':
        return [lockTop(r.minutes ?? 90), { id: `snooze:${r.id}:15`, label: 'In 15 minutes' }];
      case 'hydrate':
        // Logging the glass counts toward a water goal.
        return [{ id: 'water', label: '💧 Drank a glass' }, { id: `snooze:${r.id}:15`, label: 'In 15 minutes' }];
      case 'stretch':
      case 'lunch':
        return [{ id: 'dismiss', label: 'Done' }, { id: `snooze:${r.id}:15`, label: 'In 15 minutes' }];
      case 'eyes':
        return [];
      case 'midday':
        return [lockTop(50), { id: 'talk:midday', label: 'Tell me what you did' }, { id: 'open:todos', label: 'Open my list' }];
      case 'shutdown':
        return [{ id: 'talk:shutdown', label: 'Tell me what you did' }, { id: 'mute-until-morning', label: 'End my day' }, { id: `snooze:${r.id}:15`, label: '15 more minutes' }];
      case 'bedtime':
        return [{ id: `bed:${r.id}`, label: "I'm going to bed" }, { id: `snooze:${r.id}:10`, label: '10 more minutes' }];
      case 'weekly':
        return [{ id: 'open:today', label: 'See my week' }, { id: 'dismiss', label: 'Later' }];
      case 'custom':
        return r.offerSession
          ? [{ id: `start:${r.minutes ?? 50}:${r.name}`, label: `Lock in for ${r.minutes ?? 50} minutes` }, { id: `snooze:${r.id}:15`, label: 'In 15 minutes' }]
          : [{ id: 'dismiss', label: 'Got it' }, { id: `snooze:${r.id}:15`, label: 'In 15 minutes' }];
    }
  }

  async todoEvent(ev: WatchEvent): Promise<void> {
    const persona = this.persona();
    if (ev.type === 'win') {
      const body = winLine(persona, { active: '', done: ev.done, open: ev.open, overdue: 0, task: ev.task.title });
      await this.d.notify({ kind: 'todo_win', title: 'Task done', body, toastKind: 'win', autoHideMs: 8000, priority: 'low' });
      return;
    }
    const active = spokenDuration(ev.activeMin);
    const ctx = { active, done: ev.done, open: ev.open, overdue: ev.overdue, top: ev.top?.title };
    const fallback = roastLine(ev.severity, persona, ctx);
    const facts = `Active screen time today: ${active}. Minutes since they last finished a task: ${ev.sinceProgressMin}. To-dos: ${ev.open} open, ${ev.done} done today, ${ev.overdue} overdue${ev.top ? `, top one "${ev.top.title}"` : ''}. This is roast number ${ev.severity} of 3 since their last finished task: ${['a raised eyebrow', 'a proper roast', 'a full intervention'][ev.severity - 1]}.`;
    const body = await this.words('a to-do list roast because they have been on the computer a long time without finishing anything', facts, fallback, true);
    const titles = ['To-do check', 'To-do roast', 'To-do intervention'];
    const priorities: Priority[] = ['normal', 'high', 'critical'];
    const top = ev.top?.title;
    await this.d.notify({
      kind: 'todo_roast',
      title: titles[ev.severity - 1],
      body,
      shout: ev.severity === 3 && persona !== 'gentle',
      toastKind: 'roast',
      priority: priorities[ev.severity - 1],
      actions: [
        { id: 'start-top:50', label: top ? `Lock in on “${short(top)}”` : 'Lock in for 50 minutes' },
        { id: 'talk:roast', label: 'Talk back' },
        { id: 'snooze-roasts:30', label: 'Leave me alone for 30' },
      ],
      extra: ev.severity === 3 ? ['card', 'phone'] : ev.severity === 2 ? ['voice'] : [],
      card: { cardName: 'To-do intervention', tone: 'yellow', meta: `${active} on screen today, ${ev.done} done` },
    });
  }

  /** Pomodoro break and other session moments that go through the routing table. */
  async sessionNote(title: string, line: string, actions?: ActionButton[]): Promise<void> {
    await this.d.notify({ kind: 'session', title, body: line, actions, autoHideMs: 15_000 });
  }

  pomodoroLine(c: LineCtx): string {
    return miscLine('pomodoroBreak', this.persona(), c);
  }
}
