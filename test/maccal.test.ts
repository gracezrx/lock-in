import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MacCalendar, asStatus, calendarsFrom, defaultExcluded, eventsFrom, macStatusMessage, type RawOutput } from '../src/main/maccal';
import { CalendarManager, mergeEvents } from '../src/main/calendar';
import type { CalEvent, CalendarSettings } from '../src/shared/types';

const T = new Date('2026-10-26T00:00:00').getTime();
const at = (h: number, m = 0) => T + (h * 60 + m) * 60_000;

const raw: RawOutput = {
  status: 'granted',
  calendars: [
    { id: 'g1', title: 'alex@school.edu', source: 'alex@school.edu' },
    { id: 'g3', title: 'Holidays in United States', source: 'alex@school.edu' },
    { id: 'b1', title: 'Birthdays', source: 'Other' },
    { id: 'i1', title: 'Home', source: 'iCloud' },
  ],
  events: [
    { id: 'e1', title: 'Club board meeting', start: at(17), end: at(18), calendarId: 'g1', calendar: 'alex@school.edu', url: 'https://example.zoom.us/j/123' },
    { id: 'e2', title: ' Captain sync ', start: at(10), end: at(10, 45), calendarId: 'i1', calendar: 'Home', notes: 'Join: https://meet.google.com/abc-defg-hij thanks', free: true },
    { id: 'e3', title: 'Halloween', start: at(0), end: at(23, 59) + 59_000, allDay: true, calendarId: 'g3', calendar: 'Holidays in United States' },
    { id: 'e4', title: 'Mom', start: at(0), end: at(23, 59) + 59_000, allDay: true, calendarId: 'b1' },
    { id: 'e5', title: '', start: at(12), end: at(13), calendarId: 'g1' },
    { id: 'bad', title: 'no times', calendarId: 'g1' },
  ],
};

test('Calendar app events become Lock In events: links found, birthdays and holidays left out by default', () => {
  const ev = eventsFrom(raw, undefined);
  assert.deepEqual(ev.map((e) => e.title), ['Captain sync', 'Busy', 'Club board meeting']);
  const sync = ev[0];
  assert.equal(sync.link, 'https://meet.google.com/abc-defg-hij');
  assert.equal(sync.busy, false);
  assert.equal(sync.id, 'mac:e2');
  assert.equal(ev[2].link, 'https://example.zoom.us/j/123');
  assert.deepEqual(defaultExcluded(calendarsFrom(raw)).sort(), ['b1', 'g3']);
});

test('your own choices replace the default; all-day events end at midnight', () => {
  const ev = eventsFrom(raw, ['g1']);
  assert.deepEqual(ev.map((e) => e.title), ['Halloween', 'Mom', 'Captain sync']);
  assert.equal(ev[0].end, T + 86_400_000);
  assert.equal(ev[0].allDay, true);
});

test('calendars are grouped by account and statuses are checked', () => {
  assert.deepEqual(calendarsFrom(raw).map((c) => c.source), ['alex@school.edu', 'alex@school.edu', 'iCloud', 'Other']);
  assert.equal(asStatus('granted'), 'granted');
  assert.equal(asStatus('weird'), 'unknown');
  assert.match(macStatusMessage('denied'), /Privacy & Security, Calendars/);
  assert.match(macStatusMessage('missing'), /Start Lock In/);
  assert.equal(macStatusMessage('granted'), '');
});

test('the reader is asked for the right things', async () => {
  const calls: string[][] = [];
  const mac = new MacCalendar({
    bin: () => '/x/lockin-calendar',
    log: () => undefined,
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'events') return `noise\n${JSON.stringify(raw)}\n`;
      return JSON.stringify({ status: args[0] === 'request' ? 'granted' : 'notDetermined' });
    },
  });
  assert.equal(await mac.status(), 'notDetermined');
  assert.equal(await mac.request(), 'granted');
  const r = await mac.read(at(0), at(48), ['b1']);
  assert.equal(r.status, 'granted');
  assert.equal(r.calendars.length, 4);
  assert.equal(r.events.length, 4, 'holidays now on, birthdays off');
  assert.deepEqual(calls[2], ['events', String(at(0)), String(at(48))]);

  const denied = new MacCalendar({ bin: () => 'x', log: () => undefined, run: async () => JSON.stringify({ status: 'denied' }) });
  assert.deepEqual(await denied.read(0, 1), { status: 'denied', calendars: [], events: [] });
  const missing = new MacCalendar({ bin: () => null, log: () => undefined });
  assert.equal(await missing.status(), 'missing');
});

test('the same meeting from the Calendar app and a link shows once', () => {
  const a: CalEvent = { id: 'mac:1', title: 'Standup', start: at(9), end: at(9, 15), allDay: false, busy: true, calendar: 'x' };
  const b: CalEvent = { ...a, id: 'uid@1', title: 'standup ' };
  const c: CalEvent = { ...a, id: 'z', title: 'Lunch', start: at(12), end: at(13) };
  assert.deepEqual(mergeEvents([[c, a], [b]]).map((e) => e.id), ['mac:1', 'z']);
});

test('the calendar works with only the Calendar app turned on, and says why when macOS blocks it', async () => {
  const settings: CalendarSettings = { urls: [], mac: true, quietInMeetings: true, headsUpMin: 5, offerGaps: true, capSessions: true };
  let blocked = false;
  const now = Date.now();
  const cal = new CalendarManager({
    settings: () => settings,
    log: () => undefined,
    saveDay: () => undefined,
    mac: async () => {
      if (blocked) throw new Error(macStatusMessage('denied'));
      return [{ id: 'm', title: 'Office hours', start: now + 30 * 60_000, end: now + 90 * 60_000, allDay: false, busy: true, calendar: 'Brown' }];
    },
  });
  assert.equal(cal.configured, true);
  await cal.refresh(true);
  assert.equal(cal.connected, true);
  assert.equal(cal.next(now)?.title, 'Office hours');
  assert.match(cal.agenda(now), /Office hours/);
  blocked = true;
  await cal.refresh(true);
  assert.equal(cal.connected, false);
  assert.match(cal.error ?? '', /Privacy & Security/);
  settings.mac = false;
  await cal.refresh(true);
  assert.equal(cal.configured, false);
  assert.equal(cal.events.length, 0);
});
