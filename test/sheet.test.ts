import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import {
  SheetProvider, analyzeTable, appsScript, colIndex, colName, detectColumns, findHeader, findPointer, googleCsvUrl, isDone, isMe, isScriptUrl, matchTab,
  parseCsv, parseDue, parsePriority, pickTab, readXlsx, readXlsxBook, sheetMode, tableToTasks, track, type Cell, type Table, type TrackState,
} from '../src/main/todos/sheet';
import { parseMdDate, parseMdlsRaw } from '../src/main/apps';
import { DEFAULT_TODO, buildDefaultProfile, combineRoles, roleText, suggestWorkApps } from '../src/shared/templates';
import type { SheetSettings } from '../src/shared/types';

const NOW = new Date('2026-10-19T10:00:00').getTime();

test('column letters', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colIndex('AB'), 27);
});

test('done, priority and date values in all their usual shapes', () => {
  for (const v of [true, 'TRUE', 'x', '✓', 'Done', 'Completed ✅', 'yes', 1]) assert.equal(isDone(v), true, String(v));
  for (const v of [false, 'FALSE', '', 'In progress', 'Not done', 'To do', 'incomplete', null, 0]) assert.equal(isDone(v), false, String(v));
  assert.equal(parsePriority('High'), 3);
  assert.equal(parsePriority('P2'), 2);
  assert.equal(parsePriority(3), 1);
  assert.equal(parseDue('2026-10-17', NOW), '2026-10-17');
  assert.equal(parseDue('10/17/2026', NOW), '2026-10-17');
  assert.equal(parseDue('10/17', NOW), '2026-10-17');
  assert.equal(parseDue('Oct 17', NOW), '2026-10-17');
  assert.equal(parseDue('17 October 2026', NOW), '2026-10-17');
  assert.equal(parseDue(46312, NOW), '2026-10-17', 'Excel serial');
  assert.equal(parseDue('today', NOW), '2026-10-19');
  assert.equal(parseDue('soon', NOW), undefined);
});

test('CSV parsing with quotes, commas and line breaks', () => {
  const t = parseCsv('Task,Done\n"Email Sam, then call",FALSE\r\n"Write ""the"" memo\nline 2",TRUE\n');
  assert.deepEqual(t[1], ['Email Sam, then call', 'FALSE']);
  assert.deepEqual(t[2], ['Write "the" memo\nline 2', 'TRUE']);
});

test('detects columns from headers', () => {
  const t: Table = [
    ['Priority', 'Task', 'Due date', 'Done?'],
    ['High', 'Send the investor update', '10/18/2026', false],
    ['', 'Book flights', '', true],
  ];
  const m = detectColumns(t);
  assert.deepEqual(m, { header: 0, task: 1, done: 3, due: 2, priority: 0, assignee: null, project: null });
  const tasks = tableToTasks(t, m, 'all', NOW);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].priority, 3);
  assert.equal(tasks[0].due, '2026-10-18');
  assert.equal(tasks[1].completed, true);
});

test('detects columns with no header row, from the values', () => {
  const t: Table = [
    [false, 'Finish the pitch deck', 'Oct 20'],
    [true, 'Reply to Sam', 'Oct 18'],
    [false, 'Read the Q3 memo', ''],
  ];
  const m = detectColumns(t);
  assert.equal(m.header, -1);
  assert.equal(m.done, 0);
  assert.equal(m.task, 1);
  assert.equal(m.due, 2);
  assert.equal(tableToTasks(t, m, 'all', NOW).length, 3);
});

test('a status column with words works as the done column', () => {
  const t: Table = [['To-do', 'Status'], ['Deck', 'In progress'], ['Memo', 'Done'], ['Email', 'Not started']];
  const m = detectColumns(t);
  assert.equal(m.task, 0);
  assert.equal(m.done, 1);
  assert.deepEqual(tableToTasks(t, m, 'all', NOW).filter((x) => x.completed).map((x) => x.title), ['Memo']);
});

test('"due today or earlier" scope keeps undated and overdue rows', () => {
  const t: Table = [['Task', 'Due'], ['Later', '2026-11-01'], ['Overdue', '2026-10-01'], ['Undated', ''], ['Today', '2026-10-19']];
  const m = detectColumns(t);
  assert.deepEqual(tableToTasks(t, m, 'due', NOW).map((x) => x.title), ['Overdue', 'Undated', 'Today']);
});

test('duplicate task names get separate ids', () => {
  const t: Table = [['Task'], ['Gym'], ['Gym']];
  const ids = tableToTasks(t, detectColumns(t), 'all', NOW).map((x) => x.id);
  assert.notEqual(ids[0], ids[1]);
});

test('tracking: a row ticked after the first read counts as done today; one already ticked does not', () => {
  const t0: Table = [['Task', 'Done'], ['A', false], ['B', false], ['C', true]];
  const m = detectColumns(t0);
  let r = track(null, tableToTasks(t0, m, 'all', NOW), NOW, false);
  assert.equal(r.doneToday.length, 0);
  const t1: Table = [['Task', 'Done'], ['A', true], ['B', false], ['C', true]];
  r = track(r.state, tableToTasks(t1, m, 'all', NOW + 60_000), NOW + 60_000, false);
  assert.deepEqual(r.doneToday.map((x) => x.title), ['A']);
  // Un-ticked again → no longer done.
  r = track(r.state, tableToTasks(t0, m, 'all', NOW + 120_000), NOW + 120_000, false);
  assert.equal(r.doneToday.length, 0);
});

test('tracking: lists without a done column count deleted rows as done, but not an empty read', () => {
  const m = { header: 0, task: 0, done: null, due: null, priority: null, assignee: null, project: null };
  const full: Table = [['Task'], ['A'], ['B']];
  let r = track(null, tableToTasks(full, m, 'all', NOW), NOW, true);
  r = track(r.state, tableToTasks([['Task'], ['B']], m, 'all', NOW), NOW, true);
  assert.deepEqual(r.doneToday.map((x) => x.title), ['A']);
  const r2 = track(r.state, [], NOW, true);
  assert.deepEqual(r2.doneToday.map((x) => x.title), ['A'], 'an empty read changes nothing');
});

test('tracking: a new day starts a new count', () => {
  const m = detectColumns([['Task', 'Done']]);
  const prev: TrackState = { day: '2026-10-18', open: {}, done: { 'row:x#1': { title: 'x', at: NOW - 86_400_000 } } };
  const r = track(prev, tableToTasks([['Task', 'Done'], ['x', true]], { ...m, task: 0, done: 1 }, 'all', NOW), NOW, false);
  assert.equal(r.doneToday.length, 0);
});

test('reads an .xlsx file: shared strings, booleans, inline strings, dates and tabs', () => {
  const xml = (s: string) => strToU8(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
  const zip = zipSync({
    'xl/workbook.xml': xml('<workbook><sheets><sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="To-dos" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': xml('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>'),
    'xl/sharedStrings.xml': xml('<sst><si><t>Task</t></si><si><t>Done</t></si><si><r><t>Pitch </t></r><r><t>deck &amp; memo</t></r></si><si><t>Due</t></si></sst>'),
    'xl/worksheets/sheet1.xml': xml('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>nothing</t></is></c></row></sheetData></worksheet>'),
    'xl/worksheets/sheet2.xml': xml(
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="b"><v>0</v></c><c r="C3"><v>46312</v></c></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t>Email Sam</t></is></c><c r="B4" t="b"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    ),
  });
  const t = readXlsx(zip, 'to-dos');
  assert.deepEqual(t[0], ['Task', 'Done', 'Due']);
  assert.deepEqual(t[1], [], 'missing row 2 is kept as an empty row');
  assert.deepEqual(t[2], ['Pitch deck & memo', false, 46312]);
  const tasks = tableToTasks(t, detectColumns(t), 'all', NOW);
  assert.deepEqual(tasks.map((x) => [x.title, x.completed, x.due]), [['Pitch deck & memo', false, '2026-10-17'], ['Email Sam', true, undefined]]);
  assert.equal(readXlsx(zip)[0][0], 'nothing', 'first tab by default');
  assert.throws(() => readXlsx(zip, 'Nope'), /Tabs: Notes, To-dos/);
});

test('Google links and modes', () => {
  assert.equal(googleCsvUrl('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=77'), 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=77');
  assert.equal(googleCsvUrl('https://example.com'), null);
  assert.ok(isScriptUrl('https://script.google.com/macros/s/AKfy/exec'));
  const base: SheetSettings = { ...DEFAULT_TODO.sheet };
  assert.equal(sheetMode({ ...base, url: 'https://docs.google.com/spreadsheets/d/x/edit' }), 'link');
  assert.equal(sheetMode({ ...base, url: 'https://script.google.com/macros/s/AKfy/exec' }), 'script');
  assert.equal(sheetMode({ ...base, kind: 'file', path: '/Users/g/todo.numbers' }), 'numbers');
  assert.equal(sheetMode({ ...base, kind: 'file', path: '/Users/g/todo.xlsx' }), 'xlsx');
  assert.equal(sheetMode({ ...base, kind: 'file', path: '/Users/g/todo.csv' }), 'csv');
  assert.match(appsScript('abc123'), /const TOKEN = 'abc123'/);
});

test('Google link mode: reads the CSV, explains a private sheet', async () => {
  let body = 'Task,Done\nDeck,FALSE\nMemo,TRUE\n';
  let type = 'text/csv';
  const http = (async () => new Response(body, { status: 200, headers: { 'content-type': type } })) as typeof fetch;
  let state: TrackState | null = null;
  const p = new SheetProvider({ cfg: () => ({ ...DEFAULT_TODO.sheet, url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit' }), http, loadState: () => state, saveState: (s) => (state = s) });
  const snap = await p.fetch(NOW);
  assert.deepEqual(snap.open.map((t) => t.title), ['Deck']);
  assert.equal(p.writesBack, false, 'a shared link is not written to');
  body = 'Task,Done\nDeck,TRUE\nMemo,TRUE\n';
  const snap2 = await p.fetch(NOW + 60_000);
  assert.deepEqual(snap2.doneToday.map((t) => t.title), ['Deck']);
  type = 'text/html; charset=utf-8';
  body = '<html>Sign in</html>';
  await assert.rejects(p.fetch(NOW + 120_000), /private/);
});

test('private connector mode: reads with the secret and ticks rows off', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ values: [['Task', 'Done'], ['Deck', false], ['Memo', true]] }), { status: 200 });
  }) as typeof fetch;
  const cfg = { ...DEFAULT_TODO.sheet, url: 'https://script.google.com/macros/s/AKfy/exec', token: 's3cret', tab: 'Today' };
  const p = new SheetProvider({ cfg: () => cfg, http, loadState: () => null, saveState: () => undefined });
  const snap = await p.fetch(NOW);
  assert.match(calls[0].url, /token=s3cret/);
  assert.match(calls[0].url, /tab=Today/);
  assert.equal(p.canComplete, true);
  assert.equal(await p.complete(snap.open[0].id), true);
  const sent = JSON.parse(String(calls[1].init!.body));
  assert.deepEqual(sent, { token: 's3cret', tab: 'Today', action: 'complete', row: 1, taskCol: 0, doneCol: 1, title: 'Deck' });
});

test('app usage: Spotlight output parsing', () => {
  assert.equal(parseMdDate('2026-10-17 20:31:05 +0000'), Date.parse('2026-10-17T20:31:05Z'));
  const out = ['2026-10-17 20:31:05 +0000', '42', '', '', '7', '2026-09-01 08:00:00 +0000'].join('\0');
  const m = parseMdlsRaw(out, ['/A.app', '/B.app', '/C.app']);
  assert.deepEqual(m.get('/A.app'), { uses: 42, lastUsed: Date.parse('2026-10-17T20:31:05Z') });
  assert.deepEqual(m.get('/B.app'), { uses: 0, lastUsed: 0 });
  assert.equal(m.get('/C.app')!.uses, 7, 'order of the two values does not matter');
});

test('roles: several at once, with their apps limited to what you actually use', () => {
  const p = buildDefaultProfile(['founder', 'finance', 'student']);
  assert.deepEqual(p.roles, ['founder', 'finance', 'student']);
  assert.ok(p.workDomains.includes('pitchbook.com') && p.workDomains.includes('notion.so') && p.workDomains.includes('canvas.brown.edu'));
  assert.ok(!('cnn.com' in p.distractionDomains), 'news counts as work for finance');
  assert.equal(roleText({ ...p, roleNote: 'incoming analyst' }), 'Founder, Banking, consulting or finance, Student; incoming analyst');
  assert.ok(combineRoles(['creator']).graySuggest.includes('youtube'));

  const apps = [
    { name: 'Notion', uses: 90, lastUsed: NOW - 86_400_000 },
    { name: 'Microsoft Excel', uses: 30, lastUsed: NOW - 2 * 86_400_000 },
    { name: 'Linear', uses: 2, lastUsed: NOW - 200 * 86_400_000 },
    { name: 'Figma', uses: 0, lastUsed: 0 },
  ];
  assert.deepEqual(suggestWorkApps(combineRoles(['founder']).workApps, apps, NOW), ['Notion', 'Microsoft Excel'], 'only apps used this month');
  const noUsage = apps.map((a) => ({ ...a, uses: 0, lastUsed: 0 }));
  assert.deepEqual(suggestWorkApps(['Notion', 'Cursor'], noUsage, NOW), ['Notion'], 'falls back to installed');
});

test('more date shapes', () => {
  assert.equal(parseDue('Friday, October 23, 2026', NOW), '2026-10-23');
  assert.equal(parseDue('23rd Oct', NOW), '2026-10-23');
  assert.equal(parseDue('Oct. 5', NOW), '2026-10-05');
});

test('read-only sheets: ticking in Lock In works, survives refreshes, clears when the sheet catches up, and can be undone', async () => {
  let body = 'Task,Done\nDeck,FALSE\nMemo,FALSE\n';
  const http = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch;
  let state: TrackState | null = null;
  const p = new SheetProvider({ cfg: () => ({ ...DEFAULT_TODO.sheet, url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit' }), http, loadState: () => state, saveState: (s) => (state = s) });
  const s0 = await p.fetch(NOW);
  assert.equal(p.canComplete, true, 'ticking is always allowed');
  assert.equal(p.writesBack, false, 'but it is not written to a shared link');
  const deck = s0.open.find((t) => t.title === 'Deck')!;
  assert.equal(await p.complete(deck.id), true);
  const s1 = await p.fetch(NOW + 1000);
  assert.deepEqual(s1.open.map((t) => t.title), ['Memo']);
  assert.deepEqual(s1.doneToday.map((t) => [t.title, t.localOnly]), [['Deck', true]]);
  const s2 = await p.fetch(NOW + 2000);
  assert.deepEqual(s2.open.map((t) => t.title), ['Memo'], 'still done after another read');
  // Undo brings it back.
  assert.equal(await p.undo(deck.id), true);
  const s3 = await p.fetch(NOW + 3000);
  assert.deepEqual(s3.open.map((t) => t.title).sort(), ['Deck', 'Memo']);
  assert.equal(s3.doneToday.length, 0);
  // Tick again, then the sheet itself gets ticked: stays done, no longer local-only.
  await p.complete(deck.id);
  await p.fetch(NOW + 4000);
  body = 'Task,Done\nDeck,TRUE\nMemo,FALSE\n';
  const s4 = await p.fetch(NOW + 5000);
  assert.deepEqual(s4.doneToday.map((t) => [t.title, !!t.localOnly]), [['Deck', false]]);
  assert.deepEqual(state!.local, {});
});


// ---------------------------------------------------------------------------
// Real-world sheets: a team tracker with a dashboard tab and one tab per person.

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A minimal .xlsx with the given tabs (strings inline, numbers, booleans). */
function xlsx(tabs: Record<string, Cell[][]>, hidden: string[] = []): Uint8Array {
  const xml = (x: string) => strToU8(`<?xml version="1.0" encoding="UTF-8"?>${x}`);
  const names = Object.keys(tabs);
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': xml(`<workbook><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}"${hidden.includes(n) ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': xml(`<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  names.forEach((n, i) => {
    const rows = tabs[n]
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            if (v === null || v === '') return '';
            if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = xml(`<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zipSync(files);
}

// Shaped like Grace's own tab: a summary block, then the table (first column empty, an unlabelled date column).
const GRACE_TAB: Table = [
  ['', "Grace's Task Tracker", '', '', '', '', '', '', '', ''],
  ['', 'Personal workload and real-time task backlog', '', '', '', '', '', '', '', ''],
  ['', 'TOTAL TASKS', '', 'COMPLETED', '', 'IN PROGRESS', '', 'TOTAL EST. HOURS', '', ''],
  ['', 60, '', 55, '', 2, '', 23, '', ''],
  ['', 'All assigned', '', '92% of total', '', '3% of total', '', 'Hours allocated', '', ''],
  [],
  ['', 'Task Name', '', 'Day', 'Week', 'Assignee', 'Status', 'Priority', '', ''],
  ['', 'meet up with alex/follow up in person about the studio', 46317, 'Thursday', 'Week 3', 'Grace', '', '', 2, ''],
  ['', 'update website with latest storytelling', 46316, 'Wednesday', 'Week 3', 'Grace', 'In Progress', 'High', 3, ''],
  ['', 'speedrun video', 46309, 'Wednesday', 'Week 2', 'Grace', 'Completed', 'Medium', 1, ''],
  ['', 'reformat team organizations structure', 46300, 'Monday', 'Week 1', 'Grace', 'Completed', 'Urgent', 2, ''],
  ['', 'bug fixing', 46315, 'Tuesday', 'Week 3', 'Grace', '', '', '', ''],
];

// Shaped like the first tab: a read-only dashboard over the "All Tasks" tab.
const DASHBOARD: Table = [
  ['Weekly Project Management Tracker'],
  ['This page is designed to be read, please edit under "All Tasks" tab.'],
  [],
  ['Select sprint week', '', 'TOTAL TASKS'],
  ['Filter Week:', 'Week 3', 35],
  [],
  ['Sprint workload'],
  ['Weekly Schedule & Filtered Tasks'],
  ['Task Name', 'Due Date', 'Assignee', 'Status'],
  ['follow up on the studio - how to get access', '2026-10-22', 'Grace', ''],
  ['standup 1-1 with everyone', '2026-10-20', 'Sam', 'Completed'],
];

const ALL_TASKS: Table = [
  ['Task Name', 'Due Date', 'Week', 'Assignee', 'Status', 'Priority'],
  ['follow up on the studio - how to get access', '2026-10-22', 'Week 3', 'Grace', '', 'High'],
  ['update website with latest storytelling', '2026-10-21', 'Week 3', 'Grace', 'In Progress', 'High'],
  ['standup 1-1 with everyone', '2026-10-20', 'Week 3', 'Sam', 'Completed', ''],
  ['client follow up list + materials', '2026-10-21', 'Week 3', 'Sam, Grace', '', ''],
  ['design review', '2026-10-23', 'Week 3', 'Lee', '', 'Medium'],
  ['old idea', '2026-10-01', 'Week 0', 'Lee', 'Cancelled', ''],
];

const ME = ['Grace Zhong', 'grace'];

test("finds the table under a summary block (Grace's tab)", () => {
  assert.equal(findHeader(GRACE_TAB), 6);
  const m = detectColumns(GRACE_TAB);
  assert.equal(m.task, 1);
  assert.equal(m.due, 2, 'the unlabelled column of dates, not the "Day" column of weekday names');
  assert.equal(m.done, 6);
  assert.equal(m.priority, 7);
  assert.equal(m.assignee, 5);
  const a = analyzeTable(GRACE_TAB, m, { now: NOW, me: ME });
  assert.deepEqual(a.tasks.filter((t) => !t.completed).map((t) => t.title), ['meet up with alex/follow up in person about the studio', 'update website with latest storytelling', 'bug fixing']);
  assert.equal(a.tasks.filter((t) => t.completed).length, 2);
  assert.equal(a.tasks[1].due, '2026-10-21');
  assert.equal(a.tasks[1].priority, 3);
  assert.equal(a.owner, '', 'one person in the sheet: no filtering needed');
});

test('skips the dashboard furniture: titles, instructions, filters, totals, section names', () => {
  const m = detectColumns(DASHBOARD);
  assert.equal(m.header, 8);
  const a = analyzeTable(DASHBOARD, m, { now: NOW, owner: '' });
  assert.deepEqual(a.tasks.map((t) => t.title), ['follow up on the studio - how to get access', 'standup 1-1 with everyone']);
  assert.equal(findPointer(DASHBOARD), 'All Tasks');
});

test('skips rows that are not tasks, keeps ones that are', () => {
  const t: Table = [
    ['Task', 'Status', 'Due'],
    ['WEEK 1', '', ''],
    ['Write the memo', 'Done', '10/18/2026'],
    ['Monday', '', ''],
    ['Call the bank', '', '10/20/2026'],
    ['Notes:', '', ''],
    ['42', '', ''],
    ['Total', '3', ''],
    ['Task', 'Status', 'Due'],
    ['Old plan', 'Cancelled', ''],
    ['email mom', '', ''],
  ];
  const a = analyzeTable(t, detectColumns(t), { now: NOW });
  assert.deepEqual(a.tasks.map((x) => x.title), ['Write the memo', 'Call the bank', 'email mom'], 'a bare new task at the end is still a task');
  assert.deepEqual(a.skipped.map((x) => x.why), ['section', 'section', 'label', 'number', 'total', 'header', 'cancelled']);
});

test('a list with no header row is not mistaken for one', () => {
  const t: Table = [['Review task priorities', 'Grace', 'Done'], ['Decide what to cook', 'Sam', ''], ['Status update for Sam', 'Grace', '']];
  assert.equal(findHeader(t), -1);
  assert.equal(tableToTasks(t, detectColumns(t), 'all', NOW).length, 3);
});

test('shared sheets: only your rows, picked by your name', () => {
  const m = detectColumns(ALL_TASKS);
  assert.equal(m.assignee, 3);
  const mine = analyzeTable(ALL_TASKS, m, { now: NOW, me: ME });
  assert.equal(mine.owner, 'Grace');
  assert.deepEqual(mine.owners, ['Grace', 'Sam', 'Lee']);
  assert.deepEqual(mine.tasks.map((t) => t.title), ['follow up on the studio - how to get access', 'update website with latest storytelling', 'client follow up list + materials']);
  const everyone = analyzeTable(ALL_TASKS, m, { now: NOW, me: ME, owner: '' });
  assert.equal(everyone.tasks.length, 5, 'everyone, minus the cancelled row');
  const lee = analyzeTable(ALL_TASKS, m, { now: NOW, me: ME, owner: 'Lee' });
  assert.deepEqual(lee.tasks.map((t) => t.title), ['design review']);
  const stranger = analyzeTable(ALL_TASKS, m, { now: NOW, me: ['Pat Doe', 'pdoe'] });
  assert.equal(stranger.owner, '', 'not in the sheet: everyone');
  assert.ok(isMe('grace', ME) && isMe('Grace Z.', ME) && !isMe('Gracie', ['Sam']));
});

test('picks the right tab: yours by name, else the one the sheet points to', () => {
  const tabs = { Dashboard: DASHBOARD, 'All Tasks': ALL_TASKS, Grace: GRACE_TAB, Lists: [['Status'], ['Done'], ['Open']] };
  const read = (n: string) => tabs[n as keyof typeof tabs];
  assert.deepEqual(pickTab(Object.keys(tabs), read, ME), { name: 'Grace', why: 'it has your name' });
  assert.deepEqual(pickTab(Object.keys(tabs), read, ['Pat Doe']), { name: 'All Tasks', why: 'the sheet says to edit there' });
  assert.equal(matchTab(Object.keys(tabs), 'grace'), 'Grace');
  assert.equal(matchTab(Object.keys(tabs), 'all'), 'All Tasks');
  assert.equal(matchTab(Object.keys(tabs), 'nope'), null);
});

test('reads every tab of an .xlsx, skips hidden ones', () => {
  const book = readXlsxBook(xlsx({ Dashboard: DASHBOARD, Grace: GRACE_TAB, Config: [['x']] }, ['Config']));
  assert.deepEqual(book.tabs, ['Dashboard', 'Grace']);
  assert.equal(book.table('Grace')[7][2], 46317);
  assert.equal(readXlsx(xlsx({ A: [['Task'], ['x']] }), 'a')[1][0], 'x');
});

test('Google link: reads the tab you named from the whole file, and lists the tabs', async () => {
  const file = xlsx({ Dashboard: DASHBOARD, 'All Tasks': ALL_TASKS, Grace: GRACE_TAB });
  const urls: string[] = [];
  const http = (async (u: string | URL | Request) => {
    urls.push(String(u));
    if (String(u).includes('format=xlsx')) return new Response(file as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
    return new Response('Task\nshould not be read\n', { status: 200, headers: { 'content-type': 'text/csv' } });
  }) as typeof fetch;
  let cfg: SheetSettings = { ...DEFAULT_TODO.sheet, url: 'https://docs.google.com/spreadsheets/d/1a0rYV7dQEih2gG-6QnGU_vkqDKAw4MSxr9FdfLJO63s/edit?usp=sharing', tab: 'grace' };
  let state: TrackState | null = null;
  const p = new SheetProvider({ cfg: () => cfg, http, loadState: () => state, saveState: (x) => (state = x), me: () => ME });
  const snap = await p.fetch(NOW);
  assert.match(urls[0], /\/export\?format=xlsx$/);
  assert.deepEqual(snap.open.map((t) => t.title), ['meet up with alex/follow up in person about the studio', 'update website with latest storytelling', 'bug fixing']);
  const pv = await p.preview();
  assert.deepEqual(pv.tabs, ['Dashboard', 'All Tasks', 'Grace']);
  assert.equal(pv.tab, 'Grace');
  assert.equal(pv.headerRow, 7);
  assert.equal(pv.skipped, 0, 'nothing junk under the header');
  assert.equal(pv.map.due, 2);
  // No tab named: picks yours.
  cfg = { ...cfg, tab: '' };
  const pv2 = await p.preview();
  assert.equal(pv2.tab, 'Grace');
  assert.equal(pv2.tabWhy, 'it has your name');
  // A tab that is not there: says which ones are.
  cfg = { ...cfg, tab: 'Gracie' };
  const pv3 = await p.preview();
  assert.match(pv3.error ?? '', /no tab called "Gracie".*Dashboard, All Tasks, Grace/i);
  assert.deepEqual(pv3.tabs, ['Dashboard', 'All Tasks', 'Grace'], 'so you can pick the right one');
});

test('Google link with a tab in the link (gid) still reads that tab', async () => {
  const urls: string[] = [];
  const http = (async (u: string | URL | Request) => {
    urls.push(String(u));
    return new Response('Task,Done\nDeck,FALSE\n', { status: 200, headers: { 'content-type': 'text/csv' } });
  }) as typeof fetch;
  const p = new SheetProvider({ cfg: () => ({ ...DEFAULT_TODO.sheet, url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit#gid=77' }), http, loadState: () => null, saveState: () => undefined });
  const snap = await p.fetch(NOW);
  assert.deepEqual(snap.open.map((t) => t.title), ['Deck']);
  assert.deepEqual(urls, ['https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/export?format=csv&gid=77']);
});

test('switching to the right tab clears junk ticks from today, keeps real ones', async () => {
  let tab = 'Dashboard';
  const file = xlsx({ Dashboard: DASHBOARD, Grace: GRACE_TAB });
  const http = (async () => new Response(file as unknown as BodyInit, { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })) as typeof fetch;
  let state: TrackState | null = null;
  const p = new SheetProvider({ cfg: () => ({ ...DEFAULT_TODO.sheet, url: 'https://docs.google.com/spreadsheets/d/1a0rYV7dQEih2gG-6QnGU_vkqDKAw4MSxr9FdfLJO63s/edit', tab, owner: '' }), http, loadState: () => state, saveState: (x) => (state = x), me: () => ME });
  // An older version had read junk rows and they got ticked in Lock In.
  state = {
    day: '2026-10-19', open: {}, done: { 'row:total tasks#1': { title: 'TOTAL TASKS', at: NOW - 1000 }, 'row:bug fixing#1': { title: 'bug fixing', at: NOW - 1000 } },
    local: { 'row:total tasks#1': { title: 'TOTAL TASKS', at: NOW - 1000 }, 'row:bug fixing#1': { title: 'bug fixing', at: NOW - 1000 } },
  };
  tab = 'Grace';
  const snap = await p.fetch(NOW);
  assert.ok(!snap.open.some((t) => t.title === 'bug fixing'), 'your tick on a real task is kept');
  assert.ok(!snap.doneToday.some((t) => t.title === 'TOTAL TASKS'), 'junk is gone from today');
  assert.deepEqual(Object.keys(state!.local ?? {}), ['row:bug fixing#1']);
});
