// Types shared by the main process, preload and renderer pages.

export type Label = 'work' | 'neutral' | 'distraction' | 'away' | 'private';
export type LabelSource = 'rule' | 'gray' | 'cache' | 'model' | 'user' | 'fallback' | 'call';
export type Persona = 'sassy' | 'gentle' | 'firm' | 'drill';
export type Role =
  | 'founder' | 'engineer' | 'pm' | 'designer' | 'finance' | 'data' | 'marketing' | 'creator'
  | 'sales' | 'ops' | 'student' | 'research' | 'writer' | 'legal' | 'teacher' | 'other';
export type RouteOption = 'back' | 'starter' | 'break' | 'is_work' | 'talk' | 'end';
export type Level = 0 | 1 | 2 | 3 | 4;

export interface GrayRule {
  domain: string;
  workIfTitleContains: string[];
}

export interface Profile {
  version: 1;
  createdAt: string;
  /** The first chosen role (kept for older profiles). */
  role: Role;
  /** Every role picked in the quiz. */
  roles?: Role[];
  /** "Something else", in their own words. */
  roleNote?: string;
  /** App names (as macOS shows them) that count as work. */
  workApps: string[];
  workDomains: string[];
  /** Domain → weight (1.0 default, higher = drift builds faster). */
  distractionDomains: Record<string, number>;
  /** App name → weight. */
  distractionApps: Record<string, number>;
  neutralApps: string[];
  grayRules: GrayRule[];
  schedule: { days: number[]; start: string } | null;
  toleranceMin: 2 | 5 | 10;
  persona: Persona;
  voice: { speak: boolean; listen: boolean };
  routeBackOrder: RouteOption[];
  /** A coach made from someone you know (its id); `persona` then holds how hard it pushes. */
  customCoach?: string;
}

// ---- notifications -----------------------------------------------------------

/** Every way Lock In can get your attention. */
export type Channel = 'toast' | 'card' | 'tab' | 'voice' | 'sound' | 'system' | 'menubar' | 'dock' | 'phone' | 'webhook';
/** Every kind of event that can notify you. */
export type NotifyKind =
  | 'nudge' | 'speak' | 'yellow' | 'red'
  | 'todo_roast' | 'todo_win'
  | 'routine' | 'wellness' | 'bedtime'
  | 'session' | 'meeting' | 'deadline';
export type SoundId =
  | 'none' | 'whistle' | 'airhorn' | 'buzzer' | 'chime' | 'ding' | 'sad_trombone' | 'fanfare'
  | 'Glass' | 'Ping' | 'Pop' | 'Purr' | 'Sosumi' | 'Submarine' | 'Tink' | 'Funk' | 'Hero' | 'Basso' | 'Blow' | 'Bottle' | 'Frog' | 'Morse';

export interface ActionButton {
  /** Parsed by the main process: "start:50:Goal", "start-top:50", "snooze:<routine>:<min>", "complete:<task>", "open:<route>", "mute-until-morning", "dismiss". */
  id: string;
  label: string;
}

// ---- to-dos --------------------------------------------------------------------

export type TodoProviderId = 'none' | 'builtin' | 'reminders' | 'things' | 'todoist' | 'sheet';

export interface SheetSettings {
  /** Google Sheets (a link, or the private connector's URL) or a file on this Mac. */
  kind: 'google' | 'file';
  /** Google Sheets link or Apps Script web app URL. */
  url: string;
  /** Excel, Numbers or CSV file. */
  path: string;
  /** Tab name; blank = pick the tab with your tasks (or the tab in the link). */
  tab: string;
  /** Secret shared with the private Google connector. */
  token: string;
  /** Column numbers (0 = A); null = detect automatically. */
  task: number | null;
  done: number | null;
  due: number | null;
  priority: number | null;
  /** The "assigned to" column; null = detect, -1 = none. */
  assignee: number | null;
  /** The project or category column; null = detect, -1 = none. */
  project?: number | null;
  /** Only rows assigned to this person. null = you, if your name is in the sheet; '' = everyone. */
  owner: string | null;
  /** Which open rows count: all of them, or only those due today or earlier (plus undated). */
  scope: 'all' | 'due';
}

export interface SheetPreview {
  ok: boolean;
  error?: string;
  /** "A: Task", "B: Done"… */
  columns: string[];
  map: { task: number | null; done: number | null; due: number | null; priority: number | null; assignee: number | null; project: number | null };
  open: number;
  done: number;
  sample: string[];
  canComplete: boolean;
  canAdd: boolean;
  mode: 'link' | 'script' | 'xlsx' | 'csv' | 'numbers' | 'none';
  /** Every tab in the file, when Lock In can see them. */
  tabs: string[];
  /** The tab actually read ('' when unknown). */
  tab: string;
  /** Why that tab, when Lock In picked it. */
  tabWhy?: string;
  /** 1-based row of the column names, or null when there are none. */
  headerRow: number | null;
  /** Rows that are in the task column but are not tasks (titles, totals, notes…). */
  skipped: number;
  skippedSample: string[];
  /** People in the "assigned to" column, and whose rows are being read ('' = everyone). */
  owners: string[];
  owner: string;
}

export interface Task {
  id: string;
  title: string;
  /** YYYY-MM-DD, local. */
  due?: string;
  priority?: number;
  project?: string;
  completed: boolean;
  completedAt?: number;
  /** Done items you told the coach about (not on your list). */
  said?: boolean;
  /** Ticked off in Lock In but not (yet) in the source list. */
  localOnly?: boolean;
}

export interface TodoSettings {
  provider: TodoProviderId;
  remindersList: string;
  remindersScope: 'today' | 'all';
  thingsList: string;
  todoistFilter: string;
  sheet: SheetSettings;
  roastsEnabled: boolean;
  /** Active screen minutes without finishing a task before the first roast. */
  noProgressMin: number;
  maxRoastsPerDay: number;
  celebrate: boolean;
  /** Rows you marked "not a task" (lower-cased titles). */
  hidden: string[];
}

// ---- talking, calendar, export ------------------------------------------------

export interface TalkSettings {
  /** After a to-do roast, open the mic so you can answer back. */
  afterRoast: boolean;
  /** Longest a conversation can run (keeps ElevenLabs credits in check). */
  maxMinutes: number;
  /** Hold the space bar anywhere to start talking (a tap still types a space). */
  holdSpace?: boolean;
}

export interface CalendarSettings {
  /** Private iCal (.ics) links: Google, Outlook, iCloud… */
  urls: string[];
  /** Read the Calendar app on this Mac (every account it syncs). */
  mac?: boolean;
  /** Calendar app calendars left out (ids). Unset = everything but birthdays, holidays and the like. */
  macExclude?: string[];
  /** No nags or roasts while a meeting is on. */
  quietInMeetings: boolean;
  /** Minutes of warning before a meeting; 0 = none. */
  headsUpMin: number;
  /** When a meeting ends and there is a real gap, offer to lock in on your top task. */
  offerGaps: boolean;
  /** Sessions end before your next meeting. */
  capSessions: boolean;
}

export interface CalEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  /** False for events marked "free" (transparent). */
  busy: boolean;
  location?: string;
  /** A Meet, Zoom or Teams link, when there is one. */
  link?: string;
  calendar: string;
}

export interface CalendarSummary {
  connected: boolean;
  error?: string;
  now?: { title: string; end: number };
  next?: { title: string; start: number; link?: string };
  /** Meetings left today. */
  left: number;
}

export interface Deadline {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  due: string;
  /** HH:MM, optional */
  time?: string;
  done: boolean;
  doneAt?: number;
  createdAt: number;
  /** The to-do it was made from; ticking that to-do finishes the deadline. */
  taskId?: string;
  project?: string;
}

/** One day of the week view on the To-dos page. */
export interface WeekDay {
  date: string;
  label: string;
  events: CalEvent[];
  deadlines: Deadline[];
  tasks: Task[];
}

export interface ExportSettings {
  /** Write the CSV files every day (and every hour, so today's is fresh). */
  auto: boolean;
  /** Folder for the files; blank = Documents/Lock In. */
  folder: string;
}

export interface TodoSummary {
  provider: TodoProviderId;
  connected: boolean;
  error?: string;
  open: number;
  overdue: number;
  doneToday: number;
  top?: string;
  activeMinToday: number;
  minSinceProgress: number;
  nextRoastInMin?: number;
  canComplete: boolean;
  canAdd: boolean;
  /** Shown under the list when ticks are kept in Lock In instead of written to the source. */
  tickNote?: string;
  /** How many rows you marked "not a task". */
  hidden: number;
}

// ---- routines -------------------------------------------------------------------

export type RoutineKind =
  | 'kickoff' | 'deepwork' | 'hydrate' | 'stretch' | 'eyes' | 'lunch' | 'midday' | 'shutdown' | 'bedtime' | 'weekly' | 'custom';

export type RoutineTrigger =
  | { type: 'time'; at: string; days: number[] }
  | { type: 'interval'; everyMin: number; from: string; to: string; days: number[] };

export interface Routine {
  id: string;
  kind: RoutineKind;
  name: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  /** Custom routines: what to say. */
  message?: string;
  /** Deep work and custom "lock in" routines: session length. */
  minutes?: number;
  /** Custom routines: offer to start a session. */
  offerSession?: boolean;
}

export interface Settings {
  notify: Record<NotifyKind, Channel[]>;
  sounds: Record<NotifyKind, SoundId>;
  ntfyServer: string;
  ntfyTopic: string;
  webhookUrl: string;
  todo: TodoSettings;
  /** One-time settings upgrades already applied (e.g. 'tab-card'). */
  migrated?: string[];
  /** Lock in with friends. */
  crew: CrewSettings;
  voiceId: string;
  /** The chosen voice's name, for showing it. */
  voiceName?: string;
  ttsModelLive: string;
  ttsModelShout: string;
  sttModel: string;
  sayVoice: string;
  coachModel: string;
  classifierModel: string;
  volumeCap: number;
  quietStart: string;
  quietEnd: string;
  profanityOk: boolean;
  titlesStayLocal: boolean;
  maxSpokenPerHour: number;
  commitmentMode: boolean;
  sensitiveDomains: string[];
  sensitiveApps: string[];
  breakMinutes: number;
  talk: TalkSettings;
  calendar: CalendarSettings;
  exportCsv: ExportSettings;
  /** Lock In on your phone, over the same Wi-Fi. */
  phone: { enabled: boolean };
  /** How the Mac app looks: the jailbreak look (with a key for a cursor) or the classic one. */
  look: { theme: 'jail' | 'classic'; keyCursor: boolean };
  /** Goals (beta): the page, what Lock In notices, and nudges toward your goals. */
  goals: { enabled: boolean; suggest: boolean; nudges: boolean };
  /** How Lock In reaches out: cards that can wait go out at natural pauses, within a daily budget. */
  attention: { pauses: boolean; maxPerDay: number; minGapMin: number };
  /** 'panel': everything lives in a small panel under the menu bar icon, and the window only opens
   *  for settings. 'window': the classic app window and menu bar menu. */
  ui: 'panel' | 'window';
  /** Anonymous usage data for Lock In's maker: features used, and (only if you say yes) app usage. */
  telemetry: TelemetrySettings;
}

export interface TelemetrySettings {
  /** Which features you use (anonymous). */
  features: boolean;
  /** Seconds per day in each app and site, and how they were labeled. Off until you say yes. */
  apps: boolean;
  /** You've seen the question in setup (or in Settings). */
  asked: boolean;
}

export interface KeyStatus {
  anthropic: boolean;
  elevenlabs: boolean;
  todoist: boolean;
  encrypted: boolean;
}

export interface Sample {
  t: number;
  app: string;
  bundleId?: string;
  title?: string;
  url?: string;
  domain?: string;
  documentPath?: string;
  tabId?: number;
  browser: boolean;
  idleSec: number;
  mediaPlaying: boolean;
  inCall: boolean;
  isPrivate: boolean;
}

export interface LabeledSample extends Sample {
  label: Label;
  /** Distraction weight for this item (1.0 when not a distraction). */
  weight: number;
  itemKey: string;
  source: LabelSource;
}

export interface Span {
  sessionId: string;
  app: string;
  bundleId?: string;
  title?: string;
  url?: string;
  domain?: string;
  label: Label;
  start: number;
  end: number;
  idleSec: number;
  mediaPlaying: boolean;
}

export interface SessionRecord {
  id: string;
  goal: string;
  plannedMin: number;
  startedAt: number;
  endedAt?: number;
  endedBy?: 'timer' | 'user' | 'quit';
  focusSec: number;
  driftSec: number;
  neutralSec: number;
  awaySec: number;
  breakSec: number;
  maxLevel: Level;
  interventions: number;
  topDistractions: Record<string, number>;
}

export interface InterventionRecord {
  id: string;
  sessionId: string;
  level: Level;
  trigger: 'score' | 'pattern' | 'repeat' | 'manual' | 'break_over';
  distraction: string;
  startedAt: number;
  resolvedAt?: number;
  option?: RouteOption | 'self';
  secToReturn?: number;
  worked?: boolean;
}

export interface CoachTurn {
  interventionId: string;
  speaker: 'coach' | 'user';
  text: string;
  toolCall?: string;
  createdAt: number;
}

export interface LastWork {
  app: string;
  bundleId?: string;
  title?: string;
  url?: string;
  documentPath?: string;
  tabId?: number;
  updatedAt: number;
}

export interface LiveSession {
  id: string;
  goal: string;
  plannedMin: number;
  startedAt: number;
  elapsedSec: number;
  focusSec: number;
  driftSec: number;
  drift: number;
  driftThresholdSec: number;
  level: Level;
  onBreakUntil?: number;
  pomodoro?: { cycle: number; cycles: number };
}

export interface LiveState {
  onboarded: boolean;
  session: LiveSession | null;
  current: { app: string; domain?: string; title?: string; label: Label; source: LabelSource } | null;
  extensionConnected: boolean;
  helperRunning: boolean;
  inCall: boolean;
  muteUntil?: number;
  keys: KeyStatus;
  lastGoal: string;
  todos: TodoSummary;
  calendar: CalendarSummary;
  /** Live conversation: whether one is open, and whether voice (ElevenLabs) is available for it. */
  talk: { open: boolean; voice: boolean };
  /** Deadlines due today or overdue (pinned on Lock in), and how many are coming up. */
  deadlines: { pinned: (Deadline & { overdue: boolean })[]; upcoming: number };
  /** Goals (beta) is on. */
  goals?: boolean;
  /** The menu bar panel or the classic window (Settings, "ui"). */
  ui: 'panel' | 'window';
  /** A friend's bomb has every distraction locked until then. */
  lockout?: { until: number; from: string };
}

export interface OptionButton {
  id: RouteOption;
  label: string;
}

export interface ToastPayload {
  kind: 'nudge' | 'speak' | 'starter' | 'break' | 'info' | 'checkin' | 'schedule' | 'roast' | 'win' | 'routine' | 'wellness' | 'bedtime' | 'meeting' | 'deadline';
  title: string;
  body: string;
  options?: OptionButton[];
  /** Generic buttons (routines, roasts) handled by "action:run" in the main process. */
  actions?: ActionButton[];
  timerEndsAt?: number;
  interventionId?: string;
  chime?: boolean;
  canTalk?: boolean;
  autoHideMs?: number;
  /** Ties the card back to what offered it, so Lock In can learn which cards you act on. */
  tag?: string;
}

export interface OverlayPayload {
  interventionId: string;
  level: Level;
  line: string;
  distraction: string;
  driftMin: number;
  goal: string;
  options: OptionButton[];
  status?: string;
  canTalk: boolean;
  /** Non-intervention cards (to-do roasts, bedtime): heading, meta line, colour and generic buttons. */
  cardName?: string;
  meta?: string;
  tone?: 'yellow' | 'red' | 'paper';
  actions?: ActionButton[];
  /** Seconds the card can't be dismissed (a friend's Lock In bomb). */
  lockSec?: number;
}

export interface DashboardData {
  todayFocusMin: number;
  todaySessions: number;
  todayDrifts: number;
  sessions: SessionRecord[];
  topDistractions: { name: string; minutes: number }[];
  optionStats: { option: string; used: number; worked: number }[];
}

/** Everything the menu bar panel shows besides the live state, in one call. */
export interface PanelData {
  today: { focusMin: number; sessions: number; streak: number };
  todos: { open: Task[]; canAdd: boolean; canComplete: boolean };
  /** Goals (beta) with a bar, for a glance; empty when Goals is off. */
  goals: { id: string; kind: GoalKind; name: string; progress: string; pct: number | null; tone: GoalView['tone']; daysLeft?: number }[];
  water: number;
  crew: CrewView | null;
  /** Ending a session early means typing a sentence first. */
  commitment: boolean;
}

export interface SetupStatus {
  platform: string;
  accessibility: 'granted' | 'missing' | 'n/a';
  microphone: string;
  helperBuilt: boolean;
  helperRunning: boolean;
  extensionConnected: boolean;
  /** Connected, but older than the version this Lock In needs (it should be updated). */
  extensionOutdated?: boolean;
  keys: KeyStatus;
  /** Running as the installed Lock In app (not from Terminal). */
  installed: boolean;
  openAtLogin: boolean;
}

export const OPTION_LABELS: Record<RouteOption, string> = {
  back: 'Back to it',
  starter: 'Give me a 5-minute starter',
  break: 'I need a real break',
  is_work: 'This is work',
  talk: 'Talk it out',
  end: 'End session',
};

export interface AppUsage {
  name: string;
  /** Times opened, as Spotlight counts it (0 = unknown). */
  uses: number;
  /** Last opened, ms since epoch (0 = unknown). */
  lastUsed: number;
}

// ---- voices --------------------------------------------------------------------

/** A voice the coach can use, from Lock In's picks, your ElevenLabs account or the Voice Library. */
export interface VoiceOption {
  id: string;
  name: string;
  vibe: string;
  accent?: string;
  gender?: string;
  /** ElevenLabs' own sample clip. */
  previewUrl?: string;
  source: 'pick' | 'mine' | 'library';
  category?: string;
  /** Voice Library voices: who shared it, needed to add it to your account. */
  ownerId?: string;
  /** Already saved to your ElevenLabs account. */
  added?: boolean;
  /** Not available on the free ElevenLabs plan. */
  paidOnly?: boolean;
  /** How many people have added it. */
  uses?: number;
}

// ---- the Mac Calendar app ---------------------------------------------------------

export type MacCalStatus = 'notDetermined' | 'restricted' | 'denied' | 'granted' | 'writeOnly' | 'unknown';

export interface MacCalendarInfo {
  id: string;
  title: string;
  /** The account it comes from: "Google", "iCloud", "Exchange"… (or the email). */
  source: string;
}

// ---- friends: crews, Lock In bombs, the weekly board ----------------------------

/** What a friend is up to. Bombs land only on "free" and "drifting". */
export type CrewState = 'locked' | 'break' | 'drifting' | 'free' | 'meeting' | 'away' | 'offline';

export interface CrewSettings {
  /** The crew's invite code (it is also the encryption key). Empty: not in a crew. */
  code: string;
  /** The crew's name. */
  crewName: string;
  /** Your name in the crew. */
  name: string;
  /** The relay: any ntfy server. */
  server: string;
  /** Show friends what you're locked in on. */
  shareGoal: boolean;
  /** Show friends which site or app you're drifting on. */
  shareDistraction: boolean;
  /** Friends' bombs lock every distraction on this Mac for 5 minutes (sites blocked, apps hidden). */
  bombsLockout?: boolean;
  /** Friends' bombs take over your screen for 5 seconds (off: they arrive as a corner card). */
  bombsFullScreen: boolean;
}

export interface CrewStats {
  todayMin: number;
  weekMin: number;
  streak: number;
  /** Bombs, red and yellow cards and to-do roasts this week. */
  roastedWeek: number;
  bombsThrownWeek: number;
  achievements: number;
}

export interface CrewMemberView {
  id: string;
  name: string;
  me: boolean;
  state: CrewState;
  /** When they went into this state. */
  since: number;
  goal?: string;
  distraction?: string;
  sessionMin?: number;
  stats: CrewStats;
  lastSeen: number;
  /** You can throw a bomb at them right now. */
  bombable: boolean;
}

export interface CrewFeedItem {
  id: string;
  at: number;
  kind: 'bomb' | 'bounce' | 'achievement' | 'session' | 'join' | 'leave';
  text: string;
}

export interface CrewView {
  joined: boolean;
  crewName: string;
  code: string;
  connected: boolean;
  error?: string;
  me: string;
  members: CrewMemberView[];
  bombsLeft: number;
  bombsPerDay: number;
  feed: CrewFeedItem[];
  insults: string[];
}

export interface AchievementView {
  id: string;
  name: string;
  desc: string;
  unlockedAt?: number;
}

// ---- coaches made from someone you know ---------------------------------------

export type CoachLineKind =
  | 'level1' | 'level2' | 'level3' | 'level4' | 'repeat'
  | 'back' | 'self' | 'starter' | 'break' | 'is_work' | 'talk' | 'end'
  | 'breakOver' | 'away' | 'halfway' | 'streak' | 'pomodoroBreak'
  | 'roast1' | 'roast2' | 'roast3' | 'overdue' | 'win' | 'allDone'
  | 'kickoff' | 'deepwork' | 'hydrate' | 'stretch' | 'eyes' | 'lunch' | 'midday' | 'shutdown' | 'bedtime' | 'weekly'
  | 'talkOpen';

export type CoachLines = Partial<Record<CoachLineKind, string[]>>;

/** One voice heard in a recording. */
export interface CoachSpeaker {
  id: string;
  words: number;
  seconds: number;
  /** A few things they said, to tell the voices apart. */
  quotes: string[];
}

/** A recording, or messages and emails they wrote. */
export interface CoachSource {
  id: string;
  kind: 'recording' | 'text';
  title: string;
  addedAt: number;
  status: 'waiting' | 'transcribing' | 'pick-speaker' | 'ready' | 'error';
  error?: string;
  /** Their words in it (only theirs, once the speaker is picked). */
  words: number;
  /** Recordings: total length, the voices heard, which one is them and how long they talk. */
  seconds?: number;
  speakers?: CoachSpeaker[];
  speaker?: string;
  theirSec?: number;
  language?: string;
  /** The copy Lock In keeps (inside its data folder), or where the original was. */
  audioFile?: string;
  originalPath?: string;
}

export interface CoachStyle {
  /** How they talk, in a few sentences, for you to read. */
  summary: string;
  /** How they talk, written for Claude and the voice agent. */
  persona: string;
  callsYou: string[];
  catchphrases: string[];
  /** "Mandarin with English work words". */
  language: string;
  /** ISO 639-1, e.g. "zh". */
  languageCode: string;
}

export interface CustomCoach {
  id: string;
  name: string;
  /** "my mum", "my boss". */
  relation: string;
  /** How hard they push: the built-in personality whose rules (and spare lines) they use. */
  base: Persona;
  /** Language for their lines; empty means the one in the recordings. */
  language: string;
  /** What you know about how they talk: pet names, sayings, what they care about. */
  notes: string;
  createdAt: number;
  updatedAt: number;
  sources: CoachSource[];
  style?: CoachStyle;
  lines: CoachLines;
  /** Moments you rewrote by hand: distilling again keeps your version. */
  edited: CoachLineKind[];
  distilledAt?: number;
  distilledWords?: number;
  /** A copy of their voice on your ElevenLabs account, made with their consent. */
  voice?: { id: string; name: string; consentAt: number; madeAt: number; seconds: number };
  /** Speak in their voice while they're your coach. */
  useVoice: boolean;
}

export interface CoachReadiness {
  /** Their words across ready recordings and messages. */
  words: number;
  noteWords: number;
  /** Seconds of their own voice in recordings. */
  theirSec: number;
  style: 'empty' | 'sketch' | 'good' | 'great';
  canDistill: boolean;
  canClone: boolean;
  /** Their words added since the last distill. */
  newWords: number;
  /** Recordings still being transcribed. */
  pending: number;
  /** Recordings waiting for you to pick which voice is them. */
  pickSpeaker: number;
}

export interface CustomCoachView extends CustomCoach {
  readiness: CoachReadiness;
  active: boolean;
  /** What Lock In is doing with this coach right now ("distilling", "cloning"). */
  busy?: string;
  lastError?: string;
}

// ---- goals (beta) ------------------------------------------------------------------

/** Goals Lock In can measure by itself, plus "something else" that you check off. */
export type GoalKind = 'focus' | 'breaks' | 'water' | 'bedtime' | 'start' | 'drift' | 'todos' | 'custom';

export interface Goal {
  id: string;
  kind: GoalKind;
  /** Hours (focus), minutes (breaks, drift), a count (water, todos), or minutes after midnight (bedtime, start). */
  target: number;
  /** Your own words, for "something else". */
  title?: string;
  /** Why it matters to you, shown under the goal and given to the coach. */
  why?: string;
  days: 'every' | 'weekdays';
  createdAt: number;
  source: 'you' | 'noticed' | 'coach';
  paused?: boolean;
  /** When the target last changed (Lock In waits a week before suggesting another change). */
  changedAt?: number;
  /** Big goals (kind "custom"): the last day it runs, YYYY-MM-DD. */
  until?: string;
  /** Big goals: words and names that count toward it ("investors", "Sequoia", "Lock In"). */
  counts?: string[];
  /** Big goals: things you said aren't part of it. */
  notCounts?: string[];
  /** Big goals: who wrote the list of what counts (the coach adds to it once there's a Claude key; your edits are left alone). */
  seededBy?: 'words' | 'coach' | 'you';
  /** Big goals: a check-in once a day at a natural pause, until you've done something for it (default on). */
  daily?: boolean;
}

/** What happened on one day, everything goals are measured from. */
export interface RhythmDay {
  day: string;
  activeMin: number;
  /** First and last activity (ms); the day runs 4 am to 4 am. */
  first?: number;
  last?: number;
  /** Longest stretch at the computer without a 5-minute break. */
  longestMin: number;
  breaks: number;
  /** When you logged a glass of water. */
  water: number[];
  /** Active minutes in each clock hour. */
  hours: number[];
}

export interface GoalDayMark {
  day: string;
  label: string;
  /** null: not a goal day, or nothing to go on. */
  hit: boolean | null;
}

export interface GoalView extends Goal {
  name: string;
  /** "2.1 of 4 h". */
  progress: string;
  /** 0..1 for the bar; null when a bar makes no sense (times of day). */
  pct: number | null;
  status: string;
  /** How the goal is doing today: ahead, fine, behind, or done. */
  tone: 'done' | 'ok' | 'behind' | 'idle';
  week: GoalDayMark[];
  /** Hit on how many of the last 7 goal days. */
  hits: number;
  of: number;
  /** Big goals: days left until its end date. */
  daysLeft?: number;
  /** Big goals: what moved it forward lately (newest first). */
  moved?: { day: string; label: string; kind: 'todo' | 'session' | 'meeting' | 'you'; text: string }[];
  /** Big goals: the first open to-do that counts toward it. */
  nextStep?: string;
  /** Big goals: what counts toward it (its list, or the words of its title). */
  terms?: string[];
}

/** "Is Lock In one of your cool side products?" */
export interface GoalQuestion {
  id: string;
  term: string;
  goalIds: string[];
  text: string;
  evidence: string;
}

export interface GoalSuggestion {
  id: string;
  kind: GoalKind;
  target: number;
  days: 'every' | 'weekdays';
  name: string;
  /** The numbers behind it. */
  evidence: string;
  /** What it would do for you. */
  why: string;
  source: 'noticed' | 'coach';
  /** A change to a goal you already have (raise it once it's easy, ease it when it's out of reach). */
  goalId?: string;
  change?: 'raise' | 'ease';
}

/** How Lock In reaches out: the settings, today's count, and what it learned about each kind of card. */
export interface AttentionView {
  settings: { pauses: boolean; maxPerDay: number; minGapMin: number };
  sentToday: number;
  waiting: number;
  kinds: { kind: string; name: string; shown: number; acted: number; ignored: number; streak: number; skipEvery: number }[];
}

export interface GoalsView {
  enabled: boolean;
  goals: GoalView[];
  /** Things you keep working on that might belong to a big goal. */
  questions: GoalQuestion[];
  suggestions: GoalSuggestion[];
  /** Days of rhythm Lock In has seen (suggestions need about three). */
  daysSeen: number;
  canAskCoach: boolean;
  /** The last 7 days in numbers. */
  week: { day: string; label: string; activeMin: number; focusMin: number; longestMin: number; water: number; lastAt?: number }[];
  /** Right now: the current stretch without a break, and water today. */
  now: { stretchMin: number; water: number };
}
