// The Calendar app on this Mac as a calendar source, through the small Swift reader
// (native/mac-helper/calendar.swift). Whatever shows in Calendar works: Google (school and
// work accounts too, which often hide their iCal links), iCloud, Outlook/Exchange.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { CalEvent, MacCalendarInfo, MacCalStatus } from '../shared/types';
import { findLink } from './calendar';

/** Calendars that are noise for a focus coach, left out until you tick them. */
const NOISE = /birthdays?|holidays?|siri suggestions|scheduled reminders|found in (apps|mail|natural language)|week numbers/i;

export function defaultExcluded(cals: MacCalendarInfo[]): string[] {
  return cals.filter((c) => NOISE.test(c.title)).map((c) => c.id);
}

interface RawEvent {
  id?: string;
  title?: string;
  start?: number;
  end?: number;
  allDay?: boolean;
  free?: boolean;
  calendar?: string;
  calendarId?: string;
  location?: string;
  url?: string;
  notes?: string;
}

export interface RawOutput {
  status?: string;
  calendars?: { id?: string; title?: string; source?: string }[];
  events?: RawEvent[];
}

const STATUSES: MacCalStatus[] = ['notDetermined', 'restricted', 'denied', 'granted', 'writeOnly', 'unknown'];
export const asStatus = (s: unknown): MacCalStatus => (STATUSES.includes(s as MacCalStatus) ? (s as MacCalStatus) : 'unknown');

export function calendarsFrom(raw: RawOutput): MacCalendarInfo[] {
  return (raw.calendars ?? [])
    .filter((c) => c.id)
    .map((c) => ({ id: String(c.id), title: String(c.title ?? '').trim() || 'Calendar', source: String(c.source ?? '').trim() }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.title.localeCompare(b.title));
}

/** The reader's events as Lock In's, minus calendars you left out. */
export function eventsFrom(raw: RawOutput, exclude: string[] | undefined): CalEvent[] {
  const skip = new Set(exclude ?? defaultExcluded(calendarsFrom(raw)));
  const out: CalEvent[] = [];
  for (const e of raw.events ?? []) {
    if (typeof e.start !== 'number' || typeof e.end !== 'number') continue;
    if (e.calendarId && skip.has(e.calendarId)) continue;
    const start = e.start;
    let end = e.end;
    if (end < start) end = start;
    // EventKit ends all-day events at 23:59:59 on the last day; round up to midnight like iCal.
    if (e.allDay && new Date(end).getSeconds() === 59) end += 1000;
    out.push({
      id: `mac:${e.id ?? `${e.title}@${start}`}`,
      title: String(e.title ?? '').trim() || 'Busy',
      start,
      end,
      allDay: !!e.allDay,
      busy: !e.free,
      location: e.location || undefined,
      link: findLink(e.url, e.location, e.notes),
      calendar: e.calendar || 'Calendar',
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

export type Runner = (args: string[], timeoutMs: number) => Promise<string>;

export interface MacCalDeps {
  /** Path to lockin-calendar, or null when it isn't installed. */
  bin: () => string | null;
  run?: Runner;
  log: (m: string) => void;
}

export class MacCalendar {
  constructor(private d: MacCalDeps) {}

  /** Is the reader installed on this Mac? */
  get available(): boolean {
    if (this.d.run) return true;
    const b = this.d.bin();
    return process.platform === 'darwin' && !!b && existsSync(b);
  }

  private exec(args: string[], timeoutMs: number): Promise<RawOutput> {
    const run: Runner =
      this.d.run ??
      ((a, t) =>
        new Promise((resolve, reject) => {
          const b = this.d.bin();
          if (!b) return reject(new Error('missing'));
          execFile(b, a, { timeout: t, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))));
        }));
    return run(args, timeoutMs).then((out) => {
      const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
      return JSON.parse(line) as RawOutput;
    });
  }

  async status(): Promise<MacCalStatus | 'missing'> {
    if (!this.available) return 'missing';
    try {
      return asStatus((await this.exec(['status'], 10_000)).status);
    } catch (e) {
      this.d.log(`[mac calendar] status: ${(e as Error).message}`);
      return 'unknown';
    }
  }

  /** Shows macOS's "Lock In would like to access your calendars" prompt (only the first time). */
  async request(): Promise<MacCalStatus | 'missing'> {
    if (!this.available) return 'missing';
    try {
      return asStatus((await this.exec(['request'], 190_000)).status);
    } catch (e) {
      this.d.log(`[mac calendar] request: ${(e as Error).message}`);
      return 'unknown';
    }
  }

  async read(from: number, to: number, exclude?: string[]): Promise<{ status: MacCalStatus | 'missing'; calendars: MacCalendarInfo[]; events: CalEvent[] }> {
    if (!this.available) return { status: 'missing', calendars: [], events: [] };
    const raw = await this.exec(['events', String(Math.round(from)), String(Math.round(to))], 30_000);
    const status = asStatus(raw.status);
    if (status !== 'granted') return { status, calendars: [], events: [] };
    return { status, calendars: calendarsFrom(raw), events: eventsFrom(raw, exclude) };
  }
}

/** What to tell you when macOS hasn't given access. */
export function macStatusMessage(s: MacCalStatus | 'missing'): string {
  switch (s) {
    case 'granted':
      return '';
    case 'missing':
      return "The calendar reader isn't installed yet. Double-click Start Lock In once more; if it still says this, install Apple's command line tools by running xcode-select --install in Terminal.";
    case 'denied':
    case 'writeOnly':
      return 'macOS is blocking it. Open System Settings, Privacy & Security, Calendars, and turn on Full Access for Lock In.';
    case 'restricted':
      return "This Mac's settings don't allow apps to read calendars.";
    case 'notDetermined':
      return "macOS didn't show the permission prompt. Try again, or turn Lock In on in System Settings, Privacy & Security, Calendars.";
    default:
      return "Couldn't read the Calendar app. Try again in a moment.";
  }
}
