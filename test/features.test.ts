import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodoWatchdog, type WatchEvent } from '../src/main/todos/watchdog';
import { BuiltinProvider, TodoistProvider, rankTasks, remindersPriority, todoistToTask, type TodoSnapshot } from '../src/main/todos/providers';
import { dayKey } from '../src/main/todos/day';
import { RoutineScheduler } from '../src/main/routines';
import { Notifier, type NotifierDeps, type NotifyPayload } from '../src/main/notify';
import { Guardrails } from '../src/main/guardrails';
import { roastLine, routineLine, winLine, levelLine, spokenDuration } from '../src/main/coach/lines';
import { DEFAULT_CALENDAR, DEFAULT_CREW, DEFAULT_EXPORT, DEFAULT_NOTIFY, DEFAULT_ROUTINES, DEFAULT_SOUNDS, DEFAULT_TALK, DEFAULT_TODO, buildDefaultProfile } from '../src/shared/templates';
import type { Routine, Settings, Task, TodoSettings } from '../src/shared/types';

const CFG: TodoSettings = { ...DEFAULT_TODO, noProgressMin: 90 };
const T0 = new Date('2026-10-19T10:00:00').getTime();
const task = (id: string, title = `Task ${id}`, extra: Partial<Task> = {}): Task => ({ id, title, completed: false, ...extra });
const snap = (open: Task[], done: Task[] = []): TodoSnapshot => ({ open, doneToday: done, fetchedAt: T0 });

function run(wd: TodoWatchdog, seconds: number, start: number, opts: { idle?: number; allowed?: boolean } = {}): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (let i = 0; i < seconds; i++) out.push(...wd.tick(opts.idle ?? 0, 1, start + i * 1000, CFG, opts.allowed ?? true));
  return out;
}

// ---------------------------------------------------------------------------
// To-do watchdog

test('watchdog: 90 active minutes with open tasks and nothing done → roast, then hotter and sooner', () => {
  const wd = new TodoWatchdog(null, T0, CFG, (o) => o[0]);
  wd.onSnapshot(snap([task('1', 'Deck'), task('2')]), T0, CFG);
  const first = run(wd, 90 * 60, T0);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'roast');
  assert.equal((first[0] as { severity: number }).severity, 1);
  assert.equal((first[0] as { top?: Task }).top?.title, 'Deck');
  // Next one after 45 more minutes (x0.5), severity 2; then 30 (x0.33), severity 3.
  const second = run(wd, 45 * 60, T0 + 90 * 60_000);
  assert.deepEqual(second.map((e) => (e as { severity: number }).severity), [2]);
  const third = run(wd, 30 * 60, T0 + 135 * 60_000);
  assert.deepEqual(third.map((e) => (e as { severity: number }).severity), [3]);
});

test('watchdog: idle time does not count, and nothing fires with an empty list', () => {
  const wd = new TodoWatchdog(null, T0, CFG, (o) => o[0]);
  wd.onSnapshot(snap([task('1')]), T0, CFG);
  assert.equal(run(wd, 100 * 60, T0, { idle: 300 }).length, 0);
  assert.equal(wd.state.activeSec, 0);
  const empty = new TodoWatchdog(null, T0, CFG, (o) => o[0]);
  empty.onSnapshot(snap([]), T0, CFG);
  assert.equal(run(empty, 100 * 60, T0).length, 0);
});

test('watchdog: finishing a task celebrates and resets the clock', () => {
  const wd = new TodoWatchdog(null, T0, CFG, (o) => o[0]);
  wd.onSnapshot(snap([task('1'), task('2')]), T0, CFG); // primes silently
  run(wd, 80 * 60, T0);
  const ev = wd.onSnapshot(snap([task('2')], [task('1', 'Email Sam', { completed: true, completedAt: T0 + 1 })]), T0 + 80 * 60_000, CFG);
  assert.equal(ev[0]?.type, 'win');
  assert.equal(wd.state.sinceProgressSec, 0);
  assert.equal(run(wd, 60 * 60, T0 + 80 * 60_000).length, 0, 'clock restarted');
});

test('watchdog: completions already there at startup are not celebrated', () => {
  const wd = new TodoWatchdog(null, T0, CFG, (o) => o[0]);
  const ev = wd.onSnapshot(snap([task('2')], [task('1', 'x', { completed: true })]), T0, CFG);
  assert.equal(ev.length, 0);
  assert.equal(wd.doneCount, 1);
});

test('watchdog: deferred while not allowed, snooze works, daily cap holds', () => {
  const wd = new TodoWatchdog(null, T0, { ...CFG, maxRoastsPerDay: 1 }, (o) => o[0]);
  const cfg = { ...CFG, maxRoastsPerDay: 1 };
  wd.onSnapshot(snap([task('1')]), T0, cfg);
  let out: WatchEvent[] = [];
  for (let i = 0; i < 95 * 60; i++) out.push(...wd.tick(0, 1, T0 + i * 1000, cfg, false));
  assert.equal(out.length, 0, 'not while in a session or a call');
  wd.snooze(10, T0 + 95 * 60_000);
  out = [];
  for (let i = 0; i < 5 * 60; i++) out.push(...wd.tick(0, 1, T0 + 95 * 60_000 + i * 1000, cfg, true));
  assert.equal(out.length, 0, 'snoozed');
  out = [];
  for (let i = 0; i < 60 * 60; i++) out.push(...wd.tick(0, 1, T0 + 106 * 60_000 + i * 1000, cfg, true));
  assert.equal(out.length, 1, 'fires once, then the daily cap stops it');
});

test('watchdog: a new day starts fresh (days begin at 4 am)', () => {
  const wd = new TodoWatchdog(null, T0, CFG, (o) => o[0]);
  wd.onSnapshot(snap([task('1')]), T0, CFG);
  run(wd, 60, T0);
  assert.equal(dayKey(new Date('2026-10-20T03:00:00').getTime()), '2026-10-19');
  wd.tick(0, 1, new Date('2026-10-20T05:00:00').getTime(), CFG, true);
  assert.equal(wd.state.day, '2026-10-20');
  assert.equal(wd.state.activeSec, 1);
});

// ---------------------------------------------------------------------------
// Providers

test('built-in list: add, complete, and today counts', async () => {
  let data: unknown[] = [];
  const p = new BuiltinProvider(() => data as never[], (d) => (data = d));
  await p.add('Write memo');
  await p.add('Call bank');
  let s = await p.fetch();
  assert.equal(s.open.length, 2);
  await p.complete(s.open[0].id);
  s = await p.fetch();
  assert.equal(s.open.length, 1);
  assert.equal(s.doneToday.length, 1);
});

test('Todoist: reads the filter, pages, and detects completed tasks that left the filter', async () => {
  const calls: string[] = [];
  let state = 'first';
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u.replace('https://api.todoist.com/api/v1', '')}`);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer tok');
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/tasks/filter')) {
      if (state === 'first') {
        if (!u.includes('cursor=')) return json({ results: [{ id: 'a', content: 'Deck', priority: 4, due: { date: '2026-10-19' } }], next_cursor: 'c2' });
        return json({ results: [{ id: 'b', content: 'Email', priority: 1, due: { date: '2026-10-18' } }], next_cursor: null });
      }
      return json({ results: [{ id: 'b', content: 'Email', priority: 1, due: { date: '2026-10-18' } }], next_cursor: null });
    }
    if (u.endsWith('/tasks/a')) return json({ id: 'a', content: 'Deck', checked: true });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const p = new TodoistProvider(() => DEFAULT_TODO, () => 'tok', http);
  const s1 = await p.fetch(T0);
  assert.deepEqual(s1.open.map((t) => t.title), ['Deck', 'Email']);
  assert.ok(calls[0].includes(`query=${encodeURIComponent('today | overdue')}`));
  state = 'second';
  const s2 = await p.fetch(T0 + 60_000);
  assert.deepEqual(s2.open.map((t) => t.title), ['Email']);
  assert.deepEqual(s2.doneToday.map((t) => t.title), ['Deck']);
});

test('task ranking: overdue first, then priority, then due date', () => {
  const now = new Date('2026-10-19T12:00:00').getTime();
  const ranked = rankTasks([task('a', 'later', { due: '2026-10-25' }), task('b', 'urgent', { priority: 3 }), task('c', 'overdue', { due: '2026-10-10' })], now);
  assert.deepEqual(ranked.map((t) => t.title), ['overdue', 'urgent', 'later']);
  assert.equal(todoistToTask({ id: '1', content: 'x', priority: 4 }).priority, 3);
  assert.equal(remindersPriority(1), 3);
  assert.equal(remindersPriority(9), 1);
  assert.equal(remindersPriority(0), 0);
});

// ---------------------------------------------------------------------------
// Routines

const at = (s: string) => new Date(`2026-10-19T${s}:00`); // a Monday
const R = (id: string) => structuredClone(DEFAULT_ROUTINES.find((r) => r.id === id)!) as Routine;

test('routines: time routines fire once, within 90 minutes, only when you are at the computer', () => {
  const s = new RoutineScheduler();
  const kickoff = R('kickoff');
  assert.equal(s.tick([kickoff], at('08:59'), 1, true, () => true).length, 0);
  assert.equal(s.tick([kickoff], at('09:05'), 1, false, () => true).length, 0, 'away: wait');
  assert.equal(s.tick([kickoff], at('09:20'), 1, true, () => true).length, 1);
  assert.equal(s.tick([kickoff], at('09:21'), 1, true, () => true).length, 0, 'once a day');
  const late = new RoutineScheduler();
  assert.equal(late.tick([kickoff], at('10:45'), 1, true, () => true).length, 0, 'missed the window');
  const sunday = new RoutineScheduler();
  assert.equal(sunday.tick([kickoff], new Date('2026-10-18T09:10:00'), 1, true, () => true).length, 0, 'weekdays only');
});

test('routines: interval routines count active minutes inside their window', () => {
  const s = new RoutineScheduler();
  const water = R('hydrate');
  let fired = 0;
  const start = at('10:00').getTime();
  for (let i = 0; i < 60 * 60; i++) fired += s.tick([water], new Date(start + i * 1000), 1, i % 2 === 0, () => true).length;
  assert.equal(fired, 0, 'only half that hour was active');
  for (let i = 0; i < 31 * 60; i++) fired += s.tick([water], new Date(start + 3_600_000 + i * 1000), 1, true, () => true).length;
  assert.equal(fired, 1);
});

test('routines: bedtime nags every 15 minutes while you stay, and stops when you leave', () => {
  const s = new RoutineScheduler();
  const bed = R('bedtime');
  const t0 = at('23:30').getTime();
  const fire = (ms: number, active = true) => s.tick([bed], new Date(t0 + ms), 1, active, () => true);
  assert.equal(fire(0)[0]?.followUp, 0);
  assert.equal(fire(15 * 60_000)[0]?.followUp, 1);
  assert.equal(fire(30 * 60_000)[0]?.followUp, 2);
  assert.equal(fire(45 * 60_000, false).length, 0, 'they went to bed');
  assert.equal(fire(60 * 60_000).length, 0);
});

test('routines: snooze brings it back, disabled routines stay quiet, and allowedFor defers', () => {
  const s = new RoutineScheduler();
  const lunch = R('lunch');
  const t0 = at('12:30').getTime();
  assert.equal(s.tick([lunch], new Date(t0), 1, true, () => false).length, 0, 'deferred');
  assert.equal(s.tick([lunch], new Date(t0 + 60_000), 1, true, () => true).length, 1);
  s.snooze('lunch', 15, t0 + 60_000);
  assert.equal(s.tick([lunch], new Date(t0 + 10 * 60_000), 1, true, () => true).length, 0);
  assert.equal(s.tick([lunch], new Date(t0 + 17 * 60_000), 1, true, () => true)[0]?.snoozed, true);
  const off = { ...R('midday'), enabled: false };
  assert.equal(new RoutineScheduler().tick([off], at('14:10'), 1, true, () => true).length, 0);
});

// ---------------------------------------------------------------------------
// Notifier

function notifierSetup(over: Partial<Settings> = {}, deps: Partial<NotifierDeps> = {}) {
  const settings: Settings = {
    notify: structuredClone(DEFAULT_NOTIFY), sounds: { ...DEFAULT_SOUNDS }, ntfyServer: 'https://ntfy.sh', ntfyTopic: '', webhookUrl: '', todo: DEFAULT_TODO,
    voiceId: 'v', ttsModelLive: 'f', ttsModelShout: 'v3', sttModel: 's', sayVoice: '', coachModel: 'c', classifierModel: 'h', volumeCap: 0.8,
    quietStart: '00:00', quietEnd: '00:00', profanityOk: false, titlesStayLocal: false, maxSpokenPerHour: 6, commitmentMode: false,
    sensitiveDomains: [], sensitiveApps: [], breakMinutes: 7, talk: DEFAULT_TALK, calendar: DEFAULT_CALENDAR, exportCsv: DEFAULT_EXPORT, crew: DEFAULT_CREW, phone: { enabled: false }, look: { theme: 'jail', keyCursor: true }, goals: { enabled: true, suggest: true, nudges: true }, attention: { pauses: true, maxPerDay: 12, minGapMin: 20 }, ui: 'panel', ...over,
  };
  const log: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const guard = new Guardrails();
  const n = new Notifier({
    settings: () => settings,
    profile: () => buildDefaultProfile('founder'),
    guard,
    inCall: () => false,
    cardBusy: () => false,
    toast: (p) => log.push(`toast:${p.title}`),
    card: (p) => log.push(`card:${p.cardName}`),
    speak: async (t) => void log.push(`voice:${t}`),
    sound: async (id) => void log.push(`sound:${id}`),
    system: (t) => log.push(`system:${t}`),
    menubar: (t) => log.push(`menubar:${t}`),
    dock: (c) => log.push(`dock:${c}`),
    http: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response('ok', { status: 200 });
    }) as typeof fetch,
    log: () => {},
    ...deps,
  });
  return { n, log, requests, settings, guard };
}

const P = (over: Partial<NotifyPayload> = {}): NotifyPayload => ({ kind: 'todo_roast', title: 'To-do roast', body: 'Hello?', ...over });

test('notifier: follows the routing table, sound before voice', async () => {
  const { n, log } = notifierSetup();
  const used = await n.notify(P());
  assert.deepEqual(used.sort(), ['sound', 'system', 'toast', 'voice']);
  assert.ok(log.indexOf('sound:sad_trombone') < log.indexOf('voice:Hello?'));
});

test('notifier: phone push and webhook send the right requests', async () => {
  const { n, requests } = notifierSetup({ ntfyTopic: 'grace-lockin', webhookUrl: 'https://discord.com/api/webhooks/1/abc' });
  await n.notify(P({ kind: 'red', title: 'Red card', body: 'youtube.com blocked', extra: ['webhook'], priority: 'critical' }));
  await new Promise((r) => setTimeout(r, 10));
  const push = requests.find((r) => r.url.startsWith('https://ntfy.sh/'))!;
  assert.equal(push.url, 'https://ntfy.sh/grace-lockin');
  const h = push.init!.headers as Record<string, string>;
  assert.equal(h['X-Title'], 'Red card');
  assert.equal(h['X-Priority'], 'urgent');
  assert.match(h['X-Tags'], /rotating_light/);
  const hook = requests.find((r) => r.url.includes('discord'))!;
  assert.deepEqual(JSON.parse(String(hook.init!.body)), { content: 'Lock In: Red card. youtube.com blocked' });
});

test('notifier: a full-screen card replaces the corner card; mute and calls hold things back', async () => {
  const a = notifierSetup();
  const used = await a.n.notify(P({ extra: ['card'] }));
  assert.ok(used.includes('card') && !used.includes('toast'));
  const b = notifierSetup();
  b.guard.mute(30);
  assert.deepEqual((await b.n.notify(P())).sort(), ['toast']);
  assert.ok((await b.n.notify(P({ kind: 'bedtime' }))).includes('sound'), 'bedtime gets through a mute');
  const c = notifierSetup({}, { inCall: () => true });
  const inCall = await c.n.notify(P());
  assert.ok(!inCall.includes('voice') && !inCall.includes('sound'));
});

test('notifier: phone and webhook need setup and are rate limited', async () => {
  const a = notifierSetup();
  assert.ok(!(await a.n.notify(P({ kind: 'red' }))).includes('phone'), 'no topic, no push');
  const b = notifierSetup({ ntfyTopic: 't' });
  let sent = 0;
  for (let i = 0; i < 20; i++) if ((await b.n.notify(P({ kind: 'red' }))).includes('phone')) sent++;
  assert.equal(sent, 12);
});

// ---------------------------------------------------------------------------
// Lines

test('sassy roasts, wins and routines read well', () => {
  const r = roastLine(1, 'sassy', { active: spokenDuration(154), done: 0, open: 6, overdue: 2, top: 'finish the deck' });
  assert.match(r, /2 hours 34 minutes|zero|6/);
  assert.match(r, /overdue/);
  assert.match(winLine('sassy', { active: '', done: 3, open: 0, overdue: 0, task: 'x' }), /everything/);
  assert.match(routineLine('kickoff', 'sassy', { active: '', done: 0, open: 4, overdue: 0, top: 'Send the update', time: '9:00 AM' }), /4/);
  assert.match(routineLine('kickoff', 'sassy', { active: '', done: 0, open: 0, overdue: 0, time: '9:00 AM' }), /empty/);
  assert.match(routineLine('bedtime', 'sassy', { active: '', done: 0, open: 0, overdue: 0, time: '11:30 PM' }), /11:30 PM|Bed|bed/);
  assert.equal(routineLine('custom', 'sassy', { active: '', done: 0, open: 0, overdue: 0, time: '', message: 'Call mom' }), 'Call mom');
  const l1 = new Set<string>();
  for (let i = 0; i < 30; i++) l1.add(levelLine(1, 'sassy', { site: 'youtube.com', goal: 'Finish the deck', min: 3, work: 'deck' }));
  assert.ok([...l1].some((l) => l.startsWith('Why are we so locked out again?')));
  assert.equal(spokenDuration(45), '45 minutes');
  assert.equal(spokenDuration(60), '1 hour');
});

test('roast grammar: singular counts and quoted task names', () => {
  const r = roastLine(3, 'sassy', { active: '3 hours', done: 1, open: 1, overdue: 1, top: 'Finish the pitch deck' });
  assert.doesNotMatch(r, /\b1 things\b|\b1 are\b/);
  if (r.includes('Finish')) assert.match(r, /“Finish the pitch deck”/);
});
