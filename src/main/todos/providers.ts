// To-do list connections. Each returns today's open tasks and what was finished today.
//  - builtin:   a JSON list kept by Lock In
//  - reminders: Apple Reminders through JavaScript for Automation (asks permission once)
//  - things:    Things 3 through JavaScript for Automation (asks permission once)
//  - todoist:   Todoist API v1 with your personal token
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Task, TodoProviderId, TodoSettings } from '../../shared/types';
import { dayStart, endOfToday, localDate } from './day';

export interface TodoSnapshot {
  open: Task[];
  doneToday: Task[];
  fetchedAt: number;
}

export interface TodoProvider {
  id: TodoProviderId;
  fetch(now?: number, force?: boolean): Promise<TodoSnapshot>;
  complete(id: string): Promise<boolean>;
  add(title: string): Promise<boolean>;
  /** Defaults to true when missing. */
  readonly canComplete?: boolean;
  readonly canAdd?: boolean;
  /** False when ticks are only remembered by Lock In, not written to the source. */
  readonly writesBack?: boolean;
  /** Un-tick something ticked in Lock In only. */
  undo?(id: string): Promise<boolean>;
}

/** Higher = more urgent, 0-3, across providers. */
export function rankTasks(tasks: Task[], now = Date.now()): Task[] {
  const today = localDate(now);
  return [...tasks].sort((a, b) => {
    const ao = a.due && a.due < today ? 1 : 0;
    const bo = b.due && b.due < today ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const ap = a.priority ?? 0;
    const bp = b.priority ?? 0;
    if (ap !== bp) return bp - ap;
    if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Built-in list

interface StoredTask extends Task {
  createdAt: number;
}

export class BuiltinProvider implements TodoProvider {
  id = 'builtin' as const;
  constructor(private load: () => StoredTask[], private save: (t: StoredTask[]) => void) {}

  async fetch(now = Date.now()): Promise<TodoSnapshot> {
    const all = this.load();
    const start = dayStart(now);
    return {
      open: all.filter((t) => !t.completed),
      doneToday: all.filter((t) => t.completed && (t.completedAt ?? 0) >= start),
      fetchedAt: now,
    };
  }

  async complete(id: string): Promise<boolean> {
    const all = this.load();
    const t = all.find((x) => x.id === id);
    if (!t) return false;
    t.completed = true;
    t.completedAt = Date.now();
    // Keep the list from growing forever: drop items finished more than a week ago.
    const weekAgo = Date.now() - 7 * 86_400_000;
    this.save(all.filter((x) => !x.completed || (x.completedAt ?? 0) > weekAgo));
    return true;
  }

  async add(title: string): Promise<boolean> {
    const all = this.load();
    all.push({ id: randomUUID(), title: title.trim(), completed: false, createdAt: Date.now() });
    this.save(all);
    return true;
  }

  async remove(id: string): Promise<void> {
    this.save(this.load().filter((t) => t.id !== id));
  }
}

// ---------------------------------------------------------------------------
// AppleScript (JXA) helpers

function jxa(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new Error('Only available on macOS'));
      return;
    }
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        if (/-1743|not authori[sz]ed|Not authorized/i.test(msg)) reject(new Error('macOS blocked access. Allow Lock In (or Electron) under System Settings, Privacy and Security, Automation.'));
        else if (/-1728|Can't get|Can’t get/i.test(msg)) reject(new Error('List not found. Check the list name.'));
        else if (/-600|isn't running|not running|Application can't be found/i.test(msg)) reject(new Error('The app is not installed or could not be opened.'));
        else reject(new Error(msg.trim().slice(0, 200) || 'Script failed'));
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

const lit = (v: unknown) => JSON.stringify(v);

interface RawItem {
  id: string;
  title: string;
  due?: string | null;
  priority?: number | null;
  project?: string | null;
  completedAt?: number | null;
}

function toTask(r: RawItem, completed: boolean): Task {
  return {
    id: String(r.id),
    title: String(r.title ?? '').trim() || 'Untitled',
    due: r.due ? localDate(Date.parse(r.due)) : undefined,
    priority: r.priority ?? undefined,
    project: r.project ?? undefined,
    completed,
    completedAt: r.completedAt ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Apple Reminders

/** Reminders priority: 1-4 high, 5 medium, 6-9 low, 0 none. */
export function remindersPriority(p: number | null | undefined): number {
  if (!p) return 0;
  if (p <= 4) return 3;
  if (p === 5) return 2;
  return 1;
}

export class RemindersProvider implements TodoProvider {
  id = 'reminders' as const;
  constructor(private cfg: () => TodoSettings) {}

  async fetch(now = Date.now()): Promise<TodoSnapshot> {
    const c = this.cfg();
    const script = `
      const app = Application('Reminders');
      const LIST = ${lit(c.remindersList.trim())};
      const SCOPE = ${lit(c.remindersScope)};
      const SINCE = new Date(${lit(new Date(dayStart(now)).toISOString())});
      const END = new Date(${lit(new Date(endOfToday(now)).toISOString())});
      const lists = LIST ? [app.lists.byName(LIST)] : app.lists();
      const open = [], done = [];
      for (const l of lists) {
        const lname = l.name();
        const o = l.reminders.whose({ completed: false });
        const ids = o.id(), names = o.name(), dues = o.dueDate(), prios = o.priority();
        for (let i = 0; i < ids.length; i++) {
          const due = dues[i];
          if (SCOPE === 'today' && !(due && due <= END)) continue;
          open.push({ id: ids[i], title: names[i], due: due ? due.toISOString() : null, priority: prios[i], project: lname });
        }
        const d = l.reminders.whose({ completed: true, completionDate: { _greaterThan: SINCE } });
        const dids = d.id(), dnames = d.name(), dwhen = d.completionDate();
        for (let i = 0; i < dids.length; i++) done.push({ id: dids[i], title: dnames[i], completedAt: dwhen[i] ? dwhen[i].getTime() : null });
      }
      JSON.stringify({ open, done });`;
    const out = JSON.parse(await jxa(script)) as { open: RawItem[]; done: RawItem[] };
    return {
      open: out.open.map((r) => ({ ...toTask(r, false), priority: remindersPriority(r.priority) })),
      doneToday: out.done.map((r) => toTask(r, true)),
      fetchedAt: now,
    };
  }

  async complete(id: string): Promise<boolean> {
    await jxa(`Application('Reminders').reminders.byId(${lit(id)}).completed = true; 'ok'`);
    return true;
  }

  async add(title: string): Promise<boolean> {
    const c = this.cfg();
    await jxa(`
      const app = Application('Reminders');
      const LIST = ${lit(c.remindersList.trim())};
      const list = LIST ? app.lists.byName(LIST) : app.defaultList();
      const props = { name: ${lit(title.trim())} };
      if (${lit(c.remindersScope)} === 'today') {
        const d = new Date(); d.setHours(17, 0, 0, 0); props.dueDate = d;
      }
      list.reminders.push(app.Reminder(props));
      'ok'`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Things 3

export class ThingsProvider implements TodoProvider {
  id = 'things' as const;
  constructor(private cfg: () => TodoSettings) {}

  async fetch(now = Date.now()): Promise<TodoSnapshot> {
    const c = this.cfg();
    const script = `
      const app = Application('Things3');
      const LIST = ${lit(c.thingsList.trim() || 'Today')};
      const SINCE = new Date(${lit(new Date(dayStart(now)).toISOString())});
      const items = app.lists.byName(LIST).toDos;
      const ids = items.id(), names = items.name(), statuses = items.status(), dues = items.dueDate();
      const open = [];
      for (let i = 0; i < ids.length; i++) {
        if (statuses[i] !== 'open') continue;
        open.push({ id: ids[i], title: names[i], due: dues[i] ? dues[i].toISOString() : null });
      }
      const done = [];
      const logged = app.lists.byName('Logbook').toDos.whose({ completionDate: { _greaterThan: SINCE } });
      const lids = logged.id(), lnames = logged.name(), lwhen = logged.completionDate(), lstatus = logged.status();
      for (let i = 0; i < lids.length; i++) if (lstatus[i] === 'completed') done.push({ id: lids[i], title: lnames[i], completedAt: lwhen[i] ? lwhen[i].getTime() : null });
      JSON.stringify({ open, done });`;
    const out = JSON.parse(await jxa(script)) as { open: RawItem[]; done: RawItem[] };
    return { open: out.open.map((r) => toTask(r, false)), doneToday: out.done.map((r) => toTask(r, true)), fetchedAt: now };
  }

  async complete(id: string): Promise<boolean> {
    await jxa(`Application('Things3').toDos.byId(${lit(id)}).status = 'completed'; 'ok'`);
    return true;
  }

  async add(title: string): Promise<boolean> {
    // The URL scheme is the documented way to add straight to Today.
    const url = `things:///add?title=${encodeURIComponent(title.trim())}&when=today`;
    await new Promise<void>((resolve, reject) => execFile('open', ['-g', url], (err) => (err ? reject(err) : resolve())));
    return true;
  }
}

// ---------------------------------------------------------------------------
// Todoist (API v1)

const TODOIST = 'https://api.todoist.com/api/v1';

interface TodoistTask {
  id: string;
  content: string;
  priority?: number;
  project_id?: string;
  checked?: boolean;
  due?: { date?: string; is_recurring?: boolean } | null;
}

export function todoistToTask(t: TodoistTask): Task {
  return {
    id: String(t.id),
    title: t.content,
    due: t.due?.date ? t.due.date.slice(0, 10) : undefined,
    // Todoist: 4 = urgent (shown as p1) … 1 = normal.
    priority: Math.max(0, Math.min(3, (t.priority ?? 1) - 1)),
    project: t.project_id,
    completed: !!t.checked,
  };
}

export class TodoistProvider implements TodoProvider {
  id = 'todoist' as const;
  private known = new Map<string, TodoistTask>();
  private done = new Map<string, Task>();
  private doneDay = 0;

  constructor(private cfg: () => TodoSettings, private token: () => string | undefined, private http: typeof fetch = fetch) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.token();
    if (!token) throw new Error('Add your Todoist API token first.');
    const res = await this.http(`${TODOIST}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) throw new Error('Todoist rejected the token. Paste it again.');
    return res;
  }

  async fetch(now = Date.now()): Promise<TodoSnapshot> {
    if (this.doneDay !== dayStart(now)) {
      this.doneDay = dayStart(now);
      this.done.clear();
    }
    const query = encodeURIComponent(this.cfg().todoistFilter.trim() || 'today | overdue');
    const items: TodoistTask[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await this.call(`/tasks/filter?query=${query}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!res.ok) throw new Error(`Todoist error ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const json = (await res.json()) as { results?: TodoistTask[]; next_cursor?: string | null };
      items.push(...(json.results ?? []));
      cursor = json.next_cursor ?? null;
      if (!cursor) break;
    }
    // Tasks that dropped out of the filter: finished, rescheduled or deleted? Ask.
    const nowIds = new Set(items.map((t) => String(t.id)));
    for (const [id, prev] of this.known) {
      if (nowIds.has(id) || this.done.has(id)) continue;
      try {
        const res = await this.call(`/tasks/${encodeURIComponent(id)}`);
        if (res.ok) {
          const t = (await res.json()) as TodoistTask;
          const recurringMoved = !!prev.due?.is_recurring && !!t.due?.date && !!prev.due?.date && t.due.date > prev.due.date;
          if (t.checked || recurringMoved) this.done.set(id, { ...todoistToTask(prev), completed: true, completedAt: now });
        }
      } catch {
        /* network hiccup: try again next time */
      }
    }
    this.known = new Map(items.map((t) => [String(t.id), t]));
    return { open: items.filter((t) => !t.checked).map(todoistToTask), doneToday: [...this.done.values()], fetchedAt: now };
  }

  async complete(id: string): Promise<boolean> {
    const res = await this.call(`/tasks/${encodeURIComponent(id)}/close`, { method: 'POST' });
    if (!res.ok) return false;
    const prev = this.known.get(id);
    if (prev) this.done.set(id, { ...todoistToTask(prev), completed: true, completedAt: Date.now() });
    return true;
  }

  async add(title: string): Promise<boolean> {
    const res = await this.call('/tasks', { method: 'POST', body: JSON.stringify({ content: title.trim(), due_string: 'today' }) });
    return res.ok;
  }
}
