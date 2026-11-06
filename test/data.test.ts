import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { TodoHistory, mergeDay } from '../src/main/todos/history';
import { buildExport } from '../src/main/export';
import { collect, isDataFile, makeBackup, prune, readBackup, restore } from '../src/main/backup';
import type { DoneEntry } from '../src/main/todos/donelog';
import type { Deadline, Task } from '../src/shared/types';

const at = (s: string) => new Date(s).getTime();
const task = (id: string, title: string, o: Partial<Task> = {}): Task => ({ id, title, completed: false, ...o });
const done = (id: string, title: string, when: string, o: Partial<DoneEntry> = {}): DoneEntry => ({ id, at: at(when), day: when.slice(0, 10), title, source: 'list', ...o });

test("a day's to-dos: open ones, ones finished later, and things you told the coach", () => {
  let d = mergeDay(null, '2026-10-26', at('2026-10-26T09:00'), [task('a', 'Pitch deck', { due: '2026-10-25', project: 'Captain' }), task('b', 'Email Sam')], [], 'Apple Reminders');
  assert.deepEqual(d.rows.map((r) => [r.title, r.status]), [['Email Sam', 'open'], ['Pitch deck', 'open']]);
  // Later: the deck is done (it leaves the open list), and you told the coach you booked the dentist.
  d = mergeDay(d, '2026-10-26', at('2026-10-26T15:00'), [task('b', 'Email Sam')], [done('x1', 'Pitch deck', '2026-10-26T14:30', { taskId: 'a', project: 'Captain' }), done('x2', 'Booked the dentist', '2026-10-26T12:00', { source: 'said' })], 'Apple Reminders');
  const by = Object.fromEntries(d.rows.map((r) => [r.title, r]));
  assert.equal(by['Pitch deck'].status, 'done');
  assert.equal(by['Pitch deck'].doneAt, at('2026-10-26T14:30'));
  assert.equal(by['Pitch deck'].due, '2026-10-25', 'what it was still remembered');
  assert.equal(by['Email Sam'].status, 'open');
  assert.equal(by['Booked the dentist'].source, 'said');
  // Un-ticked: it's open again.
  d = mergeDay(d, '2026-10-26', at('2026-10-26T16:00'), [task('a', 'Pitch deck'), task('b', 'Email Sam')], [], 'Apple Reminders');
  assert.equal(d.rows.find((r) => r.title === 'Pitch deck')?.status, 'open');
});

test('one file per day, rewritten only when something changes (or every 10 minutes)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-hist-'));
  const h = new TodoHistory(dir);
  assert.equal(h.record(at('2026-10-26T09:00'), '2026-10-26', [task('a', 'Deck')], [], 'Lock In list'), true);
  assert.equal(h.record(at('2026-10-26T09:01'), '2026-10-26', [task('a', 'Deck')], [], 'Lock In list'), false);
  assert.equal(h.record(at('2026-10-26T09:02'), '2026-10-26', [task('a', 'Deck'), task('b', 'Essay')], [], 'Lock In list'), true);
  assert.equal(h.record(at('2026-10-26T09:13'), '2026-10-26', [task('a', 'Deck'), task('b', 'Essay')], [], 'Lock In list'), true, 'refreshed after 10 min');
  h.record(at('2026-10-27T09:00'), '2026-10-27', [task('b', 'Essay')], [], 'Lock In list');
  assert.deepEqual(readdirSync(join(dir, 'todo-days')).sort(), ['2026-10-26.json', '2026-10-27.json']);
  assert.deepEqual(h.all().map((x) => [x.day, x.rows.length]), [['2026-10-26', 2], ['2026-10-27', 1]]);
  assert.equal(new TodoHistory(join(dir, 'nothing')).all().length, 0);
});

test('the spreadsheets: to-dos by day, deadlines, and what was still open in each day file', () => {
  const day = mergeDay(null, '2026-10-26', at('2026-10-26T09:00'), [task('a', 'Pitch deck', { due: '2026-10-25' }), task('b', 'Email Sam')], [done('x', 'Essay', '2026-10-26T11:00', { taskId: 'c', project: 'School' })], 'Things');
  const deadlines: Deadline[] = [
    { id: '1', title: 'Problem set', due: '2026-10-30', time: '17:00', done: false, createdAt: at('2026-10-20T10:00') },
    { id: '2', title: 'Old', due: '2026-10-20', done: false, createdAt: at('2026-10-10T10:00') },
    { id: '3', title: 'Tax form', due: '2026-10-22', done: true, doneAt: at('2026-10-21T18:00'), createdAt: at('2026-10-10T10:00') },
  ];
  const files = buildExport({ done: [done('x', 'Essay', '2026-10-26T11:00', { taskId: 'c', project: 'School' })], sessions: [], days: {}, meetings: {}, todoDays: [day], deadlines }, { now: at('2026-10-26T20:00') });
  const get = (n: string) => files.find((f) => f.name === n)?.content.replace(/^﻿/, '').trim().split('\r\n') ?? [];
  assert.deepEqual(get('Lock In - to-dos by day.csv'), [
    'Date,Day,Task,Status,Due,Overdue,Project,List,Done at,How,First seen',
    '2026-10-26,Monday,Essay,Done,,,School,Things,11:00,Ticked in your list,11:00',
    '2026-10-26,Monday,Email Sam,Open,,,,Things,,,09:00',
    '2026-10-26,Monday,Pitch deck,Open,2026-10-25,Yes,,Things,,,09:00',
  ]);
  assert.deepEqual(get('Lock In - deadlines.csv').slice(1), [
    'Old,2026-10-20,,Overdue,,,2026-10-10',
    'Tax form,2026-10-22,,Done,2026-10-21 18:00,,2026-10-10',
    'Problem set,2026-10-30,17:00,Open,,,2026-10-20',
  ]);
  const dayFile = files.find((f) => f.name.endsWith('2026-10-26.csv'))!.content;
  assert.match(dayFile, /,Still open,Pitch deck,,,due 2026-10-25/);
  assert.ok(dayFile.indexOf('Essay') < dayFile.indexOf('Still open'), 'open items come last');
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-data-'));
  writeFileSync(join(dir, 'settings.json'), '{"a":1}');
  writeFileSync(join(dir, 'done-log.ndjson'), '{"t":"x"}\n');
  writeFileSync(join(dir, 'keys.json'), '{"secret":true}');
  writeFileSync(join(dir, 'settings.json.tmp'), 'half');
  mkdirSync(join(dir, 'todo-days'));
  writeFileSync(join(dir, 'todo-days', '2026-10-26.json'), '{"day":"2026-10-26","rows":[]}');
  mkdirSync(join(dir, 'Cache'));
  writeFileSync(join(dir, 'Cache', 'x.json'), 'electron junk');
  mkdirSync(join(dir, 'runtime'));
  writeFileSync(join(dir, 'runtime', 'package.json'), '{}');
  return dir;
}

test('a backup holds every record, but not API keys, half-written files or Electron caches', () => {
  const dir = dataDir();
  assert.deepEqual(collect(dir).map((f) => f.name), ['done-log.ndjson', 'settings.json', 'todo-days/2026-10-26.json']);
  const b = readBackup(makeBackup(dir, '0.3.0', new Date('2026-10-26T12:00:00Z')));
  assert.equal(b.manifest.app, 'Lock In');
  assert.equal(b.manifest.createdAt, '2026-10-26T12:00:00.000Z');
  assert.deepEqual(b.files.map((f) => f.name).sort(), ['done-log.ndjson', 'settings.json', 'todo-days/2026-10-26.json']);
  assert.equal(isDataFile('../evil.json'), false);
  assert.equal(isDataFile('todo-days/../../x.json'), false);
});

test('restoring on a "new Mac" brings everything back and sets the old records aside', () => {
  const zip = makeBackup(dataDir(), '0.3.0');
  const fresh = mkdtempSync(join(tmpdir(), 'lockin-new-'));
  writeFileSync(join(fresh, 'settings.json'), '{"fresh":true}');
  writeFileSync(join(fresh, 'keys.json'), '{"mine":true}');
  const r = restore(fresh, zip, 123);
  assert.equal(r.files, 3);
  assert.equal(readFileSync(join(fresh, 'settings.json'), 'utf8'), '{"a":1}');
  assert.ok(existsSync(join(fresh, 'todo-days', '2026-10-26.json')));
  assert.equal(readFileSync(join(fresh, 'before-restore-123', 'settings.json'), 'utf8'), '{"fresh":true}', 'kept aside, not deleted');
  assert.equal(readFileSync(join(fresh, 'keys.json'), 'utf8'), '{"mine":true}', "this Mac's keys stay");
});

test("files that aren't Lock In backups, and backups with tricks inside, are refused", () => {
  assert.throws(() => readBackup(strToU8('nope')), /isn't a zip/);
  assert.throws(() => readBackup(zipSync({ 'hello.txt': strToU8('hi') })), /isn't a Lock In backup/);
  assert.throws(() => readBackup(zipSync({ 'manifest.json': strToU8(JSON.stringify({ app: 'Lock In', backup: 99 })) })), /newer Lock In/);
  const sneaky = zipSync({
    'manifest.json': strToU8(JSON.stringify({ app: 'Lock In', backup: 1, createdAt: 'x', appVersion: '1', files: [] })),
    'data/../../escape.json': strToU8('{}'),
    'data/keys.json': strToU8('{"stolen":true}'),
    'data/settings.json': strToU8('{"ok":true}'),
  });
  assert.deepEqual(readBackup(sneaky).files.map((f) => f.name), ['settings.json']);
});

test('only the last 14 daily backups are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-bk-'));
  for (let i = 1; i <= 20; i++) writeFileSync(join(dir, `Lock In backup 2026-10-${String(i).padStart(2, '0')}.zip`), 'x');
  writeFileSync(join(dir, 'Lock In backup 2026-10-05 10.30.zip'), 'manual');
  prune(dir, 14);
  const left = readdirSync(dir).sort();
  assert.equal(left.filter((f) => /\d{4}-\d{2}-\d{2}\.zip$/.test(f)).length, 14);
  assert.ok(left.includes('Lock In backup 2026-10-20.zip') && !left.includes('Lock In backup 2026-10-06.zip'));
  assert.ok(left.includes('Lock In backup 2026-10-05 10.30.zip'), 'manual backups are never pruned');
});
