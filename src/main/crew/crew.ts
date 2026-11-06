// Lock in with friends. A crew shares one encrypted ntfy topic; everyone posts their status
// (locked in, drifting, free, in a meeting, away) and can throw Lock In bombs at friends who
// aren't locked in: 3 a day, each one locks every distraction on the friend's Mac for 5 minutes
// and takes over their screen for 5 seconds.
//
// There is no server of our own, so the rules are kept by the people they protect: whoever
// gets bombed counts how many bombs each friend has landed on them today and ignores a fourth,
// ignores stale bombs (sent while they were offline), and bounces bombs that arrive after they
// locked in (the thrower gets that bomb back).
import { randomUUID } from 'node:crypto';
import type { CrewFeedItem, CrewMemberView, CrewSettings, CrewState, CrewStats, CrewView } from '../../shared/types';
import { codeSecret, crewKeys, formatCode, newCode, open, seal, type CrewKeys } from './code';
import type { Relay, RelayMessage } from './relay';

export const BOMBS_PER_DAY = 3;
export const MAX_INSULT = 140;

export const INSULTS = [
  'Touch grass later. Touch your to-do list now.',
  'Your future self just filed a complaint.',
  'I can hear you scrolling from here.',
  'Bold of you to relax with that deadline.',
  'Main character energy, side quest behavior.',
  'Close it. Whatever it is. Close it.',
  'Your work misses you. It told me.',
  'The group chat has voted: lock in.',
];

/** Nothing heard for this long: offline. */
export const ONLINE_MS = 25 * 60_000;
/** A bomb that took longer than this to arrive (you were offline) doesn't go off. */
export const BOMB_FRESH_MS = 2 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;
/** Drifting and free must settle this long before friends hear about it (no flicker). */
const SETTLE_MS = 20_000;

export type BombOutcome = 'hit' | 'soft' | 'bounced';
type LiveState = Exclude<CrewState, 'offline'>;

export interface LocalStatus {
  state: LiveState;
  since: number;
  goal?: string;
  distraction?: string;
  sessionMin?: number;
  stats: CrewStats;
}

interface Base {
  v: 1;
  t: string;
  from: string;
  name: string;
  crew?: string;
  at: number;
}
interface StatusMsg extends Base {
  t: 'status';
  state: LiveState;
  since: number;
  goal?: string;
  distraction?: string;
  sessionMin?: number;
  stats: CrewStats;
}
interface BombMsg extends Base {
  t: 'bomb';
  id: string;
  to: string;
  toName: string;
  insult: string;
}
interface ResultMsg extends Base {
  t: 'result';
  id: string;
  to: string;
  toName: string;
  outcome: BombOutcome;
}
interface AchMsg extends Base {
  t: 'ach';
  achName: string;
}
interface LeaveMsg extends Base {
  t: 'leave';
}
type Msg = StatusMsg | BombMsg | ResultMsg | AchMsg | LeaveMsg;

interface MemberRec {
  id: string;
  name: string;
  state: LiveState;
  since: number;
  goal?: string;
  distraction?: string;
  sessionMin?: number;
  stats: CrewStats;
  lastSeen: number;
  /** When their latest status was sent (older ones arriving late are ignored). */
  statusAt?: number;
}

/** Bombs in and out, kept for achievements and the weekly board. */
export interface CrewEvent {
  type: 'thrown' | 'received';
  at: number;
  /** The friend's id. */
  other: string;
  outcome?: BombOutcome;
}

export interface CrewData {
  me: string;
  members: Record<string, MemberRec>;
  feed: CrewFeedItem[];
  thrown: { day: string; ids: string[]; refunded: string[] };
  received: { day: string; bySender: Record<string, number> };
  seen: string[];
  events: CrewEvent[];
}

export interface CrewDeps {
  settings: () => CrewSettings;
  saveSettings: (patch: Partial<CrewSettings>) => void;
  relay: Relay;
  load: () => CrewData | null;
  save: (d: CrewData) => void;
  /** What you're up to right now. */
  local: () => LocalStatus;
  /** A bomb aimed at you: show it, and say whether it hit, was softened (a call, mute) or bounced (you're locked in). */
  onBomb: (b: { id: string; from: string; name: string; insult: string }) => BombOutcome;
  onChange: () => void;
  log: (m: string) => void;
  now?: () => number;
}

const EMPTY_STATS: CrewStats = { todayMin: 0, weekMin: 0, streak: 0, roastedWeek: 0, bombsThrownWeek: 0, achievements: 0 };

const pad = (n: number) => String(n).padStart(2, '0');
export const dayOf = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** One line of plain text, no control characters, at most `max` long. */
export function clean(text: unknown, max: number): string {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const STATES = new Set<LiveState>(['locked', 'break', 'drifting', 'free', 'meeting', 'away']);

function statsOf(x: unknown): CrewStats {
  const s = (x ?? {}) as Partial<CrewStats>;
  const n = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
  return {
    todayMin: n(s.todayMin, 1440),
    weekMin: n(s.weekMin, 10_080),
    streak: n(s.streak, 3650),
    roastedWeek: n(s.roastedWeek, 10_000),
    bombsThrownWeek: n(s.bombsThrownWeek, 100),
    achievements: n(s.achievements, 100),
  };
}

/** A message from the wire, checked field by field (anything off is dropped). */
export function parseMsg(x: unknown): Msg | null {
  const m = x as Partial<Msg> & Record<string, unknown>;
  if (!m || m.v !== 1 || typeof m.t !== 'string' || typeof m.from !== 'string' || !m.from || typeof m.at !== 'number') return null;
  const base = { v: 1 as const, from: m.from.slice(0, 64), name: clean(m.name, 32) || 'A friend', crew: m.crew ? clean(m.crew, 40) : undefined, at: m.at };
  switch (m.t) {
    case 'status':
      if (!STATES.has(m.state as LiveState)) return null;
      return {
        ...base,
        t: 'status',
        state: m.state as LiveState,
        since: typeof m.since === 'number' ? m.since : m.at,
        goal: m.goal ? clean(m.goal, 80) : undefined,
        distraction: m.distraction ? clean(m.distraction, 40) : undefined,
        sessionMin: typeof m.sessionMin === 'number' ? Math.max(0, Math.min(600, Math.round(m.sessionMin))) : undefined,
        stats: statsOf(m.stats),
      };
    case 'bomb':
      if (typeof m.id !== 'string' || typeof m.to !== 'string') return null;
      return { ...base, t: 'bomb', id: m.id.slice(0, 64), to: m.to.slice(0, 64), toName: clean(m.toName, 32), insult: clean(m.insult, MAX_INSULT) || 'Lock in.' };
    case 'result':
      if (typeof m.id !== 'string' || typeof m.to !== 'string' || !['hit', 'soft', 'bounced'].includes(String(m.outcome))) return null;
      return { ...base, t: 'result', id: m.id.slice(0, 64), to: m.to.slice(0, 64), toName: clean(m.toName, 32), outcome: m.outcome as BombOutcome };
    case 'ach':
      return { ...base, t: 'ach', achName: clean(m.achName, 40) };
    case 'leave':
      return { ...base, t: 'leave' };
    default:
      return null;
  }
}

function fresh(me?: string): CrewData {
  return { me: me ?? randomUUID(), members: {}, feed: [], thrown: { day: '', ids: [], refunded: [] }, received: { day: '', bySender: {} }, seen: [], events: [] };
}

export class Crew {
  private data: CrewData;
  private keys: CrewKeys | null = null;
  private connected = false;
  private error?: string;
  private lastSig = '';
  private lastPublish = 0;
  private pending: { sig: string; since: number } | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private d: CrewDeps) {
    const saved = d.load();
    this.data = saved?.me ? { ...fresh(saved.me), ...saved } : fresh();
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  get me(): string {
    return this.data.me;
  }

  get joined(): boolean {
    return !!codeSecret(this.d.settings().code);
  }

  /** Bomb history, for achievements and the weekly board. */
  events(): CrewEvent[] {
    return this.data.events;
  }

  /** Everyone else's latest numbers (not yours, so it's safe to call while working yours out). */
  othersStats(): CrewStats[] {
    return this.joined ? Object.values(this.data.members).map((m) => m.stats) : [];
  }

  // ---- joining ------------------------------------------------------------------

  start(): void {
    this.keys = crewKeys(this.d.settings().code);
    if (!this.keys) return;
    // Catch up on the last 12 hours (that's how long ntfy keeps messages).
    this.d.relay.start(this.keys.topic, 12 * 3600);
    this.lastSig = '';
  }

  stop(): void {
    this.d.relay.stop();
    this.connected = false;
  }

  setConnection(on: boolean, error?: string): void {
    this.connected = on;
    this.error = on ? undefined : error || this.error;
    if (on) this.lastSig = ''; // say hello again
    this.d.onChange();
  }

  create(crewName: string, name: string): string {
    const code = newCode();
    this.reset();
    this.d.saveSettings({ code, crewName: clean(crewName, 40) || 'Our crew', name: clean(name, 32) || 'Me' });
    this.feed('join', `You started ${clean(crewName, 40) || 'the crew'}. Send friends the invite code.`);
    this.start();
    return code;
  }

  join(code: string, name: string): { ok: boolean; error?: string } {
    if (!codeSecret(code)) return { ok: false, error: "That isn't a Lock In invite code. It's 26 letters and numbers, like K7Q2M-9XW4T-…" };
    this.reset();
    this.d.saveSettings({ code: formatCode(code), crewName: '', name: clean(name, 32) || 'Me' });
    this.feed('join', 'You joined the crew.');
    this.start();
    return { ok: true };
  }

  async leave(): Promise<void> {
    if (this.keys) await this.send({ t: 'leave' } as Partial<Msg>);
    this.stop();
    this.reset();
    this.d.saveSettings({ code: '', crewName: '' });
    this.d.onChange();
  }

  private reset(): void {
    this.stop();
    this.data = fresh(this.data.me);
    this.lastSig = '';
    this.pending = null;
    this.persist();
  }

  // ---- the wire -------------------------------------------------------------------

  private async send(m: Partial<Msg>): Promise<boolean> {
    if (!this.keys) return false;
    const st = this.d.settings();
    const msg = { v: 1, from: this.data.me, name: st.name || 'Me', crew: st.crewName || undefined, at: this.now(), ...m };
    return this.d.relay.publish(this.keys.topic, seal(this.keys.key, msg));
  }

  receive(raw: RelayMessage): void {
    if (!this.keys) return;
    if (raw.id) {
      if (this.data.seen.includes(raw.id)) return;
      this.data.seen.push(raw.id);
      if (this.data.seen.length > 3000) this.data.seen.splice(0, this.data.seen.length - 3000);
    }
    const msg = parseMsg(open(this.keys.key, raw.text));
    if (!msg) return;
    const now = this.now();
    if (msg.from === this.data.me) return; // our own echo
    if (msg.crew && !this.d.settings().crewName) this.d.saveSettings({ crewName: msg.crew });

    if (msg.t === 'leave') {
      delete this.data.members[msg.from];
      this.feed('leave', `${msg.name} left the crew.`, msg.at);
    } else {
      const m = (this.data.members[msg.from] ??= { id: msg.from, name: msg.name, state: 'free', since: msg.at, stats: { ...EMPTY_STATS }, lastSeen: 0 });
      m.name = msg.name;
      m.lastSeen = Math.max(m.lastSeen, Math.min(msg.at, now));
      if (msg.t === 'status' && msg.at >= (m.statusAt ?? 0)) {
        const lockedNow = msg.state === 'locked' && m.state !== 'locked' && now - msg.at < 5 * 60_000;
        Object.assign(m, { state: msg.state, since: msg.since, goal: msg.goal, distraction: msg.distraction, sessionMin: msg.sessionMin, stats: msg.stats, statusAt: msg.at });
        if (lockedNow) this.feed('session', `${msg.name} locked in${msg.goal ? ` on ${msg.goal}` : ''}.`, msg.at);
      }
    }
    if (msg.t === 'bomb') this.bombArrived(msg, now);
    if (msg.t === 'result') this.resultArrived(msg);
    if (msg.t === 'ach' && msg.achName) this.feed('achievement', `${msg.name} unlocked ${msg.achName}.`, msg.at);
    this.persist();
    this.d.onChange();
  }

  private bombArrived(b: BombMsg, now: number): void {
    if (b.to !== this.data.me) {
      this.feed('bomb', `${b.name} bombed ${b.toName || 'someone'}: “${b.insult}”`, b.at);
      return;
    }
    if (now - b.at > BOMB_FRESH_MS) {
      this.feed('bomb', `${b.name} bombed you while you were away: “${b.insult}”`, b.at);
      return;
    }
    const today = dayOf(now);
    if (this.data.received.day !== today) this.data.received = { day: today, bySender: {} };
    const landed = this.data.received.bySender[b.from] ?? 0;
    if (landed >= BOMBS_PER_DAY) {
      this.d.log(`[crew] ignored a 4th bomb from ${b.name} today`);
      return;
    }
    let outcome: BombOutcome;
    try {
      outcome = this.d.onBomb({ id: b.id, from: b.from, name: b.name, insult: b.insult });
    } catch (e) {
      this.d.log(`[crew] bomb: ${(e as Error).message}`);
      outcome = 'soft';
    }
    if (outcome !== 'bounced') this.data.received.bySender[b.from] = landed + 1;
    this.data.events.push({ type: 'received', at: now, other: b.from, outcome });
    this.trimEvents();
    this.feed(outcome === 'bounced' ? 'bounce' : 'bomb', outcome === 'bounced' ? `${b.name}'s bomb bounced off you. You're locked in.` : `${b.name} bombed you: “${b.insult}”`, b.at);
    void this.send({ t: 'result', id: b.id, to: b.from, toName: b.name, outcome } as Partial<Msg>);
  }

  private resultArrived(r: ResultMsg): void {
    if (r.to !== this.data.me) {
      if (r.outcome === 'bounced') this.feed('bounce', `${r.toName || 'A bomb'}'s bomb bounced off ${r.name}. Locked in.`, r.at);
      return;
    }
    const ev = this.data.events.find((e) => e.type === 'thrown' && e.other === r.from && !e.outcome);
    if (ev) ev.outcome = r.outcome;
    if (r.outcome === 'bounced' && this.data.thrown.ids.includes(r.id) && !this.data.thrown.refunded.includes(r.id)) {
      this.data.thrown.refunded.push(r.id);
      this.feed('bounce', `Your bomb bounced off ${r.name}: they locked in first. You get it back.`, r.at);
    } else if (r.outcome === 'soft') {
      this.feed('bomb', `${r.name} was in a meeting or on mute, so your bomb landed softly.`, r.at);
    }
  }

  // ---- bombs ----------------------------------------------------------------------

  bombsLeft(): number {
    const today = dayOf(this.now());
    if (this.data.thrown.day !== today) this.data.thrown = { day: today, ids: [], refunded: [] };
    const used = this.data.thrown.ids.filter((id) => !this.data.thrown.refunded.includes(id)).length;
    return Math.max(0, BOMBS_PER_DAY - used);
  }

  private bombable(m: MemberRec, now: number): boolean {
    return m.id !== this.data.me && (m.state === 'free' || m.state === 'drifting') && now - m.lastSeen < ONLINE_MS;
  }

  async throwBomb(to: string, insult: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.keys) return { ok: false, error: 'Join a crew first.' };
    const now = this.now();
    const m = this.data.members[to];
    if (!m) return { ok: false, error: "That friend isn't in your crew." };
    if (!this.bombable(m, now)) {
      return { ok: false, error: m.state === 'locked' || m.state === 'break' ? `${m.name} is locked in. Leave them be.` : `${m.name} isn't at their computer right now.` };
    }
    if (this.bombsLeft() <= 0) return { ok: false, error: 'No bombs left today. You get 3 more tomorrow.' };
    const text = clean(insult, MAX_INSULT);
    if (!text) return { ok: false, error: 'Pick an insult or write one.' };
    const id = randomUUID();
    // Written down before it goes out: the reply (hit or bounced) can beat the send's own answer.
    const ev: CrewEvent = { type: 'thrown', at: now, other: to };
    this.data.thrown.ids.push(id);
    this.data.events.push(ev);
    const sent = await this.send({ t: 'bomb', id, to, toName: m.name, insult: text } as Partial<Msg>);
    if (!sent) {
      this.data.thrown.ids = this.data.thrown.ids.filter((x) => x !== id);
      this.data.events = this.data.events.filter((e) => e !== ev);
      return { ok: false, error: "Couldn't reach the relay. Check your internet and try again." };
    }
    this.trimEvents();
    this.feed('bomb', `You bombed ${m.name}: “${text}”`, now);
    this.persist();
    this.d.onChange();
    return { ok: true };
  }

  // ---- your status ------------------------------------------------------------------

  /** Called every few seconds: tells the crew when your status changes, and every 10 minutes regardless. */
  tick(): void {
    if (!this.keys || !this.connected) return;
    const now = this.now();
    const local = this.d.local();
    const sig = JSON.stringify([local.state, local.goal ?? '', local.distraction ?? '']);
    let due = now - this.lastPublish > HEARTBEAT_MS;
    if (sig !== this.lastSig) {
      // Locking in (or out of) a session is news right away; drifting and free settle first.
      const urgent = local.state === 'locked' || local.state === 'break' || this.lastSig.includes('"locked"') || this.lastSig.includes('"break"') || !this.lastSig;
      if (urgent) due = true;
      else {
        if (!this.pending || this.pending.sig !== sig) this.pending = { sig, since: now };
        if (now - this.pending.since >= SETTLE_MS) due = true;
      }
    }
    if (!due) return;
    this.lastSig = sig;
    this.lastPublish = now;
    this.pending = null;
    void this.send({ t: 'status', state: local.state, since: local.since, goal: local.goal, distraction: local.distraction, sessionMin: local.sessionMin, stats: local.stats } as Partial<Msg>).then((ok) => {
      if (!ok) this.lastPublish = 0; // try again next tick
    });
  }

  /** Tell the crew about an achievement. */
  shareAchievement(name: string): void {
    if (this.keys) void this.send({ t: 'ach', achName: clean(name, 40) } as Partial<Msg>);
  }

  // ---- what the page shows --------------------------------------------------------------

  view(): CrewView {
    const st = this.d.settings();
    const now = this.now();
    const local = this.d.local();
    const meView: CrewMemberView = {
      id: this.data.me,
      name: st.name || 'You',
      me: true,
      state: local.state,
      since: local.since,
      goal: local.goal,
      distraction: local.distraction,
      sessionMin: local.sessionMin,
      stats: local.stats,
      lastSeen: now,
      bombable: false,
    };
    const order: CrewState[] = ['locked', 'break', 'drifting', 'free', 'meeting', 'away', 'offline'];
    const others = Object.values(this.data.members).map<CrewMemberView>((m) => {
      const offline = now - m.lastSeen >= ONLINE_MS;
      const { statusAt: _, ...rest } = m;
      return { ...rest, me: false, state: offline ? 'offline' : m.state, since: offline ? m.lastSeen : m.since, bombable: this.bombable(m, now) };
    });
    others.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.name.localeCompare(b.name));
    return {
      joined: this.joined,
      crewName: st.crewName,
      code: st.code,
      connected: this.connected,
      error: this.error,
      me: this.data.me,
      members: [meView, ...others],
      bombsLeft: this.bombsLeft(),
      bombsPerDay: BOMBS_PER_DAY,
      feed: [...this.data.feed].sort((a, b) => b.at - a.at).slice(0, 30),
      insults: INSULTS,
    };
  }

  // ---- bookkeeping ----------------------------------------------------------------------

  private feed(kind: CrewFeedItem['kind'], text: string, at = this.now()): void {
    this.data.feed.push({ id: randomUUID(), at, kind, text });
    if (this.data.feed.length > 80) this.data.feed.splice(0, this.data.feed.length - 80);
  }

  private trimEvents(): void {
    const cutoff = this.now() - 35 * 86_400_000;
    this.data.events = this.data.events.filter((e) => e.at >= cutoff).slice(-500);
  }

  private persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.d.save(this.data);
    }, 500);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.d.save(this.data);
  }
}
