// Writing to .xlsx files without a spreadsheet library: add Lock In's tab, fill in rows, tick
// cells. Only the parts that change are touched; everything else in the file (other tabs,
// formatting, charts, macros) is copied through byte for byte.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { colIndex, colName, type Cell } from './sheet';
import { TEMPLATE_HEADERS, TEMPLATE_TAB, TCOL, templateCells, type TemplateRow, type WCell } from './template';

type Files = Record<string, Uint8Array>;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_SHEET = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const CT_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (t: string) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];

/** Days since 1899-12-30: how spreadsheets store dates. */
export function dateSerial(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function read(buf: Uint8Array): Files {
  try {
    return unzipSync(buf);
  } catch {
    throw new Error('That file is not a spreadsheet Lock In can write to.');
  }
}

function write(files: Files, order: string[]): Uint8Array {
  // Same order as before ([Content_Types].xml first), new parts at the end.
  const z: Zippable = {};
  for (const name of [...order.filter((n) => files[n]), ...Object.keys(files).filter((n) => !order.includes(n))]) z[name] = [files[name], { level: 6 }];
  return zipSync(z);
}

const text = (f: Files, name: string) => (f[name] ? strFromU8(f[name]) : '');
const put = (f: Files, name: string, xml: string) => (f[name] = strToU8(xml));

// ---------------------------------------------------------------------------
// Styles: a header style, a date style and a "done" look (grey, struck through).

interface Styles {
  header: number;
  date: number;
  doneDxf: number;
}

/** Splits `<tag ...>children</tag>` (or `<tag/>`) out of xml: the items inside, and a way to put new ones back. */
function block(xml: string, tag: string, item: string): { items: string[]; replace: (items: string[]) => string } | null {
  const re = new RegExp(`<${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`);
  const m = re.exec(xml);
  if (!m) return null;
  const inner = m[3] ?? '';
  const items = [...inner.matchAll(new RegExp(`<${item}\\b[^>]*?(?:/>|>[\\s\\S]*?</${item}>)`, 'g'))].map((x) => x[0]);
  return {
    items,
    replace: (next) => {
      const attrs = m[1].replace(/\s*count="\d*"/, '');
      return xml.slice(0, m.index) + `<${tag}${attrs} count="${next.length}">${next.join('')}</${tag}>` + xml.slice(m.index + m[0].length);
    },
  };
}

/** Puts a block in the right place when the styles file doesn't have one yet. */
function addBlock(xml: string, tag: string, after: string[]): string {
  if (new RegExp(`<${tag}\\b`).test(xml)) return xml;
  for (const a of after) {
    const m = new RegExp(`</${a}>|<${a}\\b[^>]*/>`).exec(xml);
    if (m) {
      // The last one of these, so new blocks go after it.
      const all = [...xml.matchAll(new RegExp(`</${a}>|<${a}\\b[^>]*/>`, 'g'))];
      const last = all[all.length - 1];
      const at = (last.index ?? m.index) + last[0].length;
      return xml.slice(0, at) + `<${tag} count="0"></${tag}>` + xml.slice(at);
    }
  }
  return xml.replace(/<styleSheet\b[^>]*>/, (s) => `${s}<${tag} count="0"></${tag}>`);
}

const MIN_STYLES = `${HEAD}<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

/** The cell style for dates, reusing one that is already there. */
function dateStyle(f: Files): number {
  let xml = text(f, 'xl/styles.xml') || MIN_STYLES;
  const xfs = block(xml, 'cellXfs', 'xf');
  if (!xfs) return 0;
  const have = xfs.items.findIndex((x) => /numFmtId="14"/.test(x) && /fillId="0"/.test(x));
  if (have >= 0) return have;
  xml = xfs.replace([...xfs.items, '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>']);
  put(f, 'xl/styles.xml', xml);
  return xfs.items.length;
}

/** Header and "done" styles for a new Lock In tab. */
function templateStyles(f: Files): Styles {
  let xml = text(f, 'xl/styles.xml') || MIN_STYLES;
  xml = addBlock(xml, 'fonts', ['numFmts']);
  xml = addBlock(xml, 'fills', ['fonts']);
  xml = addBlock(xml, 'cellXfs', ['cellStyleXfs', 'borders', 'fills']);
  xml = addBlock(xml, 'dxfs', ['cellStyles', 'cellXfs']);
  const fonts = block(xml, 'fonts', 'font')!;
  const font = fonts.items.length;
  xml = fonts.replace([...fonts.items, '<font><b/><sz val="11"/><color rgb="FF15181C"/><name val="Calibri"/><family val="2"/></font>']);
  const fills = block(xml, 'fills', 'fill')!;
  const fill = fills.items.length;
  xml = fills.replace([...fills.items, '<fill><patternFill patternType="solid"><fgColor rgb="FFFECD00"/><bgColor indexed="64"/></patternFill></fill>']);
  const xfs = block(xml, 'cellXfs', 'xf')!;
  const header = xfs.items.length;
  xml = xfs.replace([...xfs.items, `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>`]);
  const dxfs = block(xml, 'dxfs', 'dxf')!;
  const doneDxf = dxfs.items.length;
  xml = dxfs.replace([...dxfs.items, '<dxf><font><strike/><color rgb="FF8A9199"/></font></dxf>']);
  put(f, 'xl/styles.xml', xml);
  return { header, date: dateStyle(f), doneDxf };
}

// ---------------------------------------------------------------------------
// Cells

function cellXml(ref: string, v: WCell, style: number | undefined, date: number): string {
  if (v === null || v === undefined || v === '') return style !== undefined ? `<c r="${ref}" s="${style}"/>` : '';
  const s = (fallback?: number) => (style !== undefined ? ` s="${style}"` : fallback !== undefined ? ` s="${fallback}"` : '');
  // Dates always get a date format, or they'd show as a plain number.
  if (typeof v === 'object') return `<c r="${ref}" s="${date}"><v>${dateSerial(v.date)}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}"${s()} t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === 'number') return `<c r="${ref}"${s()}><v>${v}</v></c>`;
  return `<c r="${ref}"${s()} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function templateSheet(rows: TemplateRow[], st: Styles, doneValue: Cell): string {
  const width = TEMPLATE_HEADERS.length;
  const last = colName(width - 1);
  const head = `<row r="1">${TEMPLATE_HEADERS.map((h, i) => cellXml(`${colName(i)}1`, h, st.header, st.date)).join('')}</row>`;
  const body = rows
    .map((r, i) => `<row r="${i + 2}">${templateCells(r, doneValue).map((v, c) => cellXml(`${colName(c)}${i + 2}`, v, undefined, st.date)).join('')}</row>`)
    .join('');
  const widths = [8, 44, 12, 10, 16, 32, 12];
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const d = colName(TCOL.done);
  const p = colName(TCOL.priority);
  return (
    `${HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<sheetPr><tabColor rgb="FFFECD00"/></sheetPr>' +
    `<dimension ref="A1:${last}${rows.length + 1}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="B2" sqref="B2"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${head}${body}</sheetData>` +
    `<conditionalFormatting sqref="A2:${last}2000"><cfRule type="expression" dxfId="${st.doneDxf}" priority="1"><formula>OR($${d}2="Done",$${d}2=TRUE)</formula></cfRule></conditionalFormatting>` +
    '<dataValidations count="2">' +
    `<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${d}2:${d}2000"><formula1>"Done"</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${p}2:${p}2000"><formula1>"High,Medium,Low"</formula1></dataValidation>` +
    '</dataValidations>' +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

// ---------------------------------------------------------------------------
// Finding a tab's part in the package

interface SheetRef {
  name: string;
  path: string;
}

function sheets(f: Files): SheetRef[] {
  const wb = text(f, 'xl/workbook.xml');
  if (!wb) throw new Error('That file is not a spreadsheet Lock In can write to.');
  const rels = [...text(f, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]);
  return [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const rid = /\b[\w]+:id="([^"]*)"/.exec(m[0])?.[1] ?? '';
    const rel = rels.find((r) => attr(r, 'Id') === rid);
    let target = rel ? attr(rel, 'Target') ?? '' : '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name: unesc(attr(m[0], 'name') ?? ''), path: target.replace(/\/\.\//g, '/') };
  });
}

/** Adds the Lock In tab to a workbook (unless it is there already). */
function addSheetPart(f: Files, name: string, xml: string): void {
  let n = 1;
  while (f[`xl/worksheets/sheet${n}.xml`]) n++;
  const part = `xl/worksheets/sheet${n}.xml`;
  put(f, part, xml);

  let rels = text(f, 'xl/_rels/workbook.xml.rels') || `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const ids = new Set([...rels.matchAll(/\bId="([^"]*)"/g)].map((m) => m[1]));
  let r = 1;
  while (ids.has(`rId${r}`)) r++;
  const rid = `rId${r}`;
  rels = rels.replace(/<\/Relationships>\s*$/, `<Relationship Id="${rid}" Type="${REL_SHEET}" Target="worksheets/sheet${n}.xml"/></Relationships>`);
  put(f, 'xl/_rels/workbook.xml.rels', rels);

  let wb = text(f, 'xl/workbook.xml');
  const prefix = /<sheet\b[^>]*\b(\w+):id="/.exec(wb)?.[1] ?? /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/.exec(wb)?.[1] ?? 'r';
  // Declared on the workbook, or (as some writers do) on each sheet: then ours declares it too.
  const rootNs = new RegExp(`xmlns:${prefix}=`).test(/<workbook\b[^>]*>/.exec(wb)?.[0] ?? '');
  const sheetId = Math.max(0, ...[...wb.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const tag = `<sheet${rootNs ? '' : ` xmlns:${prefix}="${NS_REL}"`} name="${esc(name)}" sheetId="${sheetId}" ${prefix}:id="${rid}"/>`;
  wb = /<sheets\s*\/>/.test(wb) ? wb.replace(/<sheets\s*\/>/, `<sheets>${tag}</sheets>`) : wb.replace(/<\/sheets>/, `${tag}</sheets>`);
  put(f, 'xl/workbook.xml', wb);

  const ct = text(f, '[Content_Types].xml');
  if (ct && !ct.includes(`PartName="/${part}"`)) put(f, '[Content_Types].xml', ct.replace(/<\/Types>\s*$/, `<Override PartName="/${part}" ContentType="${CT_SHEET}"/></Types>`));
}

/** The workbook with Lock In's tab added (filled with `rows`). `created` is false when it was already there. */
export function addTemplateTab(buf: Uint8Array, rows: TemplateRow[], doneValue: Cell = 'Done'): { buf: Uint8Array; created: boolean } {
  const f = read(buf);
  const order = Object.keys(f);
  if (sheets(f).some((s) => s.name.toLowerCase() === TEMPLATE_TAB.toLowerCase())) return { buf, created: false };
  if (!f['xl/styles.xml']) {
    put(f, 'xl/styles.xml', MIN_STYLES);
    let rels = text(f, 'xl/_rels/workbook.xml.rels');
    rels = rels.replace(/<\/Relationships>\s*$/, `<Relationship Id="rIdLockInStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    put(f, 'xl/_rels/workbook.xml.rels', rels);
    const ct = text(f, '[Content_Types].xml');
    put(f, '[Content_Types].xml', ct.replace(/<\/Types>\s*$/, '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'));
  }
  const st = templateStyles(f);
  addSheetPart(f, TEMPLATE_TAB, templateSheet(rows, st, doneValue));
  return { buf: write(f, order), created: true };
}

/** A new workbook that is just Lock In's tab. */
export function newTemplateWorkbook(rows: TemplateRow[]): Uint8Array {
  const f: Files = {};
  put(f, '[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  put(f, '_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put(f, 'xl/workbook.xml', `${HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets></sheets></workbook>`);
  put(f, 'xl/_rels/workbook.xml.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  put(f, 'xl/styles.xml', MIN_STYLES);
  const st = templateStyles(f);
  addSheetPart(f, TEMPLATE_TAB, templateSheet(rows, st, 'Done'));
  return write(f, ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']);
}

// ---------------------------------------------------------------------------
// Editing a tab: set cells, and add rows under the last task.

export interface CellEdit {
  /** 0-based row and column, as in the tables Lock In reads. */
  row: number;
  col: number;
  value: WCell;
}

interface RowRec {
  open: string;
  cells: Map<number, string>;
}

const hasValue = (c: string) => /<v>|<is>|<f[\s>]/.test(c);

/**
 * Writes `edits` into a tab and adds `rows` (each a column → value map) under the last row that
 * has something in `taskCol`. Returns the new file.
 */
export function writeXlsx(buf: Uint8Array, tab: string, edits: CellEdit[], rows: Map<number, WCell>[], taskCol: number): Uint8Array {
  const f = read(buf);
  const order = Object.keys(f);
  const all = sheets(f);
  const ref = (tab.trim() ? all.find((s) => s.name.toLowerCase() === tab.trim().toLowerCase()) : null) ?? (tab.trim() ? null : all[0]);
  if (!ref) throw new Error(`No tab called "${tab}".`);
  let xml = text(f, ref.path);
  if (!xml) throw new Error('Could not read that tab.');
  const date = edits.some((e) => typeof e.value === 'object' && e.value) || rows.some((r) => [...r.values()].some((v) => typeof v === 'object' && v)) ? dateStyle(f) : 0;

  // The rows, by 1-based number, each with its cells by column.
  const sd = /<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!sd) throw new Error('Could not read that tab.');
  const recs = new Map<number, RowRec>();
  let next = 1;
  for (const m of (sd[1] ?? '').matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const n = Number(attr(m[1], 'r') ?? next);
    next = n + 1;
    const cells = new Map<number, string>();
    let ci = 0;
    for (const c of (m[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const r = attr(c[1], 'r');
      ci = r ? colIndex(r.replace(/\d+/g, '')) : ci;
      cells.set(ci, c[0]);
      ci++;
    }
    // "spans" is only a hint about which columns are used; dropped, since rows may get new cells.
    recs.set(n, { open: `<row${m[1].replace(/\s*\/$/, '').replace(/\s+spans="[^"]*"/, '')}>`, cells });
  }

  let droppedFormula = false;
  let firstAdded = 0;
  const set = (row: number, col: number, v: WCell) => {
    const n = row + 1;
    const rec = recs.get(n) ?? { open: `<row r="${n}">`, cells: new Map<number, string>() };
    recs.set(n, rec);
    const old = rec.cells.get(col);
    if (old && /<f[\s>]/.test(old)) droppedFormula = true;
    const s = old ? attr(/<c\b[^>]*>/.exec(old)?.[0] ?? '', 's') : undefined;
    const out = cellXml(`${colName(col)}${n}`, v, s !== undefined ? Number(s) : undefined, date);
    if (out) rec.cells.set(col, out);
    else rec.cells.delete(col);
  };

  for (const e of edits) set(e.row, e.col, e.value);
  if (rows.length) {
    let last = 0;
    for (const [n, rec] of recs) {
      const c = rec.cells.get(taskCol);
      if (c && hasValue(c)) last = Math.max(last, n);
    }
    // Below the header at least, even on an empty tab.
    if (!last) last = Math.max(1, ...[...recs.entries()].filter(([, r]) => [...r.cells.values()].some(hasValue)).map(([n]) => n));
    firstAdded = last + 1;
    rows.forEach((cells, i) => {
      for (const [col, v] of cells) set(last + i, col, v);
    });
  }

  const nums = [...recs.keys()].sort((a, b) => a - b);
  const body = nums
    .map((n) => {
      const rec = recs.get(n)!;
      const cells = [...rec.cells.keys()].sort((a, b) => a - b).map((c) => rec.cells.get(c)!);
      return `${rec.open}${cells.join('')}</row>`;
    })
    .join('');
  xml = xml.slice(0, sd.index) + `<sheetData>${body}</sheetData>` + xml.slice(sd.index + sd[0].length);
  const maxCol = Math.max(0, ...[...recs.values()].flatMap((r) => [...r.cells.keys()]));
  const maxRow = Math.max(1, ...nums);
  const dim = `A1:${colName(maxCol)}${maxRow}`;
  xml = /<dimension\b[^>]*\/>/.test(xml) ? xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${dim}"/>`) : xml;
  put(f, ref.path, xml);

  // A table (Format as Table) that ended where the rows were added grows to take them in.
  if (rows.length) growTables(f, ref.path, firstAdded, firstAdded + rows.length - 1, taskCol);
  // A formula Lock In overwrote: let Excel rebuild its calculation order.
  if (droppedFormula && f['xl/calcChain.xml']) {
    delete f['xl/calcChain.xml'];
    put(f, 'xl/_rels/workbook.xml.rels', text(f, 'xl/_rels/workbook.xml.rels').replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/, ''));
    put(f, '[Content_Types].xml', text(f, '[Content_Types].xml').replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
  }
  return write(f, order);
}

function growTables(f: Files, sheetPath: string, fromRow: number, lastRow: number, taskCol: number): void {
  const dir = sheetPath.replace(/[^/]+$/, '');
  const relsPath = `${dir}_rels/${sheetPath.split('/').pop()}.rels`;
  for (const m of text(f, relsPath).matchAll(/<Relationship\b[^>]*>/g)) {
    if (!/\/table"/.test(m[0])) continue;
    const target = attr(m[0], 'Target') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : normalize(dir + target);
    const xml = text(f, path);
    const ref = /<table\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/.exec(xml);
    // Only a table that ends just above the new rows and holds the task column.
    if (!ref || Number(ref[4]) !== fromRow - 1 || taskCol < colIndex(ref[1]) || taskCol > colIndex(ref[3])) continue;
    const grown = `${ref[1]}${ref[2]}:${ref[3]}${lastRow}`;
    const old = `${ref[1]}${ref[2]}:${ref[3]}${ref[4]}`;
    put(f, path, xml.split(`ref="${old}"`).join(`ref="${grown}"`));
  }
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  return out.join('/');
}
