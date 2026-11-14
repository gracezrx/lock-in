// Anonymous usage data, so Lock In's maker can see which features people use (and, only for
// people who say yes, which apps and sites they spend their day in). Sent to Lock In's Supabase
// project every few minutes.
//
//   install id  a random id made on this Mac. No name, email, account or IP is kept with it.
//   events      what you did: started a session, the coach spoke, you talked back, sent a bomb,
//               every button and action in the app (counted, not timed). Never what you typed,
//               your goals, to-dos, window titles or what the coach said.
//   app usage   seconds per day in each app (and site, for browsers) and how Lock In labeled
//               it (work, distraction…). Only with "Share app usage" on. Apps you mark
//               sensitive, private windows and incognito tabs are counted as "(private)".
//
// The key below is Supabase's *publishable* key: it is meant to ship inside apps. It can only call
// ingest() and forget(); it can't read anything back. Set LOCKIN_TELEMETRY=off to turn it all off.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LabeledSample } from '../shared/types';

export const TELEMETRY_URL = 'https://byjevbycenjiceydsdmt.supabase.co';
export const TELEMETRY_KEY = 'sb_publishable_aumDs8Smi6Of7Ap-rZoJ6Q_TjtdyhSf';

/** Every this often, and when Lock In quits. */
export const FLUSH_MS = 3 * 60_000;
const MAX_QUEUE = 2000;
/** Read-only IPC calls aren't features: the pages ask for these all the time. */
const QUIET = /(:get|:status|:list|:where|:log|:view|:views|:state|:browsers|:apps|:installedApps|:clipPlan|:audio|:payload|:peek)$|^(state|settings:get|profile:get|setup:status)$/;

export type Props = Record<string, string | number | boolean | null | undefined>;

export interface TelemetryEvent {
  at: string;
  name: string;
  props: Props;
}

export interface UsageRow {
  day: string;
  app: string;
  bundle_id: string;
  domain: string;
  label: 'work' | 'neutral' | 'distraction' | 'private';
  in_session: boolean;
  seconds: number;
}

export interface TelemetryDeps {
  dir: string;
  version: string;
  osVersion: string;
  /** Anything at all (this is the "Share usage data" switch, and off in dev and tests). */
  enabled: () => boolean;
  /** App and site usage too ("Share app usage"). */
  shareApps: () => boolean;
  /** How this install is set up right now (persona, keys added, extension…). No personal data. */
  traits: () => Record<string, string | number | boolean | null>;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  url?: string;
  key?: string;
}

const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Short strings and numbers only, so no stray text (a goal, a title) can ride along. */
function clean(props: Props = {}): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 80);
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    else out[k] = v;
  }
  return out;
}

export class Telemetry {
  readonly installId: string;
  private events: TelemetryEvent[] = [];
  private ui = new Map<string, number>();
  private usage = new Map<string, UsageRow>();
  private sending = false;
  private lastFlush = 0;
  private lastDay = '';
  private file: string;
  private queueFile: string;
  private now: () => number;

  constructor(private d: TelemetryDeps) {
    this.now = d.now ?? Date.now;
    this.file = join(d.dir, 'telemetry.json');
    this.queueFile = join(d.dir, 'telemetry-queue.json');
    let id = '';
    try {
      id = String((JSON.parse(readFileSync(this.file, 'utf8')) as { installId?: string }).installId ?? '');
    } catch {
      /* first run */
    }
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      id = randomUUID();
      try {
        writeFileSync(this.file, JSON.stringify({ installId: id, createdAt: new Date(this.now()).toISOString() }, null, 2));
      } catch {
        /* read-only disk: a new id next time */
      }
    }
    this.installId = id;
    // Whatever didn't make it out last time (offline, or quit mid-send).
    try {
      if (existsSync(this.queueFile)) {
        const q = JSON.parse(readFileSync(this.queueFile, 'utf8')) as { events?: TelemetryEvent[]; usage?: UsageRow[] };
        this.events = (q.events ?? []).slice(-MAX_QUEUE);
        for (const r of q.usage ?? []) this.addUsage(r);
        writeFileSync(this.queueFile, '{}');
      }
    } catch {
      /* a broken queue is dropped */
    }
  }

  get on(): boolean {
    return this.d.enabled();
  }

  /** A feature was used. */
  track(name: string, props?: Props): void {
    if (!this.on) return;
    this.events.push({ at: new Date(this.now()).toISOString(), name, props: clean(props) });
    if (this.events.length > MAX_QUEUE) this.events.splice(0, this.events.length - MAX_QUEUE);
  }

  /** A button or action in any of Lock In's pages (an IPC call), counted per flush. */
  action(channel: string, from: 'mac' | 'phone' | 'extension' = 'mac'): void {
    if (!this.on || QUIET.test(channel)) return;
    const k = `${from}|${channel}`;
    this.ui.set(k, (this.ui.get(k) ?? 0) + 1);
  }

  /** One tick of the 1 Hz loop: dt seconds in whatever is in front. */
  sample(s: LabeledSample | null, dt: number, inSession: boolean, idleSec: number): void {
    if (!this.on) return;
    const now = this.now();
    const day = dayOf(now);
    if (day !== this.lastDay) {
      // A daily "I was here", so active users count even on days without a session.
      if (this.lastDay) this.track('day_active');
      this.lastDay = day;
    }
    if (!this.d.shareApps() || !s || idleSec > 120 || s.label === 'away' || dt <= 0) return;
    const priv = s.label === 'private' || s.isPrivate;
    this.addUsage({
      day,
      app: priv ? '(private)' : s.app.slice(0, 120),
      bundle_id: priv ? '' : (s.bundleId ?? '').slice(0, 160),
      domain: priv || !s.browser ? '' : (s.domain ?? '').replace(/^www\./, '').slice(0, 160),
      label: priv ? 'private' : s.label === 'work' || s.label === 'distraction' ? s.label : 'neutral',
      in_session: inSession,
      seconds: dt,
    });
  }

  private addUsage(r: UsageRow): void {
    const k = [r.day, r.app, r.bundle_id, r.domain, r.label, r.in_session].join('|');
    const had = this.usage.get(k);
    if (had) had.seconds += r.seconds;
    else this.usage.set(k, { ...r });
  }

  /** Is it time to send? (The loop asks every tick.) */
  due(): boolean {
    return this.on && !this.sending && this.now() - this.lastFlush >= FLUSH_MS;
  }

  /** What would be sent right now (also shown in Settings → Your data). */
  payload(): Record<string, unknown> {
    const events = [...this.events];
    for (const [k, count] of this.ui) {
      const [from, action] = k.split('|');
      events.push({ at: new Date(this.now()).toISOString(), name: 'ui', props: { action, from, count } });
    }
    const usage = [...this.usage.values()].filter((r) => r.seconds >= 1).map((r) => ({ ...r, seconds: Math.round(r.seconds) }));
    return {
      install_id: this.installId,
      app_version: this.d.version,
      os_version: this.d.osVersion,
      arch: process.arch,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      share_apps: this.d.shareApps(),
      traits: this.d.traits(),
      events,
      usage: this.d.shareApps() ? usage : [],
    };
  }

  /** Sends everything queued. Keeps it for next time if the network is down. */
  async flush(timeoutMs = 15_000): Promise<boolean> {
    if (!this.on || this.sending) return false;
    this.sending = true;
    this.lastFlush = this.now();
    const body = this.payload();
    const sentEvents = this.events.length;
    const sentUi = new Map(this.ui);
    const sentUsage = new Map([...this.usage].map(([k, r]) => [k, r.seconds]));
    try {
      const ok = await this.post('rpc/ingest', { payload: body }, timeoutMs);
      if (!ok) return false;
      this.events.splice(0, sentEvents);
      for (const [k, n] of sentUi) {
        const left = (this.ui.get(k) ?? 0) - n;
        if (left > 0) this.ui.set(k, left);
        else this.ui.delete(k);
      }
      for (const [k, s] of sentUsage) {
        const r = this.usage.get(k);
        if (!r) continue;
        if (s >= 1) r.seconds -= s;
        if (r.seconds < 0.5) this.usage.delete(k);
      }
      return true;
    } finally {
      this.sending = false;
    }
  }

  /** "Delete my data": removes this install's rows on the server, and starts over with a new id. */
  async forget(): Promise<boolean> {
    const ok = await this.post('rpc/forget', { p_install_id: this.installId }, 15_000, true);
    if (ok) {
      this.events = [];
      this.ui.clear();
      this.usage.clear();
    }
    return ok;
  }

  /** On quit: whatever couldn't be sent waits on disk for the next launch. */
  saveQueue(): void {
    if (!this.on) return;
    try {
      writeFileSync(this.queueFile, JSON.stringify({ events: this.events.slice(-MAX_QUEUE), usage: [...this.usage.values()] }));
    } catch {
      /* lost, which is fine */
    }
  }

  /** Turned off: drop what was waiting. */
  clear(): void {
    this.events = [];
    this.ui.clear();
    this.usage.clear();
    try {
      writeFileSync(this.queueFile, '{}');
    } catch {
      /* nothing to clear */
    }
  }

  private async post(path: string, body: unknown, timeoutMs: number, force = false): Promise<boolean> {
    if (!force && !this.on) return false;
    const f = this.d.fetch ?? fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(`${this.d.url ?? TELEMETRY_URL}/rest/v1/${path}`, {
        method: 'POST',
        headers: { apikey: this.d.key ?? TELEMETRY_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!r.ok) this.d.log?.(`[telemetry] ${path} ${r.status}`);
      return r.ok;
    } catch (e) {
      this.d.log?.(`[telemetry] ${path} failed: ${(e as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
