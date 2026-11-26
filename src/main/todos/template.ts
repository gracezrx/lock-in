// The "Lock In" tab Lock In adds to your spreadsheet: one row per to-do, the same columns in
// Google Sheets, Excel, Numbers and CSV. Anything you add or tick in Lock In is written here,
// and rows you add here show up in Lock In.
import type { Cell } from './sheet';

export const TEMPLATE_TAB = 'Lock In';

/**
 * Your own tab's name: "Lock In · Grace", so a team sharing one spreadsheet each gets a tab.
 * Kept to what Excel allows (31 characters, none of : \\ / ? * [ ]).
 */
export function ownTabName(name: string): string {
  const n = name.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return n ? `${TEMPLATE_TAB} · ${n}`.slice(0, 31).trim() : TEMPLATE_TAB;
}
export const TEMPLATE_HEADERS = ['Done', 'Task', 'Due', 'Priority', 'Project', 'Notes', 'Added'] as const;

/** Column numbers in the template (0 = A). */
export const TCOL = { done: 0, task: 1, due: 2, priority: 3, project: 4, notes: 5, added: 6 } as const;

/** A date to write as a real date cell where the sheet has them (YYYY-MM-DD, local). */
export interface DateCell {
  date: string;
}

/** A value to write: text, a number, a tick, a date, or empty. */
export type WCell = Cell | DateCell;

export interface TemplateRow {
  title: string;
  done?: boolean;
  /** YYYY-MM-DD */
  due?: string;
  /** 0-3, as on tasks. */
  priority?: number;
  project?: string;
  /** YYYY-MM-DD the row was added. */
  added?: string;
}

export const PRIORITY_LABELS = ['', 'Low', 'Medium', 'High'] as const;

export function priorityLabel(p: number | undefined): string {
  return PRIORITY_LABELS[Math.max(0, Math.min(3, Math.round(p ?? 0)))];
}

/** The template row as cells, in column order. `doneValue` is what a tick looks like in this sheet. */
export function templateCells(r: TemplateRow, doneValue: Cell = 'Done'): WCell[] {
  return [
    r.done ? doneValue : '',
    r.title.trim(),
    r.due ? { date: r.due } : '',
    priorityLabel(r.priority),
    r.project?.trim() ?? '',
    '',
    r.added ? { date: r.added } : '',
  ];
}

/** A row's cells placed into a sheet's own columns (for a tab that isn't the template). */
export function placeCells(
  r: TemplateRow,
  map: { task: number | null; done: number | null; due: number | null; priority: number | null; project?: number | null },
  doneValue: Cell,
): Map<number, WCell> {
  const out = new Map<number, WCell>();
  if (map.task === null) return out;
  out.set(map.task, r.title.trim());
  if (map.done !== null && r.done) out.set(map.done, doneValue);
  if (map.due !== null && map.due !== undefined && r.due) out.set(map.due, { date: r.due });
  if (map.priority !== null && map.priority !== undefined && r.priority) out.set(map.priority, priorityLabel(r.priority));
  if (map.project !== null && map.project !== undefined && r.project) out.set(map.project, r.project);
  return out;
}

const DONE_WORDS = /^(done|complete|completed|finished|yes|y|x|✓|✔|☑|✅|true)$/i;

/**
 * What a tick looks like in this column, copied from the ticks already there: a real checkbox
 * (true), or the word people use ("x", "Done", "✓"). "Done" when there's nothing to copy.
 */
export function doneValueFor(column: Cell[]): Cell {
  let bools = 0;
  const words = new Map<string, number>();
  for (const v of column) {
    if (typeof v === 'boolean') bools++;
    else if (typeof v === 'string' && DONE_WORDS.test(v.trim())) words.set(v.trim(), (words.get(v.trim()) ?? 0) + 1);
  }
  if (bools && bools >= Math.max(0, ...words.values())) return true;
  const best = [...words.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'Done';
}
