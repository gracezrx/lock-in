// Lock In main process: wires sensors → classifier → session/drift → coach → UI.
import { app, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, safeStorage, session as electronSession, shell, systemPreferences, Tray, type Rectangle } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AttentionView, Goal, GoalQuestion, GoalSuggestion, GoalsView, PanelData, SessionRecord, CoachLineKind, CustomCoach, CustomCoachView, Channel, DashboardData, Deadline, LabeledSample, LiveState, MacCalendarInfo, Profile, RouteOption, Routine, SetupStatus, Settings, SheetSettings, SoundId, WeekDay } from '../shared/types';
import { appUsage } from './apps';
import { CalendarManager, fetchIcs } from './calendar';
import { MacCalendar, defaultExcluded, macStatusMessage } from './maccal';
import { Crew, type BombOutcome, type CrewData, type LocalStatus } from './crew/crew';
import { NtfyRelay, type Relay } from './crew/relay';
import { TodoHistory } from './todos/history';
import { makeBackup, prune as pruneBackups, readBackup, restore as restoreBackup } from './backup';
import { crewKeys, open as openSealed, seal } from './crew/code';
import { BOMB_LOCKOUT_MIN, Lockout, distractionDomains, mmss as lockClock } from './lockout';
import { achievementViews, crewStats, evaluate, streak as streakOf, type AchievementCtx } from './achievements';
import { inQuietHours } from './guardrails';
import { Deadlines, isOverdue, reminderLine, ymd, type ReminderState } from './deadlines';
import { buildExport, writeExport, type MeetingRow } from './export';
import { ElevenAgent, type AgentRecord } from './talk/agent';
import type { Situation, TalkContext } from './talk/prompt';
import { Talk, type TalkActions } from './talk/talk';
import { PhoneServer, bonjourName, lanAddresses, type PhoneDevice } from './phone/server';
import { PhoneChat } from './phone/chat';
import QRCode from 'qrcode';
import { dayKey } from './todos/day';
import { buildDefaultProfile, roleText } from '../shared/templates';
import { Announcer } from './coach/announcer';
import { Notifier, type NotifyPayload } from './notify';
import { RoutineScheduler, type RoutineState } from './routines';
import { TodoManager } from './todos/manager';
import { Coach } from './coach/coach';
import { Claude, coachSystem, makeLabeler } from './coach/llm';
import { Voice } from './coach/voice';
import { AUDIO_EXT, Coaches, TEXT_EXT, cleanLine, type ClipFile } from './coach/custom';
import { activeStyle, setActiveStyle, toActiveStyle } from './coach/style';
import { opener, personaVoice } from './talk/prompt';
import { exampleLine, levelLine } from './coach/lines';
import { LINE_SPECS } from '../shared/coachlines';
import { buildDashboard } from './dashboard';
import { Rhythm, clock as goalClock, focusPace, goalDay, goalName, goalsForCoach, hrs, ideasPrompt, IDEAS_SYSTEM, lastMinOf, minutesOfDay, notice, parseIdeas, tune, viewGoal, type DayFacts } from './goals';
import { Attention, DEFAULT_ATTENTION, outcomeOf, thinning, type Card, type Moment } from './attention';
import { LINK_SYSTEM, TERMS_SYSTEM, daysLeft, daysLeftText, guessGoal, linkPrompt, themeTerms, matches, movedItems, parseLinks, parseTerms, questionFor, recurringThings, seedTerms, termKey, termsOf, termsPrompt, type DayItem } from './biggoals';
import { Classifier } from './engine/classifier';
import type { DriftEvent } from './engine/drift';
import { Session } from './engine/session';
import { Guardrails } from './guardrails';
import { assetPath, calendarReaderPath, distDir, extensionPath, helperPath, isInstalledApp, keyWatcherPath, userDir } from './paths';
import { Router } from './router';
import { Bridge } from './sensors/bridge';
import { FallbackSensor } from './sensors/fallback';
import { HelperSensor } from './sensors/helper';
import { Sampler } from './sensors/sampler';
import { HoldSpace, holdSpaceAllowed } from './sensors/holdspace';
import { Store } from './store';
import { SUGGESTED, VoiceCatalog, previewLine } from './voices';
import { Windows } from './windows';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('Lock In');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const SMOKE = process.env.LOCKIN_SMOKE === '1';
if (SMOKE) {
  // The smoke test talks to a stand-in voice server with a fake microphone.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
const logLines: string[] = [];
function log(m: string): void {
  const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
  console.log(line);
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
}

let store: Store;
let profile: Profile | null;
let settings: Settings;
let classifier: Classifier;
let claude: Claude;
let voice: Voice;
let router: Router;
let guard: Guardrails;
let coach: Coach;
let bridge: Bridge;
let helper: HelperSensor;
let fallback: FallbackSensor;
let sampler: Sampler;
let windows: Windows;
let tray: Tray | null = null;
let notifier: Notifier;
let announcer: Announcer;
let todos: TodoManager;
let scheduler: RoutineScheduler;
let routines: Routine[] = [];
let talk: Talk;
let deadlines: Deadlines;
let voices: VoiceCatalog;
let coaches: Coaches;
let phone: PhoneServer | null = null;
let rhythm: Rhythm;
let lastGoalTick = 0;
/** The gate in front of every card that can wait (attention.ts). */
let attention: Attention;
/** The smoke test drives the gate's clock itself for a moment. */
let attentionFrozen = false;
let phoneChat: PhoneChat;
let agentKey = '';
let lastDeadlineCheck = 0;
let agent: ElevenAgent;
let talkError = '';
let calendar: CalendarManager;
let macCal: MacCalendar;
let holdSpace: HoldSpace;
let crew: Crew;
let todoHistory: TodoHistory;
let crewRelay: NtfyRelay;
let macCalendars: MacCalendarInfo[] = [];
let lastExportAt = 0;
let exportError = '';
let lastStatsAt = 0;
let statsDay = '';
let lastRoutineSave = 0;
let flashUntil = 0;
let flashText = '';
const systemNotes: Notification[] = [];

let sess: Session | null = null;
let current: LabeledSample | null = null;
/** The most recent sample from an app other than Lock In itself (clicking our UI shouldn't relabel us). */
let lastExternal: LabeledSample | null = null;

const SELF_NAMES = ['lock in', 'electron'];
function isSelf(s: LabeledSample | null): boolean {
  if (!s) return false;
  const b = s.bundleId?.toLowerCase() ?? '';
  return SELF_NAMES.includes(s.app.toLowerCase()) || b === 'app.lockin.desktop' || b === 'com.github.electron';
}
let appState = { lastGoal: '', lastWork: null as Session['lastWork'] };
let lastTick = Date.now();
let labelsDirty = false;
let trayMenuSig = '';

const getProfile = (): Profile => profile ?? buildDefaultProfile('other');
const clockTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// -----------------------------------------------------------------------------
// Session control

function startSession(goal: string, minutes: number, opts: { pomodoro?: boolean } = {}): void {
  if (sess) endSession('user');
  const p = getProfile();
  const pomo = opts.pomodoro ? { focusMin: 25, breakMin: 5, cycles: 4, breaksTaken: 0 } : undefined;
  if (pomo) minutes = pomo.cycles * pomo.focusMin + (pomo.cycles - 1) * pomo.breakMin;
  // End before the next meeting instead of running into it.
  let capNote = '';
  const nextUp = calendar?.next();
  if (!pomo && settings.calendar.capSessions && nextUp) {
    const until = Math.floor((nextUp.start - Date.now()) / 60_000) - 2;
    if (until >= 10 && until < minutes) {
      minutes = until;
      capNote = ` Ends at ${clockTime(nextUp.start - 120_000)}, before "${nextUp.title}".`;
    }
  }
  sess = new Session(goal.trim(), minutes, p.toleranceMin, (span) => store.logSpan(span), appState.lastWork);
  sess.pomodoro = pomo;
  appState.lastGoal = goal.trim();
  store.saveState(appState);
  store.logSession(sess.record);
  classifier.goal = goal.trim();
  classifier.modelEnabled = true;
  guard.unmute();
  windows.hideToast();
  void notifier.notify({ kind: 'session', title: 'Locked in', body: `${goal.trim() || 'Deep work'}, ${pomo ? '4 rounds of 25 minutes' : `${minutes} minutes`}.${capNote}${settings.goals.enabled && goalsData ? countsToward(goal) : ''} Go.`, speak: getProfile().persona === 'sassy' ? `Okay. ${goal.trim() || 'Deep work'}. Let's see how long this lasts.` : `Locked in. ${goal.trim() || 'Deep work'}. Go.`, autoHideMs: 4000 });
  log(`[session] start "${goal}" ${minutes} min`);
  pushState();
}

function endSession(by: 'user' | 'timer' | 'quit'): void {
  if (!sess) return;
  const ended = sess;
  sess = null;
  const rec = ended.end(by);
  store.logSession(rec);
  appState.lastWork = ended.lastWork;
  store.saveState(appState);
  classifier.goal = '';
  classifier.modelEnabled = false;
  todos.snooze(10); // no to-do roast right on top of the recap
  log(`[session] end (${by}) focus ${Math.round(rec.focusSec / 60)} min, drift ${Math.round(rec.driftSec / 60)} min`);
  if (by !== 'quit') void coach.onSessionEnd(rec);
  pushState();
}

function handleEvents(events: DriftEvent[], s: LabeledSample): void {
  for (const ev of events) {
    if (ev.type === 'level') {
      log(`[engine] level ${ev.level} (${ev.reason}) on ${s.domain ?? s.app}`);
      void coach.onLevel(ev.level, ev.reason, s);
    } else if (ev.type === 'recovered') {
      log('[engine] recovered');
      coach.onRecovered();
    } else if (ev.type === 'away_checkin') {
      void coach.onAwayCheckin();
    }
  }
}

// -----------------------------------------------------------------------------
// Main loop (1 Hz)

let looping = false;

/** Reminders that can wait for a natural pause, and how long (see attention.ts). */
const SOFT_ROUTINES: Partial<Record<Routine['kind'], Omit<Card, 'key' | 'kind' | 'send'>>> = {
  hydrate: { when: 'pause', holdMin: 30 },
  stretch: { when: 'pause', holdMin: 20, dropIfStale: true, mootOn: ['back', 'arrive'], family: 'move' },
  eyes: { when: 'pause', holdMin: 10, dropIfStale: true, mootOn: ['back', 'arrive'], family: 'move' },
  lunch: { when: 'pause', holdMin: 30 },
  kickoff: { when: 'pause', holdMin: 20 },
  midday: { when: 'pause', holdMin: 45 },
  weekly: { when: 'pause', holdMin: 120 },
};

async function loop(): Promise<void> {
  if (looping) return;
  looping = true;
  try {
    await loopOnce();
  } finally {
    looping = false;
  }
}

async function loopOnce(): Promise<void> {
  const now = Date.now();
  let dt = (now - lastTick) / 1000;
  lastTick = now;
  if (dt <= 0 || dt > 10) dt = 1; // machine slept or the clock jumped
  dt = Math.min(dt, 3);

  if (sess || windows.main?.isVisible()) sampler.pollFallbacks();
  const s = sampler.sample(now);
  current = s ? classifier.classify(s) : null;
  if (current && !isSelf(current)) lastExternal = current;
  holdSpace.setIntercept(holdSpaceAllowed(current, { on: settings.talk.holdSpace !== false, self: isSelf(current) }));
  lockoutTick(now);

  if (sess) {
    if (sess.elapsedSec(now) % 60 === 0) store.logSession(sess.record);
    if (current) handleEvents(sess.tick(current, dt), current);
    await coach.onTick(current, sess, now);
    if (sess?.pomodoroBreakDue(now) && !coach.active) {
      const pomo = sess.pomodoro!;
      pomo.breaksTaken += 1;
      sess.startBreak(pomo.breakMin, now);
      void announcer.sessionNote(`Round ${pomo.breaksTaken} of ${pomo.cycles} done`, announcer.pomodoroLine({ site: '', goal: sess.record.goal, min: 0, work: '' }));
    }
    if (sess && sess.isOver(now)) endSession('timer');
  }

  // All-day: to-do watchdog and routines (they only count time you are actually at the computer).
  const idle = powerMonitor.getSystemIdleTime();
  rhythm?.tick(now, idle, dt);
  const inCall = !!current?.inCall;
  const meeting = settings.calendar.quietInMeetings ? calendar.now(now) : undefined;
  todos.tick(idle, dt, !sess && !inCall && !meeting && !guard.muted() && !coach.active && !windows.overlayVisible && !talk.isOpen);
  const busy = inCall || !!meeting || !!coach.active || windows.overlayVisible || talk.isOpen;
  const fired = scheduler.tick(routines, new Date(now), dt, idle < 120, (r) => {
    if (busy) return false;
    if (r.kind === 'bedtime') return true;
    if (guard.muted()) return false;
    return !sess || r.kind === 'lunch' || r.kind === 'shutdown';
  });
  for (const f of fired) {
    log(`[routine] ${f.routine.name}${f.followUp ? ` (follow-up ${f.followUp})` : ''}`);
    // Reminders that can wait go through the gate; follow-ups, ones you snoozed, and bedtime don't.
    const soft = !f.followUp && !f.snoozed ? SOFT_ROUTINES[f.routine.kind] : undefined;
    if (!soft) {
      void announcer.routine(f.routine, f.followUp);
      continue;
    }
    // A break goal does this job better (it counts real stretches), so the stretch reminder steps aside.
    if (f.routine.kind === 'stretch' && settings.goals.enabled && goalsData.goals.some((g) => g.kind === 'breaks' && !g.paused)) continue;
    const r = f.routine;
    const tag = `routine:${r.id}`;
    attention.offer({ key: tag, kind: `routine:${r.kind}`, ...soft, send: async () => (await announcer.routine(r, 0, tag)).includes('toast') }, now);
  }
  // Natural pauses: the stretch and eye-break counts start over after a real break, and the goals look ahead.
  const moment = attentionFrozen ? null : attention.tick({ now, day: dayKey(now), idleSec: idle, calm: !busy && !sess && !guard.muted() && !windows.overlayVisible, inSession: !!sess, inMeeting: !!(calendar.configured && calendar.now(now)), todosDone: todos.summary().doneToday });
  if (moment === 'back' || moment === 'arrive') scheduler.naturalBreak(routines.filter((x) => x.kind === 'stretch' || x.kind === 'eyes').map((x) => x.id));
  if (moment && settings.goals.enabled) focusOffer(moment, now);
  if (now - lastRoutineSave > 60_000) {
    lastRoutineSave = now;
    store.writeJson('routine-state.json', scheduler.state);
  }
  calendarTick(now, busy);
  deadlineTick(now, busy, idle);
  goalTick(now, busy, idle);
  if (now % 5000 < 1000) crew.tick();
  if (now - lastAchievementCheck > 60_000) checkAchievements(now);
  statsAndExportTick(now);
  if (labelsDirty) {
    labelsDirty = false;
    store.saveLabels(classifier.cache);
  }
  pushState();
}

function liveState(): LiveState {
  const shown = isSelf(current) && lastExternal && Date.now() - lastExternal.t < 120_000 ? lastExternal : current;
  return {
    onboarded: !!profile,
    session: sess
      ? {
          id: sess.record.id,
          goal: sess.record.goal,
          plannedMin: sess.record.plannedMin,
          startedAt: sess.record.startedAt,
          elapsedSec: sess.elapsedSec(),
          focusSec: sess.record.focusSec,
          driftSec: sess.record.driftSec,
          drift: sess.engine.drift,
          driftThresholdSec: sess.engine.thresholdSec(4),
          level: sess.engine.level,
          onBreakUntil: sess.onBreakUntil,
          pomodoro: sess.pomodoro ? { cycle: Math.min(sess.pomodoro.cycles, sess.pomodoro.breaksTaken + 1), cycles: sess.pomodoro.cycles } : undefined,
        }
      : null,
    current: shown ? { app: shown.app, domain: shown.domain, title: settings.titlesStayLocal ? undefined : shown.title, label: shown.label, source: shown.source } : null,
    extensionConnected: bridge.connected,
    helperRunning: helper.running,
    inCall: !!current?.inCall,
    muteUntil: guard.muted() ? guard.muteUntil : undefined,
    keys: store.keyStatus(),
    lastGoal: appState.lastGoal,
    todos: todos.summary(),
    calendar: calendar.summary(),
    talk: { open: talk.isOpen, voice: talk.voiceReady },
    deadlines: { pinned: deadlines.pinned().map((d) => ({ ...d, overdue: isOverdue(d, Date.now()) })), upcoming: deadlines.open().length },
    ui: settings.ui ?? 'panel',
    lockout: lockout.active(Date.now()) && lockout.state ? { until: lockout.state.until, from: lockout.state.from } : undefined,
    goals: settings.goals.enabled,
  };
}

// -----------------------------------------------------------------------------
// Deadlines

/** Reminders: once 3 days before, twice 2 days before, three times the day before. Never during a session, call or meeting. */
function deadlineTick(now: number, busy: boolean, idleSec: number): void {
  if (now - lastDeadlineCheck < 30_000) return;
  lastDeadlineCheck = now;
  if (sess || busy || guard.muted() || idleSec >= 120 || talk.isOpen) return;
  const next = deadlines.nextReminder(now);
  if (!next) return;
  const { d, r } = next;
  const { title, body } = reminderLine(d, r, getProfile().persona);
  log(`[deadline] reminder ${r.n}/${r.of} for "${d.title}" (${r.daysLeft} days)`);
  void notifier.notify({
    kind: 'deadline',
    title,
    body,
    toastKind: 'deadline',
    priority: r.daysLeft === 1 ? 'high' : 'normal',
    autoHideMs: r.daysLeft === 1 ? undefined : 120_000,
    actions: [
      { id: `start:50:${d.title}`, label: 'Lock in on it' },
      { id: `deadline:done:${d.id}`, label: 'Done ✓' },
      { id: 'talk:checkin', label: 'Talk it through' },
    ],
  });
}

function setDeadlineDone(id: string, done: boolean): void {
  const d = deadlines.update(id, { done });
  if (!d) return;
  const today = dayKey(Date.now());
  if (done) {
    const linkedDone = d.taskId && todos.doneLog.all().some((e) => e.taskId === d.taskId);
    if (!linkedDone) todos.doneLog.add({ at: Date.now(), title: d.title, source: 'lockin', list: 'Deadlines', project: d.project });
    todos.noteProgress();
    void notifier.notify({ kind: 'todo_win', title: 'Deadline done', body: `"${d.title}" is done. Off the list.`, toastKind: 'win', autoHideMs: 6000, priority: 'low' });
  } else {
    for (const e of todos.doneLog.onDay(today)) if (e.list === 'Deadlines' && e.title === d.title) todos.doneLog.remove(e.id);
  }
  pushState();
}

/** Deadlines made from a to-do finish when the to-do does. */
function syncLinkedDeadlines(): void {
  for (const d of deadlines.open()) {
    if (d.taskId && todos.doneLog.all().some((e) => e.taskId === d.taskId && e.at >= d.createdAt - 60_000)) deadlines.update(d.id, { done: true });
  }
}

/** Seven days from today: meetings, deadlines and to-dos due each day. */
function weekView(): WeekDay[] {
  const now = Date.now();
  const base = new Date(now);
  const open = todos.openRanked();
  const all = deadlines.all();
  const out: WeekDay[] = [];
  for (let i = 0; i < 7; i++) {
    const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).getTime();
    const end = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i + 1).getTime();
    const date = ymd(start);
    out.push({
      date,
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
      events: calendar.events.filter((e) => e.start < end && e.end > start && (!e.allDay || e.end > start)),
      deadlines: all.filter((d) => d.due === date || (i === 0 && !d.done && d.due < date)),
      tasks: open.filter((t) => t.due === date || (i === 0 && !!t.due && t.due < date)).slice(0, 12),
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Lock in with friends, Lock In bombs, achievements and streaks

let unlocked: Record<string, number> | null = null;
let lastAchievementCheck = 0;
let statsCache: { at: number; stats: CrewStatsT } | null = null;
let stateSince: { state: string; at: number } = { state: '', at: Date.now() };
type CrewStatsT = LocalStatus['stats'];

function achievementCtx(now: number): AchievementCtx {
  const others = crew?.othersStats() ?? [];
  const ctx: AchievementCtx = {
    now,
    sessions: store.sessions(),
    interventions: store.interventions(),
    doneAts: todos.doneLog.all().map((e) => e.at),
    todoRoastAts: store.readLog<{ at: number }>('roasts.ndjson').map((r) => r.at),
    crewEvents: crew?.events() ?? [],
  };
  const mine = crewStats(ctx, 0).roastedWeek;
  ctx.roastTop = others.length > 0 && mine >= 3 && others.every((o) => o.roastedWeek < mine);
  return ctx;
}

function myStats(now: number, fresh = false): CrewStatsT {
  if (!fresh && statsCache && now - statsCache.at < 60_000) return statsCache.stats;
  const stats = crewStats(achievementCtx(now), Object.keys(unlocked ?? {}).length);
  statsCache = { at: now, stats };
  return stats;
}

/** What friends see about you right now. */
function crewLocal(): LocalStatus {
  const now = Date.now();
  const idle = powerMonitor.getSystemIdleTime();
  let state: LocalStatus['state'];
  if (sess) state = sess.onBreakUntil ? 'break' : 'locked';
  else if (current?.inCall || (settings.calendar.quietInMeetings && calendar?.now(now))) state = 'meeting';
  else if (idle >= 300 || !current) state = 'away';
  else if (current.label === 'distraction') state = 'drifting';
  else state = 'free';
  if (stateSince.state !== state) stateSince = { state, at: sess && (state === 'locked' || state === 'break') ? sess.record.startedAt : now };
  const c = settings.crew;
  const where = current && state === 'drifting' && !current.isPrivate ? current.domain ?? current.app : undefined;
  return {
    state,
    since: stateSince.at,
    goal: c.shareGoal && sess ? sess.record.goal : undefined,
    distraction: c.shareDistraction ? where : undefined,
    sessionMin: sess ? Math.round(sess.elapsedSec(now) / 60) : undefined,
    stats: myStats(now),
  };
}

/**
 * A friend's bomb: every distraction on this Mac locks for 5 minutes, then the red card locks the
 * screen for 5 seconds (or a corner card, when a full-screen card would be rude).
 */
function bombLanded(b: { id: string; from: string; name: string; insult: string }): BombOutcome {
  const now = Date.now();
  const me = crewLocal().state;
  if (me === 'locked' || me === 'break') return 'bounced';
  store.append('roasts.ndjson', { at: now, kind: 'bomb', from: b.name });
  statsCache = null;
  const locks = settings.crew.bombsLockout !== false;
  if (locks) startLockout(b.name, now);
  const gentle = me === 'meeting' || guard.muted() || inQuietHours(settings, new Date(now)) || windows.overlayVisible || talk?.isOpen || !settings.crew.bombsFullScreen;
  log(`[crew] bomb from ${b.name}${gentle ? ' (softened)' : ''}${locks ? `, distractions locked ${BOMB_LOCKOUT_MIN} min` : ''}`);
  if (gentle) {
    windows.showToast({ kind: 'roast', title: `Lock In bomb from ${b.name}`, body: locks ? `${b.insult} Your distractions are locked for ${BOMB_LOCKOUT_MIN} minutes.` : b.insult, autoHideMs: 15_000, actions: [{ id: 'start:25:', label: 'Lock in for 25 minutes' }, { id: 'dismiss', label: 'Okay' }] });
    return 'soft';
  }
  windows.showOverlay({
    interventionId: `bomb-${b.id}`,
    level: 4,
    tone: 'red',
    cardName: `Lock In bomb from ${b.name}`,
    meta: locks ? `Every distraction locked for ${BOMB_LOCKOUT_MIN} minutes` : 'Screen locked for 5 seconds',
    line: b.insult,
    distraction: '',
    driftMin: 0,
    goal: '',
    options: [],
    canTalk: false,
    lockSec: 5,
    actions: [
      { id: 'start:25:', label: 'Lock in for 25 minutes' },
      { id: `crew:back:${b.from}`, label: `Bomb ${b.name} back` },
      { id: 'dismiss', label: 'Okay, okay' },
    ],
  });
  void playSound('buzzer');
  if (getProfile().voice.speak && guard.canSpeak(getProfile(), settings, false, now)) void voice.speak(`${b.name} says: ${b.insult}`, { shout: true });
  return 'hit';
}

// -----------------------------------------------------------------------------
// The bomb's lockout: every distracting site blocked and every distracting app hidden for 5 minutes.

const lockout = new Lockout();

const lockNote = () => (lockout.state ? { from: lockout.state.from, until: lockout.state.until } : undefined);

function startLockout(from: string, now: number): void {
  lockout.start(from, now);
  // Every distracting site, at once (open tabs on them turn into the blocked page).
  const p = getProfile();
  if (bridge.connected) for (const d of distractionDomains(p.distractionDomains, classifier.cache, p.workDomains)) void router.blockDomain(d, lockNote());
  lockoutTick(now);
  pushState();
}

/** Once a second: whatever distraction comes to the front is blocked or hidden, until the lock lifts. */
function lockoutTick(now: number): void {
  if (lockout.expire(now)) {
    log('[lockout] lifted');
    // A session keeps its own blocks until it ends.
    if (!sess) void router.unblockAll();
    windows.showToast({ kind: 'info', title: 'The bomb wore off', body: 'Your distractions are unlocked. Use them wisely.', autoHideMs: 5000 });
    pushState();
    return;
  }
  if (!lockout.active(now) || !current || isSelf(current)) return;
  const a = lockout.act(current, now, bridge.connected);
  if (!a) return;
  if (a.kind === 'block-site') void router.blockDomain(a.domain, lockNote());
  else void router.hideApp(a.app);
  log(`[lockout] ${a.kind === 'block-site' ? `blocked ${a.domain}` : `hid ${a.app}`}`);
  if (!windows.overlayVisible && lockout.notice(now)) {
    const what = current.browser && current.domain ? current.domain : current.app;
    windows.showToast({ kind: 'roast', title: `Locked by ${lockout.state!.from}'s bomb`, body: `${what} is locked for ${lockClock(lockout.leftSec(now))} more. Back to it.`, autoHideMs: 5000 });
  }
}

function checkAchievements(now: number): void {
  if (!store) return;
  lastAchievementCheck = now;
  const first = unlocked === null;
  const res = evaluate(achievementCtx(now), unlocked);
  const changed = Object.keys(res.unlocked).length !== Object.keys(unlocked ?? {}).length;
  unlocked = res.unlocked;
  if (changed || first) store.writeJson('achievements.json', unlocked);
  if (res.backfilled > 0) {
    windows.showToast({ kind: 'win', title: `${res.backfilled} achievements already`, body: 'You earned these before they existed. See them on the Progress page.', autoHideMs: 9000, actions: [{ id: 'open:progress', label: 'Show me' }] });
  }
  for (const a of res.fresh) {
    log(`[achievement] ${a.name}`);
    windows.showToast({ kind: 'win', title: `Achievement: ${a.name}`, body: a.desc, autoHideMs: 9000 });
    void playSound('fanfare');
    crew?.shareAchievement(a.name);
  }
  if (changed) statsCache = null;
}

function crewPayload() {
  const now = Date.now();
  return { view: crew.view(), achievements: achievementViews(unlocked ?? {}), streak: streakOf(store.sessions(), now) };
}

function pushCrew(): void {
  const p = crewPayload();
  windows.sendMain('crew:update', p);
  windows.sendPanel('crew:update', p);
}

// -----------------------------------------------------------------------------
// The Chrome card: a big Lock In card over the distracting tab for 5 seconds

let extensionVersion: string | null | undefined;
function bundledExtensionVersion(): string | null {
  if (extensionVersion !== undefined) return extensionVersion;
  try {
    extensionVersion = String((JSON.parse(readFileSync(join(extensionPath(), 'manifest.json'), 'utf8')) as { version?: string }).version ?? '') || null;
  } catch {
    extensionVersion = null;
  }
  return extensionVersion;
}

let lastTabCard = 0;
/** The browser tab in front is a distraction (YouTube and the like) and the extension can cover it. */
function distractingTab(): LabeledSample | null {
  const c = current;
  if (!c || !c.browser || c.label !== 'distraction' || typeof c.tabId !== 'number') return null;
  if (!bridge.connected || !bridge.canCard) return null;
  return c;
}

async function showTabCard(p: NotifyPayload, force = false): Promise<boolean> {
  const c = distractingTab();
  if (!force && !c) return false;
  const now = Date.now();
  if (!force && now - lastTabCard < 20_000) return false;
  lastTabCard = now;
  const tone = p.kind === 'red' ? 'red' : p.kind === 'yellow' ? 'yellow' : p.kind === 'todo_roast' ? 'orange' : 'lime';
  const ok = await bridge.send({ cmd: 'card', tabId: c?.tabId, title: 'Lock in.', text: p.body, goal: sess?.record.goal || undefined, seconds: 5, tone }, 'active');
  if (!ok) log('[bridge] the Chrome card could not be shown on this tab');
  return ok;
}

// -----------------------------------------------------------------------------
// Calendar, daily stats and the CSV export

function calendarTick(now: number, busy: boolean): void {
  const cal = settings.calendar;
  if (!calendar.configured) return;
  void calendar.refresh();
  const soon = calendar.headsUp(now, cal.headsUpMin);
  if (soon && !talk.isOpen) {
    const inMin = Math.max(1, Math.round((soon.start - now) / 60_000));
    const persona = getProfile().persona;
    const body =
      persona === 'sassy' ? `"${soon.title}" at ${clockTime(soon.start)}. Wrap up the thought, don't start a new one.` :
      persona === 'drill' ? `${soon.title} in ${inMin} minutes. Wrap it up!` :
      `"${soon.title}" starts at ${clockTime(soon.start)}. Good moment to wrap up.`;
    void notifier.notify({
      kind: 'meeting',
      title: `${soon.title} in ${inMin} min`,
      body,
      toastKind: 'meeting',
      autoHideMs: 90_000,
      actions: [...(soon.link ? [{ id: `url:${encodeURIComponent(soon.link)}`, label: 'Join the call' }] : []), { id: 'dismiss', label: 'Got it' }],
    });
  }
  const gap = calendar.gapAfter(now);
  if (gap && cal.offerGaps && !sess && !busy && !guard.muted()) {
    const top = todos.top()?.title;
    const min = Math.max(20, Math.min(90, Math.floor((gap.freeMin - 5) / 5) * 5));
    const free = gap.next ? `${gap.freeMin >= 60 ? `${Math.floor(gap.freeMin / 60)} h ${gap.freeMin % 60} min` : `${gap.freeMin} min`} until "${gap.next.title}"` : 'Nothing else on the calendar for a while';
    void notifier.notify({
      kind: 'meeting',
      title: 'Meeting over',
      body: `${free}.${behindLine(now)}${top ? ` Lock in on "${top}"?` : ' Lock in on something?'}`,
      toastKind: 'meeting',
      autoHideMs: 120_000,
      actions: [{ id: `start-top:${min}`, label: `Lock in for ${min} min` }, { id: 'talk:checkin', label: 'Talk it through' }, { id: 'dismiss', label: 'Not now' }],
    });
  }
}

/** " You're 45 min behind an even pace on your focus goal." (or nothing) */
function behindLine(now: number): string {
  const b = settings.goals.nudges ? focusBehind(now) : null;
  return b ? ` You're about ${dur(b.behindMin)} behind an even pace on your focus goal (${hrs(b.focusMin)} of ${hrs(b.g.target * 60)} h).` : '';
}

function exportFolder(): string {
  return settings.exportCsv.folder.trim() || join(app.getPath('documents'), 'Lock In');
}

function runExport(): { ok: boolean; folder: string; error?: string; at: number } {
  const folder = exportFolder();
  try {
    const files = buildExport({
      done: todos.doneLog.all(),
      sessions: store.sessions(),
      days: store.readJson<Record<string, { activeSec: number }>>('days.json', {}),
      meetings: store.readJson<Record<string, MeetingRow[]>>('calendar-days.json', {}),
      todoDays: todoHistory.all(),
      deadlines: deadlines.all(),
    });
    writeExport(folder, files);
    lastExportAt = Date.now();
    exportError = '';
    return { ok: true, folder, at: lastExportAt };
  } catch (e) {
    exportError = /EPERM|EACCES/.test((e as Error).message) ? `macOS did not let Lock In write to ${folder}. Choose another folder, or allow it in System Settings, Privacy and Security, Files and Folders.` : (e as Error).message;
    log(`[export] ${exportError}`);
    return { ok: false, folder, error: exportError, at: lastExportAt };
  }
}

// ---- backups: everything Lock In keeps, in one zip you can restore on any Mac -----------------

function backupFolder(): string {
  return join(exportFolder(), 'Backups');
}

function writeBackup(name: string): string {
  const folder = backupFolder();
  mkdirSync(folder, { recursive: true });
  const file = join(folder, name);
  writeFileSync(file, makeBackup(store.dir, app.getVersion()));
  return file;
}

/** Once a day, a dated backup next to the spreadsheets; the last 14 are kept. */
function dailyBackup(now: number): void {
  const name = `Lock In backup ${dayKey(now)}.zip`;
  if (existsSync(join(backupFolder(), name))) return;
  try {
    writeBackup(name);
    pruneBackups(backupFolder(), 14);
    log(`[backup] ${name}`);
  } catch (e) {
    log(`[backup] ${(e as Error).message}`);
  }
}

/** Once a minute: keep today's screen time and to-dos; every hour (and when the day turns over): refresh the CSVs. */
function statsAndExportTick(now: number): void {
  if (now - lastStatsAt < 60_000) return;
  lastStatsAt = now;
  syncLinkedDeadlines();
  try {
    const day = dayKey(now);
    todoHistory.record(now, day, todos.watchdog.openTasks, todos.doneLog.onDay(day), todos.listName());
  } catch (e) {
    log(`[todos] history: ${(e as Error).message}`);
  }
  store.writeJson('rhythm.json', rhythm.toJSON());
  store.writeJson('attention.json', attention.toJSON());
  const wd = todos.watchdog.state;
  const days = store.readJson<Record<string, { activeSec: number }>>('days.json', {});
  days[wd.day] = { activeSec: Math.round(wd.activeSec) };
  store.writeJson('days.json', days);
  const today = dayKey(now);
  const turned = statsDay !== '' && statsDay !== today;
  statsDay = today;
  if (settings.exportCsv.auto && (turned || now - lastExportAt > 3_600_000)) {
    runExport();
    dailyBackup(now);
  }
}

function saveCalendarDay(day: string, events: MeetingRow[]): void {
  const all = store.readJson<Record<string, MeetingRow[]>>('calendar-days.json', {});
  all[day] = events;
  const keys = Object.keys(all).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete all[k];
  store.writeJson('calendar-days.json', all);
}

// -----------------------------------------------------------------------------
// Talking

function talkContext(situation: Situation, detail?: string): TalkContext {
  const wd = todos.watchdog.state;
  const status = sess
    ? `In a focus session on "${sess.record.goal || 'deep work'}", ${Math.round(sess.elapsedSec() / 60)} of ${sess.record.plannedMin} minutes in.`
    : `Not in a focus session. ${Math.round(wd.activeSec / 60)} minutes at the computer today; ${Math.round(wd.sinceProgressSec / 60)} minutes since they last finished something.`;
  const goalLine = settings.goals.enabled ? goalsForCoach(goalsView().goals) : '';
  return {
    userName: todos.firstName,
    persona: getProfile().persona,
    profanityOk: settings.profanityOk,
    situation,
    detail,
    now: new Date(),
    status: goalLine ? `${status} ${goalLine}` : status,
    openTasks: todos.openRanked().map((t) => t.title),
    doneToday: todos.doneToday().map((t) => t.title),
    agenda: [calendar.agenda(), deadlines.summary() ? `Deadlines: ${deadlines.summary()}.` : ''].filter(Boolean).join(' '),
  };
}

/** ⌘⇧Space or holding the space bar: start talking, answer the coach, or hang up. */
function toggleTalk(): void {
  if (talk.isOpen) talk.close();
  else if (coach.active && !coach.active.preview) void coach.choose('talk', 'voice');
  else startTalk('checkin');
}

function startTalk(situation: Situation, opts: { detail?: string; onEnd?: () => void; focus?: boolean } = {}): void {
  windows.hideToast();
  void talk.start(situation, opts).then(() => pushState());
}

/** Gets the voice agent ready in the background, so the first conversation is quick and key problems show up early. */
// -----------------------------------------------------------------------------
// Coaches made from someone you know

/** Languages ElevenLabs agents talk in. */
const AGENT_LANGS = new Set(['en', 'zh', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'hi', 'ru', 'vi', 'ar', 'tr', 'nl', 'pl', 'id', 'sv', 'da', 'fi', 'no', 'cs', 'ro', 'uk', 'el', 'bg', 'hr', 'sk', 'ta', 'ms', 'hu', 'fil']);

function activeCoach(): CustomCoach | null {
  const id = profile?.customCoach;
  return id && coaches ? coaches.get(id) : null;
}

/** The voice the coach speaks in: theirs, while a coach made from someone (with a voice) is on. */
function coachVoiceId(): string {
  const c = activeCoach();
  return c?.voice && c.useVoice ? c.voice.id : settings.voiceId;
}

function agentLanguage(): string {
  const code = activeStyle()?.languageCode ?? 'en';
  const l = code === 'tl' ? 'fil' : code;
  return AGENT_LANGS.has(l) ? l : 'en';
}

function coachView(id: string): CustomCoachView | null {
  return coaches.view(id, profile?.customCoach);
}

/** Puts the active coach's way of talking in place (or the built-in one back), and keeps the profile in step. */
function applyCoach(): void {
  const c = activeCoach();
  if (profile?.customCoach && !c) {
    profile = { ...profile, customCoach: undefined };
    store.saveProfile(profile);
  }
  if (c && profile && profile.persona !== c.base) {
    profile = { ...profile, persona: c.base };
    store.saveProfile(profile);
  }
  setActiveStyle(c ? toActiveStyle(c) : null);
  // The live agent speaks in the coach's voice and language: rebuild it when they change.
  const k = `${coachVoiceId()}|${agentLanguage()}`;
  if (agentKey && k !== agentKey) warmAgent();
  agentKey = k;
}

function setupCoachIpc(): void {
  const views = () => coaches.list().map((c) => coachView(c.id)).filter(Boolean);
  handle('coaches:list', () => views());
  handle('coaches:get', (_e, id: string) => coachView(id));
  handle('coaches:create', (_e, p: { name: string; relation?: string; base?: Profile['persona'] }) => coachView(coaches.create({ base: getProfile().persona, ...p }).id));
  handle('coaches:update', (_e, id: string, patch: Parameters<Coaches['update']>[1]) => {
    coaches.update(id, patch ?? {});
    return coachView(id);
  });
  handle('coaches:remove', async (_e, id: string, alsoVoice?: boolean) => {
    if (alsoVoice) await coaches.deleteVoice(id);
    if (profile?.customCoach === id) {
      profile = { ...profile, customCoach: undefined };
      store.saveProfile(profile);
    }
    coaches.remove(id);
    applyCoach();
    pushState();
    return views();
  });
  handle('coaches:addFiles', async (_e, id: string, paths?: string[]) => {
    let list = Array.isArray(paths) ? paths.filter((x) => typeof x === 'string' && x) : [];
    if (!list.length) {
      const opts: Electron.OpenDialogOptions = {
        title: 'Add recordings or writing',
        buttonLabel: 'Add',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Recordings and text', extensions: [...AUDIO_EXT, ...TEXT_EXT] }, { name: 'All files', extensions: ['*'] }],
      };
      const r = windows.main ? await dialog.showOpenDialog(windows.main, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths.length) return { added: 0, skipped: [], view: coachView(id) };
      list = r.filePaths;
    }
    const res = coaches.addFiles(id, list);
    return { ...res, view: coachView(id) };
  });
  handle('coaches:addText', (_e, id: string, t: { title?: string; text: string }) => {
    try {
      coaches.addText(id, t?.title ?? '', t?.text ?? '');
      return { ok: true, view: coachView(id) };
    } catch (e) {
      return { ok: false, error: (e as Error).message, view: coachView(id) };
    }
  });
  handle('coaches:removeSource', (_e, id: string, sid: string) => {
    coaches.removeSource(id, sid);
    return coachView(id);
  });
  handle('coaches:pickSpeaker', (_e, id: string, sid: string, speaker: string | null) => {
    coaches.pickSpeaker(id, sid, speaker);
    return coachView(id);
  });
  handle('coaches:retry', (_e, id: string, sid: string) => {
    coaches.retry(id, sid);
    return coachView(id);
  });
  handle('coaches:distill', async (_e, id: string) => ({ ...(await coaches.distill(id)), view: coachView(id) }));
  handle('coaches:setLines', (_e, id: string, kind: CoachLineKind, lines: string[]) => ({ ...coaches.setLines(id, kind, Array.isArray(lines) ? lines : []), view: coachView(id) }));
  handle('coaches:use', (_e, id: string | null) => {
    const c = id ? coaches.get(id) : null;
    const p = getProfile();
    profile = { ...p, customCoach: c?.id, persona: c ? c.base : p.persona };
    store.saveProfile(profile);
    applyCoach();
    pushState();
    log(c ? `[coaches] ${c.name} is the coach now` : '[coaches] back to the built-in coach');
    return profile;
  });
  handle('coaches:hear', async (_e, id: string, kind?: CoachLineKind, line?: string) => {
    const c = coaches.get(id);
    if (!c) return 'none';
    const k: CoachLineKind = kind && LINE_SPECS[kind] ? kind : (['level2', 'back', 'win', 'kickoff'] as CoachLineKind[]).find((x) => c.lines[x]?.length) ?? 'level2';
    const pool = line?.trim() ? [line] : c.lines[k] ?? [];
    if (!pool.length) return 'none';
    const text = exampleLine(k, cleanLine(pool[Math.floor(Math.random() * pool.length)]));
    return voice.preview(c.voice && c.useVoice ? c.voice.id : settings.voiceId, text, async () => null);
  });
  handle('coaches:clipPlan', (_e, id: string) => coaches.clipPlan(id));
  handle('coaches:audio', (_e, id: string, sid: string) => coaches.audio(id, sid));
  handle('coaches:clone', async (_e, id: string, p: { files?: ClipFile[]; macCut?: string[]; consent?: boolean }) => {
    const files = (p?.files ?? []).map((f) => ({ name: String(f.name).replace(/[^\w.-]/g, '_').slice(0, 60), data: new Uint8Array(f.data), mime: String(f.mime || 'audio/wav'), seconds: Number(f.seconds) || 0 }));
    const r = await coaches.cloneVoice(id, { files, macCut: p?.macCut ?? [], consent: p?.consent === true });
    return { ...r, view: coachView(id) };
  });
  handle('coaches:deleteVoice', async (_e, id: string) => ({ ...(await coaches.deleteVoice(id)), view: coachView(id) }));
}

// -----------------------------------------------------------------------------
// Goals (beta)

interface GoalsFile {
  goals: Goal[];
  /** Suggestions you said "not now" (until) or "don't suggest this" (never) to. */
  memo: Record<string, { until?: number; never?: boolean }>;
  /** "Something else" goals: the days you ticked them off. */
  checks: Record<string, string[]>;
  /** The coach's last ideas. */
  coach: GoalSuggestion[];
  /** Suggestions already brought up, and when. */
  pinged: Record<string, number>;
  lastPingDay?: string;
  /** Nudges done or snoozed: key → not before this time. */
  nudged: Record<string, number>;
  /** Big goals: the coach's guess for things you keep working on (term → goal, and how to ask). */
  guesses: Record<string, { goalId: string | null; text?: string }>;
  /** Big goals: things you said aren't part of any goal. */
  ignoredTerms: string[];
  /** The day the coach last looked for links, the day Lock In last asked, and each goal's last check-in day. */
  linkDay?: string;
  askedDay?: string;
  checkin: Record<string, string>;
  /** Big goals already celebrated today: goal id → day. */
  cheered: Record<string, string>;
}

let goalsData: GoalsFile;
const loadGoals = (): GoalsFile => ({ goals: [], memo: {}, checks: {}, coach: [], pinged: {}, nudged: {}, guesses: {}, ignoredTerms: [], checkin: {}, cheered: {}, ...store.readJson<Partial<GoalsFile>>('goals.json', {}) });
function saveGoals(): void {
  store.writeJson('goals.json', goalsData);
  pastCache = null;
}

let pastCache: { at: number; day: string; past: DayFacts[] } | null = null;

function dayFacts(day: string, sessions: SessionRecord[], meetings: Record<string, MeetingRow[]>, active: Record<string, { activeSec: number }>): DayFacts {
  const r = rhythm.days[day];
  const own = sessions.filter((x) => dayKey(x.startedAt) === day);
  const tops: Record<string, number> = {};
  for (const x of own) for (const [k, v] of Object.entries(x.topDistractions ?? {})) tops[k] = (tops[k] ?? 0) + v;
  const first = own.length ? Math.min(...own.map((x) => x.startedAt)) : undefined;
  // What you did, in words: big goals are matched against these.
  const items: DayItem[] = [
    ...todos.doneLog.onDay(day).map((e): DayItem => ({ kind: 'todo', text: e.title, at: e.at })),
    ...own.filter((x) => x.goal && x.focusSec >= 300).map((x): DayItem => ({ kind: 'session', text: x.goal, at: x.startedAt, min: Math.round(x.focusSec / 60) })),
    ...(meetings[day] ?? []).map((m): DayItem => ({ kind: 'meeting', text: m.title, at: m.start, min: Math.round((m.end - m.start) / 60_000) })),
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return {
    day,
    items,
    tracked: !!r,
    activeMin: r?.activeMin ?? (active[day]?.activeSec ?? 0) / 60,
    longestMin: r?.longestMin ?? 0,
    breaks: r?.breaks ?? 0,
    water: r?.water?.length ?? 0,
    lastMin: lastMinOf(r),
    focusMin: own.reduce((n, x) => n + x.focusSec, 0) / 60,
    driftMin: own.reduce((n, x) => n + x.driftSec, 0) / 60,
    sessions: own.length,
    firstSessionMin: first !== undefined ? minutesOfDay(first, day) : undefined,
    todosDone: todos.doneLog.onDay(day).length,
    meetingMin: (meetings[day] ?? []).reduce((n, m) => n + Math.max(0, (m.end - m.start) / 60_000), 0),
    checked: Object.entries(goalsData.checks).filter(([, days]) => days.includes(day)).map(([id]) => id),
    topDistraction: Object.entries(tops).sort((a, b) => b[1] - a[1])[0]?.[0],
  };
}

/** Today (live, with any session going on) and the 14 days before it. */
function goalHistory(now: number): { today: DayFacts; past: DayFacts[] } {
  const today = dayKey(now);
  const sessions = store.sessions();
  const meetings = store.readJson<Record<string, MeetingRow[]>>('calendar-days.json', {});
  const active = store.readJson<Record<string, { activeSec: number }>>('days.json', {});
  if (!pastCache || pastCache.day !== today || now - pastCache.at > 5 * 60_000) {
    const past: DayFacts[] = [];
    const base = new Date(`${today}T12:00:00`);
    for (let i = 14; i >= 1; i--) {
      const d = new Date(base);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      past.push(dayFacts(key, sessions, meetings, active));
    }
    pastCache = { at: now, day: today, past };
  }
  const live = sess ? [...sessions.filter((x) => x.id !== sess!.record.id), { ...sess.record }] : sessions;
  return { today: dayFacts(today, live, meetings, active), past: pastCache.past };
}

function goalsView(now = Date.now()): GoalsView {
  const { today, past } = goalHistory(now);
  const stretch = rhythm.stretchMin(now);
  const open = todos.openRanked().map((t) => t.title);
  const goals = goalsData.goals.map((g) => viewGoal(g, today, past, now, stretch, open));
  let suggestions: GoalSuggestion[] = [];
  if (settings.goals.suggest) {
    const have = new Set(goalsData.goals.filter((g) => !g.paused).map((g) => g.kind));
    const blocked = (id: string) => !!goalsData.memo[id]?.never || (goalsData.memo[id]?.until ?? 0) > now;
    const coachIdeas = goalsData.coach.filter((x) => !have.has(x.kind) && !blocked(x.id));
    const sum = todos.summary();
    const noticed = notice({ past, openTodos: sum.open, overdue: sum.overdue, goals: goalsData.goals, memo: goalsData.memo, now }).filter((x) => !coachIdeas.some((c) => c.kind === x.kind));
    // A goal that has become too easy, or keeps being out of reach, comes first.
    const tuned = tune(goalsData.goals, past, now).filter((x) => !blocked(x.id));
    suggestions = [...tuned, ...coachIdeas, ...noticed].slice(0, 4);
  }
  const short = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short' });
  return {
    enabled: settings.goals.enabled,
    goals,
    suggestions,
    daysSeen: Object.keys(rhythm.days).length,
    questions: settings.goals.suggest ? goalQuestions(today, past) : [],
    canAskCoach: claude.available,
    week: [...past.slice(-6), today].map((f) => ({ day: f.day, label: f.day === today.day ? 'Today' : short(f.day), activeMin: Math.round(f.activeMin), focusMin: Math.round(f.focusMin), longestMin: Math.round(f.longestMin), water: f.water, lastAt: rhythm.days[f.day]?.last })),
    now: { stretchMin: Math.round(stretch), water: today.water },
  };
}

const bigGoals = () => goalsData.goals.filter((g) => g.kind === 'custom' && !g.paused);

/** Things you keep working on that might belong to a big goal, as questions (most likely first). */
function goalQuestions(today: DayFacts, past: DayFacts[]): GoalQuestion[] {
  const big = bigGoals();
  if (!big.length) return [];
  const byDay = [...past.slice(-6), today].map((f) => f.items ?? []);
  const out: GoalQuestion[] = [];
  for (const t of recurringThings(byDay, big, goalsData.ignoredTerms)) {
    const coach = goalsData.guesses[termKey(t.term)];
    // The coach looked and thinks it belongs to none of them: don't ask.
    if (coach && !coach.goalId) continue;
    // The coach's guess, or Lock In's own from the words around it ("Ship Lock In 1.2" sounds like a product).
    const own = coach ? undefined : guessGoal(t, big);
    const q = questionFor(t, big, coach?.goalId ? { goalId: coach.goalId, text: coach.text } : own ? { goalId: own } : undefined);
    if (q && !(goalsData.memo[q.id]?.until && goalsData.memo[q.id].until! > Date.now())) out.push(q);
    if (out.length >= 3) break;
  }
  return out;
}

/** Your answer to "Is Lock In one of your cool side products?": yes puts it on that goal's list, no remembers. */
function answerQuestion(qid: string, goalId: string | null): boolean {
  const { today, past } = goalHistory(Date.now());
  const q = goalQuestions(today, past).find((x) => x.id === qid);
  if (!q) return false;
  if (goalId) {
    const g = goalsData.goals.find((x) => x.id === goalId);
    if (!g) return false;
    g.counts = cleanTerms([...(g.counts?.length ? g.counts : seedTerms(g.title ?? '')), q.term]);
    log(`[goals] "${q.term}" counts toward ${goalName(g)}`);
  } else {
    for (const id of q.goalIds) {
      const g = goalsData.goals.find((x) => x.id === id);
      if (g) g.notCounts = cleanTerms([...(g.notCounts ?? []), q.term]);
    }
    if (q.goalIds.length > 1 || bigGoals().length === 1) goalsData.ignoredTerms = cleanTerms([...goalsData.ignoredTerms, q.term], 200);
  }
  saveGoals();
  return true;
}

function cleanTerms(xs: unknown, max = 20): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(xs) ? xs : []) {
    const t = String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (t.length >= 2 && !out.some((o) => termKey(o) === termKey(t))) out.push(t);
  }
  return out.slice(-max);
}

/** With a Claude key: the words and names that count toward a new big goal. Without one, the words of its title. */
async function seedCounts(g: Goal): Promise<void> {
  const seed = cleanTerms([...seedTerms(g.title ?? ''), ...themeTerms(g.title ?? '', g.why)]);
  // Keep what's there (your answers, earlier lists); the coach only adds.
  const base = g.counts?.length ? g.counts : seed;
  g.counts = base;
  g.seededBy ??= 'words';
  if (!claude.available) return;
  const { today, past } = goalHistory(Date.now());
  const recent = recurringThings([...past.slice(-6), today].map((f) => f.items ?? []), [], []).map((t) => t.term);
  const res = await claude.messages({ model: settings.coachModel, system: TERMS_SYSTEM, messages: [{ role: 'user', content: termsPrompt(g.title ?? '', g.why, roleText(getProfile()), recent) }], maxTokens: 300, timeoutMs: 12_000 }).catch(() => null);
  const terms = parseTerms(res?.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('') ?? '');
  if (terms.length) {
    g.counts = cleanTerms([...base, ...terms], 24);
    g.seededBy = 'coach';
  }
}

/** Big goals set up before there was a Claude key: once a key is added, the coach adds to their lists (once each). */
const reseedTried = new Set<string>();
function reseedWithCoach(): void {
  if (!claude.available) return;
  const g = bigGoals().find((x) => x.seededBy !== 'coach' && x.seededBy !== 'you' && !reseedTried.has(x.id));
  if (!g) return;
  reseedTried.add(g.id);
  void seedCounts(g).then(() => {
    saveGoals();
    log(`[goals] the coach added to what counts toward ${goalName(g)}`);
  });
}

/** Once a day, with a Claude key: which goal (if any) each thing you keep working on belongs to, and how to ask. */
async function guessLinks(now: number): Promise<void> {
  const today = dayKey(now);
  if (!claude.available || goalsData.linkDay === today) return;
  const big = bigGoals();
  if (!big.length) return;
  const { today: t, past } = goalHistory(now);
  const things = recurringThings([...past.slice(-6), t].map((f) => f.items ?? []), big, goalsData.ignoredTerms).filter((x) => !goalsData.guesses[termKey(x.term)]).slice(0, 12);
  goalsData.linkDay = today;
  saveGoals();
  if (!things.length) return;
  const res = await claude.messages({ model: settings.coachModel, system: LINK_SYSTEM, messages: [{ role: 'user', content: linkPrompt(big, things) }], maxTokens: 700, timeoutMs: 20_000 }).catch(() => null);
  const links = parseLinks(res?.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('') ?? '', big.map((g) => g.id));
  for (const x of things) goalsData.guesses[termKey(x.term)] = links[termKey(x.term)] ?? { goalId: null };
  saveGoals();
}

/** "Counts toward “Fundraise well”." for a line of text (a session goal, a to-do), or nothing. */
function countsToward(text: string): string {
  const hits = bigGoals().filter((g) => matches(text, termsOf(g)));
  return hits.length ? ` Counts toward ${hits.map((g) => `“${g.title}”`).join(' and ')}.` : '';
}

const GOAL_LIMITS: Record<Goal['kind'], [number, number]> = { focus: [0.5, 12], breaks: [15, 240], water: [1, 20], bedtime: [0, 1439], start: [0, 1439], drift: [1, 240], todos: [1, 30], custom: [0, 0] };
const goalId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function addGoal(p: Partial<Goal>): Goal | null {
  const kind = p.kind as Goal['kind'];
  if (!kind || !(kind in GOAL_LIMITS)) return null;
  const [lo, hi] = GOAL_LIMITS[kind];
  const raw = Number(p.target);
  const target = kind === 'custom' ? 0 : Math.min(hi, Math.max(lo, Number.isFinite(raw) ? raw : lo));
  const title = kind === 'custom' ? String(p.title ?? '').trim().slice(0, 120) : undefined;
  if (kind === 'custom' && !title) return null;
  const g: Goal = {
    id: goalId(),
    kind,
    target: kind === 'focus' ? Math.round(target * 2) / 2 : Math.round(target),
    title,
    why: String(p.why ?? '').trim().slice(0, 200) || undefined,
    days: p.days === 'weekdays' ? 'weekdays' : 'every',
    createdAt: Date.now(),
    source: p.source === 'noticed' || p.source === 'coach' ? p.source : 'you',
    ...(kind === 'custom'
      ? { until: /^\d{4}-\d{2}-\d{2}$/.test(String(p.until ?? '')) ? String(p.until) : undefined, counts: p.counts?.length ? cleanTerms(p.counts) : undefined, daily: p.daily !== false }
      : {}),
  };
  // One goal per kind (except big goals): a new one replaces the old.
  goalsData.goals = [...goalsData.goals.filter((x) => kind === 'custom' || x.kind !== kind), g];
  // A water goal needs the water reminder on.
  if (kind === 'water') {
    const r = routines.find((x) => x.kind === 'hydrate');
    if (r && !r.enabled) {
      r.enabled = true;
      store.saveRoutines(routines);
    }
  }
  saveGoals();
  log(`[goals] added ${goalName(g)}`);
  return g;
}

/** "Make it a goal" (or "Change it", for a goal you already have). */
function acceptSuggestion(s: GoalSuggestion): boolean {
  if (s.goalId) {
    const g = goalsData.goals.find((x) => x.id === s.goalId);
    if (!g) return false;
    g.target = s.target;
    g.changedAt = Date.now();
    delete goalsData.memo[s.id];
    saveGoals();
    log(`[goals] ${s.change === 'raise' ? 'raised' : 'eased'} to ${goalName(g)}`);
    return true;
  }
  return !!addGoal({ kind: s.kind, target: s.target, days: s.days, source: s.source === 'coach' ? 'coach' : 'noticed' });
}

/** What the gate learned, for the Goals page. */
const CARD_NAMES: Record<string, string> = {
  'routine:hydrate': 'Drink water',
  'routine:stretch': 'Stand up and stretch',
  'routine:eyes': '20-20-20 eye break',
  'routine:lunch': 'Lunch',
  'routine:kickoff': 'Morning kickoff',
  'routine:midday': 'Midday reality check',
  'routine:weekly': 'Weekly review',
  'goal:breaks': 'Break reminder (your goal)',
  'goal:start': 'Start-time nudge',
  'goal:focus': 'Room for focus',
  noticed: 'Lock In noticed something',
  'goal:big': 'Big goal check-in',
  'goal:ask': '“Is this part of your goal?”',
};

function attentionView(): AttentionView {
  return {
    settings: settings.attention,
    sentToday: attention.state.day === dayKey(Date.now()) ? attention.state.sentToday : 0,
    waiting: attention.waiting().length,
    kinds: Object.entries(attention.state.stats)
      .filter(([k, st]) => CARD_NAMES[k] && st.shown > 0)
      .map(([k, st]) => ({ kind: k, name: CARD_NAMES[k], shown: st.shown, acted: st.acted, ignored: st.ignored + st.dismissed, streak: st.streak, skipEvery: thinning(st.streak) }))
      .sort((a, b) => b.streak - a.streak || b.shown - a.shown),
  };
}

function setupGoalsIpc(): void {
  handle('attention:get', () => attentionView());
  handle('attention:set', (_e, patch: Partial<Settings['attention']>) => {
    const p = patch ?? {};
    const next = { ...settings.attention };
    if (typeof p.pauses === 'boolean') next.pauses = p.pauses;
    if (Number.isFinite(Number(p.maxPerDay))) next.maxPerDay = Math.min(40, Math.max(2, Math.round(Number(p.maxPerDay))));
    if (Number.isFinite(Number(p.minGapMin))) next.minGapMin = Math.min(120, Math.max(5, Math.round(Number(p.minGapMin))));
    settings = { ...settings, attention: next };
    store.saveSettings(settings);
    return attentionView();
  });
  handle('attention:reset', (_e, kind: string) => {
    attention.reset(String(kind));
    store.writeJson('attention.json', attention.toJSON());
    return attentionView();
  });
  handle('goals:get', () => goalsView());
  handle('goals:add', async (_e, p: Partial<Goal>) => {
    const g = addGoal(p ?? {});
    // A new big goal: what counts toward it (the coach's list with a Claude key, else the words of its title).
    if (g && g.kind === 'custom' && !g.counts?.length) {
      await seedCounts(g);
      saveGoals();
    }
    return { ok: !!g, view: goalsView() };
  });
  handle('goals:answer', (_e, qid: string, goalId: string | null) => ({ ok: answerQuestion(String(qid), goalId ? String(goalId) : null), view: goalsView() }));
  handle('goals:accept', (_e, id: string) => {
    const sug = goalsView().suggestions.find((x) => x.id === id);
    return { ok: !!sug && acceptSuggestion(sug), view: goalsView() };
  });
  handle('goals:update', (_e, id: string, patch: Partial<Goal>) => {
    const g = goalsData.goals.find((x) => x.id === id);
    if (g) {
      if (patch.target !== undefined && g.kind !== 'custom') {
        const [lo, hi] = GOAL_LIMITS[g.kind];
        const v = Number(patch.target);
        const next = Number.isFinite(v) ? Math.min(hi, Math.max(lo, g.kind === 'focus' ? Math.round(v * 2) / 2 : Math.round(v))) : g.target;
        if (next !== g.target) g.changedAt = Date.now();
        g.target = next;
      }
      if (patch.why !== undefined) g.why = String(patch.why).trim().slice(0, 200) || undefined;
      if (patch.title !== undefined && g.kind === 'custom') g.title = String(patch.title).trim().slice(0, 120) || g.title;
      if (g.kind === 'custom') {
        if (patch.until !== undefined) g.until = /^\d{4}-\d{2}-\d{2}$/.test(String(patch.until)) ? String(patch.until) : undefined;
        if (patch.counts !== undefined) {
          g.counts = cleanTerms(patch.counts, 24);
          g.seededBy = 'you';
        }
        if (patch.daily !== undefined) g.daily = !!patch.daily;
      }
      if (patch.days === 'weekdays' || patch.days === 'every') g.days = patch.days;
      if (patch.paused !== undefined) g.paused = !!patch.paused;
      saveGoals();
    }
    return goalsView();
  });
  handle('goals:remove', (_e, id: string) => {
    goalsData.goals = goalsData.goals.filter((x) => x.id !== id);
    delete goalsData.checks[id];
    saveGoals();
    return goalsView();
  });
  handle('goals:check', (_e, id: string, done: boolean) => {
    const day = dayKey(Date.now());
    const days = new Set(goalsData.checks[id] ?? []);
    if (done) days.add(day);
    else days.delete(day);
    goalsData.checks[id] = [...days].sort().slice(-400);
    saveGoals();
    return goalsView();
  });
  handle('goals:water', () => {
    rhythm.logWater(Date.now());
    return goalsView();
  });
  handle('goals:later', (_e, id: string) => {
    goalsData.memo[id] = { until: Date.now() + 7 * 86_400_000 };
    saveGoals();
    return goalsView();
  });
  handle('goals:never', (_e, id: string) => {
    goalsData.memo[id] = { never: true };
    saveGoals();
    return goalsView();
  });
  handle('goals:settings', (_e, patch: Partial<Settings['goals']>) => {
    settings = { ...settings, goals: { ...settings.goals, ...(patch ?? {}) } };
    store.saveSettings(settings);
    trayMenuSig = '';
    pushState();
    return { settings: settings.goals, view: goalsView() };
  });
  handle('goals:ideas', async () => {
    if (!claude.available) return { ok: false, error: 'Ideas from the coach need your Claude key (Settings, Keys).', view: goalsView() };
    const { past } = goalHistory(Date.now());
    const res = await claude.messages({ model: settings.coachModel, system: IDEAS_SYSTEM, messages: [{ role: 'user', content: ideasPrompt(past, goalsData.goals, roleText(getProfile())) }], maxTokens: 900, timeoutMs: 30_000 });
    const text = res?.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('') ?? '';
    const ideas = parseIdeas(text, goalsData.goals);
    if (!ideas.length) return { ok: false, error: res ? 'The coach had nothing new to suggest right now.' : "Couldn't reach Claude. Try again in a bit.", view: goalsView() };
    goalsData.coach = ideas;
    for (const i of ideas) delete goalsData.memo[i.id];
    saveGoals();
    return { ok: true, view: goalsView() };
  });
}

/** A card through the gate: true when it went out as a corner card (so its buttons can teach Lock In). */
async function cardOut(p: NotifyPayload): Promise<boolean> {
  return (await notifier.notify(p)).includes('toast');
}

/** Your working day, in minutes after midnight: when today started, and when your day usually ends. */
function dayWindow(now: number): { startMin?: number; endMin: number } {
  const today = dayKey(now);
  const first = rhythm.days[today]?.first;
  const bed = goalsData.goals.find((g) => g.kind === 'bedtime' && !g.paused);
  let endMin = 18 * 60 + 30;
  if (bed) endMin = (bed.target < 720 ? bed.target + 1440 : bed.target) - 60;
  else {
    const lasts = goalHistory(now).past.filter((f) => f.tracked && f.activeMin >= 60 && f.lastMin !== undefined).map((f) => f.lastMin!).sort((a, b) => a - b);
    if (lasts.length >= 3) endMin = Math.max(17 * 60, lasts[Math.floor(lasts.length / 2)] - 60);
  }
  return { startMin: first ? minutesOfDay(first, today) : undefined, endMin };
}

/** How far behind an even pace you are on today's focus goal (null when there's no focus goal today, or you're fine). */
function focusBehind(now: number): { g: Goal; focusMin: number; behindMin: number; leftMin: number; dayLeftMin: number } | null {
  if (!settings.goals.enabled) return null;
  const today = dayKey(now);
  const g = goalsData.goals.find((x) => x.kind === 'focus' && !x.paused && goalDay(x, today));
  if (!g) return null;
  const focusMin = goalHistory(now).today.focusMin;
  const w = dayWindow(now);
  const nowMin = minutesOfDay(now, today);
  // Give the day an hour to get going before calling anyone behind.
  if (nowMin < (w.startMin ?? 9 * 60) + 60) return null;
  const p = focusPace({ focusMin, targetH: g.target, nowMin, startMin: w.startMin, endMin: w.endMin });
  return p.behindMin >= 30 && p.leftMin >= 25 ? { g, focusMin, behindMin: p.behindMin, leftMin: p.leftMin, dayLeftMin: p.dayLeftMin } : null;
}

const dur = (min: number) => {
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};

/**
 * At a natural pause (back from a break, a session just ended), looking ahead: if you're behind an
 * even pace on your focus goal and the calendar has room now, offer a session that fits the room.
 * After a meeting, the "Meeting over" card says it instead.
 */
function focusOffer(m: Moment, now: number): void {
  if (!settings.goals.nudges || sess || (m !== 'back' && m !== 'session-end' && m !== 'arrive')) return;
  if ((goalsData.nudged['focus-offer'] ?? 0) > now) return;
  const b = focusBehind(now);
  if (!b) return;
  const nx = calendar.configured ? calendar.next(now) : undefined;
  const freeMin = nx ? Math.round((nx.start - now) / 60_000) : Math.min(120, b.dayLeftMin);
  if (freeMin < 30) return;
  const min = freeMin >= 60 ? 50 : Math.max(25, Math.floor((freeMin - 5) / 5) * 5);
  goalsData.nudged['focus-offer'] = now + 2 * 3_600_000;
  saveGoals();
  attention.offer(
    {
      key: 'goal:focus',
      kind: 'goal:focus',
      when: 'pause',
      holdMin: 4,
      dropIfStale: true,
      send: () =>
        cardOut({
          kind: 'routine',
          toastKind: 'routine',
          tag: 'goal:focus',
          title: 'Room for focus',
          body: `${hrs(b.focusMin)} of ${hrs(b.g.target * 60)} focused hours so far, about ${dur(b.behindMin)} behind an even pace for today. ${nx ? `You're free until ${clockTime(nx.start)} (“${nx.title}”).` : 'Nothing on your calendar for now.'} ${min} minutes now gets you to ${hrs(b.focusMin + min)}.`,
          autoHideMs: 120_000,
          actions: [{ id: `start-top:${min}`, label: `Lock in for ${min} minutes` }, { id: 'goal-snooze:focus-offer:720', label: 'Not today' }],
        }),
    },
    now,
  );
}

/** Nudges toward your goals, and (once a day at most) something Lock In noticed. All of them go through the gate. */
function goalTick(now: number, busy: boolean, idle: number): void {
  if (!settings.goals.enabled || !rhythm || now - lastGoalTick < 60_000) return;
  lastGoalTick = now;
  const today = dayKey(now);
  const nowMin = minutesOfDay(now, today);
  const calm = !busy && !guard.muted() && !windows.overlayVisible && !coach.active;
  const free = (key: string) => (goalsData.nudged[key] ?? 0) <= now;
  const mark = (key: string, until = now + 86_400_000) => {
    goalsData.nudged[key] = until;
    for (const [k, v] of Object.entries(goalsData.nudged)) if (v < now - 3 * 86_400_000) delete goalsData.nudged[k];
    saveGoals();
  };
  if (settings.goals.nudges) {
    const facts = goalHistory(now).today;
    for (const g of goalsData.goals) {
      if (g.paused || !goalDay(g, today)) continue;
      if (g.kind === 'breaks') {
        const stretch = rhythm.stretchMin(now);
        if (calm && stretch >= g.target && idle < 60 && !sess && free('breaks')) {
          mark('breaks', now + 20 * 60_000);
          attention.offer(
            {
              key: 'goal:breaks',
              kind: 'goal:breaks',
              when: 'soon',
              holdMin: 10,
              dropIfStale: true,
              mootOn: ['back', 'arrive'],
              family: 'move',
              send: () =>
                cardOut({ kind: 'wellness', toastKind: 'wellness', tag: 'goal:breaks', priority: 'low', autoHideMs: 90_000, title: 'Time for a break', body: `You've been at it ${Math.round(rhythm.stretchMin(Date.now()))} minutes. Your goal is a break every ${g.target}: stand up, get water, look out a window.`, actions: [{ id: 'dismiss', label: 'Taking one' }, { id: 'goal-snooze:breaks:15', label: 'In 15 minutes' }] }),
            },
            now,
          );
        }
      } else if (g.kind === 'start') {
        if (calm && nowMin >= g.target + 15 && nowMin <= g.target + 120 && facts.sessions === 0 && !sess && idle < 120 && free(`start:${today}`)) {
          mark(`start:${today}`);
          attention.offer(
            {
              key: 'goal:start',
              kind: 'goal:start',
              when: 'soon',
              holdMin: 30,
              dropIfStale: true,
              send: () => cardOut({ kind: 'routine', toastKind: 'routine', tag: 'goal:start', title: 'Your start goal', body: `Your goal is to be focusing by ${goalClock(g.target)}. Lock in on something small?`, actions: [{ id: 'start-top:25', label: 'Lock in for 25 minutes' }, { id: 'dismiss', label: 'Not yet' }] }),
            },
            now,
          );
        }
      } else if (g.kind === 'bedtime' && calm) {
        // A stop time is a stop time: these skip the gate.
        const target = g.target < 720 ? g.target + 1440 : g.target;
        if (nowMin >= 18 * 60 && nowMin >= target - 15 && nowMin < target && free(`bedtime-soon:${today}`)) {
          mark(`bedtime-soon:${today}`);
          void notifier.notify({ kind: 'wellness', toastKind: 'wellness', title: 'Wind down', body: `15 minutes to your goal: off the computer by ${goalClock(g.target)}.`, actions: [{ id: 'mute-until-morning', label: 'Wrap up now' }, { id: 'dismiss', label: 'Okay' }] });
        } else if (nowMin >= target && nowMin <= target + 60 && idle < 60 && free(`bedtime-past:${today}`)) {
          mark(`bedtime-past:${today}`);
          void notifier.notify({ kind: 'bedtime', toastKind: 'bedtime', title: 'Past your stop time', body: `It's ${goalClock(nowMin)}. Your goal was to be off by ${goalClock(g.target)}.`, actions: [{ id: 'mute-until-morning', label: "I'm done for today" }, { id: 'dismiss', label: '10 more minutes' }] });
        }
      }
    }
  }
  // Big goals: once a day, at a natural pause, a check-in on each one you haven't moved forward yet.
  if (settings.goals.nudges && nowMin >= 10 * 60 && nowMin < 19 * 60 + 30 && !attention.waiting().some((k) => k.startsWith('big:'))) {
    const { today: f } = goalHistory(now);
    const open = todos.openRanked().map((t) => t.title);
    const due = bigGoals().filter((g) => g.daily !== false && goalDay(g, today) && goalsData.checkin[g.id] !== today && !f.checked.includes(g.id) && !movedItems(g, f.items).length);
    // The one you've gone longest without moving forward.
    const lastMoved = (g: Goal) => Math.max(0, ...(goalsData.checks[g.id] ?? []).map((d) => new Date(`${d}T12:00:00`).getTime()));
    const g = due.sort((a, b) => lastMoved(a) - lastMoved(b))[0];
    if (g) {
      const next = open.find((t) => matches(t, termsOf(g)));
      const left = daysLeftText(daysLeft(today, g.until));
      const r = attention.offer(
        {
          key: `big:${g.id}`,
          kind: 'goal:big',
          when: 'pause',
          holdMin: Math.max(5, 20 * 60 - nowMin),
          dropIfStale: true,
          send: () => {
            goalsData.checkin[g.id] = dayKey(Date.now());
            saveGoals();
            return cardOut({
              kind: 'routine',
              toastKind: 'routine',
              tag: `big:${g.id}`,
              title: g.title ?? 'Your goal',
              body: `${left ? `${left}. ` : ''}Nothing on it yet today.${next ? ` Next on your list: “${next}”.` : ' What’s one small step you could take?'}`,
              actions: [{ id: `start:25:${next ?? g.title ?? ''}`, label: next ? 'Lock in on it' : 'Lock in for 25 min' }, { id: `goal-moved:${g.id}`, label: 'Already did something' }, { id: `goal-today:${g.id}`, label: 'Not today' }],
            });
          },
        },
        now,
      );
      if (r === 'skipped') {
        goalsData.checkin[g.id] = today;
        saveGoals();
      }
    }
  }
  // "Is Lock In one of your cool side products?": one question a day at most, at a natural pause.
  if (settings.goals.suggest && bigGoals().length && nowMin >= 10 * 60 && nowMin < 20 * 60) {
    void guessLinks(now);
    if (goalsData.askedDay !== today && !attention.waiting().includes('ask')) {
      const { today: f, past } = goalHistory(now);
      // A question gets one card every few days at most; the Goals page always has them all.
      const q = goalQuestions(f, past).find((x) => (goalsData.pinged[x.id] ?? 0) < now - 3 * 86_400_000);
      if (q) {
        const names = q.goalIds.map((id) => goalsData.goals.find((x) => x.id === id)).filter(Boolean) as Goal[];
        const trim = (t = '', n = 26) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
        const r = attention.offer(
          {
            key: 'ask',
            kind: 'goal:ask',
            when: 'pause',
            holdMin: Math.max(5, 20 * 60 - nowMin),
            dropIfStale: true,
            send: () => {
              goalsData.askedDay = dayKey(Date.now());
              goalsData.pinged[q.id] = Date.now();
              saveGoals();
              return cardOut({
                kind: 'routine',
                toastKind: 'routine',
                tag: 'ask',
                title: q.text,
                body: q.evidence,
                actions:
                  names.length === 1
                    ? [{ id: `goal-yes:${q.id}`, label: 'Yes, it counts' }, { id: `goal-no:${q.id}`, label: 'No' }]
                    : [...names.slice(0, 2).map((g) => ({ id: `goal-link:${q.id}:${g.id}`, label: trim(g.title) })), { id: `goal-no:${q.id}`, label: 'Neither' }],
              });
            },
          },
          now,
        );
        if (r === 'skipped') {
          goalsData.askedDay = today;
          saveGoals();
        }
      }
    }
  }
  reseedWithCoach();
  // Something Lock In noticed: one a day at most, at a natural pause, never the same one twice in two weeks.
  if (settings.goals.suggest && goalsData.lastPingDay !== today && nowMin >= 10 * 60 && nowMin < 20 * 60 && !attention.waiting().includes('noticed')) {
    const s = goalsView(now).suggestions.find((x) => x.source === 'noticed' && (goalsData.pinged[x.id] ?? 0) < now - 14 * 86_400_000);
    if (s) {
      const r = attention.offer(
        {
          key: 'noticed',
          kind: 'noticed',
          when: 'pause',
          // Waits for a pause until 8 pm, then lets it go until tomorrow.
          holdMin: Math.max(5, 20 * 60 - nowMin),
          dropIfStale: true,
          send: () => {
            goalsData.pinged[s.id] = Date.now();
            goalsData.lastPingDay = dayKey(Date.now());
            saveGoals();
            return cardOut({ kind: 'routine', toastKind: 'routine', tag: 'noticed', title: 'Lock In noticed something', body: s.goalId ? `${s.evidence} Change it to “${s.name}”?` : `${s.evidence} Want to try “${s.name}”?`, actions: [{ id: `goal-accept:${s.id}`, label: s.goalId ? 'Change it' : 'Make it a goal' }, { id: 'open:goals', label: 'See why' }, { id: `goal-later:${s.id}`, label: 'Not now' }] });
          },
        },
        now,
      );
      // You've let the last few go by: skip today's (it's still on the Goals page).
      if (r === 'skipped') {
        goalsData.lastPingDay = today;
        saveGoals();
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Lock In on your phone

/** What the phone may ask for: the same handlers the Mac's pages use, and nothing that touches keys, settings or files. */
const PHONE_CHANNELS = new Set([
  'state:get', 'session:start', 'session:startQuick', 'session:end', 'mute', 'unmute',
  'todos:get', 'todos:complete', 'todos:add', 'todos:undo', 'deadlines:get',
  'crew:get', 'crew:bomb', 'talk:open',
  'coaches:list', 'coaches:get', 'coaches:create', 'coaches:addText', 'coaches:removeSource', 'coaches:pickSpeaker', 'coaches:retry', 'coaches:distill', 'coaches:use',
  'goals:get', 'goals:water', 'goals:check',
]);

async function phoneCall(method: string, args: unknown[]): Promise<unknown> {
  if (method === 'chat:start') return phoneChat.start();
  if (method === 'chat:say') return phoneChat.say(String(args[0] ?? ''));
  if (method === 'chat:end') {
    phoneChat.end();
    return true;
  }
  const fn = PHONE_CHANNELS.has(method) ? handlers.get(method) : undefined;
  if (!fn) throw new Error("That isn't something the phone can do.");
  return fn({} as Electron.IpcMainInvokeEvent, ...args);
}

function phoneFile(name: string): string | null {
  if (name.startsWith('fonts/')) return join(distDir, 'renderer', name);
  if (name === 'icon.png') return assetPath('icon.png');
  if (/^phone\.(html|js|css)$/.test(name)) return join(distDir, 'phone', name);
  return null;
}

// Paired phones' keys are locked with this Mac's keychain, like API keys (and never go into backups).
const lockSecret = (v: string) => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(v).toString('base64')}` : v);
function unlockSecret(v: string): string {
  if (!v.startsWith('enc:')) return v;
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  } catch {
    return '';
  }
}
const phoneDevices = {
  load: (): PhoneDevice[] => store.readJson<PhoneDevice[]>('phone-devices.json', []).map((d) => ({ ...d, key: unlockSecret(d.key) })).filter((d) => d.key),
  save: (list: PhoneDevice[]) => store.writeJson('phone-devices.json', list.map((d) => ({ ...d, key: lockSecret(d.key) }))),
};

let macName = '';
function computerName(): Promise<string> {
  if (macName || process.platform !== 'darwin') return Promise.resolve(macName || 'your Mac');
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) =>
      execFile('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 3000 }, (err, out) => {
        macName = err ? 'your Mac' : String(out).trim() || 'your Mac';
        resolve(macName);
      }),
    );
  });
}

async function setPhone(on: boolean): Promise<void> {
  if (on) {
    if (phone?.running) return;
    await computerName();
    phone = new PhoneServer({
      port: SMOKE ? Number(process.env.LOCKIN_PHONE_PORT) || undefined : undefined,
      file: phoneFile,
      devices: phoneDevices,
      call: (m, a) => phoneCall(m, a),
      blob: (kind, id) => (kind === 'audio' ? phoneChat.sound(id) : null),
      upload: async (coach, path) => ({ ...coaches.addFiles(coach, [path]), view: coachView(coach) }),
      uploadDir: join(store.dir, 'phone-uploads'),
      onChange: () => windows.sendMain('phone:update', null),
      log,
      macName: () => macName || 'your Mac',
    });
    await phone.start();
  } else if (phone) {
    phone.stop();
    phone = null;
    phoneChat?.end();
  }
}

async function phoneStatus() {
  const running = !!phone?.running;
  let urls: string[] = [];
  if (running && phone) {
    const name = await bonjourName();
    urls = [...(name ? [`http://${name}.local:${phone.port}`] : []), ...lanAddresses().map((ip) => `http://${ip}:${phone!.port}`)];
  }
  return {
    enabled: settings.phone.enabled,
    running,
    error: phone?.error ?? '',
    urls,
    qr: urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 360, color: { dark: '#101820', light: '#ffffff' } }) : '',
    pairing: phone?.pairingInfo ?? null,
    devices: phone ? phone.list() : phoneDevices.load().map(({ key: _k, ...d }) => d),
  };
}

function setupPhoneIpc(): void {
  handle('phone:status', () => phoneStatus());
  handle('phone:enable', async (_e, on: boolean) => {
    settings = { ...settings, phone: { ...settings.phone, enabled: !!on } };
    store.saveSettings(settings);
    await setPhone(!!on);
    return phoneStatus();
  });
  handle('phone:pair', async () => {
    if (!phone?.running) await setPhone(true);
    phone?.startPairing();
    return phoneStatus();
  });
  handle('phone:cancelPair', () => {
    phone?.cancelPairing();
    return phoneStatus();
  });
  handle('phone:remove', (_e, id: string) => {
    if (phone) phone.remove(String(id));
    else phoneDevices.save(phoneDevices.load().filter((d) => d.id !== id));
    return phoneStatus();
  });
}

function warmAgent(): void {
  if (!store.getKey('elevenlabs')) {
    talkError = '';
    return;
  }
  agent
    .ensure()
    .then(() => {
      talkError = '';
    })
    .catch((e: Error) => {
      talkError = e.message;
      log(`[talk] ${e.message}`);
    });
}

function pushState(): void {
  const st = liveState();
  windows.sendMain('state', st);
  windows.sendPanel('state', st);
  updateTray(st);
}

// -----------------------------------------------------------------------------
// The menu bar panel: everything day to day lives under the menu bar icon, and the window
// opens only for settings (Settings, "Menu bar panel"). The classic window and menu are one switch away.

const panelMode = () => (settings?.ui ?? 'panel') === 'panel';

/** Where the menu bar icon is, so the panel opens under it. */
function trayBounds(): Rectangle | undefined {
  try {
    const b = tray?.getBounds();
    return b && b.width > 0 ? b : undefined;
  } catch {
    return undefined;
  }
}

function showPanel(): void {
  windows.showPanel(trayBounds());
}

/** Opens a page of the app. With the panel, "Lock in" and "Progress" are the panel itself. */
function openPage(route?: string): void {
  const page = (route ?? '').split('#')[0];
  if (panelMode() && (!page || page === 'home' || page === 'progress' || page === 'today' || page === 'dashboard')) {
    showPanel();
    return;
  }
  windows.hidePanel();
  windows.openMain(route);
}

/** The panel's lists: today's numbers, the next to-dos, goals at a glance, and the crew. */
function panelData(): PanelData {
  const now = Date.now();
  const dash = buildDashboard(store, sess?.record ?? null);
  const sum = todos.summary();
  let goals: PanelData['goals'] = [];
  let water = 0;
  if (settings.goals.enabled) {
    const gv = goalsView(now);
    water = gv.now.water;
    goals = gv.goals
      .filter((g) => !g.paused)
      .slice(0, 4)
      .map((g) => ({ id: g.id, kind: g.kind, name: g.name, progress: g.progress, pct: g.pct, tone: g.tone, daysLeft: g.daysLeft }));
  }
  const cv = crew.view();
  return {
    today: { focusMin: Math.round(dash.todayFocusMin), sessions: dash.todaySessions, streak: streakOf(store.sessions(), now) },
    todos: { open: sum.connected || sum.provider === 'none' ? todos.openRanked().slice(0, 6) : [], canAdd: sum.canAdd, canComplete: sum.canComplete },
    goals,
    water,
    crew: cv.joined ? cv : null,
    commitment: settings.commitmentMode,
  };
}

/** Panel or classic window: the Dock icon, the menu bar menu, and what's open. */
function applyUi(): void {
  windows.mainTitle = panelMode() ? 'Lock In Settings' : 'Lock In';
  if (windows.main && !windows.main.isDestroyed()) windows.main.setTitle(windows.mainTitle);
  if (process.platform === 'darwin' && app.dock) {
    // With the panel, Lock In lives in the menu bar; the Dock icon shows only while Settings is open.
    if (panelMode() && !(windows.main && !windows.main.isDestroyed())) app.dock.hide();
    else void app.dock.show();
  }
  if (!panelMode()) windows.hidePanel();
  trayMenuSig = '';
  if (tray) updateTray(liveState());
}

/** Right-click on the icon (with the panel): the few things that aren't in it. */
function trayExtrasMenu(): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Lock In', click: () => showPanel() },
    { label: 'Talk to Lock In…', accelerator: 'CommandOrControl+Shift+Space', click: () => startTalk('checkin') },
    { label: 'Settings…', click: () => openPage('settings') },
    { type: 'separator' },
    ...(isInstalledApp() ? [{ label: 'Open at login', type: 'checkbox' as const, checked: app.getLoginItemSettings().openAtLogin, click: (item: Electron.MenuItem) => setOpenAtLogin(item.checked) }] : []),
    { label: 'Quit Lock In', role: 'quit' },
  ]);
}

// -----------------------------------------------------------------------------
// Tray, shortcuts, schedule

function fmt(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function statusDot(st: LiveState): string {
  if (!st.session) return '';
  if (st.session.onBreakUntil) return '☕';
  if (st.muteUntil) return '🔇';
  const l = st.session.level;
  if (l >= 3) return '🔴';
  if (l === 2) return '🟠';
  if (l === 1 || st.session.drift > st.session.driftThresholdSec * 0.1) return '🟡';
  return '🟢';
}

function updateTray(st: LiveState): void {
  if (!tray) return;
  if (process.platform === 'darwin') {
    const flashing = Date.now() < flashUntil;
    const normal = st.session
      ? ` ${statusDot(st)} ${fmt(st.session.plannedMin * 60 - st.session.elapsedSec)}`
      : st.lockout
        ? ` 💣 ${fmt((st.lockout.until - Date.now()) / 1000)}`
        : '';
    tray.setTitle(flashing ? (Math.floor(Date.now() / 600) % 2 ? ` ${flashText}` : normal || ' ') : normal);
  }
  const td = st.todos;
  if (panelMode()) {
    // The icon opens the panel (setupTray); no menu, or a click would show it instead.
    if (trayMenuSig !== 'panel') {
      tray.setContextMenu(null);
      trayMenuSig = 'panel';
    }
    return;
  }
  const sig = JSON.stringify([!!st.session, st.session?.goal, !!st.muteUntil, !!st.session?.onBreakUntil, st.lastGoal, td.provider, td.open, td.doneToday, td.top, st.deadlines.pinned.map((d) => d.id)]);
  if (sig === trayMenuSig) return;
  trayMenuSig = sig;
  const goal = st.lastGoal || 'Deep work';
  const listItems: Electron.MenuItemConstructorOptions[] =
    td.provider !== 'none' && td.connected
      ? [
          { label: `${td.open} to go, ${td.doneToday} done today`, enabled: false },
          ...(td.top && !st.session ? [{ label: `Lock in on: ${td.top.length > 48 ? `${td.top.slice(0, 47)}…` : td.top}`, click: () => startSession(td.top!, 50) }] : []),
          { label: 'To-dos…', click: () => windows.openMain('todos') },
          { type: 'separator' },
        ]
      : [];
  const template: Electron.MenuItemConstructorOptions[] = st.session
    ? [
        { label: `Locked in: ${st.session.goal || 'Deep work'}`, enabled: false },
        { type: 'separator' },
        { label: 'End session', click: () => (settings.commitmentMode ? windows.openMain('home') : endSession('user')) },
        st.muteUntil ? { label: 'Unmute coach', click: () => guard.unmute() } : { label: 'Mute coach for 30 minutes', click: () => guard.mute(30) },
      ]
    : [
        { label: `Lock in: "${goal}"`, enabled: false },
        { label: '25 minutes', click: () => startSession(goal, 25) },
        { label: '50 minutes', click: () => startSession(goal, 50) },
        { label: '90 minutes', click: () => startSession(goal, 90) },
        { label: 'New goal…', click: () => windows.openMain('home') },
      ];
  const pinnedItems: Electron.MenuItemConstructorOptions[] = st.deadlines.pinned.length
    ? [
        ...st.deadlines.pinned.slice(0, 4).map((d): Electron.MenuItemConstructorOptions => ({
          label: `📌 ${d.overdue ? 'Overdue' : 'Due today'}: ${d.title.length > 40 ? `${d.title.slice(0, 39)}…` : d.title}`,
          submenu: [
            { label: 'Lock in on it', click: () => startSession(d.title, 50) },
            { label: 'Mark it done', click: () => setDeadlineDone(d.id, true) },
          ],
        })),
        { type: 'separator' },
      ]
    : [];
  template.unshift(...pinnedItems, ...listItems);
  template.push(
    { type: 'separator' },
    ...(settings.goals.enabled
      ? [
          { label: '💧 Drank a glass of water', click: () => void runAction('water') },
          { label: 'Goals…', click: () => windows.openMain('goals') },
        ]
      : []),
    { label: 'Talk to Lock In…', accelerator: 'CommandOrControl+Shift+Space', click: () => startTalk('checkin') },
    { label: 'Open Lock In', accelerator: 'CommandOrControl+Shift+L', click: () => windows.openMain() },
    { label: 'Progress', click: () => windows.openMain('progress') },
    { label: 'Settings', click: () => windows.openMain('settings') },
    { type: 'separator' },
    ...(isInstalledApp() ? [{ label: 'Open at login', type: 'checkbox' as const, checked: app.getLoginItemSettings().openAtLogin, click: (item: Electron.MenuItem) => setOpenAtLogin(item.checked) }] : []),
    { label: 'Quit Lock In', role: 'quit' },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function setOpenAtLogin(on: boolean): void {
  if (!isInstalledApp()) return;
  try {
    app.setLoginItemSettings({ openAtLogin: on });
  } catch (e) {
    log(`[login] ${(e as Error).message}`);
  }
  trayMenuSig = '';
  pushState();
}

/**
 * New menu bar icons appear at the left end of the icons, which on a MacBook with a notch is
 * often behind the camera. The first time, ask macOS to place ours near the right instead.
 * (After that, wherever you drag it with ⌘ held is remembered.)
 */
function placeTrayIcon(): void {
  if (process.platform !== 'darwin') return;
  const flag = store.readJson<{ placed?: boolean }>('menubar.json', {});
  if (flag.placed) return;
  try {
    systemPreferences.setUserDefault('NSStatusItem Preferred Position Item-0', 'float', 260);
  } catch (e) {
    log(`[tray] could not set position: ${(e as Error).message}`);
  }
  store.writeJson('menubar.json', { placed: true });
}

function setupTray(): void {
  const iconPath = assetPath('trayTemplate.png');
  const img = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (process.platform === 'darwin') img.setTemplateImage(true);
  placeTrayIcon();
  try {
    tray = new Tray(img);
    tray.setToolTip('Lock In');
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', (_e, bounds) => {
      if (panelMode()) windows.togglePanel(bounds);
    });
    tray.on('right-click', () => {
      if (!panelMode()) return;
      windows.hidePanel();
      tray?.popUpContextMenu(trayExtrasMenu());
    });
  } catch (e) {
    log(`[tray] unavailable: ${(e as Error).message}`);
  }
}

function setupShortcuts(): void {
  const reg = (acc: string, fn: () => void) => {
    try {
      if (!globalShortcut.register(acc, fn)) log(`[shortcut] ${acc} is taken by another app`);
    } catch {
      /* ignore */
    }
  };
  reg('CommandOrControl+Shift+L', () => (panelMode() ? windows.togglePanel(trayBounds()) : windows.openMain('home')));
  reg('CommandOrControl+Shift+Space', toggleTalk);
  reg('CommandOrControl+Shift+M', () => {
    if (guard.muted()) guard.unmute();
    else {
      guard.mute(30);
      coach.silence();
      windows.showToast({ kind: 'info', title: 'Coach muted', body: 'Silent for 30 minutes. Press ⌘⇧M again to unmute.', autoHideMs: 4000 });
    }
    pushState();
  });
}

// -----------------------------------------------------------------------------
// Notification channels that need Electron

const SYNTH_MS: Partial<Record<SoundId, number>> = { whistle: 500, airhorn: 1400, buzzer: 850, chime: 950, ding: 750, sad_trombone: 2500, fanfare: 1500 };

function playSound(id: SoundId): Promise<void> {
  if (id === 'none') return Promise.resolve();
  const ms = SYNTH_MS[id];
  if (ms !== undefined) {
    windows.voice?.webContents.send('voice:sound', { id, volume: settings.volumeCap });
    return new Promise((r) => setTimeout(r, ms));
  }
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise((resolve) => {
    const p = spawn('afplay', ['-v', String(Math.max(0.1, settings.volumeCap)), `/System/Library/Sounds/${id}.aiff`]);
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

function systemNotify(title: string, body: string, critical: boolean): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: true, urgency: critical ? 'critical' : 'normal' });
  n.on('click', () => openPage());
  n.show();
  systemNotes.push(n);
  if (systemNotes.length > 20) systemNotes.shift();
}

function dockAlert(critical: boolean): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.bounce(critical ? 'critical' : 'informational');
  app.dock.setBadge('!');
}

function muteUntilMorning(): void {
  const d = new Date();
  if (d.getHours() >= 5) d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  guard.muteUntil = d.getTime();
  coach.silence();
}

/** Buttons on corner cards and notice cards. */
async function runAction(id: string): Promise<void> {
  const card = windows.currentToast();
  if (card?.tag) attention.resolve(card.tag, outcomeOf(id), Date.now());
  windows.hideToast();
  if (!coach.active) windows.hideOverlay();
  const [verb, ...rest] = id.split(':');
  switch (verb) {
    case 'start': {
      const [min, ...goal] = rest;
      startSession(goal.join(':') || appState.lastGoal || 'Deep work', Number(min) || 50);
      break;
    }
    case 'start-top':
      startSession(todos.top()?.title ?? (appState.lastGoal || 'Deep work'), Number(rest[0]) || 50);
      break;
    case 'snooze':
      scheduler.snooze(rest[0], Number(rest[1]) || 15, Date.now());
      break;
    case 'snooze-roasts':
      todos.snooze(Number(rest[0]) || 30);
      break;
    case 'bed':
      scheduler.stopFollowUps(rest[0]);
      muteUntilMorning();
      break;
    case 'mute-until-morning':
      muteUntilMorning();
      break;
    case 'open':
      openPage(rest[0]);
      break;
    case 'complete':
      await todos.complete(rest.join(':')).catch((e: Error) => log(`[todos] ${e.message}`));
      break;
    case 'route':
      await coach.choose(rest[0] as RouteOption, 'button');
      break;
    case 'talk':
      startTalk((rest[0] as Situation) || 'checkin');
      break;
    case 'deadline':
      if (rest[0] === 'done' && rest[1]) setDeadlineDone(rest[1], true);
      break;
    case 'crew':
      // "Bomb them back": the Friends page, aimed at whoever bombed you.
      if (rest[0] === 'back' && rest[1]) {
        if (panelMode()) showPanel();
        else windows.openMain(`friends#aim-${rest[1]}`);
      }
      break;
    case 'water': {
      const n = rhythm.logWater(Date.now());
      windows.showToast({ kind: 'info', title: 'Water logged', body: `${n} ${n === 1 ? 'glass' : 'glasses'} today.`, autoHideMs: 2500 });
      break;
    }
    case 'goal-accept': {
      const sug = goalsView().suggestions.find((x) => x.id === rest[0]);
      if (sug) acceptSuggestion(sug);
      windows.openMain('goals');
      break;
    }
    case 'goal-later':
      goalsData.memo[rest[0]] = { until: Date.now() + 7 * 86_400_000 };
      saveGoals();
      break;
    case 'goal-snooze':
      goalsData.nudged[rest[0]] = Date.now() + (Number(rest[1]) || 15) * 60_000;
      saveGoals();
      break;
    // Big goals: "Already did something", "Not today", and answers to "Is X part of Y?".
    case 'goal-moved': {
      const today = dayKey(Date.now());
      const days = new Set(goalsData.checks[rest[0]] ?? []);
      days.add(today);
      goalsData.checks[rest[0]] = [...days].sort().slice(-400);
      saveGoals();
      const g = goalsData.goals.find((x) => x.id === rest[0]);
      if (g) windows.showToast({ kind: 'win', title: 'Noted', body: `You moved “${g.title}” forward today.`, autoHideMs: 3000 });
      break;
    }
    case 'goal-today':
      goalsData.checkin[rest[0]] = dayKey(Date.now());
      saveGoals();
      break;
    case 'goal-yes':
    case 'goal-link': {
      const { today, past } = goalHistory(Date.now());
      const q = goalQuestions(today, past).find((x) => x.id === rest.slice(0, verb === 'goal-link' ? -1 : undefined).join(':'));
      const goalId = verb === 'goal-link' ? rest[rest.length - 1] : q?.goalIds[0];
      if (q && goalId && answerQuestion(q.id, goalId)) {
        const g = goalsData.goals.find((x) => x.id === goalId);
        windows.showToast({ kind: 'win', title: 'Got it', body: `“${q.term}” counts toward “${g?.title}” from now on.`, autoHideMs: 3500 });
      }
      break;
    }
    case 'goal-no':
      answerQuestion(rest.join(':'), null);
      break;
    case 'url': {
      const url = decodeURIComponent(rest.join(':'));
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      break;
    }
  }
  pushState();
}

// -----------------------------------------------------------------------------
// Setup helpers

function installedApps(): string[] {
  if (process.platform !== 'darwin') return [];
  const dirs = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')];
  const names = new Set<string>();
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith('.app')) names.add(f.slice(0, -4));
    } catch {
      /* missing folder */
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Chrome-family browsers on this Mac, most common first, with their extensions page. */
/** The onboarding smoke test runs on Linux: it pretends to be a Mac for setup's last screen. */
const FAKE_MAC = SMOKE && !!process.env.LOCKIN_ONBOARD && process.platform !== 'darwin';

function installedBrowsers(): { id: string; name: string; bin: string; url: string }[] {
  if (FAKE_MAC) return [{ id: 'chrome', name: 'Chrome', bin: '/bin/true', url: 'chrome://extensions' }, { id: 'arc', name: 'Arc', bin: '/bin/true', url: 'chrome://extensions' }];
  if (process.platform !== 'darwin') return [];
  const known = [
    { id: 'chrome', name: 'Chrome', app: 'Google Chrome', url: 'chrome://extensions' },
    { id: 'arc', name: 'Arc', app: 'Arc', url: 'chrome://extensions' },
    { id: 'brave', name: 'Brave', app: 'Brave Browser', url: 'brave://extensions' },
    { id: 'edge', name: 'Edge', app: 'Microsoft Edge', url: 'edge://extensions' },
  ];
  const out: { id: string; name: string; bin: string; url: string }[] = [];
  for (const k of known) {
    for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
      const bin = join(dir, `${k.app}.app`, 'Contents', 'MacOS', k.app);
      if (existsSync(bin)) {
        out.push({ id: k.id, name: k.name, bin, url: k.url });
        break;
      }
    }
  }
  return out;
}

function setupStatus(): SetupStatus {
  const mac = process.platform === 'darwin';
  if (FAKE_MAC) return { platform: 'darwin', accessibility: 'missing', microphone: 'not-determined', helperBuilt: true, helperRunning: false, extensionConnected: false, extensionPath: extensionPath(), keys: store.keyStatus(), installed: true, openAtLogin: false };
  return {
    platform: process.platform,
    accessibility: mac ? (systemPreferences.isTrustedAccessibilityClient(false) || helper.accessibility ? 'granted' : 'missing') : 'n/a',
    microphone: mac ? systemPreferences.getMediaAccessStatus('microphone') : 'n/a',
    helperBuilt: helper.built,
    helperRunning: helper.running,
    extensionConnected: bridge.connected,
    extensionOutdated: bridge.outdated,
    extensionPath: extensionPath(),
    keys: store.keyStatus(),
    installed: isInstalledApp(),
    openAtLogin: isInstalledApp() ? app.getLoginItemSettings().openAtLogin : false,
  };
}

// -----------------------------------------------------------------------------
// IPC

/** Every handler the Mac's pages use, by channel. The phone may call a few of them (PHONE_CHANNELS). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (e: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown;
const handlers = new Map<string, Handler>();
function handle(channel: string, fn: Handler): void {
  handlers.set(channel, fn);
  ipcMain.handle(channel, fn);
}

function setupIpc(): void {
  setupCoachIpc();
  setupPhoneIpc();
  setupGoalsIpc();
  handle('state:get', () => liveState());
  handle('profile:get', () => profile);
  handle('profile:save', (_e, p: Profile) => {
    profile = p;
    store.saveProfile(p);
    sess?.engine.setTolerance(p.toleranceMin);
    applyCoach();
    pushState();
    return true;
  });
  handle('quiz:installedApps', () => installedApps());
  handle('quiz:apps', () => appUsage());
  handle('settings:get', () => settings);
  handle('settings:save', (_e, s: Partial<Settings>) => {
    const voiceChanged = s.voiceId !== undefined && s.voiceId !== settings.voiceId;
    if (voiceChanged && s.voiceName === undefined) s = { ...s, voiceName: undefined };
    settings = { ...settings, ...s };
    store.saveSettings(settings);
    if (s.calendar) void calendar.refresh(true).then(() => pushState());
    if (s.talk) holdSpace.setActive(process.platform === 'darwin' && settings.talk.holdSpace !== false);
    if (voiceChanged) warmAgent();
    agentKey = `${coachVoiceId()}|${agentLanguage()}`;
    if (s.ui !== undefined) {
      applyUi();
      pushState();
    }
    return settings;
  });
  // The menu bar panel
  handle('panel:data', () => panelData());
  handle('panel:hide', () => windows.hidePanel());
  handle('panel:resize', (_e, height: number) => windows.resizePanel(Math.max(120, Math.min(2000, Number(height) || 0))));
  handle('panel:open', (_e, route?: string) => openPage(typeof route === 'string' && route ? route : 'settings'));
  handle('app:quit', () => app.quit());
  // Setup is done: the window goes, the panel opens under the padlock.
  handle('panel:show', () => {
    if (windows.main && !windows.main.isDestroyed()) windows.main.close();
    setTimeout(showPanel, 350);
  });
  handle('keys:save', (_e, k: { anthropic?: string; elevenlabs?: string; todoist?: string }) => {
    if (k.anthropic !== undefined) store.setKey('anthropic', k.anthropic);
    if (k.elevenlabs !== undefined) {
      store.setKey('elevenlabs', k.elevenlabs);
      warmAgent();
    }
    if (k.todoist !== undefined) {
      store.setKey('todoist', k.todoist);
      void todos.refresh(true).then(() => pushState());
    }
    pushState();
    return store.keyStatus();
  });
  handle('session:start', (_e, a: { goal: string; minutes: number; pomodoro?: boolean }) => {
    startSession(a.goal, Math.max(5, Math.min(240, Math.round(a.minutes))), { pomodoro: !!a.pomodoro });
    return true;
  });
  handle('action:run', (_e, id: string) => runAction(String(id)));
  handle('todos:get', () => ({ summary: todos.summary(), open: todos.openRanked().slice(0, 100), done: todos.doneToday().slice(0, 50) }));
  handle('todos:undo', async (_e, id: string) => {
    const ok = await todos.undo(String(id));
    pushState();
    return ok;
  });
  handle('todos:refresh', async () => {
    await todos.refresh(true);
    pushState();
    return { summary: todos.summary(), open: todos.openRanked().slice(0, 100) };
  });
  handle('todos:complete', async (_e, id: string) => {
    try {
      const ok = await todos.complete(String(id));
      return { ok };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      pushState();
    }
  });
  handle('todos:add', async (_e, title: string) => {
    try {
      const ok = await todos.add(String(title).slice(0, 300));
      return { ok };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      pushState();
    }
  });
  handle('todos:sheetPreview', (_e, c: SheetSettings) => todos.previewSheet({ ...settings.todo.sheet, ...c }));
  handle('todos:pickSheetFile', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose your to-do spreadsheet',
      properties: ['openFile'],
      filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'numbers', 'csv', 'tsv'] }],
    };
    const r = windows.main ? await dialog.showOpenDialog(windows.main, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  handle('todos:connectorScript', () =>
    todos.connectorScript((token) => {
      settings = { ...settings, todo: { ...settings.todo, sheet: { ...settings.todo.sheet, token } } };
      store.saveSettings(settings);
    }),
  );
  handle('todos:hide', async (_e, id: string) => {
    const key = todos.hideKeyFor(String(id));
    if (!key) return false;
    const hidden = [...new Set([...(settings.todo.hidden ?? []), key])].slice(-500);
    settings = { ...settings, todo: { ...settings.todo, hidden } };
    store.saveSettings(settings);
    await todos.refresh(true);
    pushState();
    return true;
  });
  handle('todos:unhide', async () => {
    settings = { ...settings, todo: { ...settings.todo, hidden: [] } };
    store.saveSettings(settings);
    await todos.refresh(true);
    pushState();
    return true;
  });
  handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text)));
  handle('todos:remove', async (_e, id: string) => {
    await todos.removeBuiltin(String(id));
    pushState();
  });
  handle('todos:roastTest', async (_e, severity: 1 | 2 | 3) => {
    const s = todos.summary();
    await announcer.todoEvent({ type: 'roast', severity, activeMin: Math.max(s.activeMinToday, 154), sinceProgressMin: Math.max(s.minSinceProgress, 100), open: s.open || 6, overdue: s.overdue, done: s.doneToday, top: todos.top() ?? { id: 'x', title: 'Finish the pitch deck', completed: false } });
  });
  handle('routines:get', () => routines);
  handle('routines:save', (_e, list: Routine[]) => {
    routines = Array.isArray(list) ? list : routines;
    store.saveRoutines(routines);
    return routines;
  });
  handle('routines:test', async (_e, id: string) => {
    const r = routines.find((x) => x.id === id);
    if (r) await announcer.routine(r, 0);
  });
  handle('notify:test', (_e, ch: Channel) => notifier.test(ch));
  handle('sound:test', (_e, id: SoundId) => playSound(id));
  handle('session:startQuick', () => {
    startSession(todos.top()?.title ?? (appState.lastGoal || 'Deep work'), 50);
    return true;
  });
  handle('session:end', () => {
    endSession('user');
    return true;
  });
  handle('dashboard:get', (): DashboardData => buildDashboard(store, sess?.record ?? null));
  handle('labels:list', () => classifier.cache);
  handle('labels:set', (_e, a: { key: string; label: 'work' | 'neutral' | 'distraction' | null }) => {
    classifier.setKey(a.key, a.label);
    return classifier.cache;
  });
  handle('labels:current', (_e, label: 'work' | 'neutral' | 'distraction') => {
    const target = isSelf(current) ? lastExternal : current;
    if (target && !isSelf(target)) {
      classifier.setUserLabel(target, label);
      lastExternal = classifier.classify(target);
      if (label === 'work') sess?.engine.acknowledge();
    }
    pushState();
    return true;
  });
  handle('coach:choose', (_e, option: RouteOption) => coach.choose(option, 'button'));
  handle('coach:reply', (_e, text: string) => coach.reply(String(text).slice(0, 500), 'typed'));
  handle('coach:talk', () => coach.pushToTalk());
  handle('talk:open', (_e, situation?: string) => startTalk((situation as Situation) || 'checkin'));
  handle('talk:tool', (_e, name: string, params: Record<string, unknown>) => talk.tool(String(name), params && typeof params === 'object' ? params : {}));
  handle('talk:text', (_e, text: string) => talk.text(String(text).slice(0, 2000)));
  handle('talk:closed', () => {
    talk.closed();
    pushState();
  });
  handle('talk:transcript', (_e, role: string, text: string) => talk.transcript(role === 'user' ? 'user' : 'agent', String(text).slice(0, 2000)));
  handle('talk:status', () => ({ voice: talk.voiceReady, error: talkError, holdSpace: holdSpace.status }));
  handle('calendar:get', () => ({ events: calendar.upcoming(), summary: calendar.summary(), agenda: calendar.agenda(), lastFetch: calendar.lastFetch }));
  handle('calendar:test', async (_e, url: string) => {
    try {
      const now = Date.now();
      const ev = await fetchIcs(String(url), now - 86_400_000, now + 7 * 86_400_000, fetch);
      const next = ev.find((e) => e.start > now && !e.allDay);
      return { ok: true, count: ev.length, next: next ? `${next.title}, ${new Date(next.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : undefined };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  // The Calendar app on this Mac (your Google account through macOS, iCloud, Outlook…).
  const openPane = (...urls: string[]) => {
    const tryNext = (i: number): void => {
      if (i >= urls.length) return;
      shell.openExternal(urls[i]).catch(() => tryNext(i + 1));
    };
    tryNext(0);
  };
  const macView = async () => {
    const status = await macCal.status();
    if (status === 'granted' && settings.calendar.mac && !macCalendars.length) {
      try {
        macCalendars = (await macCal.read(Date.now(), Date.now() + 86_400_000, settings.calendar.macExclude)).calendars;
      } catch {
        /* shown as an error by the calendar itself */
      }
    }
    return {
      available: macCal.available,
      status,
      on: !!settings.calendar.mac,
      calendars: macCalendars,
      exclude: settings.calendar.macExclude ?? defaultExcluded(macCalendars),
      message: macStatusMessage(status),
    };
  };
  handle('calendar:mac', async (_e, action: string, arg?: unknown) => {
    switch (action) {
      case 'accounts':
        // System Settings → Internet Accounts, where you sign in to Google (macOS 13+, then older).
        openPane('x-apple.systempreferences:com.apple.Internet-Accounts-Settings.extension', 'x-apple.systempreferences:com.apple.preferences.internetaccounts');
        return true;
      case 'privacy':
        openPane('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
        return true;
      case 'connect': {
        const status = await macCal.request();
        if (status !== 'granted') return { ok: false, status, error: macStatusMessage(status) };
        const now = Date.now();
        let r;
        try {
          r = await macCal.read(now - 18 * 3_600_000, now + 8 * 86_400_000, settings.calendar.macExclude);
        } catch (e) {
          return { ok: false, status: 'unknown', error: `Couldn't read the Calendar app: ${(e as Error).message}` };
        }
        macCalendars = r.calendars;
        settings = { ...settings, calendar: { ...settings.calendar, mac: true } };
        store.saveSettings(settings);
        await calendar.refresh(true);
        pushState();
        const next = r.events.find((e) => e.start > now && !e.allDay);
        log(`[mac calendar] connected: ${r.calendars.length} calendars, ${r.events.length} events`);
        return {
          ok: true,
          status,
          calendars: r.calendars.filter((c) => !(settings.calendar.macExclude ?? defaultExcluded(r.calendars)).includes(c.id)).length,
          count: r.events.filter((e) => e.start < now + 7 * 86_400_000).length,
          next: next ? `${next.title}, ${new Date(next.start).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : undefined,
        };
      }
      case 'disconnect':
        settings = { ...settings, calendar: { ...settings.calendar, mac: false } };
        store.saveSettings(settings);
        await calendar.refresh(true);
        pushState();
        return true;
      case 'exclude': {
        const ids = Array.isArray(arg) ? arg.map(String) : [];
        settings = { ...settings, calendar: { ...settings.calendar, macExclude: ids } };
        store.saveSettings(settings);
        await calendar.refresh(true);
        pushState();
        return true;
      }
      default:
        return macView();
    }
  });
  handle('calendar:refresh', async () => {
    await calendar.refresh(true);
    pushState();
    return { events: calendar.upcoming(), summary: calendar.summary(), agenda: calendar.agenda(), lastFetch: calendar.lastFetch };
  });
  const deadlineList = () => deadlines.all().map((d) => ({ ...d, overdue: !d.done && isOverdue(d, Date.now()) }));
  handle('deadlines:get', () => deadlineList());
  handle('deadlines:add', (_e, p: { title: string; due: string; time?: string }) => {
    if (!p?.title?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.due))) return deadlineList();
    deadlines.add({ title: String(p.title), due: String(p.due), time: /^\d{2}:\d{2}$/.test(String(p.time ?? '')) ? String(p.time) : undefined });
    pushState();
    return deadlineList();
  });
  handle('deadlines:update', (_e, id: string, patch: Partial<Pick<Deadline, 'title' | 'due' | 'time'>>) => {
    deadlines.update(String(id), patch ?? {});
    pushState();
    return deadlineList();
  });
  handle('deadlines:done', (_e, id: string, done: boolean) => {
    setDeadlineDone(String(id), done !== false);
    return deadlineList();
  });
  handle('deadlines:remove', (_e, id: string) => {
    deadlines.remove(String(id));
    pushState();
    return deadlineList();
  });
  handle('deadlines:fromTask', (_e, taskId: string) => {
    const t = todos.openRanked().find((x) => x.id === taskId);
    if (t?.due && !deadlines.open().some((d) => d.taskId === t.id)) deadlines.add({ title: t.title, due: t.due, taskId: t.id, project: t.project });
    pushState();
    return deadlineList();
  });
  handle('week:get', () => weekView());
  handle('export:status', () => ({ folder: exportFolder(), lastAt: lastExportAt, error: exportError, auto: settings.exportCsv.auto }));
  handle('export:now', () => {
    const r = runExport();
    if (r.ok) void shell.openPath(r.folder);
    return r;
  });
  handle('export:open', () => {
    mkdirSync(exportFolder(), { recursive: true });
    return shell.openPath(exportFolder());
  });
  handle('export:chooseFolder', async () => {
    const opts: Electron.OpenDialogOptions = { title: 'Where should Lock In save the daily CSV files?', properties: ['openDirectory', 'createDirectory'] };
    const r = windows.main ? await dialog.showOpenDialog(windows.main, opts) : await dialog.showOpenDialog(opts);
    if (!r.canceled && r.filePaths[0]) {
      settings = { ...settings, exportCsv: { ...settings.exportCsv, folder: r.filePaths[0] } };
      store.saveSettings(settings);
      runExport();
    }
    return { folder: exportFolder(), lastAt: lastExportAt, error: exportError, auto: settings.exportCsv.auto };
  });
  handle('crew:get', () => crewPayload());
  handle('crew:create', (_e, a: { crewName: string; name: string }) => {
    crew.create(String(a?.crewName ?? ''), String(a?.name ?? ''));
    return crewPayload();
  });
  handle('crew:join', (_e, a: { code: string; name: string }) => {
    const r = crew.join(String(a?.code ?? ''), String(a?.name ?? ''));
    return { ...r, ...crewPayload() };
  });
  handle('crew:leave', async () => {
    await crew.leave();
    return crewPayload();
  });
  handle('crew:bomb', async (_e, a: { to: string; insult: string }) => {
    const r = await crew.throwBomb(String(a?.to ?? ''), String(a?.insult ?? ''));
    if (r.ok) {
      statsCache = null;
      checkAchievements(Date.now());
    }
    return { ...r, ...crewPayload() };
  });
  handle('crew:settings', (_e, patch: Partial<Settings['crew']>) => {
    const serverChanged = patch.server !== undefined && patch.server !== settings.crew.server;
    const { code: _c, crewName: _n, ...safe } = patch ?? {};
    settings = { ...settings, crew: { ...settings.crew, ...safe } };
    store.saveSettings(settings);
    if (serverChanged && crew.joined) crew.start();
    return crewPayload();
  });

  // The opening animation plays once per launch (the window is rebuilt each time it opens).
  let introPlayed = SMOKE && !process.env.LOCKIN_INTRO;
  handle('intro:claim', () => {
    if (introPlayed) return false;
    introPlayed = true;
    return true;
  });
  handle('voices:list', async (_e, force?: boolean) => {
    const list = await voices.list(!!force);
    const c = activeCoach();
    return { ...list, current: settings.voiceId, currentName: settings.voiceName, suggested: SUGGESTED[getProfile().persona], speaksAs: c?.voice && c.useVoice ? c.name : undefined };
  });
  handle('voices:search', (_e, q: { search?: string; gender?: string; accent?: string; page?: number }) => voices.search(q ?? {}));
  handle('voices:preview', async (_e, v: { id: string; previewUrl?: string }) => {
    if (!v?.id) return 'none';
    return voice.preview(v.id, previewLine(getProfile().persona, todos.firstName), () => voices.sample(v.previewUrl));
  });
  handle('voices:stop', () => voice.stop());
  handle('voices:use', async (_e, v: { id: string; name: string; ownerId?: string; added?: boolean }) => {
    if (!v?.id) return { ok: false, error: 'No voice picked.' };
    if (v.ownerId && !v.added) {
      // A Voice Library voice goes into your ElevenLabs voices first, so the live agent can use it too.
      const r = await voices.add(v.ownerId, v.id, v.name);
      if (!r.ok) {
        const c = await voice.check(v.id);
        if (!c.ok) {
          log(`[voices] could not use ${v.id}: ${r.error}`);
          return { ok: false, error: r.error };
        }
        log(`[voices] using ${v.id} without adding it (${r.status ?? 'error'})`);
      }
    }
    settings = { ...settings, voiceId: v.id, voiceName: v.name };
    store.saveSettings(settings);
    warmAgent();
    log(`[voices] coach voice is now ${v.name}`);
    return { ok: true };
  });
  handle('coach:preview', (_e, level: 1 | 2 | 3 | 4) => coach.preview(level));
  handle('coach:dismissPreview', () => coach.dismissPreview());
  handle('voice:test', async () => {
    await voice.speak('This is your Lock In coach. Back to work.', { shout: getProfile().persona === 'drill' });
    return true;
  });
  handle('mute', (_e, minutes: number) => {
    guard.mute(minutes);
    coach.silence();
    pushState();
  });
  handle('unmute', () => {
    guard.unmute();
    pushState();
  });
  handle('setup:status', () => setupStatus());
  handle('app:loginItem', (_e, on: boolean) => {
    setOpenAtLogin(!!on);
    return setupStatus();
  });
  handle('setup:promptAccessibility', () => {
    if (process.platform === 'darwin') {
      systemPreferences.isTrustedAccessibilityClient(true);
      helper.promptAccessibility();
    }
    return setupStatus();
  });
  handle('setup:askMic', async () => {
    if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone');
    return setupStatus();
  });
  handle('setup:openExtensionFolder', () => shell.openPath(extensionPath()));
  handle('setup:browsers', () => installedBrowsers().map(({ id, name }) => ({ id, name })));
  // The easy way in: the browser opens on its extensions page, the extension folder is shown in
  // Finder (to drag onto that page) and its path is on the clipboard (for Load unpacked, ⌘⇧G).
  handle('setup:addExtension', (_e, id?: string) => {
    const all = installedBrowsers();
    const b = all.find((x) => x.id === id) ?? all[0];
    clipboard.writeText(extensionPath());
    if (b) {
      try {
        // Run the browser itself with the address: a running browser takes it over, a closed one opens on it.
        const child = spawn(b.bin, [b.url], { detached: true, stdio: 'ignore' });
        child.on('error', () => void shell.openExternal(b.url));
        child.unref();
      } catch {
        void shell.openExternal(b.url);
      }
    }
    setTimeout(() => shell.showItemInFolder(extensionPath()), b ? 1200 : 0);
    return { browser: b?.name ?? null, path: extensionPath() };
  });
  // Setup's "Show me": the panel opens under the padlock while setup stays open.
  handle('panel:peek', () => showPanel());
  handle('setup:openUrl', (_e, url: string) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
  });
  handle('setup:log', () => logLines.slice(-200));
  handle('data:export', () => {
    // "Back up now": the same zip as the daily one, timestamped so it never replaces one.
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    const file = writeBackup(`Lock In backup ${stamp}.zip`);
    runExport();
    shell.showItemInFolder(file);
    return file;
  });
  handle('data:where', () => ({ folder: exportFolder(), backups: backupFolder() }));
  handle('data:openFolder', () => {
    mkdirSync(exportFolder(), { recursive: true });
    return shell.openPath(exportFolder());
  });
  handle('data:restore', async () => {
    const pick = await dialog.showOpenDialog({ title: 'Restore a Lock In backup', defaultPath: backupFolder(), properties: ['openFile'], filters: [{ name: 'Lock In backup', extensions: ['zip'] }] });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false };
    let bytes: Uint8Array;
    let info: { createdAt: string; files: number };
    try {
      bytes = readFileSync(pick.filePaths[0]);
      const b = readBackup(bytes);
      info = { createdAt: b.manifest.createdAt, files: b.files.length };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const when = new Date(info.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const answer = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Restore and restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Restore the backup from ${when}?`,
      detail: `Lock In replaces its records with the ${info.files} in this backup, then restarts. What's here now is backed up first, so nothing is lost. API keys aren't in backups; add them again under Settings, Keys.`,
    });
    if (answer.response !== 0) return { ok: false };
    try {
      if (sess) endSession('user');
      crew?.flush();
      writeBackup(`Lock In backup before restoring ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}.zip`);
      restoreBackup(store.dir, bytes);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    log('[backup] restored; restarting');
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
  handle('data:delete', () => {
    if (sess) endSession('user');
    store.deleteActivity();
    // Your rhythm is activity too, and so is what Lock In learned about your cards; the goals you set stay.
    rhythm = new Rhythm({});
    attention = new Attention(null, () => settings.attention ?? DEFAULT_ATTENTION, log);
    pastCache = null;
    for (const k of Object.keys(classifier.cache)) delete classifier.cache[k];
    appState = { lastGoal: '', lastWork: null };
    pushState();
    return true;
  });
  ipcMain.on('toast:resize', (_e, h: number) => windows.resizeToast(h));
  ipcMain.on('toast:close', () => windows.closeToast());
}

// -----------------------------------------------------------------------------
// Boot

async function boot(): Promise<void> {
  store = new Store(userDir());
  profile = store.profile();
  settings = store.settings();
  // The full smoke test walks the classic window's pages; LOCKIN_PANEL checks the panel.
  if (SMOKE && !process.env.LOCKIN_PANEL && !process.env.LOCKIN_ONBOARD) settings = { ...settings, ui: 'window' };
  const st = store.state();
  appState = { lastGoal: st.lastGoal, lastWork: st.lastWork };
  guard = new Guardrails();
  windows = new Windows(log);
  attention = new Attention(store.readJson('attention.json', null), () => settings.attention ?? DEFAULT_ATTENTION, log);
  // Every corner card tells the gate it appeared (for the gap between cards) and how it ended (for learning).
  windows.onToast = (p, ev) => {
    const now = Date.now();
    if (ev === 'shown') attention.cardShown(p.tag, p.kind !== 'info' && p.kind !== 'win', now);
    else attention.resolve(p.tag, ev === 'closed' ? 'dismissed' : 'ignored', now);
  };

  claude = new Claude(() => store.getKey('anthropic'), log);
  rhythm = new Rhythm(store.readJson('rhythm.json', {}));
  goalsData = loadGoals();
  coaches = new Coaches({
    dir: store.dir,
    elevenKey: () => (SMOKE ? 'smoke' : store.getKey('elevenlabs')),
    claude: SMOKE ? smokeClaude : claude,
    settings: () => settings,
    userName: () => todos?.firstName ?? '',
    http: SMOKE ? smokeCoachesHttp : undefined,
    onChange: (id) => {
      windows.sendMain('coaches:update', coachView(id));
      if (id === profile?.customCoach) applyCoach();
    },
    log,
  });
  applyCoach();
  classifier = new Classifier(getProfile, store.labels(), () => (labelsDirty = true), { titlesStayLocal: () => settings.titlesStayLocal });
  classifier.setLabeler(makeLabeler(claude, () => settings));

  bridge = new Bridge(log, () => pushState(), bundledExtensionVersion);
  helper = new HelperSensor(helperPath(), log);
  fallback = new FallbackSensor();
  voice = new Voice({
    cacheDir: join(store.dir, 'tts-cache'),
    settings: () => settings,
    elevenKey: () => store.getKey('elevenlabs'),
    voiceId: coachVoiceId,
    window: () => windows.voice,
    log,
  });
  unlocked = store.readJson<Record<string, number> | null>('achievements.json', null);
  crewRelay = new NtfyRelay({
    server: () => settings.crew.server || 'https://ntfy.sh',
    onMessage: (m) => crew.receive(m),
    onState: (on, error) => crew.setConnection(on, error),
    log,
  });
  crew = new Crew({
    settings: () => settings.crew,
    saveSettings: (patch) => {
      settings = { ...settings, crew: { ...settings.crew, ...patch } };
      store.saveSettings(settings);
    },
    relay: SMOKE ? smokeCrewRelay() : crewRelay,
    load: () => store.readJson<CrewData | null>('crew.json', null),
    save: (d) => store.writeJson('crew.json', d),
    local: crewLocal,
    onBomb: bombLanded,
    onChange: () => pushCrew(),
    log,
  });
  crew.start();
  holdSpace = new HoldSpace({
    bin: keyWatcherPath,
    onHold: () => {
      log('[hold space] held');
      toggleTalk();
    },
    log,
  });
  holdSpace.setActive(process.platform === 'darwin' && settings.talk.holdSpace !== false);
  voices = new VoiceCatalog({
    // The smoke test shows the picker with a stand-in ElevenLabs.
    key: () => (SMOKE ? 'smoke' : store.getKey('elevenlabs')),
    http: SMOKE ? smokeVoicesHttp : undefined,
    log,
  });
  sampler = new Sampler({
    helper,
    fallback,
    bridge,
    idleSec: () => powerMonitor.getSystemIdleTime(),
    settings: () => settings,
    selfRecording: () => voice.recording || voice.speaking,
  });
  router = new Router(bridge, log);
  notifier = new Notifier({
    settings: () => settings,
    profile: getProfile,
    guard,
    inCall: () => !!current?.inCall,
    cardBusy: () => windows.overlayVisible,
    toast: (p) => windows.showToast(p),
    card: (p) => windows.showOverlay(p),
    tabReady: () => !!distractingTab(),
    // The test button in Settings shows it on whatever tab is in front.
    tab: (p) => showTabCard(p, !!p.test),
    speak: (text, shout) => voice.speak(text, { shout }),
    sound: (id) => playSound(id),
    system: systemNotify,
    menubar: (text, ms) => {
      flashText = text;
      flashUntil = Date.now() + ms;
      if (process.platform !== 'darwin') tray?.setToolTip(`Lock In: ${text}`);
    },
    dock: dockAlert,
    http: fetch,
    log,
  });
  todos = new TodoManager(store, () => settings, (events) => {
    for (const ev of events) {
      log(`[todos] ${ev.type}${ev.type === 'roast' ? ` severity ${ev.severity}` : `: ${ev.task.title}`}`);
      if (ev.type === 'roast') store.append('roasts.ndjson', { at: Date.now(), kind: 'todo' });
      void announcer.todoEvent(ev).then(() => {
        // Roasted: open the mic so you can say what you were actually doing.
        if (ev.type === 'roast' && settings.talk.afterRoast && talk.voiceReady && !talkError && !talk.isOpen && !sess && !current?.inCall && !calendar.now() && !guard.muted()) {
          startTalk('roast', { focus: false });
        }
      });
    }
  }, log);
  todoHistory = new TodoHistory(store.dir);
  macCal = new MacCalendar({ bin: calendarReaderPath, run: SMOKE ? smokeMacCalendar : undefined, log });
  calendar = new CalendarManager({
    settings: () => settings.calendar,
    log,
    saveDay: saveCalendarDay,
    mac: async (from, to) => {
      const r = await macCal.read(from, to, settings.calendar.macExclude);
      if (r.status !== 'granted') throw new Error(macStatusMessage(r.status));
      macCalendars = r.calendars;
      return r.events;
    },
  });
  deadlines = new Deadlines({
    load: () => store.readJson<Deadline[]>('deadlines.json', []),
    save: (d) => store.writeJson('deadlines.json', d),
    loadState: () => store.readJson<ReminderState>('deadline-reminders.json', {}),
    saveState: (s) => store.writeJson('deadline-reminders.json', s),
  });
  routines = store.routines();
  scheduler = new RoutineScheduler(store.readJson<RoutineState | null>('routine-state.json', null));
  const todoView = () => {
    const s = todos.summary();
    return s.provider === 'none' ? null : { open: s.open, overdue: s.overdue, done: s.doneToday, top: todos.top() };
  };
  announcer = new Announcer({
    notify: (p) => notifier.notify(p),
    claude,
    settings: () => settings,
    profile: getProfile,
    todos: todoView,
    weekSessions: () => store.sessions().filter((s) => s.startedAt > Date.now() - 7 * 86_400_000),
    log,
  });
  coach = new Coach({
    store,
    profile: getProfile,
    settings: () => settings,
    classifier,
    claude,
    voice,
    router,
    guard,
    ui: {
      showToast: (p) => windows.showToast(p),
      hideToast: (k) => windows.hideToast(k),
      showOverlay: (p) => windows.showOverlay(p),
      updateOverlay: (p) => windows.updateOverlay(p),
      hideOverlay: () => windows.hideOverlay(),
      refresh: () => pushState(),
    },
    session: () => sess,
    endSession: (by) => endSession(by),
    current: () => current,
    log,
    notify: (p) => notifier.notify(p),
    channels: (k) => notifier.channelsFor(k),
    todos: todoView,
    liveTalk: (o) => {
      if (!talk.voiceReady || talk.isOpen) return false;
      startTalk('drift', o);
      return true;
    },
  });

  agent = new ElevenAgent({
    key: () => store.getKey('elevenlabs'),
    voiceId: coachVoiceId,
    language: agentLanguage,
    load: () => store.readJson<AgentRecord | null>('eleven-agent.json', null),
    save: (r) => store.writeJson('eleven-agent.json', r),
    log,
  });
  const talkActions: TalkActions = {
    startFocus: (goal, minutes) => {
      startSession(goal, minutes);
      return `Locked in on "${goal}" for ${sess?.record.plannedMin ?? minutes} minutes.`;
    },
    snooze: (minutes) => {
      todos.snooze(minutes);
      guard.mute(minutes);
      pushState();
      return `Roasts and check-ins paused for ${minutes} minutes.`;
    },
    route: async (opt, minutes) => {
      if (coach.active && !coach.active.preview) {
        await coach.choose(opt, 'model', minutes ? { minutes } : {}, undefined, true);
        return opt === 'back' ? 'Distraction closed, work reopened.' : opt === 'break' ? `Break started${minutes ? ` for ${minutes} minutes` : ''}.` : 'Relabeled as work.';
      }
      if (opt === 'is_work' && lastExternal) {
        classifier.setUserLabel(lastExternal, 'work');
        return `${lastExternal.domain ?? lastExternal.app} now counts as work.`;
      }
      return 'There is no focus session going right now.';
    },
    addTodo: async (title) => {
      if (!title) return 'Nothing to add.';
      try {
        return (await todos.add(title)) ? `Added "${title}" to the list.` : 'Could not add it.';
      } catch (e) {
        return (e as Error).message;
      }
    },
    logDone: async (items, via) => {
      const r = await todos.logDone(items, via);
      pushState();
      return r;
    },
  };
  talk = new Talk({
    agent,
    claude,
    hasVoiceKey: () => !!store.getKey('elevenlabs'),
    settings: () => settings,
    persona: () => getProfile().persona,
    context: talkContext,
    actions: talkActions,
    show: (p) => windows.showTalk(p),
    send: (e) => windows.sendTalk(e),
    hide: () => windows.hideTalk(),
    speak: (text) => voice.speak(text),
    logTurn: (speaker, text) => store.logTurn({ interventionId: 'talk', speaker, text, createdAt: Date.now() }),
    log,
  });
  setTimeout(warmAgent, 8000).unref?.();
  // Talking to the coach from your phone: typed (the phone keyboard's mic dictates), replies spoken in the coach's voice.
  phoneChat = new PhoneChat(
    (hooks) =>
      new Talk({
        agent,
        claude,
        hasVoiceKey: () => false,
        settings: () => settings,
        persona: () => getProfile().persona,
        context: talkContext,
        actions: talkActions,
        ...hooks,
        logTurn: (speaker, text) => store.logTurn({ interventionId: 'phone', speaker, text, createdAt: Date.now() }),
        log,
      }),
    (text) => voice.tts(text, settings.ttsModelLive, false),
  );

  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  electronSession.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  setupIpc();
  if (settings.phone.enabled) void setPhone(true);
  windows.createVoice();
  // The padlock in the Dock (the installed app has it built in; this covers running from Terminal).
  if (process.platform === 'darwin' && app.dock && existsSync(assetPath('icon.png'))) app.dock.setIcon(nativeImage.createFromPath(assetPath('icon.png')));
  setupTray();
  setupShortcuts();
  helper.start();
  bridge.start();
  if (!helper.built && process.platform === 'darwin') log('[helper] not built; run `npm run helper` (needs Xcode Command Line Tools). Using fallback sensing.');

  setInterval(() => void loop().catch((e) => log(`[loop] ${(e as Error).stack ?? e}`)), 1000);
  void todos.refresh(true);
  // Opened at login: stay in the menu bar until you need it. With the panel, starting Lock In
  // opens the panel under its icon (the first time, the setup questions open in the window).
  const atLogin = isInstalledApp() && !!profile && app.getLoginItemSettings().wasOpenedAtLogin;
  windows.onMain = () => applyUi();
  applyUi();
  if (!atLogin) {
    if (!profile) windows.openMain('quiz');
    else if (panelMode()) setTimeout(showPanel, 600);
    else windows.openMain('home');
  }
  log(`[app] ${isInstalledApp() ? 'installed app' : 'dev'}${atLogin ? ', opened at login' : ''}`);

  if (SMOKE) await smokeTest();
}

/** Talking (typed and voice), the calendar and the CSV export. */
async function newFeaturesSmoke(
  wait: (ms: number) => Promise<unknown>,
  shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>,
  nav: (r: string) => Promise<void>,
  errors: string[],
): Promise<void> {
  const watch = (w: Electron.BrowserWindow | null) =>
    w?.webContents.on('console-message', (e) => {
      const ev = e as unknown as { level: string | number; message: string };
      if (ev.level === 'error' || ev.level === 3) errors.push(`[talk] ${ev.message}`);
    });
  const talkText = () => windows.talk?.webContents.executeJavaScript('document.body.innerText').catch(() => '') ?? Promise.resolve('');

  // 1. Typed conversation (no ElevenLabs key).
  startTalk('roast');
  await wait(1200);
  watch(windows.talk);
  await talk.text('I was doing the pitch deck and then sent Sam the invoice');
  await wait(1200);
  await shot(windows.talk, '20-talk-typed');
  console.log('SMOKE talk typed:', JSON.stringify(String(await talkText()).replace(/\s+/g, ' ').slice(0, 300)));
  talk.close();
  await wait(2200);
  console.log('SMOKE done after typed talk:', JSON.stringify(todos.doneToday().map((t) => [t.title, t.said ? 'said' : t.localOnly ? 'lockin' : 'list'])));

  // 2. Voice conversation against a stand-in ElevenLabs server (fake mic).
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;
  const got = { init: null as Record<string, unknown> | null, audioChunks: 0, toolResults: [] as string[], userMessages: [] as string[] };
  wss.on('connection', (sock) => {
    const send = (o: unknown) => sock.send(JSON.stringify(o));
    sock.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      if (m.type === 'conversation_initiation_client_data') {
        got.init = m;
        send({ type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: 'smoke', agent_output_audio_format: 'pcm_16000', user_input_audio_format: 'pcm_16000' } });
        const vars = (m.dynamic_variables ?? {}) as Record<string, string>;
        setTimeout(() => {
          send({ type: 'agent_response', agent_response_event: { agent_response: vars.opener ?? 'Hi' } });
          send({ type: 'audio', audio_event: { audio_base_64: Buffer.alloc(16000 * 0.4 * 2).toString('base64'), event_id: 1 } });
        }, 200);
        setTimeout(() => send({ type: 'user_transcript', user_transcription_event: { user_transcript: 'I replied to Sam about pricing and booked the dentist' } }), 1200);
        setTimeout(() => send({ type: 'client_tool_call', client_tool_call: { tool_name: 'log_done', tool_call_id: 't1', parameters: { items: ['replied to Sam about pricing', 'booked the dentist'] } } }), 1500);
      } else if (m.user_audio_chunk) got.audioChunks++;
      else if (m.type === 'client_tool_result') {
        got.toolResults.push(String(m.result));
        if (m.tool_call_id === 't1') {
          send({ type: 'agent_response', agent_response_event: { agent_response: 'Fine. Both count. Want to lock in on the investor update?' } });
          setTimeout(() => send({ type: 'client_tool_call', client_tool_call: { tool_name: 'end_conversation', tool_call_id: 't2', parameters: {} } }), 2500);
        }
      } else if (m.type === 'user_message') got.userMessages.push(String(m.text));
    });
  });
  const t = talk as unknown as { d: { hasVoiceKey: () => boolean } };
  const realKey = t.d.hasVoiceKey;
  t.d.hasVoiceKey = () => true;
  const a = agent as unknown as { signedUrl: () => Promise<string> };
  const realUrl = a.signedUrl;
  a.signedUrl = async () => `ws://127.0.0.1:${port}/v1/convai/conversation?agent_id=smoke`;
  startTalk('checkin');
  await wait(400);
  watch(windows.talk);
  await wait(2600);
  await shot(windows.talk, '21-talk-voice');
  const voiceText = String(await talkText()).replace(/\s+/g, ' ');
  await wait(4500);
  console.log('SMOKE talk voice:', JSON.stringify({ vars: Object.keys(((got.init?.dynamic_variables ?? {}) as object)).length, audioChunks: got.audioChunks, toolResults: got.toolResults, open: talk.isOpen, panel: voiceText.slice(0, 260) }));
  t.d.hasVoiceKey = realKey;
  a.signedUrl = realUrl;
  wss.close();
  if (talk.isOpen) talk.close();
  await wait(1000);

  // 3. Calendar (events injected; there is no network here).
  const now = Date.now();
  const at = (min: number) => now + min * 60_000;
  settings = { ...settings, calendar: { ...settings.calendar, urls: ['https://calendar.google.com/calendar/ical/grace%40example.com/private-abc/basic.ics'] } };
  calendar.lastFetch = now;
  calendar.events = [
    { id: 'a', title: 'LA Tech Week', start: at(-600), end: at(800), allDay: true, busy: false, calendar: 'g' },
    { id: 'b', title: 'Standup', start: at(4), end: at(19), allDay: false, busy: true, link: 'https://meet.google.com/abc-defg-hij', calendar: 'g' },
    { id: 'c', title: 'Product sync', start: at(180), end: at(240), allDay: false, busy: true, calendar: 'g' },
  ];
  calendarTick(now, false);
  await wait(900);
  await shot(windows.toast, '22-toast-meeting');
  console.log('SMOKE meeting toast:', JSON.stringify(String(await windows.toast?.webContents.executeJavaScript('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ')));
  startSession('Cap test', 50);
  console.log('SMOKE capped session minutes:', sess?.record.plannedMin);
  endSession('user');
  windows.hideToast();
  pushState();
  if (process.env.LOCKIN_SHOTS) {
    await nav('calendar');
    await wait(600);
    await shot(windows.main, '23-calendar');
    await nav('home');
    await wait(600);
    await shot(windows.main, '24-home-meeting');
  }

  // 4. Deadlines and the new page layout.
  const dayStr = (n: number) => ymd(Date.now() + n * 86_400_000);
  deadlines.add({ title: 'Send the Sequoia deck', due: dayStr(0), time: '17:00' });
  deadlines.add({ title: 'Club alumni outreach list', due: dayStr(1) });
  const dl3 = deadlines.add({ title: 'Captain launch post', due: dayStr(3) });
  deadlines.add({ title: 'Old thing', due: dayStr(5) });
  setDeadlineDone(deadlines.all().find((d) => d.title === 'Old thing')!.id, true);
  console.log('SMOKE deadlines:', JSON.stringify(deadlines.all().map((d) => [d.title, d.due, d.done])), 'pinned:', deadlines.pinned().map((d) => d.title).join(', '), 'dl3:', dl3.due);
  pushState();
  if (process.env.LOCKIN_SHOTS) {
    const js = (code: string) => windows.main?.webContents.executeJavaScript(code);
    await nav('home');
    await wait(900);
    await shot(windows.main, '30-home');
    await nav('deadlines');
    await wait(900);
    await shot(windows.main, '31-home-deadlines');
    await nav('routines');
    await wait(900);
    await shot(windows.main, '32-home-routines');
    await nav('todos');
    await wait(1200);
    await shot(windows.main, '33-todos-top');
    await nav('week');
    await wait(1200);
    await shot(windows.main, '34-todos-week');
    await nav('today');
    await wait(1200);
    await shot(windows.main, '35-todos-today');
    await nav('settings');
    await wait(1200);
    await shot(windows.main, '36-setup');
    await js(`[...document.querySelectorAll('#profile-sec button')].find((b) => b.textContent === 'Edit profile')?.click()`);
    await wait(1200);
    await js(`document.getElementById('profile-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(300);
    await shot(windows.main, '37-setup-profile-editing');
    await nav('calendar');
    await wait(1200);
    await shot(windows.main, '38-setup-calendar');
    const railText = await js(`document.querySelector('.rail').innerText`);
    console.log('SMOKE rail:', JSON.stringify(String(railText).split('\n').slice(0, 6)));

    // The voice picker.
    await nav('coach');
    await wait(1500);
    await js(`document.getElementById('voice-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(500);
    await shot(windows.main, '40-voice-picks');
    await js(`[...document.querySelectorAll('#voice-sec h3')].find((x) => x.textContent?.startsWith('Your ElevenLabs'))?.scrollIntoView({ block: 'start' })`);
    await wait(500);
    await shot(windows.main, '41-voice-mine-library');
    // A library voice the key can't add (the stand-in refuses), then a pick.
    await js(`[...document.querySelectorAll('.voice-card')].find((c) => c.querySelector('b')?.textContent === 'Hope')?.querySelector('.vc-actions .btn-ink')?.click()`);
    await wait(1200);
    const err = await js(`document.querySelector('.voice-note')?.textContent`);
    console.log('SMOKE voice add refused:', JSON.stringify(String(err).slice(0, 90)));
    await js(`[...document.querySelectorAll('.voice-card')].find((c) => c.querySelector('b')?.textContent === 'River')?.querySelector('.vc-actions .btn-ink')?.click()`);
    await wait(1200);
    await js(`document.getElementById('voice-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(400);
    await shot(windows.main, '42-voice-switched');
    console.log('SMOKE voice now:', settings.voiceName, settings.voiceId, JSON.stringify(String(await js(`document.querySelector('.voice-now')?.textContent`)).slice(0, 60)));

    // Connecting a Google account through the Calendar app (with a stand-in reader).
    const calBefore = settings.calendar;
    const eventsBefore = calendar.events;
    settings = { ...settings, calendar: { ...settings.calendar, urls: [] } };
    await nav('calendar');
    await wait(1200);
    await shot(windows.main, '43-calendar-google-connect');
    await js(`[...document.querySelectorAll('.mac-cal button')].find((b) => b.textContent === 'Connect')?.click()`);
    await wait(900);
    console.log('SMOKE mac calendar result:', JSON.stringify(String(await js(`document.querySelector('.mac-cal [aria-live]')?.textContent`)).slice(0, 120)));
    await wait(1800);
    await js(`document.getElementById('calendar-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(400);
    await shot(windows.main, '44-calendar-google-connected');
    console.log('SMOKE mac calendar events:', JSON.stringify(calendar.events.map((e) => e.title)), 'connected:', calendar.connected);
    await nav('week');
    await wait(1200);
    await shot(windows.main, '45-week-with-google');
    settings = { ...settings, calendar: calBefore };
    calendar.events = eventsBefore;

    // Friends: a crew of three stand-ins, a bomb thrown, a bomb taken.
    settings = { ...settings, quietStart: '00:00', quietEnd: '00:00' };
    crew.create('Library gremlins', 'Ari');
    await wait(700);
    await nav('friends');
    await wait(900);
    await shot(windows.main, '50-friends');
    await js(`document.querySelector('.crew-row[data-state="drifting"] .bomb-btn')?.click()`);
    await wait(500);
    await js(`document.querySelectorAll('.insult')[2]?.click()`);
    await wait(200);
    await shot(windows.main, '51-friends-picker');
    await js(`document.querySelector('.throw-btn')?.click()`);
    await wait(1200);
    await js(`document.getElementById('board-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(300);
    await shot(windows.main, '52-friends-board');
    console.log('SMOKE crew:', JSON.stringify({ left: crew.bombsLeft(), feed: crew.view().feed.slice(0, 3).map((f) => f.text) }));
    smokeDeliver?.({ id: 'maya', name: 'Maya' }, { t: 'bomb', id: 'smoke-bomb', to: crew.me, toName: 'Ari', insult: 'Main character energy, side quest behavior.' });
    await wait(1100);
    await shot(windows.overlay, '53-bomb-card');
    const lockedText = await windows.overlay?.webContents.executeJavaScript(`document.getElementById('status').textContent + ' | buttons hidden: ' + document.getElementById('options').hidden`);
    await wait(5200);
    const unlockedText = await windows.overlay?.webContents.executeJavaScript(`'buttons hidden: ' + document.getElementById('options').hidden + ', ' + document.querySelectorAll('#options button').length + ' buttons'`);
    await shot(windows.overlay, '54-bomb-card-after');
    console.log('SMOKE bomb card:', JSON.stringify({ lockedText, unlockedText }));
    windows.hideOverlay();
    await js(`document.getElementById('ach-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(300);
    await shot(windows.main, '55-achievements');
    await nav('home');
    await wait(1200);
    await shot(windows.main, '56-home-strip');
    settings = { ...settings, quietStart: '22:00', quietEnd: '08:00' };
  }

  // 5. Export.
  settings = { ...settings, exportCsv: { ...settings.exportCsv, folder: join(store.dir, 'export-test') } };
  todoHistory.record(Date.now(), dayKey(Date.now()), todos.watchdog.openTasks, todos.doneLog.onDay(dayKey(Date.now())), todos.listName());
  const r = runExport();
  dailyBackup(Date.now());
  const { readdirSync: ls, readFileSync: rd } = await import('node:fs');
  console.log('SMOKE export:', r.ok, ls(r.folder).join(' | '), '| Days:', ls(join(r.folder, 'Days')).join(' '));
  console.log('SMOKE done log csv:', JSON.stringify(rd(join(r.folder, 'Lock In - done log.csv'), 'utf8').slice(0, 500)));
  console.log('SMOKE summary csv:', JSON.stringify(rd(join(r.folder, 'Lock In - daily summary.csv'), 'utf8').slice(0, 400)));
  console.log('SMOKE to-dos by day csv:', JSON.stringify(rd(join(r.folder, 'Lock In - to-dos by day.csv'), 'utf8').slice(0, 400)));
  const backups = ls(backupFolder());
  const bk = readBackup(rd(join(backupFolder(), backups[0])));
  console.log('SMOKE backup:', backups.join(' | '), '|', bk.files.length, 'files:', bk.files.map((f) => f.name).filter((n) => !n.startsWith('todo-days')).join(' '));
  if (process.env.LOCKIN_SHOTS) {
    await nav('settings');
    await wait(900);
    await windows.main?.webContents.executeJavaScript(`document.getElementById('data-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(300);
    await shot(windows.main, '57-setup-your-data');
    await nav('settings');
    await wait(900);
    await windows.main?.webContents.executeJavaScript(`document.querySelector('.export')?.scrollIntoView({ block: 'start' })`);
    await wait(300);
    await shot(windows.main, '25-today-export');
    await nav('todos');
    await wait(500);
    await windows.main?.webContents.executeJavaScript(`[...document.querySelectorAll('h2')].find((x) => x.textContent === 'Done today')?.scrollIntoView({ block: 'start' })`);
    await wait(300);
    await shot(windows.main, '26-todos-done');
    await nav('coach');
    await wait(500);
    await windows.main?.webContents.executeJavaScript(`[...document.querySelectorAll('h2')].find((x) => x.textContent === 'Talking with Lock In')?.scrollIntoView({ block: 'start' })`);
    await wait(300);
    await shot(windows.main, '27-settings-talk');
  }
}

/** A stand-in relay with three friends on it, so the smoke test can show the Friends page and bombs. */
let smokeDeliver: ((from: { id: string; name: string }, msg: Record<string, unknown>) => void) | null = null;
function smokeCrewRelay(): Relay {
  const friends = [
    { id: 'sam', name: 'Sam', state: 'locked', goal: 'Problem set 4', sessionMin: 34, stats: { todayMin: 95, weekMin: 610, streak: 6, roastedWeek: 2, bombsThrownWeek: 4, achievements: 7 } },
    { id: 'lee', name: 'Lee', state: 'drifting', distraction: 'youtube.com', stats: { todayMin: 20, weekMin: 140, streak: 0, roastedWeek: 9, bombsThrownWeek: 1, achievements: 3 } },
    { id: 'maya', name: 'Maya', state: 'free', stats: { todayMin: 60, weekMin: 380, streak: 3, roastedWeek: 4, bombsThrownWeek: 6, achievements: 5 } },
  ];
  let seq = 0;
  const relay: Relay = {
    connected: false,
    start() {
      relay.connected = true;
      setTimeout(() => {
        crew.setConnection(true);
        const keys = crewKeys(settings.crew.code);
        if (!keys) return;
        smokeDeliver = (from, msg) => crew.receive({ id: `smoke${++seq}`, time: Date.now(), text: seal(keys.key, { v: 1, from: from.id, name: from.name, crew: 'Library gremlins', at: Date.now(), ...msg }) });
        for (const f of friends) {
          const { id, name, ...rest } = f;
          smokeDeliver({ id, name }, { t: 'status', since: Date.now() - 34 * 60_000, ...rest });
        }
        smokeDeliver({ id: 'maya', name: 'Maya' }, { t: 'ach', achName: 'Relapse survivor' });
      }, 200);
    },
    stop() {
      relay.connected = false;
    },
    async publish(_topic, text) {
      // Friends answer bombs: Lee takes the hit.
      const keys = crewKeys(settings.crew.code);
      const m = keys ? openSealed<{ t: string; id: string; to: string; from: string; name: string }>(keys.key, text) : null;
      if (m?.t === 'bomb') {
        const f = friends.find((x) => x.id === m.to);
        if (f) setTimeout(() => smokeDeliver?.({ id: f.id, name: f.name }, { t: 'result', id: m.id, to: m.from, toName: m.name, outcome: 'hit' }), 300);
      }
      return true;
    },
  };
  return relay;
}

/** A stand-in for the Calendar app reader, so the smoke test can show a connected Google account. */
let smokeMacGranted = false;
async function smokeMacCalendar(args: string[]): Promise<string> {
  if (args[0] === 'request') smokeMacGranted = true;
  if (args[0] !== 'events') return JSON.stringify({ status: smokeMacGranted ? 'granted' : 'notDetermined' });
  if (!smokeMacGranted) return JSON.stringify({ status: 'notDetermined' });
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const at = (day: number, h: number, m = 0) => base.getTime() + day * 86_400_000 + (h * 60 + m) * 60_000;
  return JSON.stringify({
    status: 'granted',
    calendars: [
      { id: 'g1', title: 'alex@school.edu', source: 'alex@school.edu' },
      { id: 'g2', title: 'Captain', source: 'you@startup.com' },
      { id: 'g3', title: 'Holidays in United States', source: 'alex@school.edu' },
      { id: 'i1', title: 'Home', source: 'iCloud' },
      { id: 'b1', title: 'Birthdays', source: 'Other' },
    ],
    events: [
      { id: 'e1', title: 'Club board meeting', start: at(1, 17), end: at(1, 18), calendarId: 'g1', calendar: 'alex@school.edu', url: 'https://example.zoom.us/j/123' },
      { id: 'e2', title: 'Captain launch sync', start: at(2, 10), end: at(2, 10, 45), calendarId: 'g2', calendar: 'Captain', notes: 'Join: https://meet.google.com/abc-defg-hij' },
      { id: 'e3', title: 'Halloween', start: at(7, 0), end: at(7, 23, 59) + 59_000, allDay: true, calendarId: 'g3', calendar: 'Holidays in United States' },
    ],
  });
}

/** A stand-in for the ElevenLabs voice endpoints, so the smoke test can show the voice picker. */
async function smokeVoicesHttp(input: string | URL | Request): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/v2/voices')) {
    return json({
      voices: [
        { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', category: 'premade', preview_url: 'https://storage.googleapis.com/x/jessica.mp3', labels: { accent: 'american' } },
        { voice_id: 'myclone123', name: 'Grace (my voice)', category: 'cloned', description: '', labels: { accent: 'american', gender: 'female' } },
        { voice_id: 'saved456', name: 'Zara - The Warm Conversationalist', category: 'professional', description: 'The warm, real-world conversationalist', labels: { accent: 'american', gender: 'female' } },
      ],
      has_more: false,
    });
  }
  if (url.includes('/v1/shared-voices')) {
    const names: [string, string, string, string][] = [
      ['Hope', 'female', 'american', 'Upbeat and clear'],
      ['Mark', 'male', 'american', 'Natural conversations'],
      ['Eryn', 'female', 'american', 'Genuine, friendly and natural'],
      ['Hugh', 'male', 'british', 'Natural conversational agent'],
      ['Lucy', 'female', 'british', 'Fresh and casual'],
      ['Archer', 'male', 'british', 'Conversational'],
    ];
    return json({
      voices: names.map(([name, gender, accent, description], i) => ({ voice_id: `lib${i}`, public_owner_id: `owner${i}`, name, gender, accent, description, cloned_by_count: 1200 * (6 - i), free_users_allowed: i !== 3 })),
      has_more: true,
    });
  }
  return new Response('not found', { status: 404 });
}

/** A pretend chat between Grace and her mum, as ElevenLabs would return it with two voices. */
const SMOKE_CALL: [string, number, number, string][] = [
  ['speaker_0', 0, 18, '宝贝，你吃饭了没有？不要又熬夜啊。我跟你说，work is important, 但是身体更重要。'],
  ['speaker_1', 18, 24, 'Mum I ate, I promise. I am just finishing the deck.'],
  ['speaker_0', 24, 58, '哎呀，又是那个 deck。你上次也说 just finishing，结果弄到两点。先把最难的那一页做完，then you can rest, okay? 妈妈不是唠叨你。'],
  ['speaker_1', 58, 63, 'Okay okay. One page.'],
  ['speaker_0', 63, 101, '好，一页。手机放远一点，不要刷那个 YouTube。你小时候写作业也是这样，坐五分钟就跑了。加油，宝贝，你可以的。'],
  ['speaker_1', 101, 108, 'Thanks Mum.'],
  ['speaker_0', 108, 148, '做完了给我发个微信。早点睡觉，明天还要上班呢。我等你消息啊，不要让我等到半夜。'],
];

function smokeScribeWords(): unknown[] {
  const out: unknown[] = [];
  for (const [speaker_id, start, end, text] of SMOKE_CALL) {
    const parts = text.split(/(\s+)/).filter(Boolean);
    const step = (end - start) / Math.max(1, parts.length);
    parts.forEach((t, i) => out.push(/^\s+$/.test(t) ? { text: ' ', type: 'spacing', speaker_id } : { text: t, type: 'word', start: start + i * step, end: start + (i + 1) * step, speaker_id }));
  }
  return out;
}

/** Stand-in ElevenLabs for coaches made from someone: transcripts with two voices, and a voice copy. */
async function smokeCoachesHttp(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/v1/speech-to-text')) return json({ language_code: 'zho', text: '', words: smokeScribeWords() });
  if (url.endsWith('/v1/voices/add')) {
    const form = init?.body as FormData | undefined;
    const files = form?.getAll('files') ?? [];
    console.log('SMOKE voice clone files:', files.length, JSON.stringify(files.map((f) => (f as Blob).size)));
    return json({ voice_id: 'mumvoice01', requires_verification: false });
  }
  if (init?.method === 'DELETE') return json({});
  return new Response('not found', { status: 404 });
}

/** Stand-in Claude that distills the pretend mum. */
const smokeClaude = {
  available: true,
  async messages(): Promise<{ content: { type: 'text'; text: string }[]; stop_reason: string }> {
    const lines: Record<string, string[]> = {
      level1: ['宝贝，{site}？{goal} 还没做完呢。', 'Hello? {site} 不是 {goal} 哦。'],
      level2: ['{min} 分钟了还在 {site}，妈妈都看见了。先把 {goal} 做完。', '又是 {site}！你小时候写作业也这样。回去 {work}。'],
      level3: ['好了，{site} 我给你停了。{min} 分钟，够了。去做 {work}。', '不要再刷了，宝贝。{top} 还在等你。'],
      level4: ['{site} 关掉了，今天不许再看。{goal}，现在。', '妈妈说最后一次：{site} 没了，去做 {work}。'],
      repeat: ['我还在这里等你哦。{work}。', '不要装没听见，宝贝。'],
      back: ['这才对嘛。{work} 打开了，加油。', '好，乖。做完给我发个微信。'],
      self: ['自己回来了？妈妈很骄傲。'],
      starter: ['先做一小步就好：{step} 五分钟。'],
      break: ['好，休息 {n} 分钟。喝点水，不要刷手机。'],
      breakOver: ['休息完了，回去做 {goal} 吧。'],
      win: ['{task} 做完了？真棒！还剩 {open} 个。', '你看，我就说你可以的。还有 {open} 个。'],
      roast1: ['你在电脑前 {active} 了，才做完 {done} 个。先做 {top}，好不好？'],
      bedtime: ['都 {time} 了，还不睡觉？明天还要上班呢。', '宝贝，{time} 了。电脑关了，睡觉。'],
      kickoff: ['早上好宝贝。今天 {open} 件事，先做 {top}。'],
      talkOpen: ['宝贝，今天忙什么呢？跟妈妈说说。'],
    };
    const answer = {
      summary: 'Mum talks in quick Mandarin with English work words dropped in. She worries about you eating and sleeping, nags with love, compares you to when you were little, and always ends on 加油.',
      persona: 'A warm, worried Chinese mum. Speaks fast Mandarin mixed with English words like deck, work and okay. Calls the user 宝贝. Nags about eating, sleep and the phone, brings up childhood habits, then softens: 妈妈不是唠叨你. Proud underneath, ends with 加油 and asks for a WeChat message.',
      callsYou: ['宝贝'],
      catchphrases: ['你吃饭了没有？', '不要熬夜', '妈妈不是唠叨你', '加油，宝贝', '给我发个微信'],
      language: 'Mandarin with some English',
      languageCode: 'zh',
      lines,
    };
    return { content: [{ type: 'text', text: '```json\n' + JSON.stringify(answer) + '\n```' }], stop_reason: 'end_turn' };
  },
};

/** A coach made from someone: transcribing, picking the voice, distilling, using it, and copying the voice. */
async function coachesSmoke(
  wait: (ms: number) => Promise<unknown>,
  shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>,
  nav: (r: string) => Promise<void>,
): Promise<void> {
  const js = (code: string) => windows.main?.webContents.executeJavaScript(code).catch((e: Error) => `ERR ${e.message}`);
  // A 2.5-minute recording (a quiet hum) for the page to cut the voice out of.
  const rate = 8000;
  const secs = 150;
  const pcm = Buffer.alloc(44 + rate * secs * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + rate * secs * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(rate, 24); pcm.writeUInt32LE(rate * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(rate * secs * 2, 40);
  for (let i = 0; i < rate * secs; i++) pcm.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 180) * 3000), 44 + i * 2);
  const dir = join(store.dir, 'smoke-coach');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Call with Mum.m4a'), pcm);
  writeFileSync(join(dir, 'WeChat with Mum.txt'), 'Mum: 宝贝，到家了吗？\nMe: yes\nMum: 好，早点睡。不要又熬夜改那个 deck。\nMum: 明天记得吃早饭！\nMe: ok mum\nMum: 加油，妈妈相信你。');

  const c = coaches.create({ name: 'Mum', relation: 'my mum', base: 'firm' });
  coaches.update(c.id, { notes: 'Calls me 宝贝. Always asks if I ate. Says 妈妈不是唠叨你 right after nagging. Hates when I stay up late, and texts at midnight to check. Proud of me but only says it after the nagging. Mixes Mandarin and English.' });
  coaches.addFiles(c.id, [join(dir, 'Call with Mum.m4a'), join(dir, 'WeChat with Mum.txt'), join(dir, 'notes.pdf')]);
  await coaches.idle();
  const after = coaches.view(c.id)!;
  console.log('SMOKE coach sources:', JSON.stringify(after.sources.map((x) => [x.kind, x.status, x.words, x.speakers?.length ?? 0])));
  if (process.env.LOCKIN_SHOTS) {
    await nav('coach');
    await wait(1200);
    await js(`document.getElementById('persona-sec')?.scrollIntoView({ block: 'start' })`);
    await wait(400);
    await shot(windows.main, '60-coach-people');
  }
  await nav(`coach/${c.id}`);
  await wait(1200);
  await shot(windows.main, '61-coach-page');
  await js(`document.getElementById('cm-feed')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, '62-coach-pick-voice');
  // Which voice is Mum: the first (most talkative) one.
  await js(`document.querySelector('.cm-speaker')?.click()`);
  await wait(800);
  await js(`document.getElementById('cm-feed')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, '63-coach-fed');
  await js(`[...document.querySelectorAll('#cm-style button')].find((b) => b.textContent?.startsWith('Distill'))?.click()`);
  await wait(1500);
  await js(`document.getElementById('cm-style')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, '64-coach-distilled');
  await js(`document.getElementById('cm-lines')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, '65-coach-lines');
  // A line of your own with a placeholder that doesn't fit, then one that does.
  const fixed = await js(`(async () => {
    const ta = document.querySelectorAll('#cm-lines textarea')[4];
    ta.value = '{task} 做完了吗？'; ta.dispatchEvent(new Event('input')); ta.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    const bad = ta.parentElement.querySelector('.cm-problem').textContent;
    ta.value = '我还在等你，宝贝。{work}。'; ta.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    return bad + ' | ' + ta.parentElement.querySelector('.cm-problem').textContent;
  })()`);
  console.log('SMOKE coach line check:', JSON.stringify(fixed));
  await js(`document.querySelector('.cm-use .btn-ink')?.click()`);
  await wait(800);
  console.log('SMOKE coach active:', profile?.customCoach === c.id, profile?.persona, JSON.stringify(levelLine(2, getProfile().persona, { site: 'YouTube', goal: 'Finish the deck', min: 12, work: 'the deck' })));
  console.log('SMOKE coach system:', JSON.stringify(coachSystem(getProfile().persona, false, false).split('\n').slice(1, 4).join(' ').slice(0, 300)));
  console.log('SMOKE coach agent:', agentLanguage(), JSON.stringify(personaVoice(getProfile().persona).slice(0, 120)), JSON.stringify(opener('checkin', getProfile().persona)));
  // Their voice: tick the consent, and the page cuts Mum out of the recording.
  await js(`document.getElementById('cm-voice')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, '66-coach-voice');
  await js(`(() => { const b = document.querySelector('.cm-consent input'); b.click(); })()`);
  await wait(200);
  await js(`[...document.querySelectorAll('#cm-voice button')].find((b) => b.textContent?.startsWith('Make'))?.click()`);
  await wait(3000);
  const cv = coaches.view(c.id)!;
  console.log('SMOKE coach voice:', JSON.stringify(cv.voice ?? cv.lastError), 'speaks in', coachVoiceId());
  await js(`document.getElementById('cm-voice')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, '67-coach-voice-made');
  await js(`window.scrollTo(0, 0); document.getElementById('view').scrollTop = 0`);
  await wait(300);
  await shot(windows.main, '68-coach-active');
  // The coach speaks as Mum during a drift (preview), then back to the built-in coach.
  await coach.preview(2);
  await wait(1200);
  const toastText = await windows.toast?.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  console.log('SMOKE coach toast:', JSON.stringify(String(toastText).replace(/\s+/g, ' ').slice(0, 160)));
  await shot(windows.toast, '69-coach-toast');
  coach.dismissPreview();
  const bk = readBackup(makeBackup(store.dir, app.getVersion()));
  console.log('SMOKE coach backup:', JSON.stringify(bk.files.map((f) => f.name).filter((n) => n.startsWith('coaches/')).map((n) => n.split('/').pop())));
  profile = { ...getProfile(), customCoach: undefined, persona: 'sassy' };
  store.saveProfile(profile);
  applyCoach();
  console.log('SMOKE coach off:', JSON.stringify(levelLine(2, 'sassy', { site: 'YouTube', goal: 'Finish the deck', min: 12, work: 'the deck' })).slice(0, 80), agentLanguage());
}

/** Lock In on a phone: turning it on, pairing with the code, and every tab, in a phone-sized window. */
async function phoneSmoke(
  wait: (ms: number) => Promise<unknown>,
  shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>,
  nav: (r: string) => Promise<void>,
  errors: string[],
): Promise<void> {
  const { BrowserWindow } = await import('electron');
  await handlers.get('phone:enable')!({} as Electron.IpcMainInvokeEvent, true);
  const st = (await handlers.get('phone:pair')!({} as Electron.IpcMainInvokeEvent)) as Awaited<ReturnType<typeof phoneStatus>>;
  console.log('SMOKE phone server:', st.running, st.error || 'ok', 'urls:', st.urls.length, 'qr:', st.qr.slice(0, 22), 'code:', !!st.pairing);
  await nav('settings');
  await wait(1200);
  await windows.main?.webContents.executeJavaScript(`document.getElementById('phone-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(400);
  await shot(windows.main, '70-setup-phone');

  const win = new BrowserWindow({ width: 390, height: 844, show: true, webPreferences: { partition: 'phone-smoke' } });
  win.webContents.on('console-message', (e) => {
    const ev = e as unknown as { level: string | number; message: string };
    if (ev.level === 'error' || ev.level === 3) errors.push(`phone: ${ev.message}`);
  });
  win.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await win.loadURL(`http://127.0.0.1:${phone!.port}/`);
  await wait(900);
  const pjs = (code: string) => win.webContents.executeJavaScript(code).catch((e: Error) => `ERR ${e.message}`);
  await shot(win, '71-phone-pair');
  // A wrong code first, then the right one.
  await pjs(`(() => { const i = document.querySelector('.code'); i.value = '${st.pairing!.code === '000000' ? '111111' : '000000'}'; i.dispatchEvent(new Event('input')); })()`);
  await wait(800);
  console.log('SMOKE phone wrong code:', JSON.stringify(await pjs(`document.querySelector('.err')?.textContent`)));
  await pjs(`(() => { const i = document.querySelector('.code'); i.value = '${st.pairing!.code}'; i.dispatchEvent(new Event('input')); })()`);
  await wait(1500);
  const tabs = ['home', 'todos', 'friends', 'coach'];
  for (const [i, t] of tabs.entries()) {
    await pjs(`document.querySelectorAll('.tabs button')[${i}].click()`);
    await wait(1400);
    await shot(win, `7${2 + i}-phone-${t}`);
    console.log(`SMOKE phone ${t}:`, JSON.stringify(String(await pjs(`document.querySelector('.view').innerText`)).replace(/\s+/g, ' ').slice(0, 220)));
  }
  // Talk: tell the coach what you did.
  await pjs(`(() => { const t = document.querySelector('.composer textarea'); t.value = 'sent the deck to Sam'; document.querySelector('.composer .btn').click(); })()`);
  await wait(2000);
  await shot(win, '76-phone-talk');
  console.log('SMOKE phone chat:', JSON.stringify(String(await pjs(`[...document.querySelectorAll('.msg')].map((m) => m.className.replace('msg ', '') + ': ' + m.textContent).join(' | ')`)).slice(0, 300)));
  // Someone you know: the list, then Mum.
  await pjs(`document.querySelectorAll('.seg button')[1].click()`);
  await wait(1200);
  await shot(win, '77-phone-people');
  await pjs(`document.querySelector('.person')?.click()`);
  await wait(1400);
  await shot(win, '78-phone-coach');
  await pjs(`window.scrollTo(0, document.body.scrollHeight)`);
  await wait(400);
  await shot(win, '79-phone-coach-sources');
  // Back on Lock in: a glass of water, then start a session from the phone.
  await pjs(`document.querySelectorAll('.tabs button')[0].click()`);
  await wait(1200);
  const w0 = goalsView().now.water;
  await pjs(`document.querySelector('.goals .btn.water')?.click()`);
  await wait(1200);
  await pjs(`document.querySelector('.goals')?.scrollIntoView({ block: 'start' })`);
  await shot(win, '79b-phone-goals');
  console.log('SMOKE phone goals:', goalsView().now.water - w0, JSON.stringify(String(await pjs(`document.querySelector('.goals')?.innerText`)).replace(/\s+/g, ' ').slice(0, 300)));
  await pjs(`window.scrollTo(0, 0)`);
  await pjs(`(() => { const g = document.querySelector('.goal'); g.value = 'Finish the pitch deck'; document.querySelector('.start .btn.big').click(); })()`);
  await wait(2000);
  await shot(win, '80-phone-live');
  console.log('SMOKE phone session:', JSON.stringify(sess?.record.goal), sess?.record.plannedMin);
  if (sess) endSession('user');
  await nav('settings');
  await wait(900);
  await windows.main?.webContents.executeJavaScript(`document.getElementById('phone-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(400);
  await shot(windows.main, '81-setup-phone-paired');
  console.log('SMOKE phone paired:', JSON.stringify(((await phoneStatus()).devices).map((d) => d.name)));
  win.destroy();
  await handlers.get('phone:enable')!({} as Electron.IpcMainInvokeEvent, false);
}

/** A week that ran long (no breaks, little water, late nights), for the goals smoke and screenshots. */
function seedGoalsDemo(): void {
  for (let i = 7; i >= 1; i--) {
    const d0 = new Date();
    d0.setDate(d0.getDate() - i);
    d0.setHours(12, 0, 0, 0);
    const k = dayKey(d0.getTime());
    const start = new Date(d0);
    start.setHours(9 + (i % 2), 10 * i, 0, 0);
    const end = new Date(d0);
    if (i % 3) {
      end.setDate(end.getDate() + 1);
      end.setHours(0, 20 + 9 * i, 0, 0);
    } else end.setHours(23, 15, 0, 0);
    rhythm.days[k] = { day: k, activeMin: 560 + 20 * i, first: start.getTime(), last: end.getTime(), longestMin: 130 + 12 * i, breaks: 3, water: i % 4 ? [] : [start.getTime() + 3_600_000], hours: new Array(24).fill(0) };
  }
  pastCache = null;
}

/** Goals (beta): seeded days, the IPC handlers, and the page (adding, accepting, "not now"). */
async function goalsSmoke(
  wait: (ms: number) => Promise<unknown>,
  shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>,
  nav: (r: string) => Promise<void>,
  prefix: string,
): Promise<void> {
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({} as Electron.IpcMainInvokeEvent, ...a) as Promise<unknown> | unknown;
  const js = (code: string) => windows.main!.webContents.executeJavaScript(code).catch((e: Error) => `ERR ${e.message}`);
  seedGoalsDemo();
  const before = goalsView();
  console.log('SMOKE goals noticed:', JSON.stringify(before.suggestions.map((x) => [x.kind, x.name, x.evidence])));
  // Big goals: a week of what you did, in words.
  const ago = (i: number, hr = 15) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    d.setHours(hr, 0, 0, 0);
    return d.getTime();
  };
  for (const [i, title] of [[6, 'Fix Lock In onboarding'], [6, 'Investor update email'], [4, 'Lock In: goals page'], [4, 'Pitch deck v3'], [2, 'Ship Lock In 1.2'], [1, 'Quorum landing page']] as const) todos.doneLog.add({ at: ago(i), day: dayKey(ago(i)), title, source: 'lockin' });
  await todos.add('Reply to investors from Thursday').catch(() => undefined);
  await todos.refresh(true).catch(() => undefined);
  pastCache = null;
  await nav('goals');
  await wait(900);
  await shot(windows.main, `${prefix}0-big-empty`);
  // The first big goal from the page itself.
  await js(`(() => { const t = document.querySelector('.big-q input'); t.value = 'Fundraise well'; const w = document.querySelector('.big-composer > input'); w.value = 'Runway through next year'; [...document.querySelectorAll('.big-composer .btn')].find((b) => b.textContent === 'Add goal').click(); })()`);
  await wait(1200);
  await call('goals:add', { kind: 'custom', title: 'Launch cool side products', why: 'Small bets, shipped', until: `${new Date().getFullYear()}-12-31` });
  await call('goals:add', { kind: 'custom', title: '' });
  await call('goals:add', { kind: 'focus', target: 3, days: 'weekdays', why: 'The fundraise needs the deck done' });
  await call('goals:add', { kind: 'water', target: 99 });
  const clamped = goalsData.goals.find((g) => g.kind === 'water')?.target;
  await call('goals:add', { kind: 'water', target: 6 });
  const bigV = goalsView();
  console.log('SMOKE big goals:', JSON.stringify(bigV.goals.filter((g) => g.kind === 'custom').map((g) => ({ title: g.title, until: g.until, status: g.status, next: g.nextStep, moved: g.moved?.map((m) => `${m.label}: ${m.text}`), terms: g.terms }))));
  console.log('SMOKE big questions:', JSON.stringify(bigV.questions.map((q) => [q.text, q.goalIds.length, q.evidence])));
  console.log('SMOKE counts toward:', JSON.stringify(countsToward('Pitch deck review')), JSON.stringify(countsToward('Buy groceries')));
  await nav('home');
  await wait(400);
  await nav('goals');
  await wait(900);
  await shot(windows.main, `${prefix}0b-big`);
  await js(`document.getElementById('ask-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, `${prefix}0c-ask`);
  await call('goals:water');
  await call('goals:water');
  const v = goalsView();
  console.log('SMOKE goals:', JSON.stringify(v.goals.map((g) => [g.name, g.progress, g.status, g.tone, `${g.hits}/${g.of}`])), 'water now:', v.now.water, 'hydrate on:', routines.find((r) => r.kind === 'hydrate')?.enabled, 'water 99 became:', clamped, 'goals:', goalsData.goals.length);
  console.log('SMOKE goals coach line:', JSON.stringify(goalsForCoach(v.goals)).slice(0, 260));
  await nav('goals');
  await wait(900);
  await shot(windows.main, `${prefix}1-goals`);
  console.log('SMOKE goals page:', JSON.stringify(String(await js(`document.querySelector('.goals-page')?.innerText`)).replace(/\s+/g, ' ').slice(0, 400)));
  await js(`document.getElementById('noticed-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, `${prefix}2-goals-noticed`);
  // "Make it a goal" on the first idea, "Not now" on the next.
  const n0 = goalsData.goals.length;
  await js(`[...document.querySelectorAll('#noticed-sec .goal-sug .btn')].find((b) => b.textContent === 'Make it a goal')?.click()`);
  await wait(500);
  await js(`[...document.querySelectorAll('#noticed-sec .goal-sug .btn')].find((b) => b.textContent === 'Not now')?.click()`);
  await wait(500);
  console.log('SMOKE goals accepted:', goalsData.goals.length - n0, 'later:', JSON.stringify(Object.keys(goalsData.memo)), 'left:', JSON.stringify(goalsView().suggestions.map((x) => x.kind)));
  // Add one by hand: the Stop time builder.
  await js(`[...document.querySelectorAll('#add-goal-sec .chip.pick')].find((b) => b.textContent === 'Stop time')?.click()`);
  await wait(700);
  await shot(windows.main, `${prefix}3-goals-add`);
  await js(`(() => { const i = document.querySelector('.goal-composer input[type=time]'); if (i) i.value = '23:45'; [...document.querySelectorAll('.goal-composer .btn')].find((b) => b.textContent === 'Add goal')?.click(); })()`);
  await wait(800);
  console.log('SMOKE goals by hand:', JSON.stringify(goalsData.goals.filter((g) => g.kind === 'bedtime').map((g) => goalName(g))));
  await js(`document.querySelector('.goal-card .goal-edit-btn')?.click()`);
  await wait(400);
  await js(`document.getElementById('goals-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, `${prefix}4-goals-edit`);
  await js(`document.getElementById('rhythm-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, `${prefix}5-goals-week`);
  // Cards that wait for a natural pause: a big-goal check-in, the question, "Lock In noticed something".
  const t0 = new Date().setHours(14, 0, 0, 0);
  attentionFrozen = true;
  lastGoalTick = 0;
  goalsData.lastPingDay = undefined;
  goalsData.askedDay = undefined;
  goalsData.checkin = {};
  goalsData.memo = {};
  const quiet = guard.muteUntil;
  guard.muteUntil = 0;
  goalTick(t0, false, 0);
  guard.muteUntil = quiet;
  // Keep the real clock's goal tick from adding cards while we look.
  lastGoalTick = Date.now() + 5 * 60_000;
  const offered = attention.waiting();
  const sig = (t: number) => ({ now: t, day: dayKey(t), idleSec: 0, calm: true, inSession: false, inMeeting: false, todosDone: todos.summary().doneToday });
  attention.state.lastActiveAt = t0;
  attention.state.lastCardAt = 0;
  attention.tick(sig(t0 + 1000));
  const heldMidTask = attention.waiting().length === offered.length;
  const cards: string[] = [];
  for (let k = 1; k <= offered.length; k++) {
    // Away for a while, back, settled for 25 seconds: the next card goes out.
    const back = t0 + k * 30 * 60_000;
    const m = attention.tick(sig(back));
    attention.tick(sig(back + 25_000));
    await wait(1200);
    cards.push(`${m}: ${String(await windows.toast?.webContents.executeJavaScript('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ').slice(0, 220)}`);
    await shot(windows.toast, `${prefix}6-card-${k}`);
    // Closing it with × counts as a "no thanks": Lock In remembers.
    windows.closeToast();
  }
  attentionFrozen = false;
  console.log('SMOKE cards at pauses:', JSON.stringify({ offered, heldMidTask, left: attention.waiting() }), JSON.stringify(cards));
  await nav('goals');
  await wait(900);
  await js(`document.getElementById('ask-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  // "Yes, it counts": Lock In counts toward side products from now on.
  await js(`[...document.querySelectorAll('#ask-sec .btn')].find((b) => b.textContent === 'Yes, it counts')?.click()`);
  await wait(700);
  console.log('SMOKE big answered:', JSON.stringify(goalsData.goals.filter((g) => g.kind === 'custom').map((g) => [g.title, g.counts])), 'questions left:', goalsView().questions.length);
  await js(`document.getElementById('big-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, `${prefix}0d-big-after`);
  console.log('SMOKE attention learned:', JSON.stringify(Object.fromEntries(Object.entries(attention.state.stats).map(([k, v]) => [k, `${v.shown} shown, streak ${v.streak}`]))));
  await nav('goals');
  await wait(900);
  await js(`document.getElementById('reach-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(windows.main, `${prefix}6b-goals-reach`);
  console.log('SMOKE attention page:', JSON.stringify(String(await js(`document.getElementById('reach-sec')?.innerText`)).replace(/\s+/g, ' ').slice(0, 300)));
  await nav('home');
  await wait(1200);
  await shot(windows.main, `${prefix}7-home-goals`);
  console.log('SMOKE goals strip:', JSON.stringify(String(await js(`document.querySelector('.goal-strip')?.innerText`)).replace(/\s+/g, ' ')));
}

/** LOCKIN_OUTLINE=1 (with LOCKIN_LOOK): every page's headings and fields, and the whole page in screenshots, for reviewing what goes where. */
async function outlineShots(wait: (ms: number) => Promise<unknown>, shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>, nav: (r: string) => Promise<void>): Promise<void> {
  const w = windows.main!;
  const js = (code: string) => w.webContents.executeJavaScript(code).catch((e: Error) => `ERR ${e.message}`);
  const outline: Record<string, unknown> = {};
  for (const route of ['home', 'todos', 'goals', 'progress', 'friends', 'coach', 'settings']) {
    await nav(route);
    await wait(1500);
    const o = await js(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('#view h1, #view h2, #view h3, #view h4, #view .field > label, #view .choice b, #view summary')) {
        if (el.closest('[hidden]') || !el.offsetParent) continue;
        const t = (el.childNodes[0] && el.childNodes[0].textContent || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90);
        out.push((el.matches('.field > label') ? 'field' : el.tagName.toLowerCase()) + ': ' + t);
      }
      return JSON.stringify({ height: document.getElementById('view').scrollHeight, outline: out });
    })()`);
    outline[route] = JSON.parse(String(o));
    const height = (outline[route] as { height: number }).height;
    for (let i = 0, y = 0; y < height && i < 14; i++, y += 900) {
      await js(`document.getElementById('view').scrollTop = ${y}`);
      await wait(250);
      await shot(w, `O-${route}-${String(i).padStart(2, '0')}`);
    }
  }
  writeFileSync(join(process.env.LOCKIN_SHOTS!, 'outline.json'), JSON.stringify(outline, null, 2));
}

/** LOCKIN_ONBOARD=1 (with LOCKIN_SMOKE and LOCKIN_SHOTS): first setup, step by step, then the panel. */
async function onboardShots(wait: (ms: number) => Promise<unknown>, shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>, errors: string[]): Promise<void> {
  const w = windows.main;
  if (!w) {
    errors.push('no setup window');
    return;
  }
  w.webContents.on('console-message', (e) => {
    const ev = e as unknown as { level: string | number; message: string };
    if (ev.level === 'error' || ev.level === 3) errors.push(`[setup] ${ev.message}`);
  });
  const js = (code: string) => w.webContents.executeJavaScript(code).catch((e: Error) => `ERR ${e.message}`);
  const next = async () => {
    await js(`document.querySelector('.quiz-next')?.click()`);
    await wait(600);
  };
  // Everything inside the setup sheet (the settings page sits behind it).
  const type = (sel: string, text: string, i = 0) => js(`(() => { const el = document.querySelectorAll(${JSON.stringify(`.quiz ${sel}`)})[${i}]; el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const enter = (sel: string) => js(`document.querySelector(${JSON.stringify(`.quiz ${sel}`)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  const click = (sel: string, text: string) => js(`[...document.querySelectorAll(${JSON.stringify(`.quiz ${sel}`)})].find((b) => b.textContent.includes(${JSON.stringify(text)}))?.click()`);
  await wait(800);
  await shot(w, 'O01-goals-empty');
  await type('.goal-row-in input[type=text]', 'Fundraise well');
  await type('.goal-row-in input[type=date]', '2027-03-31');
  await click('.chips .chip', 'Launch my side projects');
  await wait(200);
  await click('.chips .chip', 'Drink water 8 times a day');
  await wait(200);
  await shot(w, 'O02-goals');
  await next();
  await shot(w, 'O03-todos-empty');
  for (const t of ['Record the YC video', 'Reply to investors from Demo Day', 'Fix Lock In']) {
    await type('.add-row input', t);
    await enter('.add-row input');
    await wait(120);
  }
  await shot(w, 'O04-todos');
  await next();
  await shot(w, 'O05-distractions');
  await click('.chips .chip', 'Discord');
  await wait(150);
  await click('.chips .chip', 'News & HN');
  await wait(150);
  await type('.add-row input', 'espn.com');
  await enter('.add-row input');
  await wait(300);
  await click('.chips .chip', 'Founder');
  await wait(150);
  await click('.chips .chip', 'Student');
  await wait(150);
  await js(`document.querySelector('.quiz').scrollTop = 9999`);
  await wait(200);
  await shot(w, 'O06-distractions-picked');
  await next();
  await wait(2500);
  await shot(w, 'O07-connect');
  // The four connections: show the padlock, start the extension, connect the calendar.
  await js(`[...document.querySelectorAll('.quiz .connect-row[data-key="calendar"] button')].find((b) => /Connect/.test(b.textContent))?.click()`);
  await wait(1500);
  await js(`document.querySelector('.quiz .connect-row[data-key="extension"] button')?.click()`);
  await wait(800);
  await js(`document.querySelector('.quiz .connect-row[data-key="padlock"] button')?.click()`);
  await wait(900);
  w.focus();
  await wait(400);
  await shot(w, 'O07b-connect-progress');
  await js(`document.querySelector('.quiz').scrollTop = 9999`);
  await wait(300);
  await shot(w, 'O07c-connect-bottom');
  console.log('SMOKE onboard connect:', JSON.stringify(await js(`[...document.querySelectorAll('.quiz .connect-row')].map((r) => r.dataset.key + (r.classList.contains('done') ? ' ✓' : ' …')).join(', ') + ' | ' + document.querySelector('.quiz .quiz-foot').innerText.split(String.fromCharCode(10)).join(' ')`)));
  console.log('SMOKE onboard goals:', JSON.stringify(goalsData.goals.map((g) => goalName(g))));
  console.log('SMOKE onboard todos:', settings.todo.provider, JSON.stringify(todos.openRanked().map((t) => t.title)));
  console.log('SMOKE onboard distraction apps:', JSON.stringify(Object.keys(getProfile().distractionApps)), 'roles:', JSON.stringify(getProfile().roles));
  console.log('SMOKE onboard sites:', JSON.stringify(Object.entries(getProfile().distractionDomains).filter(([, v]) => v > 1.2).map(([d]) => d)), 'work apps:', JSON.stringify(getProfile().workApps.slice(0, 8)));
  const doneText = await js('document.querySelector(".quiz").innerText');
  console.log('SMOKE onboard done:', JSON.stringify(String(doneText).replace(/\s+/g, ' ').slice(0, 300)));
  await js(`document.querySelector('.quiz-open')?.click()`);
  await wait(1800);
  await shot(windows.panel, 'O08-panel');
  console.log('SMOKE onboard after:', JSON.stringify({ windowOpen: !!windows.main && !windows.main.isDestroyed(), panel: windows.panelVisible }));
}

/** LOCKIN_PANEL=1 (with LOCKIN_SMOKE and LOCKIN_SHOTS): the menu bar panel in its states, for design passes. */
async function panelShots(wait: (ms: number) => Promise<unknown>, shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>, errors: string[]): Promise<void> {
  if (!profile) {
    profile = buildDefaultProfile('founder');
    store.saveProfile(profile);
  }
  windows.main?.destroy();
  if (process.env.LOCKIN_PANEL === 'light' || process.env.LOCKIN_PANEL === 'dark') nativeTheme.themeSource = process.env.LOCKIN_PANEL;
  settings = { ...settings, ui: 'panel', todo: { ...settings.todo, provider: 'builtin' } };
  store.saveSettings(settings);
  applyUi();
  for (const t of ['Fix Lock In', 'YC application: the 1-minute video', 'Reply to investors from Demo Day', 'Alumni: send out messages', 'New deck: storytelling']) await todos.add(t);
  await todos.refresh(true);
  const first = todos.openRanked().at(-1);
  if (first) await todos.complete(first.id);
  const d = new Date(Date.now() - 86_400_000);
  deadlines.add({ title: 'YC application', due: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
  if (!goalsData.goals.some((g) => g.kind === 'water')) addGoal({ kind: 'water', target: 8 });
  if (!goalsData.goals.some((g) => g.kind === 'focus')) addGoal({ kind: 'focus', target: 4 });
  rhythm.logWater(Date.now());
  rhythm.logWater(Date.now());
  saveGoals();
  if (!crew.joined) crew.create('Cofounders', 'Grace');
  appState.lastGoal = 'writing a script for YC';
  pushState();
  await wait(1200);
  windows.showPanel({ x: 1100, y: 0, width: 28, height: 24 });
  await wait(1600);
  windows.panel?.webContents.on('console-message', (e) => {
    const ev = e as unknown as { level: string | number; message: string };
    if (ev.level === 'error' || ev.level === 3) errors.push(`[panel] ${ev.message}`);
  });
  await shot(windows.panel, 'P01-idle');
  startSession('writing a script for YC', 50);
  if (sess) {
    sess.record.focusSec = 22 * 60;
    sess.record.startedAt -= 26 * 60_000;
  }
  pushState();
  await wait(1500);
  windows.showPanel();
  await wait(900);
  await shot(windows.panel, 'P02-session');
  if (sess) sess.engine.level = 3 as never;
  pushState();
  await wait(1100);
  await shot(windows.panel, 'P03-drifting');
  settings = { ...settings, commitmentMode: true };
  await windows.panel?.webContents.executeJavaScript(`[...document.querySelectorAll('.live-acts .btn-s')].find((b) => b.textContent.includes('End'))?.click()`);
  await wait(700);
  await windows.panel?.webContents.executeJavaScript(`void 0`);
  await shot(windows.panel, 'P04-commit');
  settings = { ...settings, commitmentMode: false };
  endSession('user');
  await wait(1200);
  await windows.panel?.webContents.executeJavaScript(`[...document.querySelectorAll('#crew .btn-s.danger')][0]?.click()`);
  await wait(600);
  await shot(windows.panel, 'P05-after-bomb-picker');
  const text = await windows.panel?.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  console.log('SMOKE panel:', JSON.stringify(String(text).replace(/\s+/g, ' ').slice(0, 600)));
  console.log('SMOKE panel bounds:', JSON.stringify(windows.panel?.getBounds()));
  // A friend's bomb: every distraction locked for 5 minutes, then the screen for 5 seconds.
  const outcome = bombLanded({ id: 'smoke-bomb', from: 'sam', name: 'Sam', insult: 'I can hear you scrolling from here.' });
  await wait(1200);
  await shot(windows.overlay, 'P07-bomb-card');
  const card = await windows.overlay?.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  console.log('SMOKE bomb:', outcome, JSON.stringify(liveState().lockout), JSON.stringify(String(card).replace(/\s+/g, ' ').slice(0, 160)));
  await wait(5200);
  windows.hideOverlay();
  windows.showPanel();
  await wait(1200);
  await shot(windows.panel, 'P08-locked-out');
  // Settings opens the window; the panel goes away.
  openPage('settings');
  await wait(1800);
  await shot(windows.main, 'P06-settings-window');
  const rail = await windows.main?.webContents.executeJavaScript(`[...document.querySelectorAll('.rail a')].filter((a) => a.offsetParent).map((a) => a.textContent.trim()).join(' | ')`).catch(() => '');
  console.log('SMOKE settings rail:', rail, 'title:', windows.main?.getTitle(), 'panel visible:', windows.panelVisible);
}

/** LOCKIN_LOOK=1 (with LOCKIN_SMOKE and LOCKIN_SHOTS): just the look, page by page, for design passes. */
async function lookShots(
  wait: (ms: number) => Promise<unknown>,
  shot: (win: Electron.BrowserWindow | null, name: string) => Promise<void>,
  nav: (r: string) => Promise<void>,
): Promise<void> {
  const w = windows.main!;
  const js = (code: string) => w.webContents.executeJavaScript(code).catch((e: Error) => `ERR ${e.message}`);
  const move = async (x: number, y: number) => {
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await wait(120);
  };
  if (!profile) {
    profile = buildDefaultProfile('founder');
    store.saveProfile(profile);
    windows.main?.reload();
    await wait(1500);
  }
  if (process.env.LOCKIN_LOOK === 'classic') settings = { ...settings, look: { theme: 'classic', keyCursor: false } };
  settings = { ...settings, todo: { ...settings.todo, provider: 'builtin' } };
  store.saveSettings(settings);
  for (const t of ['Try the new product', 'Alumni: send out messages', 'Demo video', 'Fix Lock In', 'Respond to all investors and customers met', 'New deck: storytelling', 'Redo the intro', 'Schedule call', 'Call the bank']) await todos.add(t);
  await todos.refresh(true);
  const first = todos.openRanked().at(-1);
  if (first) await todos.complete(first.id);
  w.reload();
  await wait(1800);
  await move(700, 300);
  await shot(w, 'L01-home');
  await nav('todos');
  await wait(900);
  await move(260, 252);
  await shot(w, 'L02-todos-rail-hover');
  const r = JSON.parse(String(await js(`JSON.stringify(document.querySelectorAll('.todos .lock-btn')[1]?.getBoundingClientRect())`)) || '{}') as { x: number; y: number; width: number; height: number };
  if (r.x) {
    await move(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    await wait(300);
    await shot(w, 'L03-todos-lock-hover');
    w.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), button: 'left', clickCount: 1 });
    await wait(470);
    await shot(w, 'L04-todos-unlocking');
    await wait(1400);
    await shot(w, 'L05-todos-after');
  }
  await js(`document.getElementById('view').scrollTop = 520`);
  await move(640, 420);
  await shot(w, 'L06-todos-done');
  // Unlocking another page: the cell door mid-slide.
  w.webContents.send('nav', 'friends');
  await wait(260);
  await shot(w, 'L07-door');
  await wait(900);
  await shot(w, 'L08-friends');
  unlocked = { ...(unlocked ?? {}), 'first-lock': Date.now(), 'night-owl': Date.now() };
  w.webContents.send('nav', 'home');
  await wait(400);
  await nav('friends');
  await wait(700);
  await js(`document.getElementById('ach-sec')?.scrollIntoView({ block: 'start' })`);
  await move(400, 160);
  await move(420, 170);
  await shot(w, 'L08b-achievements');
  await goalsSmoke(wait, shot, nav, 'LG');
  for (const [route, name] of [['coach', 'L09-coach'], ['settings', 'L10-settings'], ['progress', 'L10b-progress']] as const) {
    await nav(route);
    await wait(700);
    await move(700, 380);
    await shot(w, name);
  }
  await js(`document.getElementById('look-sec')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  await shot(w, 'L11-look');
  await nav('home');
  await wait(600);
  startSession('Finish the pitch deck', 50);
  await wait(2500);
  await shot(w, 'L12-live');
  if (sess) endSession('user');
  if (process.env.LOCKIN_OUTLINE) await outlineShots(wait, shot, nav);
}

/** LOCKIN_SMOKE=1: exercise every window and a session, then exit. Used in CI/dev checks. */
async function smokeTest(): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const errors: string[] = [];
  for (const w of [windows.main, windows.voice]) {
    w?.webContents.on('console-message', (e) => {
      const ev = e as unknown as { level: string | number; message: string };
      if (ev.level === 'error' || ev.level === 3) errors.push(ev.message);
    });
  }
  const shotsDir = process.env.LOCKIN_SHOTS;
  const shot = async (win: Electron.BrowserWindow | null, name: string) => {
    if (!shotsDir || !win || win.isDestroyed()) return;
    const img = await win.webContents.capturePage();
    writeFileSync(join(shotsDir, `${name}.png`), img.toPNG());
  };
  const nav = async (r: string) => {
    windows.main?.webContents.send('nav', r);
    await wait(900);
  };
  await wait(2500);
  if (process.env.LOCKIN_ONBOARD) {
    await onboardShots(wait, shot, errors);
    console.log('SMOKE onboard errors:', JSON.stringify(errors));
    app.exit(errors.length ? 1 : 0);
    return;
  }
  if (process.env.LOCKIN_PANEL) {
    await panelShots(wait, shot, errors);
    console.log('SMOKE panel errors:', JSON.stringify(errors));
    app.exit(errors.length ? 1 : 0);
    return;
  }
  if (process.env.LOCKIN_LOOK) {
    await lookShots(wait, shot, nav);
    app.exit(0);
    return;
  }
  if (shotsDir) {
    await shot(windows.main, '01-quiz-goals');
    const js = (code: string) => windows.main?.webContents.executeJavaScript(code);
    const clickChip = (label: string) => js(`[...document.querySelectorAll('.quiz .chip')].find((b) => b.textContent?.startsWith(${JSON.stringify(label)}))?.click()`);
    await js(`document.querySelector('.quiz-next')?.click()`);
    await wait(700);
    await shot(windows.main, '02-quiz-todos');
    await clickChip('Spreadsheet');
    await wait(900);
    await shot(windows.main, '02b-quiz-sheet');
  }
  if (!profile) {
    profile = buildDefaultProfile('founder');
    store.saveProfile(profile);
  }
  // A spreadsheet to-do list to exercise the to-do features.
  const sheetPath = join(store.dir, 'smoke-todos.csv');
  const junk = 'Weekly tracker,,,\nTOTAL TASKS,4,,\nFilter Week:,Week 3,,\n,,,\n';
  writeFileSync(sheetPath, `${junk}Task,Done,Due,Priority\nSend the investor update,FALSE,10/16/2026,High\nFinish the pitch deck,FALSE,10/18/2026,High\nReply to Sam about pricing,FALSE,,\nBook flights,TRUE,,Low\nTotal,1,,\n`);
  settings = { ...settings, todo: { ...settings.todo, provider: 'sheet', sheet: { ...settings.todo.sheet, kind: 'file', path: sheetPath } } };
  store.saveSettings(settings);
  await todos.refresh(true);
  writeFileSync(sheetPath, `${junk}Task,Done,Due,Priority\nSend the investor update,TRUE,10/16/2026,High\nFinish the pitch deck,FALSE,10/18/2026,High\nReply to Sam about pricing,FALSE,,\nBook flights,TRUE,,Low\nTotal,1,,\n`);
  await new Promise((r) => setTimeout(r, 50));
  await todos.refresh(true);
  if (shotsDir) {
    windows.main?.reload();
    await wait(1500);
    await shot(windows.main, '03-home-idle');
    await nav('settings');
    await shot(windows.main, '04-setup');
    await nav('settings');
    await shot(windows.main, '05-settings');
    await windows.main?.webContents.executeJavaScript(`document.querySelector('.matrix')?.scrollIntoView({ block: 'start' })`);
    await wait(400);
    await shot(windows.main, '05b-notifications');
    await nav('todos');
    await wait(400);
    await shot(windows.main, '13-todos');
    await windows.main?.webContents.executeJavaScript(`document.querySelector('.sheet-setup')?.scrollIntoView({ block: 'start' })`);
    await wait(900);
    await shot(windows.main, '13b-todos-sheet');
    await windows.main?.webContents.executeJavaScript(`document.querySelector('.view').scrollTop = 0; document.querySelector('.todos .lock-btn:not(:disabled)')?.click()`);
    await wait(1500);
    await shot(windows.main, '13c-todos-ticked');
    console.log('SMOKE ticked:', JSON.stringify(todos.summary().doneToday), JSON.stringify(todos.doneToday().map((t) => [t.title, t.localOnly])));
    await nav('routines');
    await wait(400);
    await shot(windows.main, '14-routines');
    await nav('home');
  }
  startSession('Smoke test the coach', 25);
  await wait(1500);
  if (sess) sess.engine.drift = sess.engine.thresholdSec(2) * 0.8;
  await wait(1200);
  await shot(windows.main, '06-home-live');
  await coach.preview(1);
  await wait(800);
  await shot(windows.toast, '07-toast-nudge');
  await coach.preview(2);
  await wait(800);
  await shot(windows.toast, '08-toast-speak');
  await coach.preview(4);
  await wait(1200);
  await shot(windows.overlay, '09-overlay-red');
  await coach.preview(3);
  await wait(1500);
  await shot(windows.overlay, '10-overlay-yellow');
  for (const w of [windows.toast, windows.overlay]) {
    w?.webContents.on('console-message', (e) => {
      const ev = e as unknown as { level: string | number; message: string };
      if (ev.level === 'error' || ev.level === 3) errors.push(ev.message);
    });
  }
  const overlayText = await windows.overlay?.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  const mainText = await windows.main?.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  await coach.choose('back', 'button');
  await wait(500);
  endSession('user');
  await wait(1500);
  // Routines, roasts and celebrations through every surface.
  const top = todos.top();
  await announcer.todoEvent({ type: 'roast', severity: 2, activeMin: 154, sinceProgressMin: 120, open: 3, overdue: 1, done: 1, top });
  await wait(700);
  await shot(windows.toast, '15-toast-roast');
  await announcer.routine(routines.find((r) => r.id === 'kickoff')!, 0);
  await wait(700);
  await shot(windows.toast, '16-toast-kickoff');
  await announcer.todoEvent({ type: 'roast', severity: 3, activeMin: 200, sinceProgressMin: 170, open: 3, overdue: 1, done: 1, top });
  await wait(1200);
  await shot(windows.overlay, '17-card-roast');
  const roastCard = await windows.overlay?.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  await runAction('dismiss');
  await announcer.routine(routines.find((r) => r.id === 'bedtime')!, 2);
  await wait(1200);
  await shot(windows.overlay, '18-card-bedtime');
  await runAction('bed:bedtime');
  await announcer.todoEvent({ type: 'win', task: { id: 'w', title: 'Reply to Sam about pricing', completed: true }, done: 2, open: 2 });
  await wait(700);
  await shot(windows.toast, '19-toast-win');
  console.log('SMOKE roast card:', JSON.stringify(String(roastCard).slice(0, 160)));
  console.log('SMOKE todos:', JSON.stringify(todos.summary()));
  await newFeaturesSmoke(wait, shot, nav, errors);
  await coachesSmoke(wait, shot, nav);
  await goalsSmoke(wait, shot, nav, '6');
  await phoneSmoke(wait, shot, nav, errors);
  if (shotsDir) {
    await nav('today');
    await shot(windows.main, '11-today');
    await nav('profile');
    await wait(500);
    await shot(windows.main, '12-profile');
  }
  const dash = buildDashboard(store, null);
  console.log('SMOKE overlay:', JSON.stringify(String(overlayText).slice(0, 200)));
  console.log('SMOKE main:', JSON.stringify(String(mainText).slice(0, 200)));
  console.log('SMOKE sessions:', dash.sessions.length, 'errors:', JSON.stringify(errors));
  console.log(errors.length ? 'SMOKE FAIL' : 'SMOKE OK');
  app.exit(errors.length ? 1 : 0);
}

app.on('second-instance', () => (windows ? openPage() : undefined));
// Updating quits the running copy with SIGTERM; wind down properly so the session is saved.
process.on('SIGTERM', () => app.quit());
app.on('window-all-closed', () => {
  /* keep running in the menu bar */
});
app.on('activate', () => {
  if (!windows) return;
  // With the panel, the Dock icon is only there while Settings is open: clicking it brings Settings back.
  if (panelMode() && windows.main && !windows.main.isDestroyed()) windows.openMain();
  else openPage();
});
app.on('before-quit', () => {
  if (sess) endSession('quit');
  if (store && todos && settings?.exportCsv.auto) runExport();
  if (classifier) store.saveLabels(classifier.cache);
  helper?.stop();
  holdSpace?.stop();
  crew?.flush();
  bridge?.stop();
  globalShortcut.unregisterAll();
});

app.whenReady().then(boot).catch((e) => {
  console.error(e);
  app.exit(1);
});
