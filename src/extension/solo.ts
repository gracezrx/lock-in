// Lock In on its own, inside Chrome: the same classifier, drift ladder, coach lines and crew as
// the Mac app, driven by Chrome's tabs instead of the Mac's windows. It runs whenever the Mac
// app isn't linked; linked, it hands its session over and the Mac does the coaching.
//
// A service worker sleeps between events, so everything lives in chrome.storage and is read
// back on every wake. Time is measured from timestamps, not ticks: whatever was on screen since
// the last event counts for the time that passed.
import { Classifier, type LabelCache } from '../main/engine/classifier';
import { Session } from '../main/engine/session';
import type { DriftEngine, DriftEvent } from '../main/engine/drift';
import { levelLine, type LineCtx } from '../main/coach/lines';
import { Crew, type CrewData, type BombOutcome, type LocalStatus } from '../main/crew/crew';
import { domainOf, domainMatches } from '../main/engine/domain';
import { inMeeting, nextMeeting, fetchIcs } from '../main/calendar';
import { dayKey } from '../main/todos/day';
import { buildDefaultProfile, DEFAULT_CREW } from '../shared/templates';
import type { CalEvent, CrewSettings, CrewStats, LabeledSample, Level, Profile, Sample, SessionRecord } from '../shared/types';
import { PollRelay } from './lib/relay';
import { DEFAULT_SETTINGS, type ExtSettings, type PanelView, type PanelTodo, type PanelGoal, type SessionStatus } from './lib/types';
import type { PageOp } from './page';

export interface Tab {
  tabId?: number;
  url?: string;
  title?: string;
  /** Chrome is the app in front. */
  focused: boolean;
  audible: boolean;
  playing: boolean;
  incognito: boolean;
}

/** What the Mac app hands over when linked (ext:sync), kept for when it isn't. */
export interface MacSync {
  profile: Profile | null;
  labels: LabelCache;
  crew: (Pick<CrewSettings, 'code' | 'crewName' | 'name' | 'server' | 'shareGoal' | 'shareDistraction'> & { me: string }) | null;
  todos: { open: { id: string; title: string; due?: string }[]; canAdd: boolean; canComplete: boolean };
  goals: { id: string; name: string; progress?: string; pct?: number | null; daysLeft?: number }[];
  events: { title: string; start: number; end: number; allDay: boolean }[];
  calendarUrls: string[];
  quietInMeetings: boolean;
  lastGoal: string;
  syncedAt: number;
}

interface SavedSession {
  goal: string;
  plannedMin: number;
  record: SessionRecord;
  engine: Partial<DriftEngine>;
  lastWork: Session['lastWork'];
  onBreakUntil?: number;
}

interface Todo {
  id: string;
  title: string;
  done: boolean;
  doneAt?: number;
  /** It came from your list on the Mac. */
  mac?: boolean;
}
type TodoOp = { op: 'add'; title: string } | { op: 'done'; id: string };

interface Goal {
  id: string;
  name: string;
  due?: string;
}

interface Data {
  settings: ExtSettings;
  profile: Profile;
  labels: LabelCache;
  sess: SavedSession | null;
  history: SessionRecord[];
  pushed: string[];
  todos: Todo[];
  todoOps: TodoOp[];
  goals: Goal[];
  crewSettings: CrewSettings;
  crewData: CrewData | null;
  crewCursor: string;
  crewWire: { lastSig: string; lastPublish: number; connected: boolean };
  muteUntil: number;
  lockout: { until: number; from: string } | null;
  events: CalEvent[];
  calFetchedAt: number;
  mac: MacSync | null;
  cur: Tab | null;
  lastStepAt: number;
  idle: { state: chrome.idle.IdleState | 'active' | 'idle' | 'locked'; since: number };
  /** The coach's open card (so a choice can be matched to it). */
  shown: { id: string; level: Level; at: number } | null;
  lastGoal: string;
}

const KEYS: (keyof Data)[] = ['settings', 'profile', 'labels', 'sess', 'history', 'pushed', 'todos', 'todoOps', 'goals', 'crewSettings', 'crewData', 'crewCursor', 'crewWire', 'muteUntil', 'lockout', 'events', 'calFetchedAt', 'mac', 'cur', 'lastStepAt', 'idle', 'shown', 'lastGoal'];

export interface SoloDeps {
  log: (m: string) => void;
  /** Shows something in a page (the active tab when no tab is given); false when that page can't be drawn on. */
  page: (op: PageOp, tabId?: number) => Promise<boolean>;
  speak: (text: string) => void;
  notify: (title: string, text: string) => void;
  onChange: () => void;
}

const LOCKOUT_RULES = 1000;
const SESSION_RULES = 2000;
const STEP = 5;
const BOMB_MS = 5 * 60_000;
const uid = () => crypto.randomUUID();
const hostLabel = (d?: string) => d ?? 'that page';

export class Solo {
  d!: Data;
  private dirty = new Set<keyof Data>();
  classifier!: Classifier;
  session: Session | null = null;
  crew!: Crew;
  relay!: PollRelay;
  /** Linked to the Mac app: it does the coaching, this only keeps its copy up to date. */
  linked = false;

  constructor(private deps: SoloDeps) {}

  // ---- storage ----------------------------------------------------------------------

  async load(): Promise<void> {
    const got = (await chrome.storage.local.get(KEYS)) as Partial<Data>;
    const settings = { ...DEFAULT_SETTINGS, ...(got.settings ?? {}) };
    this.d = {
      settings,
      profile: got.profile ?? buildDefaultProfile(settings.role),
      labels: got.labels ?? {},
      sess: got.sess ?? null,
      history: got.history ?? [],
      pushed: got.pushed ?? [],
      todos: got.todos ?? [],
      todoOps: got.todoOps ?? [],
      goals: got.goals ?? [],
      crewSettings: { ...DEFAULT_CREW, ...(got.crewSettings ?? {}) },
      crewData: got.crewData ?? null,
      crewCursor: got.crewCursor ?? '',
      crewWire: got.crewWire ?? { lastSig: '', lastPublish: 0, connected: false },
      muteUntil: got.muteUntil ?? 0,
      lockout: got.lockout ?? null,
      events: got.events ?? [],
      calFetchedAt: got.calFetchedAt ?? 0,
      mac: got.mac ?? null,
      cur: got.cur ?? null,
      lastStepAt: got.lastStepAt ?? Date.now(),
      idle: got.idle ?? { state: 'active' as chrome.idle.IdleState, since: Date.now() },
      shown: got.shown ?? null,
      lastGoal: got.lastGoal ?? '',
    };
    this.classifier = new Classifier(() => this.d.profile, this.d.labels, () => this.mark('labels'), { titlesStayLocal: () => true });
    this.session = this.d.sess ? this.restore(this.d.sess) : null;
    if (this.session) this.classifier.goal = this.session.record.goal;
    this.relay = new PollRelay({
      server: () => this.d.crewSettings.server,
      onMessage: (m) => this.crew.receive(m),
      onState: (on, err) => {
        this.d.crewWire.connected = on;
        this.mark('crewWire');
        this.crew.setConnection(on, err);
      },
      log: this.deps.log,
      cursor: {
        get: () => this.d.crewCursor,
        set: (id) => {
          this.d.crewCursor = id;
          this.mark('crewCursor');
        },
      },
    });
    this.relay.connected = this.d.crewWire.connected;
    this.buildCrew();
  }

  /** The crew, from what's saved (again after linking: the Mac's crew, as the Mac's member). */
  private buildCrew(): void {
    this.crew = new Crew({
      settings: () => this.d.crewSettings,
      saveSettings: (p) => {
        this.d.crewSettings = { ...this.d.crewSettings, ...p };
        this.mark('crewSettings');
      },
      relay: this.relay,
      load: () => this.d.crewData,
      save: (data) => {
        this.d.crewData = data;
        this.mark('crewData');
        void this.save();
      },
      local: () => this.localStatus(),
      onBomb: (b) => this.bombed(b),
      onChange: () => this.deps.onChange(),
      log: this.deps.log,
    });
    // Keep the crew's "what did I last tell them" across wakes, so it doesn't say hello every time.
    const wire = this.crew as unknown as { lastSig: string; lastPublish: number; connected: boolean };
    if (this.crew.joined && !this.linked) {
      this.crew.start();
      wire.lastSig = this.d.crewWire.lastSig;
      wire.lastPublish = this.d.crewWire.lastPublish;
      wire.connected = this.d.crewWire.connected;
    }
  }

  private mark(k: keyof Data): void {
    this.dirty.add(k);
  }

  async save(): Promise<void> {
    if (this.session) {
      this.d.sess = {
        goal: this.session.record.goal,
        plannedMin: this.session.record.plannedMin,
        record: this.session.record,
        engine: JSON.parse(JSON.stringify(this.session.engine)),
        lastWork: this.session.lastWork,
        onBreakUntil: this.session.onBreakUntil,
      };
      this.mark('sess');
    }
    const wire = this.crew as unknown as { lastSig: string; lastPublish: number };
    if (wire && (wire.lastSig !== this.d.crewWire.lastSig || wire.lastPublish !== this.d.crewWire.lastPublish)) {
      this.d.crewWire = { ...this.d.crewWire, lastSig: wire.lastSig, lastPublish: wire.lastPublish };
      this.mark('crewWire');
    }
    if (!this.dirty.size) return;
    const patch: Record<string, unknown> = {};
    for (const k of this.dirty) patch[k] = this.d[k];
    this.dirty.clear();
    await chrome.storage.local.set(patch);
  }

  private restore(s: SavedSession): Session {
    const sess = new Session(s.goal, s.plannedMin, this.d.profile.toleranceMin, () => undefined, s.lastWork, s.record.startedAt);
    Object.assign(sess.record, s.record);
    Object.assign(sess.engine, s.engine, { cfg: { ...sess.engine.cfg, toleranceSec: this.d.settings.toleranceMin * 60 } });
    sess.onBreakUntil = s.onBreakUntil;
    return sess;
  }

  // ---- what's on screen ---------------------------------------------------------------

  private idleSec(now: number): number {
    const i = this.d.idle;
    if (i.state === 'locked') return 3600;
    if (i.state === 'idle') return 60 + (now - i.since) / 1000;
    return 0;
  }

  private meetingNow(now: number): CalEvent | undefined {
    return this.d.settings.quietInMeetings ? inMeeting(this.d.events, now) : undefined;
  }

  private sample(tab: Tab | null, t: number): LabeledSample {
    const s: Sample = tab?.focused
      ? { t, app: 'Chrome', title: tab.title, url: tab.url, domain: domainOf(tab.url), tabId: tab.tabId, browser: true, idleSec: this.idleSec(t), mediaPlaying: tab.playing || tab.audible, inCall: !!this.meetingNow(t), isPrivate: tab.incognito }
      : // Another app is in front: Chrome can't see it, so it neither builds drift nor counts as focus.
        { t, app: 'Another app', browser: false, idleSec: this.idleSec(t), mediaPlaying: false, inCall: !!this.meetingNow(t), isPrivate: true };
    return this.classifier.classify(s);
  }

  /** The tab in front changed (or the idle state, or a timer fired): count the time that passed. */
  async observe(next: Tab | null | undefined, now = Date.now()): Promise<void> {
    this.step(now);
    if (next !== undefined) {
      this.d.cur = next;
      this.mark('cur');
    }
    await this.save();
  }

  setIdle(state: chrome.idle.IdleState | 'active' | 'idle' | 'locked', now = Date.now()): void {
    this.step(now);
    this.d.idle = { state, since: now };
    this.mark('idle');
  }

  /** Counts the time since the last step against what was on screen, in 5-second slices. */
  step(now = Date.now()): void {
    const from = this.d.lastStepAt;
    this.d.lastStepAt = now;
    this.mark('lastStepAt');
    if (this.linked) return;
    this.housekeeping(now);
    const sess = this.session;
    if (!sess) return;
    let dt = Math.min(180, Math.max(0, (now - from) / 1000));
    let t = from;
    while (dt > 0.01) {
      const slice = Math.min(STEP, dt);
      t += slice * 1000;
      dt -= slice;
      if (sess.onBreakUntil && t >= sess.onBreakUntil) {
        sess.endBreak();
        this.toast('Break’s over', `Back to ${sess.record.goal}.`);
      }
      const s = this.sample(this.d.cur, t);
      const events = sess.tick(s, slice);
      for (const ev of events) this.onDrift(ev, s);
      if (sess.isOver(t)) {
        this.endSession('timer', t);
        break;
      }
    }
    if (this.crew.joined) this.crew.tick();
  }

  private housekeeping(now: number): void {
    if (this.d.lockout && now >= this.d.lockout.until) {
      this.d.lockout = null;
      this.mark('lockout');
      void this.unblock(LOCKOUT_RULES);
      this.toast('Unlocked', 'The bomb wore off.');
    }
  }

  // ---- sessions -----------------------------------------------------------------------

  startSession(goal: string, minutes: number, startedAt = Date.now()): void {
    if (this.session) this.endSession('user');
    const g = goal.trim().slice(0, 120) || 'Deep work';
    const s = new Session(g, Math.max(5, Math.min(240, Math.round(minutes))), this.d.settings.toleranceMin, () => undefined, null, startedAt);
    s.engine.setTolerance(this.d.settings.toleranceMin);
    this.session = s;
    this.classifier.goal = g;
    this.d.lastGoal = g;
    this.mark('lastGoal');
    this.d.lastStepAt = Date.now();
    this.mark('lastStepAt');
    if (this.crew.joined) this.crew.tick();
    this.toast('Locked in', `${g} · ${s.record.plannedMin} min. I'm watching.`);
    this.deps.onChange();
  }

  endSession(by: 'user' | 'timer', now = Date.now()): SessionRecord | null {
    const s = this.session;
    if (!s) return null;
    const rec = s.end(by, now);
    this.session = null;
    this.d.sess = null;
    this.mark('sess');
    this.d.history = [...this.d.history, rec].slice(-300);
    this.mark('history');
    void this.unblock(SESSION_RULES);
    void this.deps.page({ kind: 'clear' });
    if (by === 'timer') {
      const min = Math.round(rec.focusSec / 60);
      this.toast('Session done', `${min} min focused on ${rec.goal}.`);
      if (this.d.settings.voice) this.deps.speak(`Done. ${min} minutes on ${rec.goal}.`);
    }
    if (this.crew.joined) this.crew.tick();
    this.deps.onChange();
    return rec;
  }

  startBreak(minutes: number): void {
    if (!this.session) return;
    this.session.startBreak(Math.max(1, Math.min(30, minutes)));
    void this.deps.page({ kind: 'clear' });
    this.toast('Break', `${minutes} minutes. I'll tell you when it's over.`);
  }

  // ---- the coach ------------------------------------------------------------------------

  private muted(now = Date.now()): boolean {
    return now < this.d.muteUntil || !!this.meetingNow(now) || !!this.session?.onBreakUntil;
  }

  private onDrift(ev: DriftEvent, s: LabeledSample): void {
    if (ev.type === 'recovered') {
      if (this.d.shown) {
        void this.deps.page({ kind: 'clear' });
        this.d.shown = null;
        this.mark('shown');
      }
      return;
    }
    if (ev.type !== 'level' || !this.session) return;
    const level = ev.level as 1 | 2 | 3 | 4;
    this.session.record.interventions += 1;
    if (this.muted(s.t)) return;
    void this.intervene(level, s);
  }

  private ctx(s: LabeledSample): LineCtx {
    const sess = this.session!;
    const site = hostLabel(s.domain);
    const onSite = sess.record.topDistractions[s.domain ?? s.app] ?? sess.record.driftSec;
    const open = this.d.todos.filter((t) => !t.done);
    return {
      site,
      goal: sess.record.goal,
      min: Math.max(1, Math.round(onSite / 60)),
      work: sess.lastWork?.title?.slice(0, 40) || domainOf(sess.lastWork?.url) || sess.record.goal,
      tasks: open.length,
      top: open[0]?.title,
    };
  }

  private async intervene(level: 1 | 2 | 3 | 4, s: LabeledSample): Promise<void> {
    const sess = this.session!;
    const line = levelLine(level, this.d.profile.persona ?? this.d.settings.persona, this.ctx(s));
    const id = uid();
    this.d.shown = { id, level, at: s.t };
    this.mark('shown');
    const goal = sess.record.goal;
    let shown = false;
    if (level === 1) {
      shown = await this.deps.page({ kind: 'nudge', id, title: 'Drifting', text: line, buttons: [{ id: 'back', label: 'Back to it', primary: true }, { id: 'snooze', label: '5 more minutes' }] });
    } else if (level === 2) {
      if (this.d.settings.voice) this.deps.speak(line);
      shown = await this.deps.page({ kind: 'talk', id, text: line, seconds: 9 });
    } else {
      if (this.d.settings.voice) this.deps.speak(line);
      if (level === 4 && s.domain) await this.block([s.domain], SESSION_RULES, {});
      const min = Math.round(sess.record.driftSec / 60);
      shown = await this.deps.page({
        kind: 'yell',
        id,
        name: level === 4 ? 'Not now' : 'Intervention',
        meta: `${min} min drifting · ${goal}`,
        line,
        tone: level === 4 ? 'red' : 'yellow',
        options: [{ id: 'back', label: `Lock in on “${goal.slice(0, 40)}”`, primary: true }, ...(level === 3 ? [{ id: 'work', label: 'This is work' }, { id: 'snooze', label: 'Leave me alone for 10' }] : [])],
      });
    }
    if (!shown) this.deps.notify(level >= 3 ? 'Lock In' : 'Drifting', line);
  }

  /** A button on one of the coach's cards. */
  async choose(id: string, choice: string): Promise<void> {
    const sess = this.session;
    if (!sess || (this.d.shown && this.d.shown.id !== id)) return;
    const level = this.d.shown?.level ?? 1;
    this.d.shown = null;
    this.mark('shown');
    if (choice === 'close') return;
    sess.engine.acknowledge();
    if (choice === 'back') await this.backToWork();
    if (choice === 'snooze') this.mute(level >= 3 ? 10 : 5);
    if (choice === 'work') {
      const dom = domainOf(this.d.cur?.url);
      if (dom) this.label(dom, 'work');
    }
  }

  async backToWork(): Promise<void> {
    const w = this.session?.lastWork;
    try {
      if (w?.tabId !== undefined) {
        const t = await chrome.tabs.get(w.tabId).catch(() => null);
        if (t?.id !== undefined) {
          await chrome.tabs.update(t.id, { active: true });
          await chrome.windows.update(t.windowId, { focused: true });
          return;
        }
      }
      if (w?.url) await chrome.tabs.create({ url: w.url, active: true });
    } catch {
      /* the tab is gone */
    }
  }

  mute(minutes: number): void {
    this.d.muteUntil = minutes > 0 ? Date.now() + minutes * 60_000 : 0;
    this.mark('muteUntil');
  }

  label(domain: string, label: 'work' | 'neutral' | 'distraction'): void {
    this.classifier.setKey(`site:${domain.replace(/^www\./, '')}`, label);
    if (label === 'distraction' && !this.d.profile.distractionDomains[domain]) {
      this.d.profile.distractionDomains[domain] = 1;
      this.mark('profile');
    }
  }

  addDistraction(domain: string): void {
    const d = (domainOf(domain.includes('://') ? domain : `https://${domain}`) ?? '').trim();
    if (!d) return;
    this.d.profile.distractionDomains[d] = 1;
    this.d.profile.workDomains = this.d.profile.workDomains.filter((w) => w !== d);
    this.mark('profile');
  }

  removeDistraction(domain: string): void {
    delete this.d.profile.distractionDomains[domain];
    this.mark('profile');
  }

  private toast(title: string, text: string): void {
    void this.deps.page({ kind: 'toast', id: uid(), title, text, seconds: 4 });
  }

  // ---- blocking (a friend's bomb, or the coach's last resort) ----------------------------

  distractionList(): string[] {
    const fromLabels = Object.entries(this.d.labels)
      .filter(([k, v]) => k.startsWith('site:') && v.label === 'distraction')
      .map(([k]) => k.slice(5));
    const work = new Set(this.d.profile.workDomains);
    return [...new Set([...Object.keys(this.d.profile.distractionDomains), ...fromLabels])].filter((d) => !work.has(d)).sort();
  }

  private async block(domains: string[], base: number, q: { from?: string; until?: number }): Promise<void> {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const mine = existing.filter((r) => r.id >= base && r.id < base + 1000);
    const query = (d: string) => `d=${encodeURIComponent(d)}${q.from ? `&from=${encodeURIComponent(q.from)}` : ''}${q.until ? `&until=${q.until}` : ''}`;
    const start = base === SESSION_RULES ? mine.reduce((m, r) => Math.max(m, r.id), base) + 1 : base;
    const rules = domains.slice(0, 900).map((d, i) => ({
      id: start + i,
      priority: 2,
      action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: `/blocked.html?${query(d)}` } },
      condition: { requestDomains: [d], resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: base === LOCKOUT_RULES ? mine.map((r) => r.id) : [], addRules: rules });
    // Tabs already open on them go too.
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      const host = domainOf(t.url);
      const hit = host && domains.find((d) => domainMatches(host, d));
      if (hit && t.id !== undefined) await chrome.tabs.update(t.id, { url: chrome.runtime.getURL(`blocked.html?${query(hit)}`) }).catch(() => undefined);
    }
  }

  private async unblock(base: number): Promise<void> {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const ids = existing.filter((r) => r.id >= base && r.id < base + 1000).map((r) => r.id);
    if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  }

  // ---- friends --------------------------------------------------------------------------

  private stats(now = Date.now()): CrewStats {
    const today = dayKey(now);
    const weekAgo = now - 7 * 86_400_000;
    const recs = [...this.d.history, ...(this.session ? [this.session.record] : [])];
    const min = (f: (r: SessionRecord) => boolean) => Math.round(recs.filter(f).reduce((a, r) => a + r.focusSec, 0) / 60);
    return { todayMin: min((r) => dayKey(r.startedAt) === today), weekMin: min((r) => r.startedAt >= weekAgo), streak: this.streak(now), roastedWeek: 0, bombsThrownWeek: 0, achievements: 0 };
  }

  private streak(now: number): number {
    const days = new Set(this.d.history.filter((r) => r.focusSec >= 600).map((r) => dayKey(r.startedAt)));
    if (this.session && this.session.record.focusSec >= 600) days.add(dayKey(now));
    let n = 0;
    for (let t = now; days.has(dayKey(t)); t -= 86_400_000) n += 1;
    return n;
  }

  private localStatus(): LocalStatus {
    const now = Date.now();
    const s = this.session;
    const shareGoal = this.d.crewSettings.shareGoal;
    const cur = this.d.cur;
    const label = cur ? this.sample(cur, now).label : 'neutral';
    let state: LocalStatus['state'] = 'free';
    if (this.d.idle.state === 'locked' || this.idleSec(now) > 600) state = 'away';
    else if (this.meetingNow(now)) state = 'meeting';
    else if (s?.onBreakUntil) state = 'break';
    else if (s && s.engine.level === 0) state = 'locked';
    else if (label === 'distraction' || (s && s.engine.level > 0)) state = 'drifting';
    return {
      state,
      since: s?.record.startedAt ?? now,
      goal: s && shareGoal ? s.record.goal : undefined,
      distraction: state === 'drifting' && this.d.crewSettings.shareDistraction ? domainOf(cur?.url) : undefined,
      sessionMin: s?.record.plannedMin,
      stats: this.stats(now),
    };
  }

  private bombed(b: { id: string; from: string; name: string; insult: string }): BombOutcome {
    const now = Date.now();
    const s = this.session;
    if (s && !s.onBreakUntil && s.engine.level === 0) {
      this.toast('Bounced', `${b.name}'s bomb bounced off you. You're locked in.`);
      return 'bounced';
    }
    if (this.muted(now)) {
      this.toast(`Bomb from ${b.name}`, `“${b.insult}” (soft landing: you're muted or in a meeting)`);
      return 'soft';
    }
    const until = now + BOMB_MS;
    this.d.lockout = { until, from: b.name };
    this.mark('lockout');
    void this.block(this.distractionList(), LOCKOUT_RULES, { from: b.name, until });
    void this.deps.page({ kind: 'bomb', id: b.id, from: b.name, insult: b.insult, until });
    if (this.d.settings.voice) this.deps.speak(`${b.name} says: ${b.insult}`);
    void this.save();
    return 'hit';
  }

  /** Polls the crew's relay (an alarm calls this every 30 seconds; the open panel, more often). */
  async pollCrew(): Promise<void> {
    if (this.linked || !this.crew.joined) return;
    await this.relay.poll();
    this.crew.tick();
    await this.save();
  }

  // ---- calendar -------------------------------------------------------------------------

  async refreshCalendar(force = false): Promise<void> {
    const url = this.d.settings.calendarUrl.trim();
    if (!url || this.linked) return;
    if (!force && Date.now() - this.d.calFetchedAt < 15 * 60_000) return;
    const now = Date.now();
    try {
      const events = await fetchIcs(url, now - 86_400_000, now + 2 * 86_400_000, fetch);
      this.d.events = events.slice(0, 200);
      this.d.calFetchedAt = now;
      this.mark('events');
      this.mark('calFetchedAt');
    } catch (e) {
      this.deps.log(`[calendar] ${(e as Error).message}`);
    }
  }

  // ---- linking with Lock In for Mac --------------------------------------------------------

  /** Linked: take the Mac's copy of you (profile, labels, crew, to-dos, goals, meetings). */
  absorb(sync: MacSync): void {
    this.d.mac = sync;
    this.mark('mac');
    if (sync.profile) {
      this.d.profile = sync.profile;
      this.mark('profile');
      // The panel shows the Mac's coach, role and patience: the same you in both places.
      const st = this.d.settings;
      st.persona = sync.profile.persona;
      st.role = sync.profile.role;
      st.toleranceMin = sync.profile.toleranceMin;
      st.onboarded = true;
      this.mark('settings');
    }
    for (const [k, v] of Object.entries(sync.labels ?? {})) this.d.labels[k] = v;
    this.mark('labels');
    if (sync.crew) {
      const same = sync.crew.code === this.d.crewSettings.code;
      this.d.crewSettings = { ...this.d.crewSettings, code: sync.crew.code, crewName: sync.crew.crewName, name: sync.crew.name, server: sync.crew.server || this.d.crewSettings.server, shareGoal: sync.crew.shareGoal, shareDistraction: sync.crew.shareDistraction };
      // The same member as on the Mac, so friends see one of you.
      this.d.crewData = same && this.d.crewData ? { ...this.d.crewData, me: sync.crew.me } : ({ me: sync.crew.me } as CrewData);
      if (!same) this.d.crewCursor = '';
      this.mark('crewSettings');
      this.mark('crewData');
      this.mark('crewCursor');
      if (!same || this.crew.me !== sync.crew.me) {
        this.crew.stop();
        this.buildCrew();
      }
      if (!this.d.settings.name && sync.crew.name) {
        this.d.settings.name = sync.crew.name;
        this.mark('settings');
      }
    }
    // Your Mac's list, plus anything made here that's still on its way there (or can't go: then it stays here).
    if (!sync.todos.canAdd) this.d.todoOps = this.d.todoOps.filter((o) => o.op !== 'add');
    const macTodos: Todo[] = sync.todos.open.map((t) => ({ id: t.id, title: t.title, done: this.d.todoOps.some((o) => o.op === 'done' && o.id === t.id), mac: true }));
    const macTitles = new Set(macTodos.map((t) => t.title));
    this.d.todos = [...macTodos, ...this.d.todos.filter((t) => !t.mac && !(macTitles.has(t.title) && !this.d.todoOps.some((o) => o.op === 'add' && o.title === t.title)))];
    this.mark('todos');
    this.mark('todoOps');
    this.d.events = sync.events.map((e, i) => ({ id: `mac-${i}`, title: e.title, start: e.start, end: e.end, allDay: e.allDay, busy: true, calendar: 'Mac' }));
    this.mark('events');
    if (sync.calendarUrls?.[0] && !this.d.settings.calendarUrl) this.d.settings.calendarUrl = sync.calendarUrls[0];
    this.d.settings.quietInMeetings = sync.quietInMeetings;
    this.mark('settings');
    if (sync.lastGoal) {
      this.d.lastGoal = sync.lastGoal;
      this.mark('lastGoal');
    }
  }

  /** What's waiting to go over to the Mac: sessions run here, to-dos added or ticked here. */
  outbox(): { sessions: SessionRecord[]; todoOps: TodoOp[] } {
    const pushed = new Set(this.d.pushed);
    return { sessions: this.d.history.filter((r) => !pushed.has(r.id)), todoOps: [...this.d.todoOps] };
  }

  delivered(sessions: string[], ops: number): void {
    this.d.pushed = [...this.d.pushed, ...sessions].slice(-500);
    this.d.todoOps = this.d.todoOps.slice(ops);
    this.mark('pushed');
    this.mark('todoOps');
  }

  /** Linking up: a session running here moves to the Mac (returns it, so the Mac can start it). */
  handOver(): { goal: string; minutes: number } | null {
    this.linked = true;
    this.crew.stop();
    const s = this.session;
    if (!s) return null;
    const left = Math.max(5, Math.round(s.record.plannedMin - s.elapsedSec() / 60));
    this.endSession('user');
    void this.deps.page({ kind: 'clear' });
    return { goal: s.record.goal, minutes: left };
  }

  /** The Mac app went away: carry on alone, picking up its session where it was. */
  takeOver(mac: { goal: string; plannedMin: number; startedAt: number } | null): void {
    this.linked = false;
    this.d.lastStepAt = Date.now();
    this.mark('lastStepAt');
    if (this.crew.joined) this.crew.start();
    if (mac && !this.session && Date.now() < mac.startedAt + mac.plannedMin * 60_000) {
      this.startSession(mac.goal, mac.plannedMin, mac.startedAt);
    }
  }

  // ---- to-dos and goals (here when on its own; the Mac's list otherwise) ------------------

  addTodo(title: string): void {
    const t = title.trim().slice(0, 200);
    if (!t) return;
    this.d.todos = [...this.d.todos, { id: uid(), title: t, done: false }];
    // Goes onto your Mac's list next time they link (unless that list can't take new ones).
    if (this.d.mac?.todos.canAdd !== false) this.d.todoOps = [...this.d.todoOps, { op: 'add', title: t }];
    this.mark('todos');
    this.mark('todoOps');
  }

  doneTodo(id: string, done = true): void {
    const t = this.d.todos.find((x) => x.id === id);
    if (!t) return;
    t.done = done;
    t.doneAt = done ? Date.now() : undefined;
    if (t.mac) {
      this.d.todoOps = done ? [...this.d.todoOps, { op: 'done', id }] : this.d.todoOps.filter((o) => !(o.op === 'done' && o.id === id));
    } else if (done) {
      // Made and finished here before the Mac ever saw it: nothing to send.
      this.d.todoOps = this.d.todoOps.filter((o) => !(o.op === 'add' && o.title === t.title));
    }
    this.mark('todos');
    this.mark('todoOps');
  }

  removeTodo(id: string): void {
    const t = this.d.todos.find((x) => x.id === id);
    this.d.todos = this.d.todos.filter((x) => x.id !== id);
    if (t && !t.mac) this.d.todoOps = this.d.todoOps.filter((o) => !(o.op === 'add' && o.title === t.title));
    this.mark('todos');
    this.mark('todoOps');
  }

  addGoal(name: string, due?: string): void {
    const n = name.trim().slice(0, 80);
    if (!n) return;
    this.d.goals = [...this.d.goals, { id: uid(), name: n, due: due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined }];
    this.mark('goals');
  }

  removeGoal(id: string): void {
    this.d.goals = this.d.goals.filter((g) => g.id !== id);
    this.mark('goals');
  }

  setSettings(patch: Partial<ExtSettings>): void {
    const roleChanged = patch.role && patch.role !== this.d.settings.role;
    this.d.settings = { ...this.d.settings, ...patch };
    this.mark('settings');
    if (patch.persona) {
      this.d.profile.persona = patch.persona;
      this.mark('profile');
    }
    if (patch.toleranceMin) {
      this.d.profile.toleranceMin = patch.toleranceMin;
      this.session?.engine.setTolerance(patch.toleranceMin);
      this.mark('profile');
    }
    if (roleChanged && !this.d.mac?.profile) {
      this.d.profile = { ...buildDefaultProfile(patch.role!), persona: this.d.settings.persona, toleranceMin: this.d.settings.toleranceMin };
      this.mark('profile');
    }
    if (patch.name !== undefined && this.crew.joined) this.d.crewSettings = { ...this.d.crewSettings, name: patch.name.slice(0, 32) };
    if (patch.calendarUrl !== undefined) {
      this.d.calFetchedAt = 0;
      void this.refreshCalendar(true);
    }
  }

  // ---- the panel ------------------------------------------------------------------------

  view(): Omit<PanelView, 'mode' | 'desktop' | 'voices'> {
    const now = Date.now();
    const s = this.session;
    const cur = this.d.cur;
    const dom = cur?.focused ? domainOf(cur.url) : undefined;
    const lab = cur && dom ? this.sample(cur, now) : null;
    let status: SessionStatus = 'neutral';
    if (s) {
      if (s.onBreakUntil) status = 'break';
      else if (this.idleSec(now) >= 300) status = 'away';
      else if (lab?.label === 'distraction' || s.engine.level > 0) status = 'drifting';
      else if (lab?.label === 'work') status = 'focused';
    }
    const thr = s ? s.engine.thresholdSec(1) : 1;
    const today = dayKey(now);
    const recs = [...this.d.history, ...(s ? [s.record] : [])].filter((r) => dayKey(r.startedAt) === today);
    const ev = this.d.events;
    const cal = this.meetingNow(now);
    const nx = nextMeeting(ev, now);
    const goalsFromMac: PanelGoal[] = (this.d.mac?.goals ?? []).map((g) => ({ id: `mac:${g.id}`, name: g.name, daysLeft: g.daysLeft, progress: g.progress, pct: g.pct }));
    // Calendar days from today to the due date (due today is 0).
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const days = (due?: string) => (due ? Math.round((new Date(`${due}T00:00:00`).getTime() - midnight) / 86_400_000) : undefined);
    const todos: PanelTodo[] = this.d.todos.map((t) => ({ id: t.id, title: t.title, done: t.done, mac: t.mac }));
    return {
      session: s
        ? {
            goal: s.record.goal,
            plannedMin: s.record.plannedMin,
            startedAt: s.record.startedAt,
            elapsedSec: s.elapsedSec(now),
            focusSec: Math.round(s.record.focusSec),
            driftSec: Math.round(s.record.driftSec),
            level: s.engine.level,
            status,
            where: status === 'drifting' ? dom : undefined,
            onBreakUntil: s.onBreakUntil,
            drift: Math.min(1, s.engine.drift / thr),
          }
        : null,
      current: dom && lab ? { domain: dom, label: lab.label } : null,
      today: { focusMin: Math.round(recs.reduce((a, r) => a + r.focusSec, 0) / 60), sessions: recs.length, streak: this.streak(now) },
      todos: { open: todos.filter((t) => !t.done).slice(0, 30), done: todos.filter((t) => t.done && (this.d.todos.find((x) => x.id === t.id)?.doneAt ?? 0) > now - 86_400_000).slice(0, 10), canAdd: true, canComplete: true, from: this.d.mac?.todos.open.length ? 'your list on the Mac' : 'here' },
      goals: [...goalsFromMac, ...this.d.goals.map((g) => ({ id: g.id, name: g.name, daysLeft: days(g.due), own: true }))],
      crew: this.crew.joined ? this.crew.view() : null,
      muteUntil: this.d.muteUntil > now ? this.d.muteUntil : undefined,
      lockout: this.d.lockout ?? undefined,
      lastGoal: this.d.lastGoal,
      meeting: cal || nx ? { now: cal?.title, next: nx?.title, nextAt: nx?.start } : undefined,
      settings: this.d.settings,
      distractions: this.distractionList(),
    };
  }
}
