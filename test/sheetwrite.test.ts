import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { strToU8, zipSync } from 'fflate';
import { SheetProvider, appsScript, parseCsv, readXlsxBook, writeCsv, type TrackState } from '../src/main/todos/sheet';
import { TEMPLATE_HEADERS, TEMPLATE_TAB, doneValueFor, templateCells, type WCell } from '../src/main/todos/template';
import { addTemplateTab, dateSerial, newTemplateWorkbook, writeXlsx } from '../src/main/todos/xlsxwrite';
import { DEFAULT_TODO } from '../src/shared/templates';
import type { SheetSettings } from '../src/shared/types';

const NOW = new Date('2026-11-24T10:00:00').getTime();

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-sheet-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the template: Done, Task, Due, Priority, Project, Notes, Added', () => {
  assert.deepEqual([...TEMPLATE_HEADERS], ['Done', 'Task', 'Due', 'Priority', 'Project', 'Notes', 'Added']);
  assert.deepEqual(templateCells({ title: ' Send the deck ', done: true, due: '2026-11-26', priority: 3, added: '2026-11-24' }), ['Done', 'Send the deck', { date: '2026-11-26' }, 'High', '', '', { date: '2026-11-24' }]);
  assert.equal(dateSerial('2026-11-24'), 46350);
});

test('a tick looks like the ticks already in the column', () => {
  assert.equal(doneValueFor([true, false, null]), true);
  assert.equal(doneValueFor(['x', '', 'x', 'Done']), 'x');
  assert.equal(doneValueFor(['TRUE', 'FALSE']), 'TRUE');
  assert.equal(doneValueFor([null, '']), 'Done');
});

test('xlsx: adds a Lock In tab next to your other tabs, once', () => {
  const base = newTemplateWorkbook([{ title: 'First thing', added: '2026-11-24' }]);
  const book = readXlsxBook(base);
  assert.deepEqual(book.tabs, [TEMPLATE_TAB]);
  assert.deepEqual(book.table(TEMPLATE_TAB)[1], [null, 'First thing', null, null, null, null, 46350]);
  const again = addTemplateTab(base, []);
  assert.equal(again.created, false, 'already there');
});

test('xlsx: rows go under the last task and ticks land in the right cell, other tabs untouched', () => {
  const wb = newTemplateWorkbook([{ title: 'One' }, { title: 'Two' }]);
  const out = writeXlsx(wb, TEMPLATE_TAB, [{ row: 1, col: 0, value: 'Done' }], [new Map<number, WCell>([[1, 'Three'], [2, { date: '2026-12-01' }]])], 1);
  const t = readXlsxBook(out).table(TEMPLATE_TAB);
  assert.deepEqual(t.map((r) => r[1]), ['Task', 'One', 'Two', 'Three']);
  assert.equal(t[1][0], 'Done');
  assert.equal(t[3][2], dateSerial('2026-12-01'));
  assert.throws(() => writeXlsx(out, 'Nope', [], [], 0), /No tab called "Nope"/);
});

test('csv: keeps the delimiter and line endings, quotes what needs quoting', () => {
  const text = 'Task;Done\r\nDeck;\r\n';
  const out = writeCsv(text, ';', [{ row: 1, col: 1, value: 'x' }], [new Map([[0, 'Email "Sam"; then call']])], 0);
  assert.equal(out, 'Task;Done\r\nDeck;x\r\n"Email ""Sam""; then call";\r\n');
  assert.deepEqual(parseCsv(out, ';')[2], ['Email "Sam"; then call', '']);
});

test('the Google connector script is valid JavaScript with your secret in it', () => {
  const code = appsScript('abc123');
  assert.doesNotThrow(() => new Script(code));
  assert.match(code, /const TOKEN = 'abc123'/);
  assert.match(code, /action === 'setup'/);
  assert.match(code, /insertCheckboxes/);
});

// ---- the provider: Lock In's own tab in a real file ---------------------------------

function provider(cfg: SheetSettings, seed: { title: string }[] = []) {
  let state: TrackState | null = null;
  const backups: string[] = [];
  const p = new SheetProvider({ cfg: () => cfg, loadState: () => state, saveState: (s) => (state = structuredClone(s)), seed: () => seed, backup: (path) => backups.push(path) });
  return { p, state: () => state, backups };
}

test('own tab in an Excel file: made from the template with your to-dos, then adds and ticks go both ways', async () => {
  const { dir, done } = tmp();
  try {
    const path = join(dir, 'Planner.xlsx');
    // Someone's existing workbook: a Budget tab Lock In must leave alone.
    writeFileSync(path, makeWorkbook({ Budget: [['Item', 'Cost'], ['Rent', 1200]] }));

    const cfg: SheetSettings = { ...DEFAULT_TODO.sheet, kind: 'file', path, own: true };
    const { p, backups } = provider(cfg, [{ title: 'Finish problem set' }, { title: 'Email the TA' }]);
    const pv = await p.preview();
    assert.equal(pv.willCreate, true);
    assert.equal(pv.seed, 2);
    assert.deepEqual(readXlsxBook(new Uint8Array(readFileSync(path))).tabs, ['Budget'], 'preview changes nothing');

    const s0 = await p.fetch(NOW);
    const book = readXlsxBook(new Uint8Array(readFileSync(path)));
    assert.deepEqual(book.tabs, ['Budget', TEMPLATE_TAB]);
    assert.deepEqual(book.table('Budget'), [['Item', 'Cost'], ['Rent', 1200]]);
    assert.deepEqual(s0.open.map((t) => t.title), ['Finish problem set', 'Email the TA']);
    assert.deepEqual(backups, [path], 'a copy is kept before the first change');

    // Added in Lock In: in the sheet on the next read, with today's date.
    await p.add('Call the bank');
    const s1 = await p.fetch(NOW + 1000);
    let t = readXlsxBook(new Uint8Array(readFileSync(path))).table(TEMPLATE_TAB);
    assert.deepEqual(t.map((r) => r[1]), ['Task', 'Finish problem set', 'Email the TA', 'Call the bank']);
    assert.equal(typeof t[3][6], 'number', 'Added date');
    assert.ok(s1.open.some((x) => x.title === 'Call the bank' && x.id.startsWith('row:')));

    // Ticked in Lock In: "Done" in the sheet, and on Done today.
    const bank = s1.open.find((x) => x.title === 'Call the bank')!;
    await p.complete(bank.id);
    t = readXlsxBook(new Uint8Array(readFileSync(path))).table(TEMPLATE_TAB);
    assert.equal(t[3][0], 'Done');
    const s2 = await p.fetch(NOW + 2000);
    assert.deepEqual(s2.doneToday.map((x) => [x.title, !!x.localOnly]), [['Call the bank', false]]);
    assert.ok(!s2.open.some((x) => x.title === 'Call the bank'));

    // A row typed into the sheet shows up in Lock In.
    writeFileSync(path, writeXlsx(new Uint8Array(readFileSync(path)), TEMPLATE_TAB, [], [new Map([[1, 'Typed in the sheet']])], 1));
    const s3 = await p.fetch(NOW + 3000, true);
    assert.ok(s3.open.some((x) => x.title === 'Typed in the sheet'));
  } finally {
    done();
  }
});

test('open in Excel: Lock In holds adds and ticks, then writes them once the file is closed', async () => {
  const { dir, done } = tmp();
  try {
    const path = join(dir, 'Todo.xlsx');
    writeFileSync(path, newTemplateWorkbook([{ title: 'Deck' }]));
    const cfg: SheetSettings = { ...DEFAULT_TODO.sheet, kind: 'file', path, own: true };
    const { p, state } = provider(cfg);
    const s0 = await p.fetch(NOW);
    writeFileSync(join(dir, '~$Todo.xlsx'), 'owner');
    await p.add('Memo');
    await p.complete(s0.open[0].id);
    const s1 = await p.fetch(NOW + 1000, true);
    assert.match(p.waiting ?? '', /open in Excel/);
    assert.deepEqual(s1.open.map((x) => x.title), ['Memo'], 'the new one shows, the ticked one is gone');
    assert.ok(s1.open[0].id.startsWith('new:'));
    assert.deepEqual(s1.doneToday.map((x) => [x.title, x.localOnly]), [['Deck', true]]);
    assert.deepEqual(readXlsxBook(new Uint8Array(readFileSync(path))).table(TEMPLATE_TAB).map((r) => r[1]), ['Task', 'Deck'], 'file untouched');

    // Tick the new one too, while it is still only in Lock In.
    await p.complete(s1.open[0].id);
    rmSync(join(dir, '~$Todo.xlsx'));
    const s2 = await p.fetch(NOW + 2000, true);
    const t = readXlsxBook(new Uint8Array(readFileSync(path))).table(TEMPLATE_TAB);
    assert.deepEqual(t.map((r) => [r[0], r[1]]), [['Done', 'Task'], ['Done', 'Deck'], ['Done', 'Memo']]);
    assert.equal(p.waiting, undefined);
    assert.deepEqual(s2.open, []);
    assert.deepEqual(s2.doneToday.map((x) => [x.title, !!x.localOnly]).sort(), [['Deck', false], ['Memo', false]]);
    assert.deepEqual(state()!.local, {});
  } finally {
    done();
  }
});

test('own tab as a CSV: a new file starts with the template', async () => {
  const { dir, done } = tmp();
  try {
    const path = join(dir, 'todo.csv');
    writeFileSync(path, '');
    const { p } = provider({ ...DEFAULT_TODO.sheet, kind: 'file', path, own: true }, [{ title: 'Read chapter 3' }]);
    await p.fetch(NOW);
    await p.add('Book flights');
    const s = await p.fetch(NOW + 1000);
    assert.deepEqual(s.open.map((x) => x.title), ['Read chapter 3', 'Book flights']);
    const rows = parseCsv(readFileSync(path, 'utf8'));
    assert.deepEqual(rows[0], [...TEMPLATE_HEADERS]);
    assert.equal(rows[2][1], 'Book flights');
    assert.equal(rows[2][6], '2026-11-24');
  } finally {
    done();
  }
});

test('a shared Google link: new to-dos stay in Lock In until the sheet has them', async () => {
  let body = 'Task,Done\nDeck,FALSE\n';
  const http = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch;
  let state: TrackState | null = null;
  const p = new SheetProvider({ cfg: () => ({ ...DEFAULT_TODO.sheet, url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit' }), http, loadState: () => state, saveState: (s) => (state = s) });
  await p.fetch(NOW);
  assert.equal(p.canAdd, true);
  assert.equal(p.addsToSheet, false);
  await p.add('Memo');
  const s1 = await p.fetch(NOW + 1000);
  assert.deepEqual(s1.open.map((x) => x.title), ['Deck', 'Memo']);
  // You copy it into the sheet: Lock In stops holding its own copy.
  body = 'Task,Done\nDeck,FALSE\nMemo,FALSE\n';
  const s2 = await p.fetch(NOW + 2000);
  assert.deepEqual(s2.open.map((x) => x.id.startsWith('row:')), [true, true]);
  assert.deepEqual(state!.pending, []);
  // One you add and then delete before it reaches the sheet just goes.
  await p.add('Never mind');
  const s3 = await p.fetch(NOW + 3000);
  assert.equal(await p.remove(s3.open.find((x) => x.title === 'Never mind')!.id), true);
  assert.deepEqual((await p.fetch(NOW + 4000)).open.map((x) => x.title), ['Deck', 'Memo']);
});

test('Google connector: adds the Lock In tab with your to-dos, then adds rows to it', async () => {
  let tab: unknown[][] | null = null;
  const posts: Record<string, unknown>[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const b = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(b);
      if (b.action === 'setup') {
        tab = [[...TEMPLATE_HEADERS], ...(b.rows as unknown[][])];
        return Response.json({ ok: true, created: true });
      }
      if (b.action === 'add') {
        for (const cells of b.rows as [number, unknown][][]) {
          const r: unknown[] = Array(7).fill('');
          for (const [c, v] of cells) r[c] = v && typeof v === 'object' ? (v as { date: string }).date : v;
          tab!.push(r);
        }
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'Unknown action' });
    }
    const u = new URL(String(url));
    if (u.searchParams.get('tab') === TEMPLATE_TAB && tab) return Response.json({ values: tab, tabs: ['Sheet1', TEMPLATE_TAB], tab: TEMPLATE_TAB, version: 2 });
    if (u.searchParams.get('tab') === TEMPLATE_TAB) return Response.json({ error: 'No tab with that name', tabs: ['Sheet1'], version: 2 });
    return Response.json({ values: [['x']], tabs: tab ? ['Sheet1', TEMPLATE_TAB] : ['Sheet1'], tab: 'Sheet1', version: 2 });
  }) as typeof fetch;
  const cfg: SheetSettings = { ...DEFAULT_TODO.sheet, url: 'https://script.google.com/macros/s/AKfy/exec', token: 't', own: true };
  let state: TrackState | null = null;
  const p = new SheetProvider({ cfg: () => cfg, http, loadState: () => state, saveState: (s) => (state = s), seed: () => [{ title: 'Deck' }] });
  const pv = await p.preview();
  assert.equal(pv.willCreate, true);
  assert.deepEqual(pv.tabs, ['Sheet1']);
  const s0 = await p.fetch(NOW);
  assert.equal(posts[0].action, 'setup');
  assert.deepEqual((posts[0].rows as unknown[][])[0].slice(0, 2), [false, 'Deck'], 'a checkbox, unticked');
  assert.deepEqual(s0.open.map((x) => x.title), ['Deck']);
  await p.add('Memo');
  const s1 = await p.fetch(NOW + 1000);
  assert.deepEqual(s1.open.map((x) => x.title), ['Deck', 'Memo']);
  assert.equal(posts[1].action, 'add');

  // The older connector can't add tabs: say how to update it.
  const old = (async () => Response.json({ error: 'No tab with that name' })) as typeof fetch;
  const p2 = new SheetProvider({ cfg: () => cfg, http: old, loadState: () => null, saveState: () => undefined });
  assert.match((await p2.preview()).error ?? '', /older version/);
});

// ---- a small workbook builder (strings inline) ------------------------------------------


function makeWorkbook(tabs: Record<string, (string | number)[][]>): Uint8Array {
  const names = Object.keys(tabs);
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i: number) => String.fromCharCode(65 + i);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
  };
  names.forEach((n, i) => {
    const rows = tabs[n].map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => (typeof v === 'number' ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  return zipSync(files);
}
