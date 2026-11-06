import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Deadlines, daysUntil, isOverdue, reminderDue, reminderLine, markReminded, ymd, type ReminderState } from '../src/main/deadlines';
import type { Deadline } from '../src/shared/types';

const at = (s: string) => new Date(s).getTime();
const dl = (due: string, time?: string): Deadline => ({ id: 'd1', title: 'Sequoia deck', due, time, done: false, createdAt: at('2026-10-20T09:00:00') });

test('days until a deadline count calendar days', () => {
  assert.equal(daysUntil('2026-10-27', at('2026-10-24T23:59:00')), 3);
  assert.equal(daysUntil('2026-10-24', at('2026-10-24T00:01:00')), 0);
  assert.equal(daysUntil('2026-10-23', at('2026-10-24T12:00:00')), -1);
  assert.equal(ymd(at('2026-10-24T08:00:00')), '2026-10-24');
});

/** Every reminder that fires between two times, checking each minute (like the app does every 30 s). */
function simulate(d: Deadline, from: string, to: string): string[] {
  const state: ReminderState = {};
  const fired: string[] = [];
  for (let t = at(from); t <= at(to); t += 60_000) {
    const r = reminderDue(d, state, t);
    if (r) {
      markReminded(d, state, t);
      const x = new Date(t);
      fired.push(`${ymd(t)} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')} ${r.n}/${r.of} (${r.daysLeft}d)`);
    }
  }
  return fired;
}

test('once 3 days before, twice 2 days before, three times the day before, none on the day', () => {
  const fired = simulate(dl('2026-10-30'), '2026-10-25T08:00:00', '2026-10-30T23:00:00');
  assert.deepEqual(fired, [
    '2026-10-27 10:00 1/1 (3d)',
    '2026-10-28 10:00 1/2 (2d)',
    '2026-10-28 15:00 2/2 (2d)',
    '2026-10-29 10:00 1/3 (1d)',
    '2026-10-29 14:00 2/3 (1d)',
    '2026-10-29 18:00 3/3 (1d)',
  ]);
});

test('missed reminders catch up, spaced out', () => {
  // The Mac was asleep until 4:30 pm the day before: the 10:00 and 2:00 reminders come late, 45 minutes apart, then 6:00.
  const fired = simulate(dl('2026-10-30'), '2026-10-29T16:30:00', '2026-10-29T23:00:00');
  assert.deepEqual(fired, ['2026-10-29 16:30 1/3 (1d)', '2026-10-29 17:15 2/3 (1d)', '2026-10-29 18:00 3/3 (1d)']);
});

test('nothing once it is done', () => {
  assert.deepEqual(simulate({ ...dl('2026-10-30'), done: true }, '2026-10-26T08:00:00', '2026-10-30T23:00:00'), []);
});

test('overdue after the due time, or after the day', () => {
  assert.equal(isOverdue(dl('2026-10-24', '17:00'), at('2026-10-24T16:59:00')), false);
  assert.equal(isOverdue(dl('2026-10-24', '17:00'), at('2026-10-24T17:01:00')), true);
  assert.equal(isOverdue(dl('2026-10-24'), at('2026-10-24T23:30:00')), false);
  assert.equal(isOverdue(dl('2026-10-23'), at('2026-10-24T08:00:00')), true);
});

test('pinned on the day and while overdue; reminders through the store', () => {
  let saved: Deadline[] = [];
  let st: ReminderState = {};
  const ds = new Deadlines({ load: () => [], save: (d) => (saved = d), loadState: () => ({}), saveState: (s) => (st = s) });
  const a = ds.add({ title: 'Tax form', due: '2026-10-24', time: '17:00' }, at('2026-10-20T09:00:00'));
  ds.add({ title: 'Deck', due: '2026-10-25' }, at('2026-10-20T09:00:00'));
  ds.add({ title: 'Old', due: '2026-10-22' }, at('2026-10-20T09:00:00'));
  const now = at('2026-10-24T10:30:00');
  assert.deepEqual(ds.pinned(now).map((d) => d.title), ['Old', 'Tax form']);
  const r = ds.nextReminder(now);
  assert.equal(r?.d.title, 'Deck');
  assert.deepEqual(r?.r, { n: 1, of: 3, daysLeft: 1 });
  assert.equal(ds.nextReminder(now), null, 'not again right away');
  assert.ok(st[r!.d.id]);
  ds.update(a.id, { done: true }, now);
  assert.deepEqual(ds.pinned(now).map((d) => d.title), ['Old']);
  assert.equal(saved.find((d) => d.id === a.id)?.done, true);
  assert.match(ds.summary(now), /"Old" \(overdue\), "Deck" \(tomorrow\)/);
});

test('reminder words get sharper and say when', () => {
  const d = dl('2026-10-30', '17:00');
  const first = reminderLine(d, { n: 1, of: 1, daysLeft: 3 }, 'sassy');
  assert.match(first.title, /Due in 3 days at 5:00\s?PM: Sequoia deck/);
  const last = reminderLine(d, { n: 3, of: 3, daysLeft: 1 }, 'sassy');
  assert.equal(last.title, 'Due tomorrow: Sequoia deck');
  assert.match(last.body, /Last call/);
  for (const p of ['gentle', 'firm', 'drill'] as const) assert.ok(reminderLine(d, { n: 2, of: 3, daysLeft: 1 }, p).body.includes('Sequoia deck'));
});
