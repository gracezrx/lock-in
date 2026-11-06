// How Lock In reaches out: one small gate in front of every card that isn't urgent (reminders,
// goal nudges, "Lock In noticed something"). Meetings, deadlines, roasts, bedtime and anything
// in a session skip it. Four rules, each from research on proactive assistants and
// just-in-time nudges (see the README, "How Lock In reaches out"):
//
//  1. Natural pauses. A card that can wait, waits for a breakpoint: back from a break, a
//     session or meeting just ended, a to-do just done, or the first minutes of the day. It goes
//     out 20 seconds to 3 minutes after the pause, once you're settled. The wait is bounded: if no
//     pause comes in time, the card goes out anyway, or is dropped when it would be stale.
//  2. One shared budget. At most N of these cards a day, and a gap after any card (a roast or a
//     meeting heads-up counts too), so they never pile up.
//  3. Nothing is an answer too. A card is dropped when the moment makes it pointless (you just
//     took a break, so "stand up" is moot) or when it has gone stale.
//  4. Learning. Cards of a kind you keep ignoring come less often (every 2nd, then every 3rd…);
//     acting on one brings them back to normal.
//
// Pure logic: no Electron, no clock of its own. index.ts feeds it signals once a second.

/** A natural pause: the moments an interruption costs least. */
export type Moment = 'arrive' | 'back' | 'session-end' | 'meeting-end' | 'todo-done';
export type Outcome = 'acted' | 'dismissed' | 'ignored' | 'snoozed';

export interface Card {
  /** A card with the same key replaces the one waiting. Also the tag that ties the toast back to it. */
  key: string;
  /** Kind for learning and for the page: "routine:hydrate", "goal:breaks", "noticed". */
  kind: string;
  /** 'pause': wait for a natural pause. 'soon': as soon as you're settled and the gap allows. */
  when: 'pause' | 'soon';
  /** The longest it waits (minutes). After that it goes out at the next calm moment… */
  holdMin: number;
  /** …unless it would be stale by then, in which case it's dropped. */
  dropIfStale?: boolean;
  /** Pauses that make it pointless: a natural break answers "time to stand up". */
  mootOn?: Moment[];
  /** Cards in one family stand in for each other: sending one drops the others waiting. */
  family?: string;
  /** Shows the card. Resolves true when it went out as a corner card (so its outcome can be learned). */
  send: () => Promise<boolean> | boolean;
}

export interface KindStats {
  shown: number;
  acted: number;
  dismissed: number;
  ignored: number;
  /** Ignored or dismissed in a row. */
  streak: number;
  /** Cards of this kind skipped since the last one shown (thinning). */
  skipped: number;
  last?: number;
}

export interface AttentionState {
  day: string;
  sentToday: number;
  /** Any card at all, even one that doesn't go through the gate. */
  lastCardAt: number;
  /** Last keyboard or mouse activity, so coming back after a restart still counts as arriving. */
  lastActiveAt?: number;
  stats: Record<string, KindStats>;
}

export interface AttentionSettings {
  /** Wait for a natural pause (otherwise cards go out as soon as you're settled). */
  pauses: boolean;
  maxPerDay: number;
  /** Minutes between any two cards. */
  minGapMin: number;
}

export const DEFAULT_ATTENTION: AttentionSettings = { pauses: true, maxPerDay: 12, minGapMin: 20 };

export interface Signals {
  now: number;
  /** The 4 am-to-4 am day. */
  day: string;
  idleSec: number;
  /** Nothing going on that a card would interrupt: no session, call, meeting, open card, mute. */
  calm: boolean;
  inSession: boolean;
  inMeeting: boolean;
  todosDone: number;
}

/** Away this long counts as a break. */
const BREAK_MS = 5 * 60_000;
/** Away this long (or a new day) and coming back is arriving. */
const ARRIVE_MS = 2 * 3_600_000;
/** After a pause: wait this long for you to settle, and use it for this long. */
const SETTLE_MS = 20_000;
const PAUSE_WINDOW_MS = 3 * 60_000;
/** A card nobody touched for this long was ignored. */
const OPEN_MS = 15 * 60_000;

const emptyStats = (): KindStats => ({ shown: 0, acted: 0, dismissed: 0, ignored: 0, streak: 0, skipped: 0 });

/** How many cards of a kind to skip for each one shown: 0 normally, 1 after two ignored in a row, 2 after four. */
export const thinning = (streak: number) => Math.min(3, Math.floor(streak / 2));

/** What a button on a card means for learning. */
export function outcomeOf(actionId: string): Outcome {
  const verb = actionId.split(':')[0];
  if (verb === 'snooze' || verb === 'goal-snooze' || verb === 'goal-later' || verb === 'snooze-roasts') return 'snoozed';
  return 'acted';
}

export class Attention {
  state: AttentionState;
  private held: (Card & { at: number })[] = [];
  private open: { key: string; kind: string; at: number; shown: boolean } | null = null;
  private prev: { session: boolean; meeting: boolean; done: number } | null = null;
  moment: { kind: Moment; at: number } | null = null;

  constructor(
    saved: Partial<AttentionState> | null,
    private settings: () => AttentionSettings,
    private log: (m: string) => void = () => undefined,
  ) {
    this.state = { day: '', sentToday: 0, lastCardAt: 0, stats: {}, ...(saved ?? {}) };
  }

  /** Offer a card. It goes out now, waits for a pause, or (for a kind you keep ignoring) is skipped. */
  offer(card: Card, now: number): 'waiting' | 'skipped' {
    const st = (this.state.stats[card.kind] ??= emptyStats());
    const skip = thinning(st.streak);
    if (skip && st.skipped < skip) {
      st.skipped++;
      this.log(`[attention] skipped ${card.kind} (${st.skipped} of ${skip}: ignored ${st.streak} in a row)`);
      return 'skipped';
    }
    this.held = this.held.filter((h) => h.key !== card.key);
    this.held.push({ ...card, at: now });
    return 'waiting';
  }

  /** Drop a waiting card (it no longer applies). */
  withdraw(key: string): void {
    this.held = this.held.filter((h) => h.key !== key);
  }

  waiting(): string[] {
    return this.held.map((h) => h.key);
  }

  /** Spots natural pauses from what the loop sees. */
  observe(s: Signals): Moment | null {
    if (this.state.day !== s.day) {
      this.state.day = s.day;
      this.state.sentToday = 0;
    }
    let m: Moment | null = null;
    if (s.idleSec < 60) {
      const at = s.now - s.idleSec * 1000;
      const last = this.state.lastActiveAt ?? 0;
      // The very first activity Lock In has seen counts as arriving too.
      if (!last || at - last >= ARRIVE_MS) m = 'arrive';
      else if (at - last > BREAK_MS) m = 'back';
      this.state.lastActiveAt = Math.max(last, at);
    }
    if (this.prev) {
      if (this.prev.session && !s.inSession) m = 'session-end';
      else if (this.prev.meeting && !s.inMeeting) m ??= 'meeting-end';
      else if (s.todosDone > this.prev.done) m ??= 'todo-done';
    }
    this.prev = { session: s.inSession, meeting: s.inMeeting, done: s.todosDone };
    if (m) {
      this.moment = { kind: m, at: s.now };
      const moot = this.held.filter((h) => h.mootOn?.includes(m!));
      if (moot.length) {
        this.held = this.held.filter((h) => !moot.includes(h));
        this.log(`[attention] ${m}: dropped ${moot.map((h) => h.kind).join(', ')}`);
      }
    }
    return m;
  }

  /** Are we a few seconds into a natural pause, and still in it? */
  atPause(now: number, idleSec: number): boolean {
    if (!this.moment || idleSec >= 60) return false;
    const since = now - this.moment.at;
    return since >= SETTLE_MS && since <= PAUSE_WINDOW_MS;
  }

  /** Once a second: spot pauses, drop stale cards, send at most one. Returns the pause, if one started. */
  tick(s: Signals): Moment | null {
    const m = this.observe(s);
    const { now } = s;
    const cfg = this.settings();
    if (this.open && now - this.open.at > OPEN_MS) this.resolve(this.open.key, 'ignored', now);
    // Stale cards that would rather be dropped than late.
    const stale = this.held.filter((h) => h.dropIfStale && now - h.at > h.holdMin * 60_000);
    if (stale.length) {
      this.held = this.held.filter((h) => !stale.includes(h));
      this.log(`[attention] dropped stale ${stale.map((h) => h.kind).join(', ')}`);
    }
    if (!this.held.length || !s.calm || s.idleSec >= 60) return m;
    if (now - this.state.lastCardAt < cfg.minGapMin * 60_000) return m;
    if (this.state.sentToday >= cfg.maxPerDay) return m;
    const pause = this.atPause(now, s.idleSec);
    const ready = (h: (typeof this.held)[number]) => h.when === 'soon' || !cfg.pauses || pause || now - h.at > h.holdMin * 60_000;
    const next = [...this.held].sort((a, b) => (a.when === b.when ? a.at - b.at : a.when === 'soon' ? -1 : 1)).find(ready);
    if (!next) return m;
    this.held = this.held.filter((h) => h !== next && !(next.family && h.family === next.family));
    this.state.sentToday++;
    this.state.lastCardAt = now;
    const st = (this.state.stats[next.kind] ??= emptyStats());
    st.shown++;
    st.skipped = 0;
    st.last = now;
    this.open = { key: next.key, kind: next.kind, at: now, shown: false };
    this.log(`[attention] sent ${next.kind}${pause ? ` at a pause (${this.moment?.kind})` : ''}`);
    const opened = this.open;
    void Promise.resolve(next.send())
      .then((tracked) => {
        // Only a corner card has buttons we can learn from.
        if (!tracked && this.open === opened && !opened.shown) this.open = null;
      })
      .catch(() => {
        if (this.open === opened) this.open = null;
      });
    return m;
  }

  /** Any corner card appeared (ours or not): it counts for the gap, and it covers ours. */
  cardShown(tag: string | undefined, counts: boolean, now: number): void {
    if (this.open && tag === this.open.key) {
      this.open.shown = true;
      return;
    }
    if (this.open) this.resolve(this.open.key, 'ignored', now);
    if (counts) this.state.lastCardAt = now;
  }

  /** A button, the close button, or the card timing out. */
  resolve(tag: string | undefined, outcome: Outcome, now: number): void {
    if (!this.open || tag !== this.open.key) return;
    const st = (this.state.stats[this.open.kind] ??= emptyStats());
    this.open = null;
    if (outcome === 'acted') {
      st.acted++;
      st.streak = 0;
      st.skipped = 0;
    } else if (outcome === 'dismissed' || outcome === 'ignored') {
      st[outcome]++;
      st.streak++;
    }
    st.last = now;
  }

  /** "Back to normal" for a kind. */
  reset(kind: string): void {
    const st = this.state.stats[kind];
    if (st) {
      st.streak = 0;
      st.skipped = 0;
    }
  }

  toJSON(): AttentionState {
    return this.state;
  }
}
