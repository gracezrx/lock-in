// A spreadsheet as the to-do list: Google Sheets, Excel, Numbers or CSV.
//  - Finds the task, done, due and priority columns from the headers and values.
//  - A row counts as finished today when it was open on an earlier read and is now
//    ticked (or, for lists without a done column, deleted).
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { SheetPreview, SheetSettings, Task } from '../../shared/types';
import { dayKey, localDate } from './day';
import type { TodoProvider, TodoSnapshot } from './providers';

export type Cell = string | number | boolean | null;
export type Table = Cell[][];

export interface ColumnMap {
  header: number;
  task: number | null;
  done: number | null;
  due: number | null;
  priority: number | null;
  assignee: number | null;
  project: number | null;
}

// ---------------------------------------------------------------------------
// Values

const s = (v: Cell): string => (v === null || v === undefined ? '' : String(v)).trim();

export function colName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BOOL_LIKE = /^(true|false|yes|no|y|n|x|✓|✔|☑|☐|✅|❌|0|1)$/i;

export function isDone(v: Cell): boolean {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'number') return v === 1;
  const t = String(v).trim().toLowerCase();
  if (!t) return false;
  if (/\b(not done|undone|incomplete|not started|to ?do|in progress|pending|open|blocked|waiting)\b/.test(t)) return false;
  if (/^(true|yes|y|x|1|✓|✔|☑|✅)$/.test(t)) return true;
  return /\b(done|complete|completed|finished|shipped|closed|sent|submitted)\b|✅|✔|✓/.test(t);
}

export function parsePriority(v: Cell): number {
  if (typeof v === 'number') return v === 1 ? 3 : v === 2 ? 2 : v === 3 ? 1 : 0;
  const t = s(v).toLowerCase();
  if (!t) return 0;
  if (/^p?1$|urgent|high|critical|!!!|asap|top|🔥/.test(t)) return 3;
  if (/^p?2$|med|normal|!!/.test(t)) return 2;
  if (/^p?3$|low|later|someday|!/.test(t)) return 1;
  return 0;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : undefined);

/** Spreadsheet dates in every shape they come in, as local YYYY-MM-DD. */
export function parseDue(v: Cell, now = Date.now()): string | undefined {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return undefined;
  if (typeof v === 'number') {
    // Excel / Sheets serial day number.
    if (v > 20000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return undefined;
  }
  const t = String(v).trim();
  const low = t.toLowerCase();
  const today = new Date(now);
  if (low === 'today') return localDate(now);
  if (low === 'tomorrow') return localDate(now + 86_400_000);
  if (low === 'yesterday') return localDate(now - 86_400_000);
  // ISO date or timestamp (Apps Script and Numbers send ISO timestamps).
  let m = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
  if (m) return m[4] ? localDate(Date.parse(t)) : ymd(+m[1], +m[2], +m[3]);
  // 10/17/2026, 10/17/26, 10/17 (US order).
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(t);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear();
    return ymd(y, +m[1], +m[2]);
  }
  // 2026/10/17 or 2026.10.17
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(t);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  // Oct 17, Oct 17 2026, 17 Oct, Friday, October 17, 2026
  // 17 Oct, 17th October 2026
  m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?(?:,?\s+(\d{4}))?\b/i.exec(t);
  if (m && MONTHS.includes(m[2].toLowerCase())) return ymd(m[3] ? +m[3] : today.getFullYear(), MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  // Oct 17, October 17 2026, Friday, October 17, 2026
  m = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(t);
  if (m && MONTHS.includes(m[1].toLowerCase())) return ymd(m[3] ? +m[3] : today.getFullYear(), MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return undefined;
}

// ---------------------------------------------------------------------------
// Finding the table: the row of column names, then what each column holds.
// Real sheets often start with a title, totals, a filter box or instructions
// before the table proper, so the header row is searched for, not assumed.

const H_TASK = /(task|to-?do|todo|item|title|name|what|action|description|thing|deliverable|任务|事项)/i;
const H_DONE = /(done|complete|status|finished|check|✓|✔|☑|✅|state|状态|完成)/i;
const H_DUE = /(due|deadline|date|when|by\b|day|截止|日期)/i;
const H_PRIO = /(prio|priority|urgen|importan|p\d|优先)/i;
const H_OWNER = /(assignee|assigned|owner|\bwho\b|person|responsible|\bpic\b|\bdri\b|负责)/i;
const H_PROJECT = /(project|category|workstream|\bstream\b|\barea\b|client|epic|项目|类别)/i;
const STRONG_TASK = /^(tasks?|task names?|to-?dos?|to do|items?|action items?|actions?|titles?|names?|descriptions?|what|things?( to do)?|deliverables?|(to-?do|task) list|任务|事项)\s*[:?]?$/i;

/** Words that make up column names. A cell made only of these is "header-like". */
const VOCAB = new Set(
  (
    'task tasks name names todo todos to do to-do to-dos item items action actions title titles description what thing things deliverable deliverables ' +
    'done complete completed completion status state finished check checked checkbox tick ticked ✓ ✔ ☑ ✅ ' +
    'due date dates deadline when by day days week weeks month sprint start end target ' +
    'priority prio urgency urgent importance level p p1 owner owners assignee assignees assigned who person people responsible pic dri lead ' +
    'notes note comments comment link links url category categories type tag tags project projects area areas est estimate estimated hours hrs hour time effort points ' +
    '% progress percent list id no # number created updated last of for workstream team client stage phase label labels section group goal goals ' +
    'details context where how why cost budget amount remarks result outcome size order rank 任务 事项 状态 完成 截止 日期 负责人 负责 优先级 备注'
  ).split(' '),
);

const words = (v: string) => v.toLowerCase().replace(/[^\p{L}\p{N}%#✓✔☑✅]+/gu, ' ').trim().split(' ').filter(Boolean);

function headerLike(v: string): boolean {
  if (!v || v.length > 30) return false;
  const w = words(v);
  return w.length > 0 && w.length <= 4 && w.every((x) => VOCAB.has(x));
}

type Kind = 'done' | 'priority' | 'assignee' | 'due' | 'project' | 'task';
function headerKind(h: string): Kind | null {
  if (!h || h.length > 30) return null;
  if (H_DONE.test(h)) return 'done';
  if (H_PRIO.test(h)) return 'priority';
  if (H_OWNER.test(h)) return 'assignee';
  if (H_DUE.test(h)) return 'due';
  if (H_PROJECT.test(h)) return 'project';
  if (H_TASK.test(h)) return 'task';
  return null;
}

function nonEmptyRows(t: Table): number[] {
  const out: number[] = [];
  t.forEach((r, i) => {
    if (r.some((c) => s(c) !== '')) out.push(i);
  });
  return out;
}

/** The row of column names: the first row made of column-name words with at least two of them (or one clear "Task"). -1 if none. */
export function findHeader(t: Table): number {
  const rows = nonEmptyRows(t).slice(0, 60);
  for (const i of rows) {
    let like = 0;
    let strong = false;
    let values = 0;
    for (const c of t[i]) {
      if (c === null || c === '') continue;
      if (typeof c !== 'string') {
        values++;
        continue;
      }
      const v = c.trim();
      if (!v) continue;
      if (headerLike(v)) like++;
      else values++;
      if (STRONG_TASK.test(v)) strong = true;
    }
    if ((like >= 2 || (like >= 1 && strong)) && like >= values) return i;
  }
  return -1;
}

const DUE_RANK = (h: string) => (/(due|deadline|截止)/i.test(h) ? 3 : /(end|by\b|when|target)/i.test(h) ? 2 : /(start|created|updated|modified|added|completed|finished|done)/i.test(h) ? -1 : 1);

export function detectColumns(t: Table): ColumnMap {
  const width = Math.max(0, ...t.map((r) => r.length));
  const map: ColumnMap = { header: -1, task: null, done: null, due: null, priority: null, assignee: null, project: null };
  const rows = nonEmptyRows(t);
  if (!rows.length) return map;

  map.header = findHeader(t);
  const body = rows.filter((i) => i > map.header).slice(0, 300).map((i) => t[i]);
  const vals = (i: number) => body.map((r) => r[i] ?? null).filter((v) => s(v) !== '');
  const share = (i: number, test: (v: Cell) => boolean) => {
    const v = vals(i);
    return v.length ? v.filter(test).length / v.length : 0;
  };
  const isDate = (v: Cell) => typeof v !== 'boolean' && !!parseDue(v);
  const textLen = (i: number) => vals(i).filter((v) => typeof v === 'string' && !BOOL_LIKE.test(v.trim()) && !parseDue(v) && !/^[\d.,%\s]+$/.test(v)).reduce<number>((n, v) => n + String(v).length, 0);

  if (map.header >= 0) {
    const head = t[map.header];
    const cands: Record<Kind, number[]> = { done: [], priority: [], assignee: [], due: [], project: [], task: [] };
    head.forEach((c, i) => {
      const k = headerKind(s(c));
      if (k) cands[k].push(i);
    });
    map.done = cands.done[0] ?? null;
    map.priority = cands.priority[0] ?? null;
    map.assignee = cands.assignee[0] ?? null;
    map.project = cands.project[0] ?? null;
    // Dates: prefer "Due"/"Deadline" over "Start"/"Created", and only a column that really holds dates.
    const dues = cands.due.filter((i) => DUE_RANK(s(head[i])) >= 0 && (vals(i).length === 0 || share(i, isDate) >= 0.5));
    dues.sort((a, b) => DUE_RANK(s(head[b])) - DUE_RANK(s(head[a])));
    map.due = dues[0] ?? null;
    // Several "task" columns ("Task ID", "Task name"): the one with the most writing in it.
    if (cands.task.length) map.task = [...cands.task].sort((a, b) => textLen(b) - textLen(a))[0];
  }

  // Fill the gaps from what the columns hold.
  const used = () => new Set([map.task, map.done, map.due, map.priority, map.assignee, map.project].filter((x): x is number => x !== null));
  if (map.done === null) {
    for (let i = 0; i < width; i++) {
      if (used().has(i)) continue;
      const v = vals(i);
      const numeric01 = v.length >= 3 && v.every((x) => x === 0 || x === 1);
      if (v.length && (numeric01 || share(i, (x) => typeof x === 'boolean' || (typeof x === 'string' && BOOL_LIKE.test(x.trim()))) >= 0.8)) {
        map.done = i;
        break;
      }
    }
  }
  if (map.due === null) {
    for (let i = 0; i < width; i++) {
      if (used().has(i)) continue;
      if (vals(i).length && share(i, isDate) >= 0.6) {
        map.due = i;
        break;
      }
    }
  }
  if (map.task === null) {
    let best = -1;
    let bestLen = 0;
    for (let i = 0; i < width; i++) {
      if (used().has(i)) continue;
      const len = textLen(i);
      if (len > bestLen) {
        best = i;
        bestLen = len;
      }
    }
    if (best >= 0) map.task = best;
  }
  return map;
}

export function columnLabels(t: Table, header: number): string[] {
  const width = Math.max(0, ...t.map((r) => r.length));
  const head = header >= 0 ? t[header] ?? [] : [];
  return Array.from({ length: width }, (_, i) => {
    const h = s(head[i] ?? null);
    return h ? `${colName(i)}: ${h}` : colName(i);
  });
}

// ---------------------------------------------------------------------------
// Rows → tasks, leaving out rows that sit in the task column but are not tasks.

export interface RowTask extends Task {
  row: number;
}

export interface Skipped {
  row: number;
  title: string;
  why: 'header' | 'number' | 'label' | 'total' | 'note' | 'section' | 'cancelled' | 'someone else';
}

export interface Analysis {
  tasks: RowTask[];
  skipped: Skipped[];
  /** Everyone in the "assigned to" column. */
  owners: string[];
  /** Whose rows were kept ('' = everyone). */
  owner: string;
}

const NOTE = /\b(this (page|sheet|tab|table) (is|was|shows)|please (edit|use|do not|don'?t|update|go to)|do not (edit|change|delete|type)|don'?t (edit|change|delete|type)|read[- ]only|auto-?(generated|calculated|filled)|filled (in )?automatically|edit (it |them )?(in|under|on) the)\b/i;
const TOTAL = /^(grand\s+)?(sub)?totals?\b|^(sum|count|average|avg|remaining|overall)\b/i;
const SECTION = /^(week|wk|day|sprint|phase|month|quarter|q[1-4]|mon(day)?|tue(s(day)?)?|wed(nesday)?|thu(r(s(day)?)?)?|fri(day)?|sat(urday)?|sun(day)?|backlog|someday|later|this week|next week|today|tomorrow|done|completed|in progress|doing|to ?do|archived?|morning|afternoon|evening)\b/i;
const CANCELLED = /\b(cancel+ed|dropped|won'?t do|wontfix|abandoned|skipped|not needed|n\/a|obsolete)\b/i;

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Splits "Grace, Sam & Lee" into names. */
function people(v: Cell): string[] {
  return s(v)
    .split(/\s*(?:,|;|\/|&|\+|\band\b|\n)\s*/i)
    .map((x) => x.trim())
    .filter((x) => x && x.length <= 40);
}

/** Whether a name from the sheet is you: your first name, or part of your Mac account name. */
export function isMe(name: string, me: string[]): boolean {
  const n = norm(name);
  if (n.length < 2) return false;
  const first = n.split(/[\s@._-]+/)[0];
  return me.some((m) => {
    const x = norm(m);
    if (!x) return false;
    const xFirst = x.split(/[\s@._-]+/)[0];
    return x === n || (first.length >= 2 && first === xFirst) || (first.length >= 4 && x.replace(/[^a-z]/g, '').includes(first));
  });
}

/** Picks whose rows to read: the setting, or you when your name is among several people. */
export function resolveOwner(setting: string | null | undefined, owners: string[], me: string[]): string {
  if (setting === '' ) return '';
  if (setting) return setting;
  if (owners.length < 2) return '';
  return owners.find((o) => isMe(o, me)) ?? '';
}

export function analyzeTable(t: Table, map: ColumnMap, opts: { scope?: SheetSettings['scope']; now?: number; owner?: string | null; me?: string[] } = {}): Analysis {
  const now = opts.now ?? Date.now();
  const scope = opts.scope ?? 'all';
  const skipped: Skipped[] = [];
  if (map.task === null) return { tasks: [], skipped, owners: [], owner: '' };
  const today = localDate(now);
  const headTitle = map.header >= 0 ? norm(s(t[map.header]?.[map.task] ?? null)) : '';
  const cand: { row: number; title: string; owners: string[]; r: Cell[] }[] = [];

  t.forEach((r, i) => {
    if (i <= map.header) return;
    const raw = r[map.task!] ?? null;
    const title = s(raw).replace(/\s+/g, ' ');
    if (!title || title.length > 300) return;
    const filled = r.filter((c) => s(c) !== '').length;
    const status = map.done !== null ? s(r[map.done] ?? null) : '';
    let why: Skipped['why'] | null = null;
    if (headTitle && norm(title) === headTitle) why = 'header';
    else if (typeof raw === 'number' || /^[\d.,%$€£¥\s:/+()-]+$/.test(title)) why = 'number';
    else if (title.length <= 40 && /:\s*$/.test(title)) why = 'label';
    else if (title.length <= 40 && TOTAL.test(title)) why = 'total';
    else if (NOTE.test(title)) why = 'note';
    else if (filled === 1 && title.split(' ').length <= 4 && ((/[A-Z]{3}/.test(title) && title === title.toUpperCase()) || SECTION.test(title))) why = 'section';
    else if (status && CANCELLED.test(status)) why = 'cancelled';
    if (why) {
      skipped.push({ row: i, title, why });
      return;
    }
    cand.push({ row: i, title, owners: map.assignee !== null ? people(r[map.assignee] ?? null) : [], r });
  });

  const owners: string[] = [];
  const seenOwner = new Set<string>();
  for (const c of cand) {
    for (const o of c.owners) {
      if (!seenOwner.has(norm(o))) {
        seenOwner.add(norm(o));
        owners.push(o);
      }
    }
  }
  const owner = map.assignee !== null ? resolveOwner(opts.owner, owners, opts.me ?? []) : '';

  const seen = new Map<string, number>();
  const tasks: RowTask[] = [];
  for (const c of cand) {
    if (owner && !c.owners.some((o) => norm(o) === norm(owner) || isMe(o, [owner]))) {
      skipped.push({ row: c.row, title: c.title, why: 'someone else' });
      continue;
    }
    const r = c.r;
    const n = norm(c.title);
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    const done = map.done !== null ? isDone(r[map.done] ?? null) : false;
    const due = map.due !== null ? parseDue(r[map.due] ?? null, now) : undefined;
    if (!done && scope === 'due' && due && due > today) continue;
    tasks.push({
      id: `row:${n}#${k}`,
      row: c.row,
      title: c.title,
      due,
      priority: map.priority !== null ? parsePriority(r[map.priority] ?? null) : 0,
      project: map.project !== null ? s(r[map.project] ?? null).slice(0, 80) || undefined : undefined,
      completed: done,
    });
  }
  skipped.sort((a, b) => a.row - b.row);
  return { tasks, skipped, owners, owner };
}

export function tableToTasks(t: Table, map: ColumnMap, scope: SheetSettings['scope'], now = Date.now()): RowTask[] {
  return analyzeTable(t, map, { scope, now, owner: '' }).tasks;
}

// ---------------------------------------------------------------------------
// Which tab

/** "please edit under "All Tasks" tab" → All Tasks */
export function findPointer(t: Table): string | null {
  for (const r of t.slice(0, 60)) {
    for (const c of r) {
      if (typeof c !== 'string' || c.length > 200) continue;
      const m = /\b(?:edit|update|use|see|go to|add|work|type)\b[^"“”'‘’]{0,40}["“‘']([^"”’']{1,40})["”’']\s*(?:tab|sheet)\b/i.exec(c);
      if (m) return m[1].trim();
    }
  }
  return null;
}

export function matchTab(tabs: string[], want: string): string | null {
  const w = norm(want);
  if (!w) return null;
  const exact = tabs.find((x) => norm(x) === w);
  if (exact) return exact;
  const starts = tabs.filter((x) => norm(x).startsWith(w));
  if (starts.length === 1) return starts[0];
  const has = tabs.filter((x) => norm(x).includes(w));
  return has.length === 1 ? has[0] : null;
}

const NOT_A_LIST = /(dashboard|summary|overview|instructions?|read ?me|how to|settings|config|lookups?|^lists?$|dropdowns?|template|archive|chart|stats|report|calendar)/i;

/** With no tab chosen: the tab named after you, else the one the sheet points to, else the one with the most tasks. */
export function pickTab(tabs: string[], read: (name: string) => Table, me: string[]): { name: string; why: string } | null {
  if (!tabs.length) return null;
  const info = tabs.slice(0, 25).map((name) => {
    let t: Table = [];
    try {
      t = read(name);
    } catch {
      /* unreadable tab */
    }
    const map = detectColumns(t);
    const tasks = analyzeTable(t, map).tasks.length;
    const ptr = findPointer(t);
    return { name, tasks, pointer: ptr ? matchTab(tabs, ptr) : null };
  });
  const pointedAt = new Set(info.map((x) => x.pointer).filter((x): x is string => !!x && x !== null));
  let best: { name: string; why: string; score: number } | null = null;
  for (const x of info) {
    if (!x.tasks) continue;
    let score = Math.min(x.tasks, 300);
    let why = 'it has the most tasks';
    if (x.pointer && x.pointer !== x.name) score -= 800;
    if (NOT_A_LIST.test(x.name)) score -= 300;
    if (pointedAt.has(x.name)) {
      score += 500;
      why = 'the sheet says to edit there';
    }
    if (me.length && isMe(x.name.replace(/['’]s\b.*$/i, ''), me)) {
      score += 1000;
      why = 'it has your name';
    }
    if (!best || score > best.score) best = { name: x.name, why, score };
  }
  return best ? { name: best.name, why: best.why } : { name: tabs[0], why: 'it is the first tab' };
}

// ---------------------------------------------------------------------------
// Completion tracking

export interface TrackState {
  day: string;
  open: Record<string, string>;
  done: Record<string, { title: string; at: number }>;
  /** Rows ticked off in Lock In for sheets it cannot write to. Cleared once the sheet shows them done. */
  local?: Record<string, { title: string; at: number }>;
  /** Which tab and columns this was tracked against; a different table starts the count fresh. */
  sig?: string;
}

export function track(prev: TrackState | null, tasks: Task[], now: number, deletedCountsAsDone: boolean): { state: TrackState; doneToday: Task[] } {
  const day = dayKey(now);
  const openNow: Record<string, string> = {};
  for (const t of tasks) if (!t.completed) openNow[t.id] = t.title;
  if (!prev) return { state: { day, open: openNow, done: {} }, doneToday: [] };

  const done = prev.day === day ? { ...prev.done } : {};
  const present = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    if (t.completed && !done[t.id] && prev.open[t.id] !== undefined) done[t.id] = { title: t.title, at: now };
  }
  // Lists without a done column: deleting a row is how you finish it. Ignore an empty read (a glitch, not a clean sweep).
  if (deletedCountsAsDone && tasks.length > 0) {
    for (const [id, title] of Object.entries(prev.open)) if (!present.has(id) && !done[id]) done[id] = { title, at: now };
  }
  // Un-ticked again: not done after all.
  for (const id of Object.keys(done)) if (openNow[id] !== undefined) delete done[id];

  const state: TrackState = { day, open: openNow, done };
  return { state, doneToday: Object.entries(done).map(([id, d]) => ({ id, title: d.title, completed: true, completedAt: d.at })) };
}

// ---------------------------------------------------------------------------
// Readers

export function parseCsv(text: string, delimiter?: string): Table {
  const d = delimiter ?? (text.split('\n')[0].split('\t').length > text.split('\n')[0].split(',').length ? '\t' : ',');
  const rows: Table = [];
  let row: Cell[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === d) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function xmlText(x: string): string {
  return x
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

export interface Book {
  tabs: string[];
  table(name: string): Table;
}

/** Minimal .xlsx reader: values only (strings, numbers, booleans), every tab. */
export function readXlsxBook(buf: Uint8Array): Book {
  const files = unzipSync(buf, { filter: (f) => f.name.startsWith('xl/') && (f.name.endsWith('.xml') || f.name.endsWith('.rels')) });
  const get = (name: string) => (files[name] ? strFromU8(files[name]) : '');
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('That file is not a spreadsheet Lock In can read.');
  const rels = get('xl/_rels/workbook.xml.rels');
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: xmlText(attr(m[0], 'name') ?? ''), rid: attr(m[0], 'r:id') ?? '', hidden: /state="(hidden|veryHidden)"/.test(m[0]) }));
  if (!sheets.length) throw new Error('No sheets found in this file.');
  let shared: string[] | null = null;
  const sharedStrings = () =>
    (shared ??= [...get('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => {
      const runs = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((r) => r[1]);
      return xmlText(runs.join(''));
    }));
  const cache = new Map<string, Table>();

  const table = (name: string): Table => {
    const pick = sheets.find((x) => x.name === name);
    if (!pick) throw new Error(`No tab called "${name}". Tabs: ${sheets.map((x) => x.name).join(', ')}.`);
    const hit = cache.get(name);
    if (hit) return hit;
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => attr(r, 'Id') === pick.rid);
    let target = rel ? attr(rel, 'Target') ?? '' : '';
    target = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    const sheetXml = get(`xl/${target}`);
    if (!sheetXml) throw new Error('Could not read that tab.');
    const strs = sharedStrings();
    const out: Table = [];
    for (const rm of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rIdx = Number(attr(rm[1], 'r') ?? out.length + 1) - 1;
      const row: Cell[] = [];
      let next = 0;
      for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(cm[1], 'r');
        const ci = ref ? colIndex(ref.replace(/\d+/g, '')) : next;
        next = ci + 1;
        const type = attr(cm[1], 't');
        const inner = cm[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val: Cell = null;
        if (type === 's') val = v !== undefined ? strs[+v] ?? '' : '';
        else if (type === 'b') val = v === '1';
        else if (type === 'inlineStr') val = xmlText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
        else if (type === 'str' || type === 'e') val = v !== undefined ? xmlText(v) : '';
        else if (v !== undefined) val = Number.isFinite(+v) ? +v : xmlText(v);
        row[ci] = val;
      }
      for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
      out[rIdx] = row;
    }
    for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
    cache.set(name, out);
    return out;
  };
  return { tabs: sheets.filter((x) => !x.hidden).map((x) => x.name), table };
}

/** One tab of an .xlsx file: the named one (any capitalisation), or the first. */
export function readXlsx(buf: Uint8Array, tab = ''): Table {
  const book = readXlsxBook(buf);
  if (!tab.trim()) return book.table(book.tabs[0]);
  const name = matchTab(book.tabs, tab);
  if (!name) throw new Error(`No tab called "${tab}". Tabs: ${book.tabs.join(', ')}.`);
  return book.table(name);
}

export function googleSheetId(url: string): string | null {
  return /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/.exec(url)?.[1] ?? null;
}

/** "https://docs.google.com/spreadsheets/d/<id>/edit#gid=123" → its CSV export URL. */
export function googleCsvUrl(url: string): string | null {
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/.exec(url)?.[1];
  if (!id) return null;
  const gid = /[#?&]gid=(\d+)/.exec(url)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}

export const isScriptUrl = (url: string) => /^https:\/\/script\.google(usercontent)?\.com\/.*\/(exec|dev)/.test(url.trim());

function jxa(script: string, timeoutMs = 25_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new Error('Numbers files can only be read on a Mac.'));
      return;
    }
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs, maxBuffer: 8_000_000 }, (err, out, stderr) => {
      if (err) {
        const msg = String(stderr || err.message);
        if (/-1743|not authori[sz]ed/i.test(msg)) reject(new Error('macOS blocked access to Numbers. Allow it under System Settings, Privacy and Security, Automation.'));
        else reject(new Error(msg.trim().slice(0, 200) || 'Could not read the Numbers file.'));
        return;
      }
      resolve(String(out).trim());
    });
  });
}

const NUMBERS_OPEN = (path: string) => `
  const app = Application('Numbers');
  const wasRunning = app.running();
  const PATH = ${JSON.stringify(path)};
  let doc = null;
  if (wasRunning) {
    for (const d of app.documents()) { try { if (d.file() && d.file().toString() === PATH) { doc = d; break; } } catch (e) {} }
  }
  const opened = !doc;
  if (!doc) doc = app.open(Path(PATH));`;

const NUMBERS_TABLE = (tab: string) => `
  const TAB = ${JSON.stringify(tab.trim())};
  const sheet = TAB ? doc.sheets.byName(TAB) : doc.sheets[0];
  const t = sheet.tables[0];`;

const NUMBERS_CLOSE = (save: boolean) => `
  if (opened) { doc.close({ saving: ${save ? "'yes'" : "'no'"} }); if (!wasRunning) app.quit(); }`;

export async function readNumbers(path: string, tab: string): Promise<Table> {
  const out = await jxa(`${NUMBERS_OPEN(path)}${NUMBERS_TABLE(tab)}
    const rows = t.rowCount(), cols = t.columnCount();
    const vals = t.cells.value();
    ${NUMBERS_CLOSE(false)}
    JSON.stringify({ rows, cols, vals });`);
  const j = JSON.parse(out) as { rows: number; cols: number; vals: Cell[] };
  const table: Table = [];
  for (let r = 0; r < j.rows; r++) table.push(j.vals.slice(r * j.cols, (r + 1) * j.cols).map((v) => (v === undefined ? null : v)));
  return table;
}

async function completeInNumbers(path: string, tab: string, row: number, col: number, checkbox: boolean): Promise<void> {
  await jxa(`${NUMBERS_OPEN(path)}${NUMBERS_TABLE(tab)}
    t.rows[${row}].cells[${col}].value = ${checkbox ? 'true' : "'Done'"};
    ${NUMBERS_CLOSE(true)}
    'ok'`);
}

// ---------------------------------------------------------------------------
// Private Google connector (Apps Script the user adds to their own sheet)

export function appsScript(token: string): string {
  return `// Lock In connector. It only answers requests that carry this secret.
const TOKEN = '${token}';

function tab_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return name ? ss.getSheetByName(name) : ss.getSheets()[0];
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (!e || e.parameter.token !== TOKEN) return out_({ error: 'Wrong secret' });
  const sh = tab_(e.parameter.tab);
  if (!sh) return out_({ error: 'No tab with that name' });
  return out_({ values: sh.getDataRange().getValues() });
}

function doPost(e) {
  const b = JSON.parse(e.postData.contents);
  if (b.token !== TOKEN) return out_({ error: 'Wrong secret' });
  const sh = tab_(b.tab);
  if (!sh) return out_({ error: 'No tab with that name' });
  if (b.action === 'complete') {
    const values = sh.getDataRange().getValues();
    let row = b.row;
    if (!values[row] || String(values[row][b.taskCol]).trim() !== b.title) {
      row = values.findIndex((r) => String(r[b.taskCol]).trim() === b.title);
    }
    if (row < 0) return out_({ error: 'Task not found' });
    const cell = sh.getRange(row + 1, b.doneCol + 1);
    const rule = cell.getDataValidation();
    const isBox = rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX;
    cell.setValue(isBox || typeof values[row][b.doneCol] === 'boolean' ? true : 'Done');
    return out_({ ok: true });
  }
  if (b.action === 'add') {
    const width = Math.max(sh.getLastColumn(), b.taskCol + 1);
    const row = new Array(width).fill('');
    row[b.taskCol] = b.title;
    sh.appendRow(row);
    return out_({ ok: true });
  }
  return out_({ error: 'Unknown action' });
}
`;
}

// ---------------------------------------------------------------------------
// Provider

type Mode = SheetPreview['mode'];

export function sheetMode(c: SheetSettings): Mode {
  if (c.kind === 'google') {
    if (!c.url.trim()) return 'none';
    return isScriptUrl(c.url) ? 'script' : 'link';
  }
  if (!c.path.trim()) return 'none';
  const ext = extname(c.path).toLowerCase();
  if (ext === '.numbers') return 'numbers';
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return 'csv';
  return 'xlsx';
}

export interface SheetDeps {
  cfg: () => SheetSettings;
  http?: typeof fetch;
  loadState: () => TrackState | null;
  saveState: (s: TrackState) => void;
  /** Your names (full name, Mac account name), to find your tab and your rows. */
  me?: () => string[];
}

/** What one read of the sheet produced. */
interface Loaded {
  table: Table;
  tabs: string[];
  tab: string;
  tabWhy?: string;
}

const XLSX_TYPE = /spreadsheetml|octet-stream|zip|excel/i;

/** A tab name that is not in the file; carries the real ones so the setup screen can offer them. */
class NoSuchTab extends Error {
  constructor(want: string, readonly tabs: string[]) {
    super(`There is no tab called "${want}". The tabs are: ${tabs.join(', ')}.`);
  }
}

export class SheetProvider implements TodoProvider {
  id = 'sheet' as const;
  private table: Table | null = null;
  private map: ColumnMap | null = null;
  private rows: RowTask[] = [];
  private readAt = 0;
  private fileMtime = 0;
  private loaded: Loaded | null = null;
  private lastAnalysis: Analysis | null = null;

  constructor(private d: SheetDeps) {}

  /** The tab being read ('' when unknown). */
  get tabName(): string {
    return this.loaded?.tab ?? '';
  }

  private get http(): typeof fetch {
    return this.d.http ?? fetch;
  }

  private get me(): string[] {
    return this.d.me?.() ?? [];
  }

  /** Ticking always works: written to the sheet when possible, otherwise remembered by Lock In. */
  get canComplete(): boolean {
    return this.map?.task !== null && this.map?.task !== undefined;
  }

  /** True when a tick in Lock In is written into the sheet itself. */
  get writesBack(): boolean {
    const m = sheetMode(this.d.cfg());
    return (m === 'script' || m === 'numbers') && this.map?.done !== null && this.map?.done !== undefined;
  }

  private stateNow(now: number): TrackState {
    return this.d.loadState() ?? { day: dayKey(now), open: {}, done: {} };
  }

  get canAdd(): boolean {
    return sheetMode(this.d.cfg()) === 'script';
  }

  /** Picks the tab from a whole workbook: the one you named, else the best guess. */
  private fromBook(book: Book): Loaded {
    const want = this.d.cfg().tab.trim();
    if (want) {
      const name = matchTab(book.tabs, want);
      if (!name) throw new NoSuchTab(want, book.tabs);
      return { table: book.table(name), tabs: book.tabs, tab: name };
    }
    const pick = pickTab(book.tabs, (n) => book.table(n), this.me) ?? { name: book.tabs[0], why: '' };
    return { table: book.table(pick.name), tabs: book.tabs, tab: pick.name, tabWhy: pick.why };
  }

  private async readGoogle(url: string, withTabs: boolean): Promise<Loaded> {
    const id = googleSheetId(url);
    if (!id) throw new Error('That does not look like a Google Sheets link.');
    const c = this.d.cfg();
    const gid = /[#?&]gid=(\d+)/.exec(url)?.[1];
    const privateErr = () => new Error('This sheet is private. Either share it as "Anyone with the link can view", or use the private connector below.');
    const linkedTab = !!gid && !c.tab.trim();

    // The whole file, every tab, so the right one can be picked by name.
    let book: Book | null = null;
    if (!linkedTab || withTabs) {
      try {
        const res = await this.http(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
        const type = res.headers.get('content-type') ?? '';
        if (res.ok && !type.includes('text/html') && (XLSX_TYPE.test(type) || !type)) book = readXlsxBook(new Uint8Array(await res.arrayBuffer()));
        else if (type.includes('text/html') || res.status === 401 || res.status === 403) throw privateErr();
      } catch (e) {
        if ((e as Error).message.includes('private')) throw e;
        book = null;
      }
    }
    if (book && !linkedTab) return this.fromBook(book);

    // One tab as CSV: the tab in the link, or the named tab.
    const csvUrl = c.tab.trim() && !book
      ? `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(c.tab.trim())}`
      : `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
    const res = await this.http(csvUrl, { redirect: 'follow', signal: AbortSignal.timeout(12_000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || type.includes('text/html')) throw privateErr();
    return { table: parseCsv(await res.text(), ','), tabs: book?.tabs ?? [], tab: c.tab.trim() };
  }

  async load(force = false, withTabs = false): Promise<Loaded> {
    const c = this.d.cfg();
    const mode = sheetMode(c);
    switch (mode) {
      case 'none':
        throw new Error(c.kind === 'google' ? 'Paste your Google Sheets link first.' : 'Choose your spreadsheet file first.');
      case 'link':
        return this.readGoogle(c.url, withTabs);
      case 'script': {
        const u = new URL(c.url.trim());
        u.searchParams.set('token', c.token);
        if (c.tab.trim()) u.searchParams.set('tab', c.tab.trim());
        const res = await this.http(u, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        let j: { values?: Table; error?: string };
        try {
          j = JSON.parse(text);
        } catch {
          throw new Error('The connector did not answer. Check it is deployed as a web app with access set to "Anyone".');
        }
        if (j.error) throw new Error(j.error === 'Wrong secret' ? 'The connector has a different secret. Copy the script from Lock In again.' : j.error);
        return { table: j.values ?? [], tabs: [], tab: c.tab.trim() };
      }
      case 'csv':
      case 'xlsx': {
        const st = statSync(c.path);
        if (!force && this.loaded && st.mtimeMs === this.fileMtime) return this.loaded;
        this.fileMtime = st.mtimeMs;
        const buf = readFileSync(c.path);
        if (mode === 'csv') return { table: parseCsv(buf.toString('utf8'), extname(c.path).toLowerCase() === '.tsv' ? '\t' : undefined), tabs: [], tab: '' };
        if (extname(c.path).toLowerCase() === '.xls') throw new Error('Old .xls files are not supported. Save it as .xlsx.');
        return this.fromBook(readXlsxBook(new Uint8Array(buf)));
      }
      case 'numbers': {
        // Reading goes through the Numbers app, so it refreshes every 10 minutes unless asked.
        if (!force && this.loaded && Date.now() - this.readAt < 600_000) return this.loaded;
        const t = await readNumbers(c.path, c.tab);
        this.readAt = Date.now();
        return { table: t, tabs: [], tab: c.tab.trim() };
      }
    }
  }

  /** Chosen columns win; null = detect; -1 = "None". */
  mapping(t: Table): ColumnMap {
    const c = this.d.cfg();
    const auto = detectColumns(t);
    const pick = (v: number | null | undefined, a: number | null) => (v === null || v === undefined ? a : v < 0 ? null : v);
    return {
      header: auto.header,
      task: pick(c.task, auto.task),
      done: pick(c.done, auto.done),
      due: pick(c.due, auto.due),
      priority: pick(c.priority, auto.priority),
      assignee: pick(c.assignee, auto.assignee),
      project: pick(c.project, auto.project),
    };
  }

  private analyze(l: Loaded, now: number): Analysis {
    this.loaded = l;
    this.table = l.table;
    const map = this.mapping(l.table);
    this.map = map;
    const c = this.d.cfg();
    const a = analyzeTable(l.table, map, { scope: c.scope, now, owner: c.owner, me: this.me });
    this.rows = a.tasks;
    this.lastAnalysis = a;
    return a;
  }

  async fetch(now = Date.now(), force = false): Promise<TodoSnapshot> {
    const l = await this.load(force);
    const a = this.analyze(l, now);
    const map = this.map!;
    if (map.task === null) throw new Error('Could not find a column of tasks. Pick it on the To-dos page.');
    const present = new Set(this.rows.map((r) => r.id));
    // A different tab or table: start today's count fresh, keeping your ticks on rows that are still there.
    const sig = `${l.tab}|${map.header}|${map.task}|${a.owner}`;
    let prev = this.d.loadState();
    if (prev && prev.sig !== sig) {
      const keep: TrackState['local'] = {};
      for (const [id, v] of Object.entries(prev.local ?? {})) if (present.has(id)) keep[id] = v;
      prev = { day: dayKey(now), open: {}, done: {}, local: keep };
    }
    const local = { ...(prev?.local ?? {}) };
    for (const r of this.rows) {
      if (!local[r.id]) continue;
      if (r.completed) delete local[r.id]; // the sheet caught up
      else r.completed = true; // ticked in Lock In
    }
    if (this.rows.length) for (const id of Object.keys(local)) if (!present.has(id)) delete local[id];
    const { state, doneToday } = track(prev, this.rows, now, map.done === null);
    state.local = local;
    state.sig = sig;
    this.d.saveState(state);
    return {
      open: this.rows.filter((r) => !r.completed).map(({ row: _r, ...task }) => task),
      doneToday: doneToday.map((d) => (local[d.id] ? { ...d, localOnly: true } : d)),
      fetchedAt: now,
    };
  }

  /** Un-tick something that was ticked in Lock In only. */
  async undo(id: string): Promise<boolean> {
    const st = this.stateNow(Date.now());
    if (!st.local?.[id]) return false;
    delete st.local[id];
    this.d.saveState(st);
    return true;
  }

  async complete(id: string): Promise<boolean> {
    const c = this.d.cfg();
    const mode = sheetMode(c);
    const task = this.rows.find((r) => r.id === id);
    const map = this.map;
    if (!task || !map || map.task === null) return false;
    if (!this.writesBack || map.done === null) {
      const st = this.stateNow(Date.now());
      st.local = { ...(st.local ?? {}), [id]: { title: task.title, at: Date.now() } };
      this.d.saveState(st);
      return true;
    }
    if (mode === 'script') {
      const res = await this.http(c.url.trim(), {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ token: c.token, tab: c.tab.trim(), action: 'complete', row: task.row, taskCol: map.task, doneCol: map.done, title: task.title }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!j.ok) throw new Error(j.error ?? 'The connector could not tick it off.');
      return true;
    }
    if (mode === 'numbers') {
      const sample = this.table?.[task.row]?.[map.done];
      await completeInNumbers(c.path, c.tab, task.row, map.done, typeof sample === 'boolean' || sample === null);
      return true;
    }
    throw new Error('This sheet is read-only from Lock In. Tick it off in the sheet itself.');
  }

  async add(title: string): Promise<boolean> {
    const c = this.d.cfg();
    if (sheetMode(c) !== 'script') throw new Error('Add it in the sheet itself. Lock In can only add rows through the private connector.');
    const map = this.map ?? { task: 0 };
    const res = await this.http(c.url.trim(), {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: c.token, tab: c.tab.trim(), action: 'add', taskCol: map.task ?? 0, title: title.trim() }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!j.ok) throw new Error(j.error ?? 'The connector could not add it.');
    return true;
  }

  /** For the setup screen: what Lock In sees in the sheet right now. */
  async preview(): Promise<SheetPreview> {
    const mode = sheetMode(this.d.cfg());
    const empty: SheetPreview = {
      ok: false, columns: [], map: { task: null, done: null, due: null, priority: null, assignee: null, project: null }, open: 0, done: 0, sample: [],
      canComplete: false, canAdd: false, mode, tabs: [], tab: '', headerRow: null, skipped: 0, skippedSample: [], owners: [], owner: '',
    };
    let l: Loaded | null = null;
    try {
      l = await this.load(true, true);
      const a = this.analyze(l, Date.now());
      const map = this.map!;
      const open = a.tasks.filter((r) => !r.completed);
      const ranked = [...open].sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0) || (x.due ?? '9999').localeCompare(y.due ?? '9999'));
      const junk = a.skipped.filter((x) => x.why !== 'someone else');
      return {
        ok: map.task !== null,
        error: map.task === null ? 'Could not find a column of tasks. Pick it below.' : undefined,
        columns: columnLabels(l.table, map.header),
        map: { task: map.task, done: map.done, due: map.due, priority: map.priority, assignee: map.assignee, project: map.project },
        open: open.length,
        done: a.tasks.length - open.length,
        sample: ranked.slice(0, 5).map((r) => r.title),
        canComplete: this.writesBack,
        canAdd: this.canAdd,
        mode,
        tabs: l.tabs,
        tab: l.tab,
        tabWhy: l.tabWhy,
        headerRow: map.header >= 0 ? map.header + 1 : null,
        skipped: junk.length,
        skippedSample: junk.slice(0, 4).map((x) => x.title),
        owners: a.owners,
        owner: a.owner,
      };
    } catch (e) {
      return { ...empty, tabs: l?.tabs ?? (e instanceof NoSuchTab ? e.tabs : []), error: (e as Error).message };
    }
  }
}
