// The Google connector script (the code people paste into Apps Script), run for real against a
// stand-in for Google Sheets, with Lock In talking to it the way it does over the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { SheetProvider, appsScript, type TrackState } from '../src/main/todos/sheet';
import { TEMPLATE_HEADERS, ownTabName } from '../src/main/todos/template';
import { DEFAULT_TODO } from '../src/shared/templates';
import type { SheetSettings } from '../src/shared/types';

type V = string | number | boolean | Date;

/** Just enough of Google Sheets for the connector: tabs of cells, checkboxes, validation. */
class FakeSheet {
  rows: V[][] = [];
  boxes = new Set<string>();
  frozen = 0;
  rules: unknown[] = [];
  constructor(public name: string, public maxRows = 1000) {}
  getName() {
    return this.name;
  }
  getMaxRows() {
    return this.maxRows;
  }
  cell(r: number, c: number): V {
    return this.rows[r]?.[c] ?? '';
  }
  put(r: number, c: number, v: V) {
    while (this.rows.length <= r) this.rows.push([]);
    while (this.rows[r].length <= c) this.rows[r].push('');
    this.rows[r][c] = v;
  }
  /** Like Google: the data range runs to the last row and column with anything in them (FALSE counts). */
  getDataRange() {
    const h = Math.max(1, ...this.rows.map((r, i) => (r.some((v) => v !== '') ? i + 1 : 0)));
    const w = Math.max(1, ...this.rows.map((r) => r.reduce((n: number, v, i) => (v !== '' ? i + 1 : n), 0)));
    return { getValues: () => Array.from({ length: h }, (_, r) => Array.from({ length: w }, (_, c) => this.cell(r, c))) };
  }
  getRange(row: number, col: number, nr = 1, nc = 1) {
    const sh = this;
    const cells = () => Array.from({ length: nr }, (_, r) => Array.from({ length: nc }, (_, c) => [row - 1 + r, col - 1 + c] as const));
    const range = {
      setValues(vals: V[][]) {
        vals.forEach((rv, r) => rv.forEach((v, c) => sh.put(row - 1 + r, col - 1 + c, v)));
        return range;
      },
      setValue(v: V) {
        sh.put(row - 1, col - 1, v);
        return range;
      },
      insertCheckboxes() {
        for (const line of cells()) for (const [r, c] of line) {
          sh.boxes.add(`${r}:${c}`);
          sh.put(r, c, false);
        }
        return range;
      },
      getDataValidation() {
        return sh.boxes.has(`${row - 1}:${col - 1}`) ? { getCriteriaType: () => 'CHECKBOX' } : null;
      },
      setFontWeight: () => range,
      setBackground: () => range,
      setDataValidation: () => range,
      setNumberFormat: () => range,
    };
    return range;
  }
  setFrozenRows(n: number) {
    this.frozen = n;
  }
  setTabColor() {}
  setColumnWidth() {}
  setConditionalFormatRules(r: unknown[]) {
    this.rules = r;
  }
}

function fakeGoogle(tabs: FakeSheet[]) {
  const chain = (): Record<string, unknown> => new Proxy({}, { get: (_t, k) => (k === 'build' ? () => ({}) : () => chain()) });
  const ctx = createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheets: () => tabs,
        insertSheet: (name: string) => {
          const s = new FakeSheet(name);
          tabs.push(s);
          return s;
        },
      }),
      newDataValidation: chain,
      newConditionalFormatRule: chain,
      DataValidationCriteria: { CHECKBOX: 'CHECKBOX' },
    },
    ContentService: { createTextOutput: (t: string) => ({ setMimeType: () => ({ text: t }) }), MimeType: { JSON: 'json' } },
    LockService: { getDocumentLock: () => ({ waitLock: () => undefined, releaseLock: () => undefined }) },
  });
  return ctx;
}

/** Lock In's requests, answered by the pasted script (JSON in and out, like the real web app). */
function serve(ctx: ReturnType<typeof fakeGoogle>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const out = init?.method === 'POST'
      ? (ctx.doPost as (e: unknown) => { text: string })({ postData: { contents: String(init.body) } })
      : (ctx.doGet as (e: unknown) => { text: string })({ parameter: Object.fromEntries(new URL(String(url)).searchParams) });
    // Dates come back as strings over the wire.
    return new Response(out.text, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const NOW = new Date('2026-11-26T10:00:00').getTime();
const URL_EXEC = 'https://script.google.com/macros/s/AKfycbTEST/exec';

function teammate(http: typeof fetch, cfg: SheetSettings, seed: string[] = []) {
  let state: TrackState | null = null;
  return new SheetProvider({ cfg: () => cfg, http, loadState: () => state, saveState: (s) => (state = structuredClone(s)), seed: () => seed.map((title) => ({ title })), clock: () => NOW });
}

test('tab names: one per person, within what Excel allows', () => {
  assert.equal(ownTabName('Grace'), 'Lock In · Grace');
  assert.equal(ownTabName(''), 'Lock In');
  assert.equal(ownTabName('Ana [design]/ops?'), 'Lock In · Ana design ops');
  assert.ok(ownTabName('A very long name that goes on and on').length <= 31);
});

test('the real connector script: a team shares one Google Sheet, each with their own tab', async () => {
  const tabs = [new FakeSheet('Roadmap')];
  tabs[0].rows = [['Feature', 'Owner'], ['Login', 'Sam']];
  const ctx = fakeGoogle(tabs);
  runInContext(appsScript('team-secret'), ctx);
  const http = serve(ctx);

  // Grace set the connector up; Sam pastes the team link (the secret rides along in it).
  const grace = teammate(http, { ...DEFAULT_TODO.sheet, url: URL_EXEC, token: 'team-secret', own: true, tab: ownTabName('Grace') }, ['Send the investor update']);
  const sam = teammate(http, { ...DEFAULT_TODO.sheet, url: `${URL_EXEC}?token=team-secret`, token: 'his-own-secret', own: true, tab: ownTabName('Sam') }, ['Fix the login bug']);

  const pv = await grace.preview();
  assert.equal(pv.willCreate, true);
  assert.deepEqual(pv.tabs, ['Roadmap']);
  const g0 = await grace.fetch(NOW);
  const s0 = await sam.fetch(NOW);
  assert.deepEqual(tabs.map((t) => t.name), ['Roadmap', 'Lock In · Grace', 'Lock In · Sam']);
  assert.deepEqual(g0.open.map((t) => t.title), ['Send the investor update']);
  assert.deepEqual(s0.open.map((t) => t.title), ['Fix the login bug'], 'only his own tab');
  const gTab = tabs[1];
  assert.deepEqual(gTab.rows[0], [...TEMPLATE_HEADERS]);
  assert.equal(gTab.frozen, 1);
  assert.equal(gTab.cell(1, 0), false, 'a checkbox, not ticked');
  assert.ok(gTab.boxes.has('1:0'));
  assert.deepEqual(tabs[0].rows, [['Feature', 'Owner'], ['Login', 'Sam']], 'other tabs untouched');

  // Grace adds two (typed, and told the coach she already did one): they land under her last task,
  // not under the hundreds of empty checkboxes.
  await grace.add('Book the offsite');
  await grace.addDone('Called the bank');
  const g1 = await grace.fetch(NOW + 1000);
  assert.deepEqual(gTab.rows.slice(1, 4).map((r) => [r[0], r[1]]), [[false, 'Send the investor update'], [false, 'Book the offsite'], [true, 'Called the bank']]);
  assert.ok(gTab.rows[3][6], 'Added date');
  assert.deepEqual(g1.open.map((t) => t.title).sort(), ['Book the offsite', 'Send the investor update']);
  assert.deepEqual(g1.doneToday.map((t) => [t.title, !!t.localOnly]), [['Called the bank', false]]);

  // Ticked in Lock In: the checkbox in the sheet.
  await grace.complete(g1.open.find((t) => t.title === 'Send the investor update')!.id);
  assert.equal(gTab.cell(1, 0), true);
  const g2 = await grace.fetch(NOW + 2000);
  assert.deepEqual(g2.open.map((t) => t.title), ['Book the offsite']);
  assert.deepEqual(g2.doneToday.map((t) => t.title).sort(), ['Called the bank', 'Send the investor update']);

  // Ticked in the sheet by hand: done in Lock In on the next read.
  tabs[2].put(1, 0, true);
  const s1 = await sam.fetch(NOW + 3000);
  assert.deepEqual(s1.open, []);
  assert.deepEqual(s1.doneToday.map((t) => t.title), ['Fix the login bug']);

  // A wrong secret is refused, with a message that says what to do.
  const stranger = teammate(http, { ...DEFAULT_TODO.sheet, url: URL_EXEC, token: 'nope', own: true, tab: ownTabName('Eve') });
  assert.match((await stranger.preview()).error ?? '', /different secret/);
  assert.equal(tabs.length, 3, 'no tab for a stranger');
});
