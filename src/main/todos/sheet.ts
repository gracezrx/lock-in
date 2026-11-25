// A spreadsheet as the to-do list: Google Sheets, Excel, Numbers or CSV.
//  - Finds the task, done, due and priority columns from the headers and values.
//  - A row counts as finished today when it was open on an earlier read and is now
//    ticked (or, for lists without a done column, deleted).
//  - Lock In can keep its own "Lock In" tab in the sheet (template.ts). To-dos added or
//    ticked in Lock In are written into the sheet; while it can't be written (a shared
//    Google link, a file open in Excel) they're kept in Lock In and written later.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { SheetPreview, SheetSettings, Task } from '../../shared/types';
import { dayKey, localDate } from './day';
import type { TodoProvider, TodoSnapshot } from './providers';
import { TCOL, TEMPLATE_HEADERS, TEMPLATE_TAB, doneValueFor, placeCells, templateCells, type TemplateRow, type WCell } from './template';
import { addTemplateTab, writeXlsx, type CellEdit } from './xlsxwrite';

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
  /** To-dos added (or ticked) in Lock In that aren't in the sheet yet. Written as soon as the sheet can be. */
  pending?: Pending[];
}

export interface Pending {
  id: string;
  title: string;
  at: number;
  due?: string;
  priority?: number;
  project?: string;
  /** Ticked off in Lock In (when). */
  done?: number;
  /** How many rows had this title when it was added, so a copy typed into the sheet is noticed. */
  seen: number;
  /** In the sheet now (kept until the day ends when done, for Done today). */
  flushed?: boolean;
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
// Writing to Numbers (through the Numbers app)

const JS_VAL = `function val_(v) { if (v && typeof v === 'object' && v.date) { const p = v.date.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); } return v; }`;

/** The tabs of a Numbers file. */
export async function numbersTabs(path: string): Promise<string[]> {
  const out = await jxa(`${NUMBERS_OPEN(path)}
    const names = doc.sheets.name();
    ${NUMBERS_CLOSE(false)}
    JSON.stringify(names);`);
  return JSON.parse(out) as string[];
}

/** Adds Lock In's tab to a Numbers file. False when it was already there. */
export async function numbersAddTab(path: string, rows: TemplateRow[]): Promise<boolean> {
  const cells = rows.map((r) => templateCells(r, true).map((v, i) => (i === TCOL.done && v === '' ? false : v)));
  const out = await jxa(`${NUMBERS_OPEN(path)}
    ${JS_VAL}
    const TAB = ${JSON.stringify(TEMPLATE_TAB)}, H = ${JSON.stringify(TEMPLATE_HEADERS)}, ROWS = ${JSON.stringify(cells)};
    let result = 'exists';
    if (!doc.sheets.name().some((n) => n.toLowerCase() === TAB.toLowerCase())) {
      doc.sheets.push(app.Sheet({ name: TAB }));
      const t = doc.sheets.byName(TAB).tables[0];
      try { t.headerColumnCount = 0; } catch (e) {}
      try { t.headerRowCount = 1; } catch (e) {}
      try { t.footerRowCount = 0; } catch (e) {}
      try { t.name = TAB; } catch (e) {}
      t.columnCount = H.length;
      t.rowCount = Math.max(ROWS.length + 1, 30);
      H.forEach((h, c) => { t.rows[0].cells[c].value = h; });
      try { t.ranges.byName('A2:A' + t.rowCount()).format = 'checkbox'; } catch (e) {}
      ROWS.forEach((r, i) => r.forEach((v, c) => { if (v !== '' && v !== null) t.rows[i + 1].cells[c].value = val_(v); }));
      [70, 300, 100, 80, 130, 220, 100].forEach((w, c) => { try { t.columns[c].width = w; } catch (e) {} });
      result = 'created';
    }
    ${NUMBERS_CLOSE(true)}
    result;`);
  return out === 'created';
}

/** Sets cells and adds rows under the last task in one tab of a Numbers file. */
export async function numbersWrite(path: string, tab: string, edits: CellEdit[], rows: Map<number, WCell>[], taskCol: number): Promise<void> {
  const add = rows.map((m) => [...m.entries()]);
  await jxa(`${NUMBERS_OPEN(path)}${NUMBERS_TABLE(tab)}
    ${JS_VAL}
    const E = ${JSON.stringify(edits)}, R = ${JSON.stringify(add)}, TC = ${taskCol};
    E.forEach((e) => { t.rows[e.row].cells[e.col].value = val_(e.value); });
    if (R.length) {
      const col = t.columns[TC].cells.value();
      let last = 0;
      col.forEach((v, i) => { if (v !== null && v !== undefined && String(v).trim() !== '') last = i; });
      const need = last + 1 + R.length;
      if (t.rowCount() < need) t.rowCount = need;
      R.forEach((cells, i) => cells.forEach(([c, v]) => { t.rows[last + 1 + i].cells[c].value = val_(v); }));
    }
    ${NUMBERS_CLOSE(true)}
    'ok'`);
}

// ---------------------------------------------------------------------------
// Writing to CSV

function csvCell(v: WCell, d: string): string {
  const t = v === null || v === undefined ? '' : typeof v === 'object' ? v.date : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  return t.includes(d) || /["\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function toCsv(t: Table, d = ',', eol = '\n'): string {
  return t.map((r) => r.map((v) => csvCell(v, d)).join(d)).join(eol) + eol;
}

/** The CSV with cells set and rows added under the last task. */
export function writeCsv(text: string, delimiter: string | undefined, edits: CellEdit[], rows: Map<number, WCell>[], taskCol: number): string {
  const d = delimiter ?? (text.split('\n')[0].split('\t').length > text.split('\n')[0].split(',').length ? '\t' : ',');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const t: WCell[][] = parseCsv(text, d);
  while (t.length && t[t.length - 1].every((c) => s(c as Cell) === '')) t.pop();
  const set = (r: number, c: number, v: WCell) => {
    while (t.length <= r) t.push([]);
    while (t[r].length <= c) t[r].push('');
    t[r][c] = v;
  };
  for (const e of edits) set(e.row, e.col, e.value);
  let last = 0;
  t.forEach((r, i) => {
    if (s((r[taskCol] ?? null) as Cell) !== '') last = i;
  });
  rows.forEach((cells, i) => {
    for (const [c, v] of cells) set(last + 1 + i, c, v);
  });
  const width = Math.max(0, ...t.map((r) => r.length));
  for (const r of t) while (r.length < width) r.push('');
  return toCsv(t as Table, d, eol);
}

// ---------------------------------------------------------------------------
// Private Google connector (Apps Script the user adds to their own sheet)

export const CONNECTOR_VERSION = 2;

export function appsScript(token: string): string {
  return `// Lock In connector (version ${CONNECTOR_VERSION}). It only answers requests that carry this secret.
const TOKEN = '${token}';
const TEMPLATE = ${JSON.stringify(TEMPLATE_HEADERS)};

function tab_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!name) return ss.getSheets()[0];
  const want = String(name).trim().toLowerCase();
  return ss.getSheets().filter(function (s) { return s.getName().toLowerCase() === want; })[0] || null;
}

function tabs_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); });
}

function value_(v) {
  if (v && typeof v === 'object' && v.date) {
    const p = String(v.date).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  return v;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (!e || e.parameter.token !== TOKEN) return out_({ error: 'Wrong secret' });
  const sh = tab_(e.parameter.tab);
  if (!sh) return out_({ error: 'No tab with that name', tabs: tabs_(), version: ${CONNECTOR_VERSION} });
  return out_({ values: sh.getDataRange().getValues(), tabs: tabs_(), tab: sh.getName(), version: ${CONNECTOR_VERSION} });
}

// Lock In's own tab: one row per to-do, a checkbox to tick it off.
function setup_(b) {
  if (tab_(b.tab)) return { ok: true, created: false };
  const sh = SpreadsheetApp.getActiveSpreadsheet().insertSheet(b.tab);
  sh.setTabColor('#fecd00');
  sh.getRange(1, 1, 1, TEMPLATE.length).setValues([TEMPLATE]).setFontWeight('bold').setBackground('#fecd00');
  sh.setFrozenRows(1);
  const last = sh.getMaxRows();
  sh.getRange(2, 1, last - 1, 1).insertCheckboxes();
  sh.getRange(2, 4, last - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['High', 'Medium', 'Low'], true).setAllowInvalid(true).build());
  sh.getRange(2, 3, last - 1, 1).setNumberFormat('mmm d, yyyy');
  sh.getRange(2, 7, last - 1, 1).setNumberFormat('mmm d, yyyy');
  [60, 320, 110, 90, 140, 240, 110].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  const done = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$A2=TRUE').setFontColor('#8a9199').setStrikethrough(true).setRanges([sh.getRange(2, 1, last - 1, TEMPLATE.length)]).build();
  sh.setConditionalFormatRules([done]);
  const rows = (b.rows || []).map(function (r) { return r.map(value_); });
  if (rows.length) sh.getRange(2, 1, rows.length, TEMPLATE.length).setValues(rows);
  return { ok: true, created: true };
}

function doPost(e) {
  const b = JSON.parse(e.postData.contents);
  if (b.token !== TOKEN) return out_({ error: 'Wrong secret' });
  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    if (b.action === 'setup') return out_(setup_(b));
    const sh = tab_(b.tab);
    if (!sh) return out_({ error: 'No tab with that name' });
    if (b.action === 'complete') {
      const values = sh.getDataRange().getValues();
      let row = b.row;
      if (!values[row] || String(values[row][b.taskCol]).trim() !== b.title) {
        row = values.findIndex(function (r) { return String(r[b.taskCol]).trim() === b.title; });
      }
      if (row < 0) return out_({ error: 'Task not found' });
      const cell = sh.getRange(row + 1, b.doneCol + 1);
      const rule = cell.getDataValidation();
      const isBox = rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX;
      cell.setValue(isBox || typeof values[row][b.doneCol] === 'boolean' ? true : (b.value || 'Done'));
      return out_({ ok: true });
    }
    if (b.action === 'add') {
      // Under the last task (not under empty checkboxes further down).
      const values = sh.getDataRange().getValues();
      let last = 0;
      values.forEach(function (r, i) { if (String(r[b.taskCol] === undefined ? '' : r[b.taskCol]).trim() !== '') last = i; });
      const rows = b.rows || [[[b.taskCol, b.title]]];
      rows.forEach(function (cells, i) {
        cells.forEach(function (c) { sh.getRange(last + 2 + i, c[0] + 1).setValue(value_(c[1])); });
      });
      return out_({ ok: true });
    }
    return out_({ error: 'Unknown action' });
  } finally {
    lock.releaseLock();
  }
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

/** Lock In can write into sheets of this kind (a plain Google link is read-only). */
export const canWrite = (m: Mode) => m === 'script' || m === 'numbers' || m === 'xlsx' || m === 'csv';

export interface SheetDeps {
  cfg: () => SheetSettings;
  http?: typeof fetch;
  loadState: () => TrackState | null;
  saveState: (s: TrackState) => void;
  /** Your names (full name, Mac account name), to find your tab and your rows. */
  me?: () => string[];
  /** Your open Lock In to-dos, to fill a new Lock In tab with. */
  seed?: () => TemplateRow[];
  /** Called before Lock In first changes a file, so a copy can be kept. */
  backup?: (path: string) => void;
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

/** The file is open somewhere that would overwrite Lock In's changes (Excel): try again later. */
class Busy extends Error {}

/** Excel leaves an owner file (~$Name.xlsx) next to a workbook while it has it open. */
function openInExcel(path: string): boolean {
  const dir = dirname(path);
  const name = basename(path);
  return existsSync(join(dir, `~$${name}`)) || (name.length > 2 && existsSync(join(dir, `~$${name.slice(2)}`)));
}

/** Replaces a file in one step, so nothing ever reads half of it. */
function replaceFile(path: string, data: Uint8Array | string): void {
  const tmp = join(dirname(path), `.${basename(path)}.lockin-${process.pid}`);
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const OLD_CONNECTOR = 'Your Google connector is the older version, which can’t add a tab. Copy the script again, paste it over the old one in Apps Script, then choose Deploy, Manage deployments, the pencil, New version, Deploy.';

export class SheetProvider implements TodoProvider {
  id = 'sheet' as const;
  private table: Table | null = null;
  private map: ColumnMap | null = null;
  private rows: RowTask[] = [];
  private readAt = 0;
  private fileMtime = 0;
  private loaded: Loaded | null = null;
  private lastAnalysis: Analysis | null = null;
  private tabReady = false;
  private backedUp = false;
  /** Why the last write didn't happen (the file is open in Excel…), for the to-dos page. */
  waiting?: string;

  constructor(private d: SheetDeps) {}

  /** The settings, with Lock In's own tab filled in. */
  private get c(): SheetSettings {
    const c = this.d.cfg();
    return c.own && sheetMode(c) !== 'csv' ? { ...c, tab: TEMPLATE_TAB } : c;
  }

  private get mode(): Mode {
    return sheetMode(this.d.cfg());
  }

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
    return canWrite(this.mode) && this.map?.done !== null && this.map?.done !== undefined;
  }

  /** Adding always works: written to the sheet when possible, otherwise kept in Lock In until it can be. */
  get canAdd(): boolean {
    return true;
  }

  /** New to-dos land in the sheet itself (not only in Lock In). */
  get addsToSheet(): boolean {
    return canWrite(this.mode);
  }

  private stateNow(now: number): TrackState {
    return this.d.loadState() ?? { day: dayKey(now), open: {}, done: {} };
  }

  /** Picks the tab from a whole workbook: the one you named, else the best guess. */
  private fromBook(book: Book): Loaded {
    const want = this.c.tab.trim();
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
    const c = this.c;
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

  private async script(params: Record<string, string>): Promise<{ values?: Table; error?: string; tabs?: string[]; tab?: string; version?: number }> {
    const c = this.c;
    const u = new URL(c.url.trim());
    u.searchParams.set('token', c.token);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    const res = await this.http(u, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('The connector did not answer. Check it is deployed as a web app with access set to "Anyone".');
    }
  }

  private async post(body: Record<string, unknown>, what: string): Promise<{ ok?: boolean; created?: boolean; error?: string }> {
    const c = this.c;
    const res = await this.http(c.url.trim(), {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token: c.token, tab: c.tab.trim(), ...body }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; created?: boolean; error?: string };
    if (!j.ok) throw new Error(j.error === 'Unknown action' ? OLD_CONNECTOR : j.error ?? `The connector could not ${what}.`);
    return j;
  }

  async load(force = false, withTabs = false): Promise<Loaded> {
    const c = this.c;
    const mode = this.mode;
    switch (mode) {
      case 'none':
        throw new Error(c.kind === 'google' ? 'Paste your Google Sheets link first.' : 'Choose your spreadsheet file first.');
      case 'link':
        return this.readGoogle(c.url, withTabs);
      case 'script': {
        const j = await this.script({ tab: c.tab.trim() });
        if (j.error) {
          if (j.error === 'No tab with that name' && j.tabs) throw new NoSuchTab(c.tab.trim(), j.tabs);
          throw new Error(j.error === 'Wrong secret' ? 'The connector has a different secret. Copy the script from Lock In again.' : j.error);
        }
        return { table: j.values ?? [], tabs: j.tabs ?? [], tab: j.tab ?? c.tab.trim() };
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

  /** Chosen columns win; null = detect; -1 = "None". Lock In's own tab is always read as the template. */
  mapping(t: Table): ColumnMap {
    const c = this.d.cfg();
    const auto = detectColumns(t);
    if (c.own) return auto;
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
    const c = this.c;
    const a = analyzeTable(l.table, map, { scope: c.scope, now, owner: c.owner, me: this.me });
    this.rows = a.tasks;
    this.lastAnalysis = a;
    return a;
  }

  // ---- Lock In's own tab ------------------------------------------------------------

  private seedRows(): TemplateRow[] {
    return this.d.seed?.() ?? [];
  }

  /** Whether Lock In's tab is in the sheet already (without changing anything). */
  private async hasOwnTab(): Promise<boolean> {
    const c = this.c;
    switch (this.mode) {
      case 'xlsx':
        return readXlsxBook(new Uint8Array(readFileSync(c.path))).tabs.some((t) => t.toLowerCase() === TEMPLATE_TAB.toLowerCase());
      case 'numbers':
        return (await numbersTabs(c.path)).some((t) => t.toLowerCase() === TEMPLATE_TAB.toLowerCase());
      case 'script': {
        const j = await this.script({ tab: TEMPLATE_TAB });
        if (j.error === 'Wrong secret') throw new Error('The connector has a different secret. Copy the script from Lock In again.');
        if (!j.error) return true;
        if (j.error === 'No tab with that name' && !j.version) throw new Error(OLD_CONNECTOR);
        return false;
      }
      case 'csv':
        return existsSync(c.path) && readFileSync(c.path, 'utf8').trim() !== '';
      case 'link':
        throw new Error('To add a Lock In tab to a Google Sheet, Lock In needs the private connector (steps below, about 2 minutes). Or pick one of the tabs you have.');
      default:
        return false;
    }
  }

  /** Adds Lock In's tab (with your open to-dos) when it isn't there yet. True when it was added. */
  async ensureOwnTab(): Promise<boolean> {
    if (!this.d.cfg().own || this.tabReady) return false;
    if (await this.hasOwnTab()) {
      this.tabReady = true;
      return false;
    }
    const c = this.c;
    const seed = this.seedRows();
    let created = false;
    switch (this.mode) {
      case 'xlsx': {
        if (openInExcel(c.path)) throw new Error(`Close ${basename(c.path)} in Excel, then Lock In can add its tab.`);
        const out = addTemplateTab(new Uint8Array(readFileSync(c.path)), seed);
        if (out.created) {
          this.keepCopy(c.path);
          replaceFile(c.path, out.buf);
        }
        created = out.created;
        break;
      }
      case 'csv':
        if (existsSync(c.path) && openInExcel(c.path)) throw new Error(`Close ${basename(c.path)} in Excel, then Lock In can set it up.`);
        replaceFile(c.path, toCsv([[...TEMPLATE_HEADERS], ...seed.map((r) => templateCells(r).map((v) => (v && typeof v === 'object' ? v.date : v)) as Cell[])]));
        created = true;
        break;
      case 'numbers':
        created = await numbersAddTab(c.path, seed);
        break;
      case 'script':
        created = !!(await this.post({ action: 'setup', tab: TEMPLATE_TAB, rows: seed.map((r) => templateCells(r, true).map((v, i) => (i === TCOL.done && v === '' ? false : v))) }, 'add its tab')).created;
        break;
    }
    this.tabReady = true;
    this.fileMtime = 0;
    this.readAt = 0;
    return created;
  }

  private keepCopy(path: string): void {
    if (this.backedUp) return;
    this.backedUp = true;
    try {
      this.d.backup?.(path);
    } catch {
      /* a copy is a nicety */
    }
  }

  // ---- writing ----------------------------------------------------------------------

  /** What a tick looks like in this sheet's done column. */
  private doneValue(): Cell {
    const map = this.map;
    if (!map || map.done === null || !this.table) return 'Done';
    if (this.mode === 'numbers' && this.d.cfg().own) return true;
    return doneValueFor(this.table.slice(map.header + 1).map((r) => r[map.done!] ?? null));
  }

  /** The "Added" column, when the sheet has one (Lock In's tab does). */
  private addedCol(): number | null {
    const head = this.map && this.map.header >= 0 ? this.table?.[this.map.header] ?? [] : [];
    const i = head.findIndex((h) => /^(added|date added|created)$/i.test(s(h)));
    return i >= 0 ? i : null;
  }

  /** Writes cells and new rows into the sheet. Throws Busy when the file can't be written right now. */
  private async write(edits: CellEdit[], rows: TemplateRow[]): Promise<void> {
    const map = this.map;
    if (!map || map.task === null) throw new Error('Could not find a column of tasks.');
    const c = this.c;
    const mode = this.mode;
    const doneValue = this.doneValue();
    const added = this.addedCol();
    const cells = rows.map((r) => {
      const m = placeCells(r, map, doneValue);
      if (added !== null && r.added) m.set(added, { date: r.added });
      return m;
    });
    switch (mode) {
      case 'xlsx':
      case 'csv': {
        if (openInExcel(c.path)) throw new Busy(`${basename(c.path)} is open in Excel. Lock In writes to it once you close it.`);
        this.keepCopy(c.path);
        if (mode === 'xlsx') replaceFile(c.path, writeXlsx(new Uint8Array(readFileSync(c.path)), this.loaded?.tab ?? c.tab, edits, cells, map.task));
        else replaceFile(c.path, writeCsv(readFileSync(c.path, 'utf8'), extname(c.path).toLowerCase() === '.tsv' ? '\t' : undefined, edits, cells, map.task));
        this.fileMtime = 0;
        return;
      }
      case 'numbers':
        await numbersWrite(c.path, c.tab, edits, cells, map.task);
        this.readAt = 0;
        return;
      case 'script':
        for (const e of edits) {
          const task = this.rows.find((r) => r.row === e.row);
          if (task) await this.post({ action: 'complete', row: e.row, taskCol: map.task, doneCol: e.col, title: task.title, value: doneValue }, 'tick it off');
        }
        if (cells.length) await this.post({ action: 'add', taskCol: map.task, title: rows[0].title, rows: cells.map((m) => [...m.entries()]) }, 'add it');
        return;
      default:
        throw new Busy('This sheet is read-only from Lock In.');
    }
  }

  /** Writes what Lock In has been holding (new to-dos, ticks) into the sheet. True when something was written. */
  private async flush(state: TrackState): Promise<boolean> {
    if (!canWrite(this.mode) || !this.map || this.map.task === null) return false;
    const pending = (state.pending ?? []).filter((p) => !p.flushed);
    const ticks = this.map.done === null ? [] : this.rows.filter((r) => state.local?.[r.id] && !this.sheetDone(r));
    if (!pending.length && !ticks.length) return false;
    try {
      await this.write(
        ticks.map((r) => ({ row: r.row, col: this.map!.done!, value: this.doneValue() })),
        pending.map((p) => ({ title: p.title, due: p.due, priority: p.priority, project: p.project, done: !!p.done, added: localDate(p.at) })),
      );
      for (const p of pending) p.flushed = true;
      this.waiting = undefined;
      return true;
    } catch (e) {
      // Kept in Lock In and tried again on the next read; the to-dos page says why.
      this.waiting = (e as Error).message;
      return false;
    }
  }

  /** Done in the sheet itself (not just ticked in Lock In). */
  private sheetDone(r: RowTask): boolean {
    const map = this.map;
    return !!map && map.done !== null && isDone(this.table?.[r.row]?.[map.done] ?? null);
  }

  async fetch(now = Date.now(), force = false): Promise<TodoSnapshot> {
    await this.ensureOwnTab();
    let l = await this.load(force);
    let a = this.analyze(l, now);
    if (this.map!.task === null) throw new Error('Could not find a column of tasks. Pick it on the To-dos page.');
    const sig = `${l.tab}|${this.map!.header}|${this.map!.task}|${a.owner}`;
    let prev = this.d.loadState();
    // A different tab or table: start today's count fresh, keeping your ticks and new to-dos.
    if (prev && prev.sig !== sig) {
      const present = new Set(this.rows.map((r) => r.id));
      const keep: TrackState['local'] = {};
      for (const [id, v] of Object.entries(prev.local ?? {})) if (present.has(id)) keep[id] = v;
      prev = { day: dayKey(now), open: {}, done: {}, local: keep, pending: prev.pending };
    }
    // Anything held in Lock In goes into the sheet now, if it can; then read what the sheet says.
    if (prev && (await this.flush(prev))) {
      this.d.saveState(prev);
      l = await this.load(true);
      a = this.analyze(l, now);
    }
    const map = this.map!;
    const present = new Set(this.rows.map((r) => r.id));
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

    // New to-dos made in Lock In: shown until the sheet has them, kept on Done today once ticked.
    const today = dayKey(now);
    const count = (title: string) => this.rows.filter((r) => norm(r.title) === norm(title)).length;
    const pending = (prev?.pending ?? []).filter((p) => {
      if (!p.flushed && count(p.title) > p.seen) p.flushed = true; // someone typed it into the sheet
      if (p.done && dayKey(p.done) !== today) return false;
      return !p.flushed || !!p.done;
    });
    state.pending = pending;
    this.d.saveState(state);
    const extraOpen = pending.filter((p) => !p.flushed && !p.done).map<Task>((p) => ({ id: p.id, title: p.title, due: p.due, priority: p.priority, project: p.project, completed: false }));
    const extraDone = pending.filter((p) => p.done).map<Task>((p) => ({ id: p.id, title: p.title, completed: true, completedAt: p.done, localOnly: !p.flushed }));
    return {
      open: [...this.rows.filter((r) => !r.completed).map(({ row: _r, ...task }) => task), ...extraOpen],
      doneToday: [...doneToday.map((d) => (local[d.id] ? { ...d, localOnly: true } : d)), ...extraDone],
      fetchedAt: now,
    };
  }

  /** Un-tick something that was ticked in Lock In only. */
  async undo(id: string): Promise<boolean> {
    const st = this.stateNow(Date.now());
    const p = st.pending?.find((x) => x.id === id);
    if (p) {
      if (p.flushed) return false;
      p.done = undefined;
      this.d.saveState(st);
      return true;
    }
    if (!st.local?.[id]) return false;
    delete st.local[id];
    this.d.saveState(st);
    return true;
  }

  async complete(id: string): Promise<boolean> {
    const now = Date.now();
    const st = this.stateNow(now);
    const p = st.pending?.find((x) => x.id === id);
    if (p) {
      p.done = now;
      this.d.saveState(st);
      return true;
    }
    // A file may have changed since the last read (rows inserted): find the row again first.
    if (this.writesBack && (this.mode === 'xlsx' || this.mode === 'csv')) this.analyze(await this.load(true), now);
    const task = this.rows.find((r) => r.id === id);
    const map = this.map;
    if (!task || !map || map.task === null) return false;
    // Remembered right away; the next read writes it into the sheet (or keeps it, for a sheet that can't be written).
    st.local = { ...(st.local ?? {}), [id]: { title: task.title, at: now } };
    this.d.saveState(st);
    if (this.writesBack) {
      try {
        await this.write([{ row: task.row, col: map.done!, value: this.doneValue() }], []);
        this.waiting = undefined;
      } catch (e) {
        this.waiting = (e as Error).message;
      }
    }
    return true;
  }

  async add(title: string): Promise<boolean> {
    const t = title.trim();
    if (!t) return false;
    const now = Date.now();
    const st = this.stateNow(now);
    const seen = this.rows.filter((r) => norm(r.title) === norm(t)).length;
    st.pending = [...(st.pending ?? []), { id: `new:${randomUUID()}`, title: t, at: now, seen }];
    this.d.saveState(st);
    return true;
  }

  /** Drops a to-do that was added in Lock In and isn't in the sheet yet. */
  async remove(id: string): Promise<boolean> {
    const st = this.stateNow(Date.now());
    const before = st.pending?.length ?? 0;
    st.pending = (st.pending ?? []).filter((p) => p.id !== id || p.flushed);
    if (st.pending.length === before) return false;
    this.d.saveState(st);
    return true;
  }

  /** Open to-dos in the sheet, for when you stop using it (Lock In keeps them). */
  openRows(): TemplateRow[] {
    return this.rows.filter((r) => !r.completed).map((r) => ({ title: r.title, due: r.due, priority: r.priority, project: r.project }));
  }

  /** For the setup screen: what Lock In sees in the sheet right now. */
  async preview(): Promise<SheetPreview> {
    const mode = this.mode;
    const empty: SheetPreview = {
      ok: false, columns: [], map: { task: null, done: null, due: null, priority: null, assignee: null, project: null }, open: 0, done: 0, sample: [],
      canComplete: false, canAdd: false, mode, tabs: [], tab: '', headerRow: null, skipped: 0, skippedSample: [], owners: [], owner: '', writable: canWrite(mode),
    };
    let l: Loaded | null = null;
    try {
      // Lock In's tab, not there yet: say what connecting will do.
      if (this.d.cfg().own && !(await this.hasOwnTab())) {
        let tabs: string[] = [];
        try {
          tabs = mode === 'xlsx' ? readXlsxBook(new Uint8Array(readFileSync(this.c.path))).tabs : mode === 'script' ? (await this.script({})).tabs ?? [] : [];
        } catch {
          /* only for the tab list */
        }
        const seed = this.seedRows();
        return { ...empty, ok: true, canComplete: true, canAdd: true, tab: TEMPLATE_TAB, tabs, willCreate: true, seed: seed.length, sample: seed.slice(0, 5).map((r) => r.title), open: seed.length };
      }
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
        canAdd: this.addsToSheet,
        mode,
        tabs: l.tabs,
        tab: l.tab,
        tabWhy: l.tabWhy,
        headerRow: map.header >= 0 ? map.header + 1 : null,
        skipped: junk.length,
        skippedSample: junk.slice(0, 4).map((x) => x.title),
        owners: a.owners,
        owner: a.owner,
        writable: canWrite(mode),
      };
    } catch (e) {
      return { ...empty, tabs: l?.tabs ?? (e instanceof NoSuchTab ? e.tabs : []), error: (e as Error).message };
    }
  }
}
