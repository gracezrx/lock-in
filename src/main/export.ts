// The daily export: CSV files you can open in Excel, Numbers or Google Sheets.
//   Lock In - to-dos by day.csv  every to-do on your list each day, open or done
//   Lock In - done log.csv       every task you finished, one row each, forever
//   Lock In - deadlines.csv      every deadline, done or not
//   Lock In - daily summary.csv  one row per day: tasks done, focus, drift, meetings, screen time
//   Lock In - sessions.csv       every focus session
//   Days/2026-10-24.csv          one day, in order: what you finished, sessions, meetings, what was left
// The files are rebuilt from Lock In's records each time, so they never double up.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Deadline, SessionRecord } from '../shared/types';
import { dayKey } from './todos/day';
import type { DoneEntry } from './todos/donelog';
import type { TodoDay } from './todos/history';

export interface MeetingRow {
  title: string;
  start: number;
  end: number;
}

export interface ExportData {
  done: DoneEntry[];
  sessions: SessionRecord[];
  /** Active screen seconds per day. */
  days: Record<string, { activeSec: number }>;
  meetings: Record<string, MeetingRow[]>;
  /** Every to-do seen each day (open and done). */
  todoDays?: TodoDay[];
  deadlines?: Deadline[];
}

export interface ExportFile {
  name: string;
  content: string;
}

type Cell = string | number | null | undefined;

/** RFC 4180 CSV with a byte-order mark so Excel reads accents and Chinese correctly. */
export function csv(rows: Cell[][]): string {
  const cell = (v: Cell) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const mins = (sec: number) => Math.round(sec / 60);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (day: string) => WEEKDAYS[new Date(`${day}T12:00:00`).getDay()];

export const HOW: Record<DoneEntry['source'], string> = {
  list: 'Ticked in your list',
  lockin: 'Ticked in Lock In',
  said: 'Told the coach',
  typed: 'Told the coach (typed)',
};

function topDistraction(ss: SessionRecord[]): string {
  const t: Record<string, number> = {};
  for (const s of ss) for (const [k, v] of Object.entries(s.topDistractions ?? {})) t[k] = (t[k] ?? 0) + v;
  const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
  return top ? `${top[0]} (${mins(top[1])} min)` : '';
}

export function buildExport(d: ExportData, opts: { now?: number; recentDays?: number } = {}): ExportFile[] {
  const now = opts.now ?? Date.now();
  const recent = opts.recentDays ?? 7;
  const sessions = d.sessions.filter((s) => s.startedAt <= now).sort((a, b) => a.startedAt - b.startedAt);
  const done = [...d.done].sort((a, b) => a.at - b.at);

  const byDay = new Map<string, { done: DoneEntry[]; sessions: SessionRecord[]; meetings: MeetingRow[] }>();
  const bucket = (day: string) => {
    let b = byDay.get(day);
    if (!b) byDay.set(day, (b = { done: [], sessions: [], meetings: [] }));
    return b;
  };
  for (const e of done) bucket(e.day).done.push(e);
  for (const s of sessions) bucket(dayKey(s.startedAt)).sessions.push(s);
  for (const [day, ms] of Object.entries(d.meetings)) bucket(day).meetings.push(...ms);
  for (const day of Object.keys(d.days)) bucket(day);
  const todoDays = new Map((d.todoDays ?? []).map((t) => [t.day, t]));
  for (const day of todoDays.keys()) bucket(day);
  const days = [...byDay.keys()].sort();

  const files: ExportFile[] = [];

  // Every to-do, every day: what was on the list, and whether it got done.
  const todoRows: Cell[][] = [];
  for (const t of [...todoDays.values()].sort((a, b) => a.day.localeCompare(b.day))) {
    const rows = [...t.rows].sort((a, b) => Number(b.status === 'done') - Number(a.status === 'done') || (a.doneAt ?? a.firstSeen) - (b.doneAt ?? b.firstSeen));
    for (const r of rows) {
      const overdue = r.status === 'open' && !!r.due && r.due < t.day;
      todoRows.push([t.day, weekday(t.day), r.title, r.status === 'done' ? 'Done' : 'Open', r.due ?? '', overdue ? 'Yes' : '', r.project ?? '', r.list ?? '', r.doneAt ? hhmm(r.doneAt) : '', r.source ? HOW[r.source] : '', hhmm(r.firstSeen)]);
    }
  }
  files.push({ name: 'Lock In - to-dos by day.csv', content: csv([['Date', 'Day', 'Task', 'Status', 'Due', 'Overdue', 'Project', 'List', 'Done at', 'How', 'First seen'], ...todoRows]) });

  if (d.deadlines) {
    const dl = [...d.deadlines].sort((a, b) => a.due.localeCompare(b.due) || (a.time ?? '').localeCompare(b.time ?? ''));
    files.push({
      name: 'Lock In - deadlines.csv',
      content: csv([
        ['Deadline', 'Due date', 'Due time', 'Status', 'Done on', 'Project', 'Added on'],
        ...dl.map((x) => [x.title, x.due, x.time ?? '', x.done ? 'Done' : x.due < dayKey(now) ? 'Overdue' : 'Open', x.doneAt ? `${dayKey(x.doneAt)} ${hhmm(x.doneAt)}` : '', x.project ?? '', dayKey(x.createdAt)]),
      ]),
    });
  }

  files.push({
    name: 'Lock In - done log.csv',
    content: csv([['Date', 'Day', 'Time', 'Task', 'Project', 'List', 'How'], ...done.map((e) => [e.day, weekday(e.day), hhmm(e.at), e.title, e.project ?? '', e.list ?? '', HOW[e.source]])]),
  });

  files.push({
    name: 'Lock In - daily summary.csv',
    content: csv([
      ['Date', 'Day', 'Tasks done', 'Focus minutes', 'Drifting minutes', 'Sessions', 'Screen minutes', 'Meetings', 'Meeting minutes', 'Top distraction', 'What got done'],
      ...days.map((day) => {
        const b = byDay.get(day)!;
        const meetingMin = b.meetings.reduce((n, m) => n + Math.round((m.end - m.start) / 60_000), 0);
        return [
          day,
          weekday(day),
          b.done.length,
          mins(b.sessions.reduce((n, s) => n + s.focusSec, 0)),
          mins(b.sessions.reduce((n, s) => n + s.driftSec, 0)),
          b.sessions.length,
          d.days[day] ? mins(d.days[day].activeSec) : '',
          b.meetings.length,
          meetingMin,
          topDistraction(b.sessions),
          b.done.map((e) => e.title).join('; '),
        ];
      }),
    ]),
  });

  files.push({
    name: 'Lock In - sessions.csv',
    content: csv([
      ['Date', 'Start', 'End', 'Goal', 'Planned minutes', 'Focus minutes', 'Drifting minutes', 'Call-outs', 'Top distraction', 'Ended'],
      ...sessions.map((s) => [
        dayKey(s.startedAt),
        hhmm(s.startedAt),
        s.endedAt ? hhmm(s.endedAt) : '',
        s.goal,
        s.plannedMin,
        mins(s.focusSec),
        mins(s.driftSec),
        s.interventions,
        topDistraction([s]),
        s.endedBy === 'timer' ? 'Timer' : s.endedBy === 'user' ? 'Early' : s.endedBy === 'quit' ? 'App closed' : 'Running',
      ]),
    ]),
  });

  // One file per recent day, in time order.
  const cutoff = dayKey(now - recent * 86_400_000);
  for (const day of days) {
    if (day < cutoff) continue;
    const b = byDay.get(day)!;
    const rows: { t: number; r: Cell[] }[] = [];
    for (const e of b.done) rows.push({ t: e.at, r: [hhmm(e.at), 'Done', e.title, e.project ?? '', '', HOW[e.source]] });
    for (const s of b.sessions) {
      rows.push({ t: s.startedAt, r: [hhmm(s.startedAt), 'Focus session', s.goal || 'Focus', '', mins(s.focusSec), `${mins(s.driftSec)} min drifting${s.interventions ? `, ${s.interventions} call-outs` : ''}`] });
    }
    for (const m of b.meetings) rows.push({ t: m.start, r: [hhmm(m.start), 'Meeting', m.title, '', Math.round((m.end - m.start) / 60_000), `until ${hhmm(m.end)}`] });
    // What was still on the list, at the end.
    for (const r of todoDays.get(day)?.rows ?? []) {
      if (r.status === 'open') rows.push({ t: Number.MAX_SAFE_INTEGER, r: ['', 'Still open', r.title, r.project ?? '', '', r.due ? `due ${r.due}` : ''] });
    }
    if (!rows.length) continue;
    rows.sort((a, b2) => a.t - b2.t);
    files.push({ name: join('Days', `${day}.csv`), content: csv([['Time', 'Type', 'What', 'Project', 'Minutes', 'Notes'], ...rows.map((x) => x.r)]) });
  }
  return files;
}

export function writeExport(folder: string, files: ExportFile[]): void {
  mkdirSync(join(folder, 'Days'), { recursive: true });
  for (const f of files) writeFileSync(join(folder, f.name), f.content, 'utf8');
}
