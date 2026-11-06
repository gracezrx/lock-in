// Your calendar, from private iCal links (Google, Outlook, iCloud…). Read-only.
// Lock In uses it to stay quiet in meetings, warn you before one, offer a lock-in in the gap
// after one, end sessions before the next one, and tell the coach what your day looks like.
import ICAL from 'ical.js';
import type { CalEvent, CalendarSettings, CalendarSummary } from '../shared/types';
import { dayKey } from './todos/day';

type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;

const LINK = /https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|[\w.-]*webex\.com|whereby\.com|app\.around\.co|[\w.-]*gotomeeting\.com)\/[^\s<>"')\]]+/i;

export function findLink(...texts: (string | undefined | null)[]): string | undefined {
  for (const t of texts) {
    const m = t ? LINK.exec(t) : null;
    if (m) return m[0];
  }
  return undefined;
}

/** webcal:// → https://; trims spaces. */
export function normalizeIcsUrl(url: string): string {
  return url.trim().replace(/^webcals?:\/\//i, 'https://');
}

/** The calendar owner's email from a Google secret address, to skip events they declined. */
export function ownerFromUrl(url: string): string | undefined {
  const m = /\/calendar\/ical\/([^/]+)\//.exec(url);
  if (!m) return undefined;
  try {
    const v = decodeURIComponent(m[1]).toLowerCase();
    return v.includes('@') ? v : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** Events overlapping [from, to], with repeating events expanded. */
export function parseIcs(text: string, from: number, to: number, opts: { calendar: string; owner?: string }): CalEvent[] {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      /* odd timezone block */
    }
  }
  const calName = str(root.getFirstPropertyValue('x-wr-calname')) || opts.calendar;
  const masters = new Map<string, IcalEvent>();
  const loose: IcalEvent[] = [];
  const exceptions: IcalEvent[] = [];
  for (const ve of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(ve);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else if (ev.uid && !masters.has(ev.uid)) masters.set(ev.uid, ev);
    else loose.push(ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex);
    else loose.push(ex);
  }

  const out: CalEvent[] = [];
  const add = (item: IcalEvent, start: IcalTime, end: IcalTime | null, occurrence: string) => {
    const c = item.component;
    if (str(c.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return;
    if (opts.owner) {
      for (const a of c.getAllProperties('attendee')) {
        const who = str(a.getFirstValue()).replace(/^mailto:/i, '').toLowerCase();
        if (who === opts.owner && str(a.getParameter('partstat')).toUpperCase() === 'DECLINED') return;
      }
    }
    const allDay = start.isDate;
    const s = start.toJSDate().getTime();
    let e = end ? end.toJSDate().getTime() : s + (allDay ? 86_400_000 : 0);
    if (e < s) e = s;
    if (e < from || s > to) return;
    const location = str(item.location) || undefined;
    out.push({
      id: `${item.uid || 'x'}@${occurrence}`,
      title: str(item.summary).trim() || 'Busy',
      start: s,
      end: e,
      allDay,
      busy: str(c.getFirstPropertyValue('transp')).toUpperCase() !== 'TRANSPARENT',
      location,
      link: findLink(str(c.getFirstPropertyValue('x-google-conference')), location, str(item.description)),
      calendar: calName,
    });
  };

  for (const ev of [...masters.values(), ...loose]) {
    try {
      if (ev.isRecurring() && !ev.isRecurrenceException()) {
        const it = ev.iterator();
        let n = 0;
        for (let next = it.next(); next && n < 20_000; next = it.next(), n++) {
          if (next.toJSDate().getTime() > to) break;
          const d = ev.getOccurrenceDetails(next);
          add(d.item, d.startDate, d.endDate, String(next.toJSDate().getTime()));
        }
      } else if (ev.startDate) {
        add(ev, ev.startDate, ev.endDate, String(ev.startDate.toJSDate().getTime()));
      }
    } catch {
      /* a malformed event should not hide the rest */
    }
  }
  const seen = new Set<string>();
  return out
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));
const timed = (e: CalEvent) => !e.allDay && e.busy && e.end - e.start <= 8 * 3_600_000;

export function inMeeting(events: CalEvent[], now: number): CalEvent | undefined {
  return events.find((e) => timed(e) && e.start <= now && now < e.end);
}

export function nextMeeting(events: CalEvent[], now: number): CalEvent | undefined {
  return events.find((e) => timed(e) && e.start > now);
}

function sameDay(t: number, now: number): boolean {
  return dayKey(t) === dayKey(now);
}

/** "In Standup until 10:15. Next: Product sync at 2:00 (in 3 h 40 min). Also today: Dinner at 7:00." */
export function agendaText(events: CalEvent[], now: number): string {
  const cur = inMeeting(events, now);
  const later = events.filter((e) => timed(e) && e.start > now && sameDay(e.start, now));
  const allDay = events.filter((e) => e.allDay && e.start <= now && now < e.end).map((e) => e.title);
  const parts: string[] = [];
  if (cur) parts.push(`In "${cur.title}" until ${clock(cur.end)}.`);
  if (later.length) {
    const n = later[0];
    const inMin = mins(n.start - now);
    parts.push(`Next: "${n.title}" at ${clock(n.start)} (in ${inMin >= 60 ? `${Math.floor(inMin / 60)} h ${inMin % 60} min` : `${inMin} min`}).`);
    if (later.length > 1) parts.push(`Also today: ${later.slice(1, 5).map((e) => `"${e.title}" at ${clock(e.start)}`).join(', ')}.`);
  } else if (!cur) parts.push('No more meetings today.');
  if (allDay.length) parts.push(`All day: ${allDay.slice(0, 3).join(', ')}.`);
  return parts.join(' ');
}

export interface CalendarDeps {
  settings: () => CalendarSettings;
  http?: typeof fetch;
  log: (m: string) => void;
  /** Keeps each day's meetings, for the daily export. */
  saveDay: (day: string, events: { title: string; start: number; end: number }[]) => void;
  /** Events from the Calendar app on this Mac, when that's turned on. */
  mac?: (from: number, to: number) => Promise<CalEvent[]>;
}

/** Links are fetched over the internet every 10 minutes; the Mac's own Calendar is read every 2. */
const REFRESH_MS = 10 * 60_000;
const MAC_REFRESH_MS = 2 * 60_000;

/** The same meeting from two sources (say the Calendar app and a link) shows once. */
export function mergeEvents(lists: CalEvent[][]): CalEvent[] {
  const seen = new Set<string>();
  const out: CalEvent[] = [];
  for (const list of lists) {
    for (const e of list) {
      const key = `${e.title.trim().toLowerCase()}|${e.start}|${e.allDay ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export class CalendarManager {
  events: CalEvent[] = [];
  error?: string;
  lastFetch = 0;
  private inflight: Promise<void> | null = null;
  private warned = new Set<string>();
  private offered = new Set<string>();

  constructor(private d: CalendarDeps) {}

  /** Any calendar set up: links or the Calendar app. */
  get configured(): boolean {
    const s = this.d.settings();
    return s.urls.length > 0 || (!!s.mac && !!this.d.mac);
  }

  get connected(): boolean {
    return this.configured && this.lastFetch > 0 && !this.error;
  }

  async refresh(force = false): Promise<void> {
    const urls = this.d.settings().urls.map(normalizeIcsUrl).filter(Boolean);
    const mac = !!this.d.settings().mac && !!this.d.mac;
    if (!urls.length && !mac) {
      this.events = [];
      this.error = undefined;
      return;
    }
    if (this.inflight) return this.inflight;
    if (!force && Date.now() - this.lastFetch < (urls.length ? REFRESH_MS : MAC_REFRESH_MS)) return;
    this.inflight = this.load(urls, mac).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(urls: string[], mac: boolean): Promise<void> {
    const now = Date.now();
    const from = now - 18 * 3_600_000;
    const to = now + 8 * 86_400_000;
    const lists: CalEvent[][] = [];
    const errors: string[] = [];
    if (mac && this.d.mac) {
      try {
        lists.push(await this.d.mac(from, to));
      } catch (e) {
        errors.push(`Calendar app: ${(e as Error).message}`);
      }
    }
    for (const url of urls) {
      try {
        lists.push(await fetchIcs(url, from, to, this.d.http ?? fetch));
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    this.lastFetch = Date.now();
    const sources = urls.length + (mac ? 1 : 0);
    if (errors.length && !lists.length) {
      this.error = errors[0];
      this.d.log(`[calendar] ${this.error}`);
      return;
    }
    this.error = errors.length ? `${errors.length} of ${sources} calendars could not be read: ${errors[0]}` : undefined;
    this.events = mergeEvents(lists);
    const day = dayKey(now);
    this.d.saveDay(
      day,
      this.events.filter((e) => timed(e) && dayKey(e.start) === day).map((e) => ({ title: e.title, start: e.start, end: e.end })),
    );
  }

  now(now = Date.now()): CalEvent | undefined {
    return inMeeting(this.events, now);
  }

  next(now = Date.now()): CalEvent | undefined {
    return nextMeeting(this.events, now);
  }

  /** Events from the start of today for `days` days (the week view). */
  upcoming(now = Date.now(), days = 2): CalEvent[] {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + days * 86_400_000;
    return this.events.filter((e) => e.end > start.getTime() && e.start < end);
  }

  agenda(now = Date.now()): string {
    if (!this.configured) return '';
    return agendaText(this.events, now);
  }

  summary(now = Date.now()): CalendarSummary {
    const cur = this.now(now);
    const nx = this.next(now);
    return {
      connected: this.connected,
      error: this.error,
      now: cur ? { title: cur.title, end: cur.end } : undefined,
      next: nx && sameDay(nx.start, now) ? { title: nx.title, start: nx.start, link: nx.link } : undefined,
      left: this.events.filter((e) => timed(e) && e.end > now && sameDay(e.start, now)).length,
    };
  }

  /** Meetings starting within `minutes` that have not been announced yet. */
  headsUp(now: number, minutes: number): CalEvent | undefined {
    if (minutes <= 0) return undefined;
    const e = this.events.find((x) => timed(x) && x.start > now && x.start - now <= minutes * 60_000 && !this.warned.has(x.id));
    if (e) this.warned.add(e.id);
    return e;
  }

  /** A meeting that just ended, with a real gap before the next one. */
  gapAfter(now: number): { ended: CalEvent; freeMin: number; next?: CalEvent } | undefined {
    const ended = this.events.find((x) => timed(x) && x.end <= now && now - x.end < 3 * 60_000 && !this.offered.has(x.id));
    if (!ended) return undefined;
    this.offered.add(ended.id);
    if (this.now(now)) return undefined;
    const nx = this.next(now);
    const freeMin = nx ? mins(nx.start - now) : 120;
    return freeMin >= 30 ? { ended, freeMin, next: nx } : undefined;
  }
}

export async function fetchIcs(url: string, from: number, to: number, http: typeof fetch): Promise<CalEvent[]> {
  const res = await http(normalizeIcsUrl(url), { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { accept: 'text/calendar, */*' } });
  const text = await res.text();
  if (!res.ok) throw new Error(res.status === 404 ? 'That calendar link was not found. Copy it again.' : `The calendar link answered ${res.status}.`);
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That link is not an iCal (.ics) calendar. Use the "secret address in iCal format".');
  const host = (() => {
    try {
      return new URL(normalizeIcsUrl(url)).hostname.replace(/^www\./, '');
    } catch {
      return 'Calendar';
    }
  })();
  return parseIcs(text, from, to, { calendar: host, owner: ownerFromUrl(url) });
}
