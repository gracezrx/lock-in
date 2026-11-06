// Connects the chosen to-do provider, refreshes it every two minutes, and feeds the watchdog.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { SheetPreview, Settings, SheetSettings, Task, TodoProviderId, TodoSummary } from '../../shared/types';
import { TODO_PROVIDERS } from '../../shared/templates';
import type { Store } from '../store';
import { dayKey } from './day';
import { DoneLog, type DoneEntry } from './donelog';
import { bestMatch, splitDone } from './match';
import { BuiltinProvider, RemindersProvider, ThingsProvider, TodoistProvider, rankTasks, type TodoProvider } from './providers';
import { SheetProvider, appsScript, type TrackState } from './sheet';
import { TodoWatchdog, type WatchEvent, type WatchState } from './watchdog';

const REFRESH_MS = 120_000;

export class TodoManager {
  readonly builtin: BuiltinProvider;
  watchdog: TodoWatchdog;
  error?: string;
  private provider: TodoProvider | null = null;
  private providerKey = '';
  private lastFetch = 0;
  private fetching = false;
  private inflight: Promise<void> | null = null;
  private lastSave = 0;
  /** Your full name and Mac account name, used to find your tab and your rows in shared sheets. */
  private me: string[] = [];
  /** Everything finished, for good (Done today, the daily export). */
  readonly doneLog: DoneLog;

  constructor(
    private store: Store,
    private settings: () => Settings,
    private onEvents: (events: WatchEvent[]) => void,
    private log: (m: string) => void,
  ) {
    this.builtin = new BuiltinProvider(
      () => store.readJson('todos.json', []),
      (t) => store.writeJson('todos.json', t),
    );
    this.doneLog = new DoneLog({ append: (e) => store.append('done-log.ndjson', e), read: () => store.readLog<DoneEntry>('done-log.ndjson', 40_000_000) });
    const saved = store.readJson<WatchState | null>('activity.json', null);
    this.watchdog = new TodoWatchdog(saved, Date.now(), settings().todo, (open) => rankTasks(open)[0]);
    try {
      this.me = [userInfo().username];
    } catch {
      /* no account name */
    }
    if (process.platform === 'darwin') {
      execFile('id', ['-F'], { timeout: 3000 }, (err, out) => {
        const full = String(out ?? '').trim();
        if (!err && full) this.me = [full, ...this.me];
      });
    }
  }

  private current(): TodoProvider | null {
    const t = this.settings().todo;
    const key = `${t.provider}|${t.remindersList}|${t.remindersScope}|${t.thingsList}|${t.todoistFilter}|${JSON.stringify(t.sheet)}`;
    if (key !== this.providerKey) {
      this.providerKey = key;
      this.error = undefined;
      this.lastFetch = 0;
      const cfg = () => this.settings().todo;
      const p: Record<TodoProviderId, TodoProvider | null> = {
        none: null,
        builtin: this.builtin,
        reminders: new RemindersProvider(cfg),
        things: new ThingsProvider(cfg),
        todoist: new TodoistProvider(cfg, () => this.store.getKey('todoist')),
        sheet: this.sheetProvider(() => this.settings().todo.sheet),
      };
      this.provider = p[t.provider];
    }
    return this.provider;
  }

  /** A spreadsheet provider; finished-row tracking is kept per sheet so switching sheets starts fresh. */
  sheetProvider(cfg: () => SheetSettings): SheetProvider {
    const source = () => {
      const c = cfg();
      return c.kind === 'google' ? c.url.trim() : `${c.path}|${c.tab}`;
    };
    return new SheetProvider({
      cfg,
      loadState: () => {
        const saved = this.store.readJson<{ source: string; state: TrackState } | null>('sheet-state.json', null);
        return saved && saved.source === source() ? saved.state : null;
      },
      saveState: (state) => this.store.writeJson('sheet-state.json', { source: source(), state }),
      me: () => this.me,
    });
  }

  /** Setup screen: read a sheet with the given (unsaved) settings and report what was found. */
  async previewSheet(c: SheetSettings): Promise<SheetPreview> {
    return new SheetProvider({ cfg: () => c, loadState: () => null, saveState: () => undefined, me: () => this.me }).preview();
  }

  /** The private Google connector script, with this install's secret (made on first use). */
  connectorScript(save: (token: string) => void): string {
    let token = this.settings().todo.sheet.token;
    if (!token) {
      token = randomUUID().replace(/-/g, '');
      save(token);
    }
    return appsScript(token);
  }

  /** Open tasks, most urgent first. */
  openRanked(): Task[] {
    return rankTasks(this.watchdog.openTasks);
  }

  async refresh(force = false): Promise<void> {
    const p = this.current();
    if (!p) return;
    if (this.inflight) {
      // A forced refresh (after a tick) waits for the read in progress, then reads again.
      if (!force) return;
      await this.inflight.catch(() => undefined);
    }
    if (!force && Date.now() - this.lastFetch < REFRESH_MS) return;
    this.inflight = this.doRefresh(p, force);
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async doRefresh(p: TodoProvider, force: boolean): Promise<void> {
    this.fetching = true;
    try {
      const raw = await p.fetch(Date.now(), force);
      // Rows you marked "not a task" stay out everywhere.
      const hidden = new Set(this.settings().todo.hidden ?? []);
      const keep = (t: Task) => !hidden.has(hideKey(t.title));
      const snap = hidden.size ? { ...raw, open: raw.open.filter(keep), doneToday: raw.doneToday.filter(keep) } : raw;
      this.recordDone(snap.open, snap.doneToday);
      this.error = undefined;
      this.lastFetch = Date.now();
      const events = this.watchdog.onSnapshot(snap, Date.now(), this.settings().todo);
      this.persist(true);
      if (events.length) this.onEvents(events);
    } catch (e) {
      this.error = (e as Error).message;
      this.lastFetch = Date.now();
      this.log(`[todos] ${this.error}`);
    } finally {
      this.fetching = false;
    }
  }

  tick(idleSec: number, dtSec: number, allowed: boolean): void {
    if (!this.current()) return;
    const events = this.watchdog.tick(idleSec, dtSec, Date.now(), this.settings().todo, allowed);
    if (events.length) this.onEvents(events);
    void this.refresh();
    this.persist();
  }

  async complete(id: string): Promise<boolean> {
    const p = this.current();
    if (!p) return false;
    if (p.canComplete === false) throw new Error('This list is read-only from Lock In. Tick it off in the list itself.');
    const ok = await p.complete(id);
    if (ok) await this.refresh(true);
    return ok;
  }

  /** Un-tick a task that was ticked in Lock In only (or take back something you told the coach). */
  async undo(id: string): Promise<boolean> {
    if (id.startsWith('said:')) return this.doneLog.remove(id.slice(5));
    const p = this.current();
    if (!p?.undo) return false;
    const ok = await p.undo(id);
    if (ok) await this.refresh(true);
    return ok;
  }

  /** Finished today, newest first: ticks in your list or in Lock In, plus things you told the coach. */
  doneToday(): Task[] {
    const said = this.extrasToday().map((e): Task => ({ id: `said:${e.id}`, title: e.title, completed: true, completedAt: e.at, said: true }));
    return [...this.watchdog.doneTasks, ...said].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }

  private extrasToday(): DoneEntry[] {
    return this.doneLog.onDay(dayKey(Date.now())).filter((e) => e.source === 'said' || e.source === 'typed');
  }

  /** Something got finished outside the list (a deadline): resets the roast clock. */
  noteProgress(): void {
    this.watchdog.progress(this.settings().todo);
    this.persist(true);
  }

  /** Your first name, from your Mac account ('' if unknown). */
  get firstName(): string {
    const full = this.me.find((m) => /\s/.test(m.trim()));
    return full ? full.trim().split(/\s+/)[0] : '';
  }

  /** Where tasks come from, for the export: "Google Sheets: Grace", "Apple Reminders"… */
  listName(): string {
    const t = this.settings().todo;
    const label = TODO_PROVIDERS.find((p) => p.id === t.provider)?.label ?? t.provider;
    if (t.provider === 'sheet') {
      const tab = this.sheetTab() || t.sheet.tab.trim();
      return `${t.sheet.kind === 'google' ? 'Google Sheets' : 'Spreadsheet'}${tab ? `: ${tab}` : ''}`;
    }
    return label;
  }

  private sheetTab(): string {
    return this.provider instanceof SheetProvider ? this.provider.tabName : '';
  }

  /** Writes newly finished list tasks into the done log, and drops ones that were un-ticked. */
  private recordDone(open: Task[], done: Task[]): void {
    const day = dayKey(Date.now());
    const list = this.listName();
    for (const d of done) {
      if (this.doneLog.hasTask(day, d.id)) continue;
      this.doneLog.add({ at: d.completedAt ?? Date.now(), title: d.title, source: d.localOnly ? 'lockin' : 'list', taskId: d.id, project: d.project, list });
    }
    for (const o of open) if (this.doneLog.hasTask(day, o.id)) this.doneLog.removeTask(day, o.id);
  }

  /**
   * Things you said you did ("I sent the deck and called the bank"): ones that match an open
   * task tick it off; the rest go on today's done list as extras. Either way the roast clock resets.
   */
  async logDone(input: string | string[], via: 'said' | 'typed'): Promise<{ ticked: string[]; added: string[]; already: string[] }> {
    const items = (Array.isArray(input) ? input : splitDone(input)).map((x) => String(x).trim()).filter((x) => x.length >= 2).slice(0, 12);
    const ticked: string[] = [];
    const added: string[] = [];
    const already: string[] = [];
    const taken = new Set<string>();
    const open = this.watchdog.openTasks;
    const doneNow = this.doneToday();
    const canTick = this.current()?.canComplete !== false;
    for (const raw of items) {
      const item = raw[0].toUpperCase() + raw.slice(1);
      // Already ticked off today: nothing to add twice.
      const was = bestMatch(item, doneNow);
      if (was && !bestMatch(item, open, taken)) {
        already.push(was.title);
        continue;
      }
      const m = canTick ? bestMatch(item, open, taken) : null;
      if (m) {
        taken.add(m.id);
        const ok = await this.complete(m.id).catch((e: Error) => {
          this.log(`[todos] tick failed: ${e.message}`);
          return false;
        });
        if (ok) {
          ticked.push(m.title);
          continue;
        }
      }
      const dupe = this.extrasToday().some((e) => e.title.toLowerCase() === item.toLowerCase());
      if (!dupe) this.doneLog.add({ at: Date.now(), title: item, source: via, list: 'Told Lock In' });
      added.push(item);
    }
    if (ticked.length || added.length) {
      this.watchdog.progress(this.settings().todo);
      this.persist(true);
    }
    return { ticked, added, already };
  }

  /** The title to remember when you mark an open task "not a task". */
  hideKeyFor(id: string): string | null {
    const t = this.watchdog.openTasks.find((x) => x.id === id);
    return t ? hideKey(t.title) : null;
  }

  async add(title: string): Promise<boolean> {
    const p = this.current();
    if (!p || !title.trim()) return false;
    const ok = await p.add(title);
    if (ok) await this.refresh(true);
    return ok;
  }

  async removeBuiltin(id: string): Promise<void> {
    await this.builtin.remove(id);
    await this.refresh(true);
  }

  snooze(minutes: number): void {
    this.watchdog.snooze(minutes, Date.now());
  }

  top(): Task | undefined {
    return rankTasks(this.watchdog.openTasks)[0];
  }

  summary(): TodoSummary {
    const t = this.settings().todo;
    const wd = this.watchdog;
    const left = wd.secondsToRoast(t);
    return {
      provider: t.provider,
      connected: t.provider !== 'none' && !this.error && this.lastFetch > 0,
      error: this.error,
      open: wd.openTasks.length,
      overdue: wd.overdueCount(Date.now()),
      doneToday: wd.doneCount + this.extrasToday().length,
      top: this.top()?.title,
      activeMinToday: Math.round(wd.state.activeSec / 60),
      minSinceProgress: Math.round(wd.state.sinceProgressSec / 60),
      nextRoastInMin: left === undefined ? undefined : Math.ceil(left / 60),
      canComplete: this.provider?.canComplete ?? true,
      canAdd: this.provider?.canAdd ?? true,
      tickNote:
        this.provider?.writesBack === false
          ? t.sheet.kind === 'google'
            ? 'Ticks here are saved in Lock In. Your Google Sheet stays as it is unless you set up the private connector below.'
            : 'Ticks here are saved in Lock In. Your file stays as it is, so tick it there too when you next open it.'
          : undefined,
      hidden: (t.hidden ?? []).length,
    };
  }

  private persist(force = false): void {
    if (!force && Date.now() - this.lastSave < 60_000) return;
    this.lastSave = Date.now();
    this.store.writeJson('activity.json', this.watchdog.state);
  }
}

export const hideKey = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim();
