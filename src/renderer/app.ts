import type {
  AppUsage, GoalsView, CalEvent, CalendarSettings, Channel, DashboardData, Deadline, KeyStatus, WeekDay, Label, LiveState, MacCalendarInfo, MacCalStatus, NotifyKind, Persona, Profile, Role, RouteOption, Routine, Settings, SetupStatus,
  SheetPreview, SheetSettings, SoundId, Task, TodoProviderId, TodoSettings, TodoSummary, VoiceOption, CrewView, CrewMemberView, AchievementView, CrewSettings, CustomCoachView,
} from '../shared/types';
import { OPTION_LABELS } from '../shared/types';
import {
  CHANNELS, COMMON_DISTRACTION_APPS, COMMON_DISTRACTIONS, DEFAULT_GRAY_KEYWORDS, DEFAULT_ROUTE_ORDER, DISTRACTION_APP_CHOICES, DISTRACTION_CHOICES,
  DEFAULT_TODO, NOTIFY_KINDS, ROLE_ORDER, ROLE_TEMPLATES, ROUTINE_HELP, SOUNDS, TODO_PROVIDERS, buildDefaultProfile, combineRoles, suggestWorkApps,
} from '../shared/templates';
import { api, clear, clockTime, h, mmss, plural } from './lib';
import { playIntro } from './intro';
import { leaveCoachPage, renderCoachPage } from './coachmaker';
import { goalStrip, reachSection, renderGoals, rhythmSection } from './goals';
import { applyLook, cachedLook, cellDoor, padlock, retargetKey, tally } from './jail';

// The look comes first, before anything is drawn.
applyLook(cachedLook());

const view = document.getElementById('view') as HTMLElement;
const quizEl = document.getElementById('quiz') as HTMLElement;
const railFoot = document.getElementById('railFoot') as HTMLElement;
const mac = api.platform === 'darwin';
const MOD = mac ? '⌘⇧' : 'Ctrl+Shift+';

let state: LiveState | null = null;
let profile: Profile | null = null;
let settings: Settings | null = null;
let route = location.hash.slice(1) || 'home';
let homeMode: 'idle' | 'live' | null = null;

// -----------------------------------------------------------------------------
// Routing

/**
 * Old page names, and sections that moved: [page, section to scroll to].
 * Each page has one job: Lock in (start now), To-dos (what to do), Goals (where you're going),
 * Progress (how it's going), Friends, Coach (who talks to you and how), Settings (everything else).
 */
const ALIAS: Record<string, [string, string]> = {
  today: ['progress', 'today-sec'],
  dashboard: ['progress', ''],
  week: ['todos', 'week-sec'],
  deadlines: ['todos', 'deadlines-sec'],
  routines: ['settings', 'routines-sec'],
  profile: ['settings', 'profile-sec'],
  calendar: ['settings', 'calendar-sec'],
  keys: ['settings', 'keys-sec'],
  notifications: ['settings', 'notif-sec'],
  setup: ['settings', ''],
};
let anchor = '';
let editingProfile = false;
let booted = false;

/** Scrolls to the section a link pointed at, once it is on the page. */
function scrollToAnchor(): void {
  if (!anchor) return;
  const el = document.getElementById(anchor);
  if (!el) return;
  anchor = '';
  el.scrollIntoView({ block: 'start' });
}

function go(r: string): void {
  if (r === 'quiz') {
    void openQuiz();
    return;
  }
  if (r.includes('#')) {
    // "friends#aim-<id>": a page and a spot on it.
    [r, anchor] = [r.slice(0, r.indexOf('#')), r.slice(r.indexOf('#') + 1)];
  }
  const a = ALIAS[r];
  if (a) {
    r = a[0];
    anchor = a[1];
    if (a[1] === 'profile-sec') editingProfile = true;
  }
  // With the menu bar panel, starting a session and today's numbers live in the panel: this window is settings.
  if (panelMode() && (r === 'home' || r === 'progress')) r = 'settings';
  // A new page is a cell you just unlocked: the door slides away (not on the first page).
  if (route !== r && booted) cellDoor();
  route = r;
  if (location.hash.slice(1) !== r) history.replaceState(null, '', `#${r}`);
  // A coach made from someone lives under Coach.
  const railRoute = r.startsWith('coach/') ? 'coach' : r;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.rail a')) a.classList.toggle('active', a.dataset.route === railRoute);
  homeMode = null;
  void render();
}

window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'home'));
api.on('nav', (r) => go(String(r)));
/** Lock In lives in the menu bar panel (Settings, "Where Lock In lives"). */
function panelMode(): boolean {
  return state?.ui === 'panel';
}

function applyUiMode(): void {
  document.body.classList.toggle('panel-mode', panelMode());
  if (panelMode() && (route === 'home' || route === 'progress') && booted) go('settings');
}

api.on('state', (s) => {
  const prevOnboarded = state?.onboarded;
  const prevUi = state?.ui;
  state = s as LiveState;
  if (state.ui !== prevUi) applyUiMode();
  renderRail();
  if (route === 'home') updateHome();
  if (prevOnboarded === false && state.onboarded) void loadProfile();
});

async function loadProfile(): Promise<void> {
  profile = await api.invoke<Profile | null>('profile:get');
}

async function render(): Promise<void> {
  clear(view);
  view.scrollTop = 0;
  leaveCoachPage();
  if (route.startsWith('coach/')) {
    const r = route;
    await renderCoachPage(r.slice(6), { view, back: () => go('coach#persona-sec'), current: () => route === r });
    scrollToAnchor();
    return;
  }
  switch (route) {
    case 'coach':
      await renderCoach();
      break;
    case 'settings':
      await renderSettingsPage();
      break;
    case 'progress':
      await renderProgress();
      break;
    case 'todos':
      await renderTodos();
      break;
    case 'friends':
      await renderFriends();
      break;
    case 'goals':
      await renderGoals({ view, current: () => route === 'goals' });
      break;
    default:
      route = 'home';
      updateHome(true);
  }
  scrollToAnchor();
  retargetKey();
}

function renderRail(): void {
  if (!state) return;
  const goalsLink = document.getElementById('railGoals');
  if (goalsLink) goalsLink.hidden = state.goals === false;
  clear(railFoot);
  railFoot.append(h('div', null,
    h('div', { class: state.extensionConnected ? 'ok' : 'bad' }, state.extensionConnected ? 'Browser connected' : 'Browser not connected'),
    h('div', { class: state.helperRunning ? 'ok' : 'bad' }, state.helperRunning ? 'Window sensor on' : 'Window sensor off'),
    h('div', { class: state.keys.elevenlabs ? 'ok' : 'bad' }, state.keys.elevenlabs ? 'Voice ready' : 'Voice: Mac fallback'),
    state.todos.provider !== 'none'
      ? h('div', { class: state.todos.connected ? 'ok' : 'bad' }, state.todos.connected ? `To-dos: ${state.todos.doneToday} done, ${state.todos.open} left` : 'To-dos not connected')
      : null,
    state.calendar.now
      ? h('div', { class: 'ok' }, `In a meeting until ${clockTime(state.calendar.now.end)}`)
      : state.calendar.next
        ? h('div', { class: 'ok' }, `Next: ${shortTitle(state.calendar.next.title, 18)} at ${clockTime(state.calendar.next.start)}`)
        : null,
    state.muteUntil ? h('div', { class: 'bad' }, `Coach muted until ${clockTime(state.muteUntil)}`) : null,
    state.lockout ? h('div', { class: 'bad' }, `Distractions locked until ${clockTime(state.lockout.until)} (${state.lockout.from}’s bomb)`) : null,
  ));
}

function shortTitle(t: string, max = 40): string {
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function inMinutes(t: number): string {
  const m = Math.max(0, Math.round((t - Date.now()) / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

// -----------------------------------------------------------------------------
// Home

let chosenMinutes = 50;
let pomodoro = false;

function updateHome(force = false): void {
  if (!state) return;
  const mode = state.session ? 'live' : 'idle';
  if (force || mode !== homeMode) {
    homeMode = mode;
    idleKey = '';
    clear(view);
    view.appendChild(mode === 'live' ? liveView() : idleView());
    if (mode === 'idle') void fillHomeExtras();
  }
  if (mode === 'live') tickLive();
  else fillIdleStatus();
}

// The readiness list and "up next" box change as the sensor, extension and to-do list come online,
// so they are redrawn on every state update without touching the goal box you may be typing in.
const idle: { ready?: HTMLElement; upNext?: HTMLElement; goal?: HTMLInputElement; extras?: HTMLElement } = {};
let idleKey = '';

function fillIdleStatus(): void {
  const s = state;
  if (!s || !idle.ready || !idle.upNext || !idle.goal) return;
  const t = s.todos;
  const cal = s.calendar;
  const pins = s.deadlines.pinned;
  const key = JSON.stringify([s.onboarded, s.extensionConnected, s.helperRunning, s.keys.anthropic, s.keys.elevenlabs, t.provider, t.connected, t.error, t.top, t.doneToday, t.open, cal.now?.title, cal.next?.title, cal.next?.start, pins.map((d) => [d.id, d.overdue]), Math.floor(Date.now() / 60_000)]);
  if (key === idleKey) return;
  idleKey = key;
  const goal = idle.goal;

  clear(idle.upNext);
  // Deadlines due today (or overdue) are pinned above everything else.
  for (const d of pins) {
    idle.upNext.append(
      h(
        'div',
        { class: `up-next pinned${d.overdue ? ' overdue' : ''}` },
        h('span', { class: 'pin-label' }, d.overdue ? '📌 Overdue' : '📌 Due today'),
        h('b', null, d.title, d.time ? h('span', { class: 'muted' }, ` · ${timeLabel(d.time)}`) : null),
        h('button', { class: 'btn btn-small btn-ink', type: 'button', style: 'margin-left:auto', onclick: () => void api.invoke('session:start', { goal: d.title, minutes: chosenMinutes, pomodoro: false }) }, 'Lock in on it'),
        h('button', { class: 'btn btn-small', type: 'button', onclick: async () => { await api.invoke('deadlines:done', d.id, true); void refreshDeadlines(); } }, 'Done ✓'),
      ),
    );
  }
  if (t.provider !== 'none' && t.top) {
    idle.upNext.append(
      h(
        'div',
        { class: 'up-next' },
        h('span', { class: 'muted' }, 'Up next on your list'),
        h('b', null, t.top),
        h('button', { class: 'btn btn-small', type: 'button', onclick: () => { goal.value = t.top!; goal.focus(); } }, 'Use as my goal'),
        h('span', { class: 'muted', style: 'margin-left:auto' }, `${t.doneToday} done, ${t.open} left`),
      ),
    );
  }
  if (cal.now || cal.next) {
    idle.upNext.append(
      h(
        'div',
        { class: 'up-next meeting-line' },
        h('span', { class: 'muted' }, cal.now ? 'In a meeting' : 'Next meeting'),
        h('b', null, cal.now ? cal.now.title : cal.next!.title),
        h('span', { class: 'muted', style: 'margin-left:auto' }, cal.now ? `until ${clockTime(cal.now.end)}` : `${clockTime(cal.next!.start)}, in ${inMinutes(cal.next!.start)}`),
      ),
    );
  }

  const ready = (on: boolean, text: string, fix?: string) =>
    h('li', { class: on ? 'on' : '' }, h('span', { class: 'dot' }), text, !on && fix ? h('a', { href: `#${fix}` }, 'Fix') : null);
  clear(idle.ready);
  idle.ready.append(
    ready(s.onboarded, s.onboarded ? 'Work profile set up' : 'Set up in a minute: your goals, today’s to-dos and what distracts you', 'quiz'),
    ready(s.extensionConnected, s.extensionConnected ? 'Browser extension connected' : 'Browser extension not connected, so all browser time looks the same', 'settings#perm-sec'),
    ready(s.helperRunning, s.helperRunning ? 'Window sensor running' : 'Window sensor not running, so window titles and files are missing', 'settings#perm-sec'),
    ready(s.keys.anthropic, s.keys.anthropic ? 'Claude key added for live coaching' : 'No Claude key, so the coach uses pre-written lines', 'settings#keys-sec'),
    ready(s.keys.elevenlabs, s.keys.elevenlabs ? 'ElevenLabs key added for the coach voice' : 'No ElevenLabs key, so the coach uses the Mac voice and cannot hear you', 'settings#keys-sec'),
    ready(
      t.connected,
      t.connected
        ? 'To-do list connected, so the coach knows what you should be doing'
        : t.provider === 'none'
          ? 'No to-do list, so no roasts about unfinished tasks'
          : t.error
            ? `To-do list not connected: ${t.error}`
            : 'Connecting to your to-do list…',
      'todos',
    ),
  );
  // Only while something is missing: once everything is set up, the start screen stays clean.
  const sec = idle.ready.closest<HTMLElement>('.ready-sec');
  if (sec) sec.hidden = !idle.ready.querySelector('li:not(.on)');
}

function idleView(): HTMLElement {
  const s = state!;
  const goal = h('input', { class: 'goal-input', type: 'text', placeholder: 'Finish the Q3 pitch deck', value: s.lastGoal, 'aria-label': 'Session goal' });
  const startBtn = h('button', { class: 'btn btn-primary btn-big', type: 'button' }, `Lock in for ${chosenMinutes} minutes`);
  const custom = h('input', { type: 'number', min: '5', max: '240', placeholder: '45', 'aria-label': 'Custom minutes' });
  const segs: HTMLButtonElement[] = [];
  const pick = (m: number) => {
    chosenMinutes = m;
    for (const b of segs) b.setAttribute('aria-pressed', String(pomodoro ? b.dataset.m === '0' : Number(b.dataset.m) === m));
    startBtn.textContent = pomodoro ? 'Lock in for 4 Pomodoro rounds' : `Lock in for ${m} minutes`;
  };
  for (const [m, label] of [[25, 'sprint'], [50, 'standard'], [90, 'deep']] as const) {
    const b = h('button', { class: 'seg', type: 'button', 'data-m': String(m), onclick: () => { custom.value = ''; pomodoro = false; pick(m); } }, h('b', null, String(m)), h('span', null, `minutes, ${label}`));
    segs.push(b);
  }
  const pomoBtn = h('button', { class: 'seg', type: 'button', 'data-m': '0', onclick: () => { custom.value = ''; pomodoro = true; pick(115); } }, h('b', null, '4×25'), h('span', null, 'Pomodoro, 5-min breaks'));
  segs.push(pomoBtn);
  custom.addEventListener('input', () => {
    const v = Number(custom.value);
    if (v >= 5 && v <= 240) pick(v);
  });
  pick(chosenMinutes);
  const start = () => void api.invoke('session:start', { goal: goal.value.trim() || 'Deep work', minutes: chosenMinutes, pomodoro });
  startBtn.addEventListener('click', start);
  const talkBtn = h('button', { class: 'btn btn-quiet btn-big talk-btn', type: 'button', title: `Or hold Space, or press ${MOD}Space, anywhere`, onclick: () => void api.invoke('talk:open', 'checkin') }, '🎙 Talk to me');
  goal.addEventListener('keydown', (e) => e.key === 'Enter' && start());
  setTimeout(() => goal.focus(), 30);

  idle.goal = goal as HTMLInputElement;
  idle.upNext = h('div', { class: 'up-next-slot' });
  idle.ready = h('ul', { class: 'ready', 'aria-label': 'Readiness' });
  idle.extras = h('div', { class: 'home-extras' });
  // Filled by fillIdleStatus() and fillHomeExtras() once this view is on screen.

  return h(
    'section',
    { class: 'page' },
    h('h1', { class: 'display' }, 'What are you locking in on?'),
    idle.upNext,
    goal,
    h('div', { class: 'durations', role: 'group', 'aria-label': 'Session length' }, segs, h('label', { class: 'custom-min' }, 'or', custom, 'min')),
    h('div', { class: 'start-row' }, startBtn, talkBtn),
    h('p', { class: 'hint' }, h('kbd', null, `${MOD}L`), ' opens this window. Hold ', h('kbd', null, 'Space'), ' or press ', h('kbd', null, `${MOD}Space`), ' to talk to the coach. ', h('kbd', null, `${MOD}M`), ' mutes it for 30 minutes.'),
    idle.extras,
    h('div', { class: 'section ready-sec', hidden: true }, h('h2', null, 'Finish setting up'), idle.ready),
  );
}

// -----------------------------------------------------------------------------
// Lock in page: deadlines and routines

function timeLabel(hhmm: string): string {
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function daysUntil(due: string): number {
  const [y, m, d] = due.split('-').map(Number);
  const today = new Date();
  return Math.round((new Date(y, m - 1, d).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
}

function dueText(d: { due: string; time?: string }): string {
  const n = daysUntil(d.due);
  const [y, m, dd] = d.due.split('-').map(Number);
  const date = new Date(y, m - 1, dd).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const rel = n < 0 ? `${-n} ${n === -1 ? 'day' : 'days'} overdue` : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
  return `${n > 1 ? `${date}, ` : ''}${rel}${d.time ? ` at ${timeLabel(d.time)}` : ''}`;
}

const isoDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let deadlinesBox: HTMLElement | null = null;

async function refreshDeadlines(): Promise<void> {
  if (!deadlinesBox?.isConnected) return;
  drawDeadlines(deadlinesBox, await api.invoke<(Deadline & { overdue: boolean })[]>('deadlines:get'));
}

function drawDeadlines(sec: HTMLElement, items: (Deadline & { overdue: boolean })[]): void {
  clear(sec);
  const title = h('input', { type: 'text', placeholder: "What's due? e.g. Sequoia pitch deck", 'aria-label': 'Deadline' });
  const date = h('input', { type: 'date', value: isoDate(Date.now() + 3 * 86_400_000), min: isoDate(Date.now()), 'aria-label': 'Due date' });
  const time = h('input', { type: 'time', 'aria-label': 'Due time (optional)', title: 'Optional time' });
  const add = h('button', { class: 'btn btn-ink btn-small', type: 'button' }, 'Add deadline');
  add.addEventListener('click', async () => {
    if (!title.value.trim()) return title.focus();
    drawDeadlines(sec, await api.invoke('deadlines:add', { title: title.value.trim(), due: date.value, time: time.value || undefined }));
  });
  title.addEventListener('keydown', (e) => e.key === 'Enter' && add.click());

  const open = items.filter((d) => !d.done);
  const done = items.filter((d) => d.done);
  const row = (d: Deadline & { overdue: boolean }) => {
    const n = daysUntil(d.due);
    const cb = h('input', { type: 'checkbox', checked: d.done, 'aria-label': d.done ? `Reopen "${d.title}"` : `"${d.title}" is done` });
    cb.addEventListener('change', async () => drawDeadlines(sec, await api.invoke('deadlines:done', d.id, cb.checked)));
    return h(
      'li',
      { class: `deadline${d.overdue ? ' overdue' : n <= 1 && !d.done ? ' soon' : ''}` },
      h('label', { class: 'task' }, cb, h('span', { class: 'task-title' }, d.title)),
      h('span', { class: 'due' }, dueText(d)),
      d.done ? null : h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void api.invoke('session:start', { goal: d.title, minutes: chosenMinutes, pomodoro: false }) }, 'Lock in'),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', 'aria-label': `Delete "${d.title}"`, onclick: async () => drawDeadlines(sec, await api.invoke('deadlines:remove', d.id)) }, '×'),
    );
  };
  sec.append(
    h('h2', null, 'Deadlines'),
    h('p', { class: 'sub' }, "You'll get a reminder once 3 days before, twice 2 days before and three times the day before, until it's done. On the day, it's pinned at the top of Lock in."),
    h('div', { class: 'add-row deadline-add' }, title, date, time, add),
    open.length ? h('ul', { class: 'tasks deadlines' }, open.map(row)) : h('p', { class: 'muted' }, 'No deadlines coming up. Add one above, or press 📌 on a to-do with a due date.'),
  );
  if (done.length) sec.append(h('details', { class: 'how' }, h('summary', null, `Done (${done.length})`), h('ul', { class: 'tasks deadlines' }, done.slice(-20).reverse().map(row))));
}

async function routinesSection(sec: HTMLElement): Promise<void> {
  const list = await api.invoke<Routine[]>('routines:get');
  const save = () => void api.invoke('routines:save', list);
  const redraw = () => void routinesSection(sec);
  clear(sec);
  sec.append(
    h('h2', null, 'Routines'),
    h('p', { class: 'sub' }, 'Check-ins through the day. Timed ones fire once a day if you are at the computer. Repeating ones count only minutes you are actually using it, and wait until a focus session ends.'),
  );
  const rows = h('div', { class: 'routines' });
  for (const r of list) {
    const trig = r.trigger;
    const sched = h('div', { class: 'inline sched' });
    if (trig.type === 'time') {
      const t = h('input', { type: 'time', value: trig.at, 'aria-label': `${r.name} time` });
      t.addEventListener('change', () => { trig.at = t.value; save(); });
      sched.append('At', t, dayPicker(trig.days, save));
    } else {
      const every = h('input', { type: 'number', min: '5', max: '240', value: String(trig.everyMin), 'aria-label': `${r.name} interval in minutes` });
      every.addEventListener('change', () => { trig.everyMin = Math.max(5, Math.min(240, Number(every.value) || 60)); save(); });
      const from = h('input', { type: 'time', value: trig.from, 'aria-label': 'From' });
      const to = h('input', { type: 'time', value: trig.to, 'aria-label': 'To' });
      from.addEventListener('change', () => { trig.from = from.value; save(); });
      to.addEventListener('change', () => { trig.to = to.value; save(); });
      sched.append('Every', every, 'min of screen time, from', from, 'to', to, dayPicker(trig.days, save));
    }
    if (r.kind === 'deepwork' || (r.kind === 'custom' && r.offerSession)) {
      const m = h('input', { type: 'number', min: '10', max: '240', value: String(r.minutes ?? 50), 'aria-label': 'Session minutes' });
      m.addEventListener('change', () => { r.minutes = Math.max(10, Math.min(240, Number(m.value) || 50)); save(); });
      sched.append('for', m, 'min');
    }
    rows.append(
      h(
        'div',
        { class: `routine${r.enabled ? '' : ' off'}` },
        sw(r.enabled, (v) => { r.enabled = v; save(); redraw(); }, `${r.name} on or off`),
        h('div', { class: 'routine-main' }, h('b', null, r.name), h('p', { class: 'muted' }, r.kind === 'custom' ? r.message ?? '' : ROUTINE_HELP[r.kind]), sched),
        h(
          'div',
          { class: 'routine-actions' },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('routines:test', r.id) }, 'Try it'),
          r.kind === 'custom' ? h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => { list.splice(list.indexOf(r), 1); save(); redraw(); } }, 'Delete') : null,
        ),
      ),
    );
  }
  sec.append(rows);

  // Add your own
  const name = h('input', { type: 'text', placeholder: 'Call mom' });
  const msg = h('input', { type: 'text', placeholder: 'What should the coach say?' });
  const kind = h('select', null, h('option', { value: 'time' }, 'At a time each day'), h('option', { value: 'interval' }, 'Every so many minutes'));
  const at = h('input', { type: 'time', value: '16:00', 'aria-label': 'Time' });
  const every = h('input', { type: 'number', min: '5', max: '240', value: '45', 'aria-label': 'Minutes', hidden: true });
  kind.addEventListener('change', () => {
    at.hidden = kind.value !== 'time';
    every.hidden = kind.value !== 'interval';
  });
  const offer = h('input', { type: 'checkbox' });
  sec.append(
    h(
      'details',
      { class: 'how add-routine' },
      h('summary', null, 'Add your own routine'),
      field('Name', null, name),
      field('Message', 'Leave blank and the name is used.', msg),
      field('When', null, h('div', { class: 'inline' }, kind, at, every)),
      field('Offer a focus session', null, h('label', { class: 'inline' }, offer, 'Show a "Lock in" button')),
      h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn btn-ink', type: 'button', onclick: () => {
        if (!name.value.trim()) return name.focus();
        list.push({
          id: `custom-${Date.now()}`,
          kind: 'custom',
          name: name.value.trim(),
          enabled: true,
          message: msg.value.trim() || name.value.trim(),
          offerSession: offer.checked,
          minutes: 50,
          trigger: kind.value === 'time' ? { type: 'time', at: at.value || '16:00', days: [0, 1, 2, 3, 4, 5, 6] } : { type: 'interval', everyMin: Math.max(5, Number(every.value) || 45), from: '08:00', to: '22:00', days: [0, 1, 2, 3, 4, 5, 6] },
        });
        save();
        redraw();
      } }, 'Add routine')),
    ),
  );
}

/** Today's goals and your crew under the start controls. Deadlines live on To-dos, routines in Settings. */
async function fillHomeExtras(): Promise<void> {
  const box = idle.extras;
  if (!box) return;
  clear(box);
  crewStrip = h('div', { class: 'crew-strip' });
  const goalsSlot = h('div', { class: 'goal-strip-slot' });
  box.append(goalsSlot, crewStrip);
  void api.invoke<CrewPayload>('crew:get').then(drawCrewStrip);
  if (state?.goals !== false) {
    void api.invoke<GoalsView>('goals:get').then((v) => {
      const strip = goalStrip(v, () => go('goals'));
      if (strip && goalsSlot.isConnected) goalsSlot.append(strip);
    });
  }
  scrollToAnchor();
}

const live: Record<string, HTMLElement> = {};

function liveView(): HTMLElement {
  const s = state!.session!;
  live.goal = h('p', { class: 'live-goal' }, s.goal || 'Deep work');
  live.clock = h('div', { class: 'clock', 'aria-live': 'off' }, '');
  live.clockSub = h('p', { class: 'clock-sub' }, '');
  live.breakBanner = h('div', { class: 'break-banner', hidden: true });
  live.needle = h('div', { class: 'needle', style: 'left:0%' });
  live.meterNote = h('span', null, '');
  live.now = h('div', { class: 'now' });
  live.focus = h('b', null, '0');
  live.drifted = h('b', null, '0');
  live.actions = h('div', { class: 'live-actions' });

  const labels = [
    ['20%', 'Nudge'],
    ['50%', 'Coach speaks'],
    ['75%', 'Yellow card'],
    ['100%', 'Red card'],
  ];

  renderLiveActions();
  return h(
    'section',
    { class: 'page' },
    live.goal,
    live.clock,
    live.clockSub,
    live.breakBanner,
    h(
      'div',
      { class: 'meter-wrap' },
      h('div', { class: 'meter-title' }, h('span', null, 'Drift'), live.meterNote),
      h('div', { class: 'meter', role: 'img', 'aria-label': 'Drift meter' }, h('div', { class: 'meter-track' }, h('i', { class: 'z0' }), h('i', { class: 'z1' }), h('i', { class: 'z2' }), h('i', { class: 'z3' })), live.needle),
      h('div', { class: 'meter-labels' }, labels.map(([left, t]) => h('span', { style: `left:${left}` }, t))),
    ),
    live.now,
    h('div', { class: 'tallies' }, h('div', { class: 'tally' }, live.focus, h('span', null, 'minutes focused')), h('div', { class: 'tally' }, live.drifted, h('span', null, 'minutes drifting'))),
    live.actions,
  );
}

let commitOpen = false;

function renderLiveActions(): void {
  clear(live.actions);
  const muted = !!state?.muteUntil;
  if (commitOpen) {
    const phrase = 'I choose to stop';
    const input = h('input', { type: 'text', placeholder: `Type "${phrase}"`, 'aria-label': 'Confirm ending early' });
    const ok = h('button', { class: 'btn btn-ink', type: 'button', disabled: true, onclick: () => { commitOpen = false; void api.invoke('session:end'); } }, 'End session');
    input.addEventListener('input', () => (ok.disabled = input.value.trim().toLowerCase() !== phrase.toLowerCase()));
    live.actions.append(h('div', { class: 'commit' }, input, ok, h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { commitOpen = false; renderLiveActions(); } }, 'Keep going')));
    setTimeout(() => input.focus(), 20);
    return;
  }
  live.actions.append(
    h('button', {
      class: 'btn btn-ink',
      type: 'button',
      onclick: () => {
        if (settings?.commitmentMode) {
          commitOpen = true;
          renderLiveActions();
        } else void api.invoke('session:end');
      },
    }, 'End session'),
    h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => void api.invoke(muted ? 'unmute' : 'mute', 30).then(() => setTimeout(renderLiveActions, 50)) }, muted ? 'Unmute the coach' : 'Mute the coach for 30 minutes'),
  );
}

let lastNowSig = '';

function tickLive(): void {
  const s = state?.session;
  if (!s || !live.clock) return;
  const left = s.plannedMin * 60 - s.elapsedSec;
  live.clock.textContent = mmss(left);
  live.clockSub.textContent = s.pomodoro ? `left in all 4 rounds, round ${s.pomodoro.cycle} of ${s.pomodoro.cycles}` : `left of ${s.plannedMin} minutes`;
  live.focus.textContent = String(Math.round(s.focusSec / 60));
  live.drifted.textContent = String(Math.round(s.driftSec / 60));
  const pct = Math.min(100, (s.drift / Math.max(1, s.driftThresholdSec)) * 100);
  live.needle.style.left = `${pct}%`;
  live.meterNote.textContent = s.level > 0 ? `Level ${s.level}` : s.drift >= 60 ? `${Math.round(s.drift / 60)} min of drift` : s.drift > 0 ? 'Under a minute of drift' : 'Clean';

  if (s.onBreakUntil) {
    live.breakBanner.hidden = false;
    clear(live.breakBanner);
    live.breakBanner.append(
      h('span', null, `On a break until ${clockTime(s.onBreakUntil)}. Distractions are allowed.`),
      h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('coach:choose', 'back') }, 'End break'),
    );
  } else live.breakBanner.hidden = true;

  const c = state?.current;
  const sig = JSON.stringify(c);
  if (sig === lastNowSig) return;
  lastNowSig = sig;
  clear(live.now);
  if (!c) {
    live.now.append(h('span', { class: 'muted' }, 'Waiting for the window sensor…'));
    return;
  }
  const where = c.domain ?? c.app;
  const tools = h('div', { class: 'now-tools' });
  if (c.label !== 'private' && c.label !== 'away') {
    if (c.label !== 'work') tools.append(h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void api.invoke('labels:current', 'work') }, 'Count as work'));
    if (c.label !== 'distraction') tools.append(h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void api.invoke('labels:current', 'distraction') }, 'Count as distraction'));
  }
  live.now.append(...[
    h('span', { class: 'muted' }, 'Now'),
    h('span', { class: 'now-where' }, where),
    c.title ? h('span', { class: 'now-title' }, c.title) : null,
    h('span', { class: `pill ${c.label}` }, c.label === 'private' ? 'private' : c.label),
    c.source === 'fallback' ? h('span', { class: 'muted', style: 'font-size:12px' }, 'checking…') : null,
    tools,
  ].filter((x): x is HTMLElement => !!x));
}

// -----------------------------------------------------------------------------
// Today

/** Focus time, sessions, distractions and what works: the old Today page, now under the to-dos. */
async function todaySections(): Promise<HTMLElement[]> {
  const d = await api.invoke<DashboardData>('dashboard:get');
  const page = h('div', { class: 'today-block' });
  page.append(
    h(
      'div',
      { class: 'section', id: 'today-sec' },
      h('h2', null, 'Today'),
      h('p', { class: 'big-stat' }, h('b', null, `${d.todayFocusMin}`), ` focused ${d.todayFocusMin === 1 ? 'minute' : 'minutes'}`),
      h('p', { class: 'sub' }, d.todaySessions ? `${plural(d.todaySessions, 'session')}, ${plural(d.todayDrifts, 'drift')} the coach had to call out.` : 'No sessions yet today.'),
    ),
  );

  const sess = h('div', { class: 'section' }, h('h2', null, 'Sessions'));
  if (!d.sessions.length) sess.append(h('div', { class: 'empty' }, 'Your sessions will show up here. Start one from the Lock in page.'));
  else {
    sess.append(
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Goal'), h('th', null, 'Started'), h('th', { class: 'num' }, 'Planned'), h('th', { class: 'num' }, 'Focused'), h('th', { class: 'num' }, 'Drifts'), h('th', null, 'Ended'))),
        h(
          'tbody',
          null,
          d.sessions.map((s) =>
            h(
              'tr',
              null,
              h('td', null, s.goal || 'Deep work'),
              h('td', null, `${new Date(s.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clockTime(s.startedAt)}`),
              h('td', { class: 'num' }, `${s.plannedMin} min`),
              h('td', { class: 'num' }, `${Math.round(s.focusSec / 60)} min`),
              h('td', { class: 'num' }, String(s.interventions)),
              h('td', null, s.endedAt ? (s.endedBy === 'timer' ? 'Finished' : s.endedBy === 'quit' ? 'App quit' : 'Ended early') : 'Running'),
            ),
          ),
        ),
      ),
    );
  }
  page.append(sess);

  const dist = h('div', { class: 'section' }, h('h2', null, 'What pulled you away this week'));
  if (!d.topDistractions.length) dist.append(h('p', { class: 'sub' }, 'Nothing yet. Distractions you spend time on during sessions appear here.'));
  else {
    const max = Math.max(...d.topDistractions.map((x) => x.minutes), 1);
    dist.append(h('div', { class: 'bars' }, d.topDistractions.map((x) => h('div', { class: 'bar-row' }, h('span', { class: 'name' }, x.name), h('div', { class: 'bar', style: `width:${Math.max(2, (x.minutes / max) * 100)}%` }), h('span', { class: 'val' }, `${x.minutes} min`)))));
  }
  page.append(dist);

  const works = h('div', { class: 'section' }, h('h2', null, 'What gets you back'), h('p', { class: 'sub' }, 'An option worked when you were back in a work app within 2 minutes and stayed there for 10.'));
  if (!d.optionStats.length) works.append(h('p', { class: 'muted' }, 'No interventions yet.'));
  else {
    works.append(
      h(
        'div',
        { class: 'bars' },
        d.optionStats.map((o) =>
          h('div', { class: 'bar-row' }, h('span', { class: 'name' }, OPTION_LABELS[o.option as RouteOption] ?? o.option), h('div', { class: 'bar good', style: `width:${o.used ? Math.max(2, (o.worked / o.used) * 100) : 2}%` }), h('span', { class: 'val' }, `${o.worked} of ${o.used}`)),
        ),
      ),
    );
  }
  page.append(works);
  return [page];
}

// -----------------------------------------------------------------------------
// To-dos page: the week

async function weekSection(): Promise<HTMLElement> {
  const days = await api.invoke<WeekDay[]>('week:get');
  const connected = !!state?.calendar.connected;
  const sec = h(
    'div',
    { class: 'section', id: 'week-sec' },
    h('div', { class: 'row-head' }, h('h2', null, 'This week'), connected ? null : h('a', { class: 'btn btn-small btn-quiet', href: '#calendar' }, 'Connect your calendar')),
  );
  const grid = h('div', { class: 'week' });
  for (const d of days) {
    const items: HTMLElement[] = [];
    for (const x of d.deadlines) {
      const late = !x.done && daysUntil(x.due) < 0;
      items.push(h('div', { class: `wk deadline${x.done ? ' done' : ''}${late ? ' late' : ''}`, title: `Deadline: ${x.title}${late ? ' (overdue)' : ''}` }, `📌 ${x.title}`));
    }
    for (const e of d.events.filter((e) => e.allDay)) items.push(h('div', { class: 'wk allday', title: e.title }, e.title));
    for (const e of d.events.filter((e) => !e.allDay)) {
      items.push(h('div', { class: `wk event${e.busy ? '' : ' free'}${e.end < Date.now() ? ' past' : ''}`, title: `${clockTime(e.start)} – ${clockTime(e.end)} ${e.title}` }, h('span', { class: 'wk-time' }, clockTime(e.start).replace(/\s?[AP]M$/i, '')), ` ${e.title}`));
    }
    for (const t of d.tasks) items.push(h('div', { class: `wk task${t.due && t.due < d.date ? ' late' : ''}`, title: `To-do: ${t.title}${t.due && t.due < d.date ? ` (was due ${t.due})` : ''}` }, `○ ${t.title}`));
    grid.append(
      h(
        'div',
        { class: `week-day${d.label === 'Today' ? ' today' : ''}` },
        h('div', { class: 'week-head' }, d.label),
        items.length ? items : h('div', { class: 'wk none' }, 'Free'),
      ),
    );
  }
  sec.append(grid, h('p', { class: 'muted week-key' }, '📌 deadline · time = meeting · ○ to-do due that day'));
  return sec;
}

// -----------------------------------------------------------------------------
// Daily export

interface ExportStatus {
  folder: string;
  lastAt: number;
  error?: string;
  auto: boolean;
}

async function exportSection(): Promise<HTMLElement> {
  const sec = h('div', { class: 'section export' });
  const draw = (x: ExportStatus) => {
    clear(sec);
    const shortFolder = x.folder.replace(/^\/Users\/[^/]+/, '~');
    sec.append(
      h('h2', null, 'Daily export'),
      h('p', { class: 'sub' }, 'Lock In writes CSV files you can open in Excel, Numbers or Google Sheets: every to-do on your list each day (open or done), everything you finished, your deadlines, a one-row-per-day summary, your focus sessions, and a file per day. A full backup goes in the Backups folder every day. More just below, under Your data.'),
      field('Folder', null, h('div', { class: 'inline' }, h('code', { class: 'file-path', title: x.folder }, shortFolder), h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => draw(await api.invoke<ExportStatus>('export:chooseFolder')) }, 'Change'))),
      field('Update every day', 'Also refreshed every hour, so today is always current.', sw(x.auto, async (v) => {
        const st = await api.invoke<Settings>('settings:get');
        await api.invoke('settings:save', { exportCsv: { ...st.exportCsv, auto: v } });
      }, 'Update every day')),
      h(
        'div',
        { class: 'test-row' },
        h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
          const r = await api.invoke<{ ok: boolean; error?: string; at: number; folder: string }>('export:now');
          draw({ ...x, lastAt: r.at, error: r.error, folder: r.folder });
        } }, 'Export now'),
        h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void api.invoke('export:open') }, 'Open the folder'),
      ),
      x.error ? h('p', { class: 'sheet-error', role: 'alert' }, x.error) : h('p', { class: 'muted' }, x.lastAt ? `Last written at ${clockTime(x.lastAt)}.` : 'Not written yet this run.'),
    );
  };
  draw(await api.invoke<ExportStatus>('export:status'));
  return sec;
}

// -----------------------------------------------------------------------------
// Calendar

interface CalendarData {
  events: CalEvent[];
  summary: LiveState['calendar'];
  agenda: string;
  lastFetch: number;
}

function maskUrl(u: string): string {
  try {
    const x = new URL(u.replace(/^webcals?:/i, 'https:'));
    return `${x.hostname}/…${x.pathname.slice(-10)}`;
  } catch {
    return `${u.slice(0, 24)}…`;
  }
}

function dayLabel(t: number): string {
  const d = new Date(t);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - today.getTime()) / 86_400_000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

interface MacCalView {
  available: boolean;
  status: MacCalStatus | 'missing';
  on: boolean;
  calendars: MacCalendarInfo[];
  exclude: string[];
  message: string;
}

/** Settings → Calendar: your Google account (and anything else) through the Calendar app on this Mac. */
async function macCalendarBlock(rerender: () => void): Promise<HTMLElement> {
  const v = await api.invoke<MacCalView>('calendar:mac', 'status');
  const box = h('div', { class: 'sub-block mac-cal' });
  const result = h('p', { class: 'muted', 'aria-live': 'polite' });
  const bad = (msg: string, privacy = false) => {
    clear(result);
    result.className = 'sheet-error';
    result.append(msg);
    if (privacy) result.append(h('button', { class: 'btn btn-small', type: 'button', style: 'margin-left:8px', onclick: () => void api.invoke('calendar:mac', 'privacy') }, 'Open Privacy settings'));
  };
  const accountsBtn = (label: string, cls = 'btn btn-small') => h('button', { class: cls, type: 'button', onclick: () => void api.invoke('calendar:mac', 'accounts') }, label);
  const connectBtn = h('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: !v.available }, v.on ? 'Try again' : 'Connect');
  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    clear(result);
    result.className = 'muted';
    result.textContent = 'Waiting for macOS… If it asks whether Lock In may see your calendars, choose Allow Full Access.';
    const r = await api.invoke<{ ok: boolean; status: string; error?: string; calendars?: number; count?: number; next?: string }>('calendar:mac', 'connect');
    connectBtn.disabled = false;
    if (!r.ok) {
      bad(r.error ?? 'That did not work.', r.status === 'denied' || r.status === 'writeOnly' || r.status === 'notDetermined');
      return;
    }
    result.className = 'muted';
    result.textContent = r.calendars
      ? `Connected: ${plural(r.calendars, 'calendar')}, ${plural(r.count ?? 0, 'event')} this week${r.next ? `; next up: ${r.next}` : ''}.`
      : 'Connected, but the Calendar app has no calendars yet. Add your Google account (step 1), wait a minute for it to sync, then press Try again.';
    setTimeout(rerender, 1600);
  });

  const granted = v.on && v.status === 'granted';
  box.append(h('h3', { class: 'sub-head' }, granted ? 'Your calendars' : 'Connect your Google account'));
  if (!granted) {
    box.append(
      h('p', { class: 'sub' }, 'Sign in to Google once through your Mac and Lock In reads your calendars from there. Works with Brown, school and work accounts (no secret link needed), and with iCloud and Outlook calendars too.'),
      h(
        'ol',
        { class: 'mac-steps' },
        h('li', null, h('div', null, h('b', null, 'Add your Google account to this Mac. '), 'In Internet Accounts, choose Google, sign in, and leave Calendars on. Already see your Google calendars in the Calendar app? Skip this.'), accountsBtn('Open Internet Accounts')),
        h('li', null, h('div', null, h('b', null, 'Let Lock In read it. '), 'macOS asks once; choose Allow Full Access. Lock In only reads; it never changes your calendar.'), connectBtn),
      ),
      result,
    );
    if (!v.available) bad(v.message);
    else if (v.on && v.status !== 'granted') bad(v.message, true);
    box.append(h('p', { class: 'muted' }, 'Why not a "Sign in with Google" button? Google only allows that for apps it has registered and reviewed. Your Mac’s own Google sign-in is already approved, so Lock In reads through it.'));
    return box;
  }

  // Connected: the calendars, grouped by account, each one on or off.
  const off = new Set(v.exclude);
  const groups = new Map<string, MacCalendarInfo[]>();
  for (const c of v.calendars) groups.set(c.source || 'On this Mac', [...(groups.get(c.source || 'On this Mac') ?? []), c]);
  const list = h('div', { class: 'mac-cals' });
  for (const [source, cals] of groups) {
    list.append(
      h(
        'div',
        { class: 'mac-group' },
        h('div', { class: 'mac-source' }, source),
        cals.map((c) => {
          const box = h('input', { type: 'checkbox', checked: !off.has(c.id) });
          box.addEventListener('change', () => {
            if (box.checked) off.delete(c.id);
            else off.add(c.id);
            void api.invoke('calendar:mac', 'exclude', [...off]);
          });
          return h('label', { class: 'mac-cal-row' }, box, h('span', null, c.title));
        }),
      ),
    );
  }
  box.append(
    h('p', { class: 'sub' }, `Reading ${plural(v.calendars.length - v.calendars.filter((c) => off.has(c.id)).length, 'calendar')} from the Calendar app on this Mac. Untick any Lock In should ignore.`),
    v.calendars.length ? list : h('p', { class: 'muted' }, 'The Calendar app has no calendars yet. Add your Google account, wait a minute, and they appear here.'),
    h(
      'div',
      { class: 'test-row' },
      accountsBtn('Add another account', 'btn btn-small btn-quiet'),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => { await api.invoke('calendar:mac', 'disconnect'); rerender(); } }, 'Stop reading the Calendar app'),
    ),
    result,
  );
  return box;
}

/** Settings → Calendar: connect iCal links and choose what Lock In does with them. */
async function calendarSection(sec: HTMLElement): Promise<void> {
  const st = await api.invoke<Settings>('settings:get');
  const cal: CalendarSettings = { ...st.calendar, urls: [...st.calendar.urls] };
  const data = await api.invoke<CalendarData>('calendar:get');
  const rerender = () => void calendarSection(sec);
  const save = async (patch: Partial<CalendarSettings>) => {
    Object.assign(cal, patch);
    // Start from what's saved now, so a change made elsewhere (the Calendar app block) isn't undone.
    const fresh = await api.invoke<Settings>('settings:get');
    await api.invoke('settings:save', { calendar: { ...fresh.calendar, ...patch } });
  };
  clear(sec);
  const page = sec;
  page.append(
    h('h2', null, 'Calendar'),
    h('p', { class: 'sub' }, cal.urls.length || cal.mac ? data.summary.error ?? `Connected. ${data.agenda}` : 'Connect your calendar so Lock In keeps quiet in meetings, warns you before them, offers a lock-in in the gaps, and shows your week on the To-dos page.'),
  );
  page.append(await macCalendarBlock(rerender));

  // Connect
  const links = h('ul', { class: 'cal-links' });
  for (const u of cal.urls) {
    links.append(
      h('li', null, h('code', null, maskUrl(u)), h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => { await save({ urls: cal.urls.filter((x) => x !== u) }); rerender(); } }, 'Remove')),
    );
  }
  const input = h('input', { type: 'text', placeholder: 'Paste a secret iCal link (ends in .ics)', 'aria-label': 'Calendar link', autocomplete: 'off' });
  const result = h('p', { class: 'muted', 'aria-live': 'polite' });
  const addBtn = h('button', { class: 'btn btn-small', type: 'button' }, 'Add');
  addBtn.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) return;
    addBtn.disabled = true;
    result.className = 'muted';
    result.textContent = 'Reading that calendar…';
    const r = await api.invoke<{ ok: boolean; count?: number; next?: string; error?: string }>('calendar:test', url);
    addBtn.disabled = false;
    if (!r.ok) {
      result.className = 'sheet-error';
      result.textContent = r.error ?? 'Could not read that link.';
      return;
    }
    await save({ urls: [...cal.urls.filter((x) => x !== url), url] });
    result.textContent = `Connected. ${r.count} events this week${r.next ? `; next up: ${r.next}` : ''}.`;
    input.value = '';
    setTimeout(rerender, 1200);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && addBtn.click());
  const how = (title: string, ...steps: string[]) => h('details', { class: 'how' }, h('summary', null, title), h('ol', null, steps.map((x) => h('li', null, x))));
  page.append(
    h(
      'details',
      { class: 'sub-block link-block', open: cal.urls.length > 0 },
      h('summary', { class: 'sub-head' }, cal.urls.length ? `Calendar links (${cal.urls.length})` : 'Or paste a calendar link instead'),
      h('p', { class: 'muted' }, 'For a calendar that is not in the Calendar app, or a shared team calendar. Most people only need the Google account above.'),
      cal.urls.length ? links : null,
      h('div', { class: 'add-row' }, input, addBtn),
      result,
      how(
        'Google Calendar',
        'Open calendar.google.com on your computer and click the gear, then Settings.',
        'On the left, under "Settings for my calendars", click your calendar.',
        'Scroll to "Integrate calendar" and copy "Secret address in iCal format".',
        'Paste it above. Add one link per calendar (work and personal).',
        'No "Secret address" there? Brown, school and work accounts often hide it. Use "Connect your Google account" above instead.',
      ),
      how('Outlook', 'Outlook on the web: Settings, Calendar, Shared calendars.', 'Under "Publish a calendar", pick your calendar and "Can view all details", then Publish.', 'Copy the ICS link and paste it above.'),
      how('iCloud', 'In the Calendar app, right-click the calendar and choose Share Calendar.', 'Tick "Public Calendar" and copy the link.', 'Paste it above.'),
      h('p', { class: 'muted' }, 'A secret link lets anyone who has it read that calendar, so Lock In keeps it on this Mac and only uses it to read your events. Lock In never changes your calendar.'),
    ),
  );

  // Behaviour
  const heads = h('select', { 'aria-label': 'Heads-up before meetings' }, [0, 2, 5, 10, 15].map((m) => h('option', { value: String(m), selected: cal.headsUpMin === m }, m ? `${m} minutes before` : 'No heads-up')));
  heads.addEventListener('change', () => void save({ headsUpMin: Number(heads.value) }));
  page.append(
    h(
      'div',
      { class: 'sub-block' },
      h('h3', { class: 'sub-head' }, 'What Lock In does with it'),
      field('Quiet in meetings', 'No roasts or check-ins while a meeting is on.', sw(cal.quietInMeetings, (v) => void save({ quietInMeetings: v }), 'Quiet in meetings')),
      field('Heads-up', 'A corner card (with the call link) before each meeting.', heads),
      field('Lock in after meetings', 'When a meeting ends and there is a real gap, offer a session sized to it.', sw(cal.offerGaps, (v) => void save({ offerGaps: v }), 'Lock in after meetings')),
      field('End sessions before meetings', 'A 50-minute session that would run into your 3:00 ends at 2:58.', sw(cal.capSessions, (v) => void save({ capSessions: v }), 'End sessions before meetings')),
    ),
  );

}

// -----------------------------------------------------------------------------
// Profile

function chipEditor(items: string[], onChange: (next: string[]) => void, placeholder: string): HTMLElement {
  const wrap = h('div');
  const draw = () => {
    clear(wrap);
    const chips = h('div', { class: 'chips' }, items.map((it, i) => h('span', { class: 'chip' }, it, h('button', { type: 'button', 'aria-label': `Remove ${it}`, onclick: () => { items.splice(i, 1); onChange(items); draw(); } }, '×'))));
    const input = h('input', { type: 'text', placeholder });
    const add = () => {
      const v = input.value.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, (m) => (placeholder.includes('site') ? '' : m));
      if (v && !items.includes(v)) {
        items.push(v);
        onChange(items);
        draw();
      }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
    wrap.append(chips, h('div', { class: 'add-row' }, input, h('button', { class: 'btn btn-small', type: 'button', onclick: add }, 'Add')));
  };
  draw();
  return wrap;
}

async function saveProfile(): Promise<void> {
  if (profile) await api.invoke('profile:save', profile);
}

/** The profile editor (work apps and sites, distractions, sometimes-work, learned labels), shown in Settings. */
async function profileEditor(): Promise<HTMLElement> {
  const page = h('div', { class: 'profile-editor' });
  if (!profile) return page;
  const p = profile;
  // What you do (it shapes the coach's words; setup also uses it to pick work apps and sites).
  const roleSet = new Set((p.roles ?? [p.role]).filter((r) => r !== 'other'));
  const saveRoles = () => {
    p.roles = roleSet.size ? [...roleSet] : ['other'];
    p.role = p.roles[0];
    void saveProfile();
  };
  const note = h('input', { type: 'text', value: p.roleNote ?? '', placeholder: 'e.g. incoming analyst, PhD in biology, architect', 'aria-label': 'Anything else about your work' });
  note.addEventListener('change', () => {
    p.roleNote = note.value.trim() || undefined;
    void saveProfile();
  });
  page.append(
    h('div', { class: 'section' }, h('h2', null, 'What you do'), h('p', { class: 'sub' }, 'The coach keeps this in mind. Changing it here doesn’t touch your work apps and sites below.'),
      h('div', { class: 'chips' }, ROLE_ORDER.filter((r) => r !== 'other').map((r) => pickChip(ROLE_TEMPLATES[r].label, () => roleSet.has(r), () => { toggleIn(roleSet, r); saveRoles(); }))),
      h('div', { class: 'add-row' }, note)),
  );
  page.append(
    h('div', { class: 'section' }, h('h2', null, 'Work apps'), h('p', { class: 'sub' }, 'Time in these apps always counts as focus. Use the name macOS shows in the menu bar.'), chipEditor(p.workApps, (v) => { p.workApps = v; void saveProfile(); }, 'Add an app, e.g. Figma')),
    h('div', { class: 'section' }, h('h2', null, 'Work sites'), h('p', { class: 'sub' }, 'Subdomains count too: adding google.com covers docs.google.com.'), chipEditor(p.workDomains, (v) => { p.workDomains = v; void saveProfile(); }, 'Add a site, e.g. linear.app')),
  );

  const distList = Object.keys(p.distractionDomains);
  page.append(
    h('div', { class: 'section' }, h('h2', null, 'Distracting sites'), h('p', { class: 'sub' }, 'Time here builds drift. A minute of grace applies before it counts.'), chipEditor(distList, (v) => {
      const next: Record<string, number> = {};
      for (const d of v) next[d] = p.distractionDomains[d] ?? COMMON_DISTRACTIONS[d] ?? 1;
      p.distractionDomains = next;
      void saveProfile();
    }, 'Add a site, e.g. espn.com')),
  );
  const distApps = Object.keys(p.distractionApps);
  page.append(
    h('div', { class: 'section' }, h('h2', null, 'Distracting apps'), chipEditor(distApps, (v) => {
      const next: Record<string, number> = {};
      for (const a of v) next[a] = p.distractionApps[a] ?? COMMON_DISTRACTION_APPS[a] ?? 1;
      p.distractionApps = next;
      void saveProfile();
    }, 'Add an app, e.g. Steam')),
  );

  const grayWrap = h('div', { class: 'section' }, h('h2', null, 'Sometimes work'), h('p', { class: 'sub' }, 'A distracting site counts as work when the page title contains one of these words.'));
  const grayList = h('div');
  const drawGray = () => {
    clear(grayList);
    if (!p.grayRules.length) grayList.append(h('p', { class: 'muted' }, 'None yet. Add one below.'));
    p.grayRules.forEach((r, i) => {
      const kw = h('input', { type: 'text', value: r.workIfTitleContains.join(', '), 'aria-label': `Keywords for ${r.domain}` });
      kw.addEventListener('change', () => {
        r.workIfTitleContains = kw.value.split(',').map((x) => x.trim()).filter(Boolean);
        void saveProfile();
      });
      grayList.append(h('div', { class: 'field' }, h('label', null, r.domain), h('div', { class: 'inline' }, kw, h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => { p.grayRules.splice(i, 1); void saveProfile(); drawGray(); } }, 'Remove'))));
    });
    const dom = h('input', { type: 'text', placeholder: 'youtube.com' });
    grayList.append(
      h('div', { class: 'add-row' }, dom, h('button', { class: 'btn btn-small', type: 'button', onclick: () => {
        const d = dom.value.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
        if (!d) return;
        p.grayRules.push({ domain: d, workIfTitleContains: [...DEFAULT_GRAY_KEYWORDS] });
        void saveProfile();
        drawGray();
      } }, 'Add a site')),
    );
  };
  drawGray();
  grayWrap.append(grayList);
  page.append(grayWrap);

  // What gets you back on track: the coach offers these in this order.
  const ol = h('ol', { class: 'order' });
  const drawOrder = () => {
    clear(ol);
    const order = p.routeBackOrder?.length ? p.routeBackOrder : [...DEFAULT_ROUTE_ORDER];
    order.forEach((o, i) => {
      const move = (d: number) => {
        const j = i + d;
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        p.routeBackOrder = order;
        void saveProfile();
        drawOrder();
      };
      ol.append(h('li', null, h('b', null, String(i + 1)), h('span', null, OPTION_LABELS[o]), h('button', { type: 'button', 'aria-label': 'Move up', onclick: () => move(-1), disabled: i === 0 }, '↑'), h('button', { type: 'button', 'aria-label': 'Move down', onclick: () => move(1), disabled: i === order.length - 1 }, '↓')));
    });
  };
  drawOrder();
  page.append(h('div', { class: 'section' }, h('h2', null, 'What gets you back on track'), h('p', { class: 'sub' }, 'When you drift, the coach offers these in this order. Put the one that works best first.'), ol));

  // Learned labels
  const labels = await api.invoke<Record<string, { label: Label; source: 'model' | 'user'; reason?: string; updatedAt: number }>>('labels:list');
  const entries = Object.entries(labels).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 80);
  const learned = h('div', { class: 'section' }, h('h2', null, 'Learned labels'), h('p', { class: 'sub' }, 'Apps and sites labeled by you or by Claude. Your labels always win.'));
  if (!entries.length) learned.append(h('p', { class: 'muted' }, 'Nothing learned yet.'));
  else {
    learned.append(
      h(
        'table',
        { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', null, 'Label'), h('th', null, 'From'))),
        h(
          'tbody',
          null,
          entries.map(([key, v]) => {
            const sel = h('select', { 'aria-label': `Label for ${key}` }, ['work', 'neutral', 'distraction'].map((l) => h('option', { value: l, selected: v.label === l }, l)), h('option', { value: '' }, 'forget'));
            sel.addEventListener('change', () => void api.invoke('labels:set', { key, label: sel.value || null }).then(() => renderProfileSoon()));
            const [kind, ...rest] = key.split(':');
            const name = rest.join(':').replace('|', ': ');
            return h('tr', null, h('td', null, name, h('div', { class: 'muted', style: 'font-size:12px' }, kind === 'page' ? 'one page' : kind === 'site' ? 'website' : 'app')), h('td', null, sel), h('td', null, v.source === 'user' ? 'You' : `Claude${v.reason ? `: ${v.reason}` : ''}`));
          }),
        ),
      ),
    );
  }
  page.append(learned);
  return page;
}

function renderProfileSoon(): void {
  if (route === 'settings' && editingProfile) void renderSettingsPage();
}

/** Settings → Your work profile: a summary, or the full editor while editing. */
async function profileSection(): Promise<HTMLElement> {
  await loadProfile();
  const sec = h('div', { class: 'section', id: 'profile-sec' });
  const p = profile;
  const toggle = h(
    'button',
    { class: editingProfile ? 'btn btn-small btn-ink' : 'btn btn-small', type: 'button', onclick: () => { editingProfile = !editingProfile; void renderSettingsPage(); } },
    editingProfile ? 'Finish editing' : 'Edit profile',
  );
  sec.append(
    h(
      'div',
      { class: 'row-head' },
      h('h2', null, 'Your work profile'),
      h('div', { class: 'inline' }, p ? toggle : null, h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void openQuiz() }, p ? 'Redo setup' : 'Set up')),
    ),
  );
  if (!p) {
    sec.append(h('p', { class: 'sub' }, 'Not set up yet. Setup takes a minute: your goals, today’s to-dos and what distracts you.'));
    return sec;
  }
  const roles = (p.roles ?? [p.role]).map((r) => ROLE_TEMPLATES[r]?.label ?? r).join(', ');
  sec.append(
    h('p', { class: 'sub' }, `${roles}${p.roleNote ? ` (${p.roleNote})` : ''}. ${plural(p.workApps.length, 'work app')}, ${plural(p.workDomains.length, 'work site')}, ${plural(Object.keys(p.distractionDomains).length, 'distracting site')}, ${plural(Object.keys(p.distractionApps).length, 'distracting app')}.`),
  );
  if (editingProfile) {
    sec.append(h('p', { class: 'muted' }, 'What counts as work and what counts as drift. Changes save as you make them.'), await profileEditor());
    sec.append(h('div', { style: 'margin-top:16px' }, h('button', { class: 'btn btn-ink', type: 'button', onclick: () => { editingProfile = false; void renderSettingsPage().then(() => document.getElementById('profile-sec')?.scrollIntoView({ block: 'start' })); } }, 'Finish editing')));
  }
  return sec;
}

// -----------------------------------------------------------------------------
// Settings

function sw(checked: boolean, onChange: (v: boolean) => void, label: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span'));
}

function field(label: string, help: string | null, control: Node): HTMLElement {
  return h('div', { class: 'field' }, h('label', null, label, help ? h('span', { class: 'help' }, help) : null), h('div', { class: 'inline' }, control));
}

const PERSONAS: { id: Persona; name: string; desc: string; sample: string }[] = [
  { id: 'sassy', name: 'Sassy best friend', desc: 'Dry, dramatic, a little mean about your habits. Secretly on your side.', sample: 'Why are you so locked out again? Twelve minutes on YouTube. Babe.' },
  { id: 'gentle', name: 'Gentle friend', desc: 'Warm and quiet. Never raises its voice.', sample: 'Hey, we drifted a bit. Want to pick the deck back up?' },
  { id: 'firm', name: 'Firm coach', desc: 'Direct, short sentences, no small talk.', sample: 'Ten minutes on Reddit. The deck is due tomorrow. Back to it.' },
  { id: 'drill', name: 'Drill sergeant', desc: 'Loud, fast, relentless. Roasts the habit, never you.', sample: 'Hey! Fourth YouTube trip since lunch. Close it. Now!' },
];

interface VoiceListResp {
  hasKey: boolean;
  picks: VoiceOption[];
  mine: VoiceOption[];
  error?: string;
  current: string;
  currentName?: string;
  suggested: string;
  /** A coach made from someone, speaking in their own voice. */
  speaksAs?: string;
}

const GENDERS: [string, string][] = [['', 'Any voice'], ['female', 'Female'], ['male', 'Male'], ['neutral', 'Neutral']];
const ACCENTS: [string, string][] = [['', 'Any accent'], ['american', 'American'], ['british', 'British'], ['australian', 'Australian'], ['irish', 'Irish'], ['canadian', 'Canadian'], ['indian', 'Indian']];

/** Pick the coach's voice: a few natural ElevenLabs voices, your own ElevenLabs voices, and the Voice Library. */
function voicePicker(hooks: { refresh?: () => void }): HTMLElement {
  const nowLine = h('p', { class: 'voice-now' }, 'Loading voices…');
  const note = h('p', { class: 'sub voice-note' });
  const picksGrid = h('div', { class: 'voice-grid' });
  const mineBox = h('div', { class: 'voice-block' });
  const libGrid = h('div', { class: 'voice-grid' });
  const libNote = h('p', { class: 'muted voice-lib-note' });
  const more = h('button', { class: 'btn btn-small btn-quiet', type: 'button', hidden: true }, 'Show more');
  let data: VoiceListResp | null = null;
  let lib: VoiceOption[] = [];
  let libPage = 0;
  let playing: string | null = null;
  const playButtons = new Map<string, HTMLButtonElement>();

  const say = (msg: string, bad = false) => {
    note.textContent = msg;
    note.classList.toggle('sheet-error', bad);
  };
  const nameOf = (id: string) => [...(data?.picks ?? []), ...(data?.mine ?? []), ...lib].find((v) => v.id === id)?.name;
  const drawNow = () => {
    if (!data) return;
    const name = nameOf(data.current) ?? data.currentName;
    clear(nowLine);
    if (data.speaksAs) nowLine.append(`While ${data.speaksAs} is your coach, it talks in ${data.speaksAs}'s own voice. Otherwise it sounds like `, h('b', null, name ?? 'a custom voice'), '.');
    else nowLine.append('Your coach sounds like ', h('b', null, name ?? 'a custom voice'), '. It uses this voice for spoken lines and live conversations.');
  };

  const preview = async (v: VoiceOption, btn: HTMLButtonElement) => {
    if (playing === v.id) {
      await api.invoke('voices:stop');
      return;
    }
    if (playing) await api.invoke('voices:stop');
    playing = v.id;
    for (const [id, b] of playButtons) b.textContent = id === v.id ? '■ Stop' : '▶ Preview';
    btn.classList.add('playing');
    const how = await api.invoke<'coach' | 'sample' | 'none'>('voices:preview', { id: v.id, previewUrl: v.previewUrl });
    if (playing === v.id) playing = null;
    btn.textContent = '▶ Preview';
    btn.classList.remove('playing');
    if (how === 'none') say(`Couldn't play ${v.name}. Check your ElevenLabs key under Keys.`, true);
    else if (how === 'sample' && v.source === 'library') say(`That was ${v.name}'s own sample. Once you use it, it says your coach's lines.`);
  };

  const use = async (v: VoiceOption, btn: HTMLButtonElement) => {
    btn.disabled = true;
    btn.textContent = v.source === 'library' && !v.added ? 'Adding…' : 'Switching…';
    const r = await api.invoke<{ ok: boolean; error?: string }>('voices:use', { id: v.id, name: v.name, ownerId: v.ownerId, added: v.added });
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = 'Use';
      say(r.error ?? `Couldn't switch to ${v.name}.`, true);
      return;
    }
    if (data) {
      data.current = v.id;
      data.currentName = v.name;
    }
    if (v.source === 'library') v.added = true;
    say(`Done. Your coach now sounds like ${v.name}.`);
    drawAll();
  };

  const card = (v: VoiceOption) => {
    const on = data?.current === v.id;
    const canPlay = !!data?.hasKey || !!v.previewUrl;
    const play = h('button', { class: 'btn btn-small', type: 'button', disabled: !canPlay, title: canPlay ? `Hear ${v.name} as your coach` : 'Add your ElevenLabs key to hear it' }, playing === v.id ? '■ Stop' : '▶ Preview');
    play.addEventListener('click', () => void preview(v, play));
    playButtons.set(v.id, play);
    const pick = h('button', { class: `btn btn-small ${on ? 'btn-on' : 'btn-ink'}`, type: 'button', disabled: on || !data?.hasKey }, on ? '✓ Your coach' : v.source === 'library' && !v.added ? 'Add and use' : 'Use');
    pick.addEventListener('click', () => void use(v, pick));
    const meta = [v.accent, v.gender, v.uses ? `${v.uses >= 1000 ? `${Math.round(v.uses / 100) / 10}k` : v.uses} people use it` : ''].filter(Boolean).join(' · ');
    return h(
      'div',
      { class: `voice-card${on ? ' on' : ''}` },
      h('div', { class: 'vc-top' }, h('b', null, v.name), data?.suggested === v.id && !on ? h('span', { class: 'vc-tag' }, 'Suits your coach') : null, v.paidOnly ? h('span', { class: 'vc-tag quiet' }, 'Paid plans') : null),
      h('p', { class: 'vc-vibe' }, v.vibe || 'No description.'),
      meta ? h('p', { class: 'vc-meta' }, meta) : null,
      h('div', { class: 'vc-actions' }, play, pick),
    );
  };

  const drawLib = () => {
    clear(libGrid);
    for (const v of lib) libGrid.append(card(v));
  };
  const drawAll = () => {
    playButtons.clear();
    drawNow();
    clear(picksGrid);
    for (const v of data?.picks ?? []) picksGrid.append(card(v));
    clear(mineBox);
    if (data?.hasKey) {
      mineBox.append(h('h3', null, 'Your ElevenLabs voices'));
      if (data.mine.length) {
        const g = h('div', { class: 'voice-grid' });
        for (const v of data.mine) g.append(card(v));
        mineBox.append(g);
      } else {
        mineBox.append(h('p', { class: 'muted' }, 'Voices you clone, design or save on elevenlabs.io show up here.'));
      }
    }
    drawLib();
  };

  const search = h('input', { type: 'search', placeholder: 'Search, e.g. warm, raspy, valley girl, calm', 'aria-label': 'Search the Voice Library' });
  const gender = h('select', { 'aria-label': 'Voice' }, GENDERS.map(([v, l]) => h('option', { value: v }, l)));
  const accent = h('select', { 'aria-label': 'Accent' }, ACCENTS.map(([v, l]) => h('option', { value: v }, l)));
  const go = h('button', { class: 'btn btn-small btn-ink', type: 'button' }, 'Search');
  const runSearch = async (append = false) => {
    if (!data?.hasKey) return;
    libPage = append ? libPage + 1 : 0;
    go.disabled = true;
    libNote.textContent = append ? '' : 'Looking…';
    const r = await api.invoke<{ voices: VoiceOption[]; hasMore: boolean; error?: string }>('voices:search', { search: search.value, gender: gender.value, accent: accent.value, page: libPage });
    go.disabled = false;
    const known = new Set([...(data?.picks ?? []), ...(data?.mine ?? [])].map((v) => v.id));
    const fresh = r.voices.filter((v) => !known.has(v.id));
    lib = append ? [...lib, ...fresh.filter((v) => !lib.some((x) => x.id === v.id))] : fresh;
    libNote.textContent = r.error ?? (lib.length ? '' : 'Nothing matched. Try fewer words.');
    libNote.classList.toggle('sheet-error', !!r.error);
    more.hidden = !r.hasMore || !!r.error;
    playButtons.clear();
    drawAll();
  };
  go.addEventListener('click', () => void runSearch());
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSearch();
  });
  gender.addEventListener('change', () => void runSearch());
  accent.addEventListener('change', () => void runSearch());
  more.addEventListener('click', () => void runSearch(true));

  const libBlock = h(
    'div',
    { class: 'voice-block' },
    h('h3', null, 'More from the ElevenLabs Voice Library'),
    h('p', { class: 'muted' }, 'Thousands of voices shared on ElevenLabs. These start with natural, conversational ones; search for anything else. Using one adds it to your ElevenLabs voices.'),
    h('div', { class: 'voice-search' }, search, gender, accent, go),
    libNote,
    libGrid,
    more,
  );

  const load = async (force = false) => {
    data = await api.invoke<VoiceListResp>('voices:list', force);
    if (!data.hasKey) say('Add your ElevenLabs key under Keys below to hear and use these voices. Until then the coach uses the Mac voice.');
    else if (data.error) say(data.error, true);
    libBlock.hidden = !data.hasKey;
    drawAll();
    if (data.hasKey && !lib.length && !force) void runSearch();
  };
  hooks.refresh = () => void load();
  void load();

  return h(
    'div',
    { class: 'section', id: 'voice-sec' },
    h('h2', null, 'Voice'),
    nowLine,
    note,
    h('h3', null, 'Picks for a coach'),
    h('p', { class: 'muted' }, 'Natural ElevenLabs voices that sound like a person talking to you. Preview plays your coach saying something it would actually say.'),
    picksGrid,
    mineBox,
    libBlock,
  );
}

async function renderCoach(): Promise<void> {
  await loadProfile();
  settings = await api.invoke<Settings>('settings:get');
  const st = settings;
  const p = profile ?? buildDefaultProfile('other');
  const saveSt = (patch: Partial<Settings>) => {
    Object.assign(st, patch);
    void api.invoke('settings:save', patch);
  };
  const page = h('section', { class: 'page' }, h('h1', { class: 'display' }, 'Coach'), h('p', { class: 'lede' }, 'Who coaches you, how it sounds, and how strict it is. Keys and notifications are in Settings.'));

  // Persona
  const personaGrid = h('div', { class: 'choices' });
  const peopleBox = h('div', { class: 'cm-people' });
  const drawPersona = () => {
    clear(personaGrid);
    for (const x of PERSONAS) {
      personaGrid.append(
        h('button', { class: 'choice', type: 'button', 'aria-pressed': String(p.persona === x.id && !p.customCoach), onclick: () => { p.persona = x.id; p.customCoach = undefined; void api.invoke('profile:save', p).then(() => { voiceHooks.refresh?.(); void drawPeople(); }); drawPersona(); } }, h('b', null, x.name), h('small', null, x.desc), h('div', { class: 'persona-line' }, x.sample)),
      );
    }
  };
  // Coaches made from someone you know.
  const drawPeople = async () => {
    const list = await api.invoke<CustomCoachView[]>('coaches:list');
    clear(peopleBox);
    const grid = h('div', { class: 'choices' });
    for (const c of list) {
      const ready = Object.keys(c.lines).length > 0 || !!c.style?.persona;
      const r = c.readiness;
      const status = c.active
        ? 'Your coach'
        : c.busy === 'distilling'
          ? 'Distilling…'
          : c.distilledAt
            ? `From ${r.words.toLocaleString()} of their words${c.voice ? ', in their voice' : ''}`
            : r.pending
              ? 'Listening to the recordings…'
              : ready
                ? 'Lines written by you'
                : r.words
                  ? `${r.words.toLocaleString()} words so far. Feed it more.`
                  : 'Feed it recordings or messages';
      const sample = c.lines.level2?.[0] ?? c.lines.level1?.[0] ?? c.style?.summary ?? '';
      grid.append(
        h(
          'div',
          { class: `choice cm-card${c.active ? ' on' : ''}` },
          h('b', null, c.name, c.active ? h('span', { class: 'cm-tick' }, ' ✓') : null),
          h('small', null, [c.relation, status].filter(Boolean).join(' · ')),
          sample ? h('div', { class: 'persona-line' }, sample.replace(/\{(\w+)\}/g, (_m, k: string) => ({ site: 'YouTube', goal: 'the deck', min: '12', work: 'the deck', top: '“Email Sam”', tasks: '5' } as Record<string, string>)[k] ?? '…')) : null,
          h(
            'div',
            { class: 'cm-card-actions' },
            ready && !c.active
              ? h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: async () => { Object.assign(p, await api.invoke<Profile>('coaches:use', c.id)); drawPersona(); void drawPeople(); voiceHooks.refresh?.(); } }, 'Use')
              : null,
            h('button', { class: 'btn btn-small', type: 'button', onclick: () => go(`coach/${c.id}`) }, ready ? 'Edit' : 'Feed it'),
          ),
        ),
      );
    }
    const name = h('input', { type: 'text', placeholder: 'Mum, Dad, Sam from work…', 'aria-label': 'Their name' });
    const start = async () => {
      if (!name.value.trim()) {
        name.focus();
        return;
      }
      const c = await api.invoke<CustomCoachView>('coaches:create', { name: name.value.trim() });
      go(`coach/${c.id}`);
    };
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void start();
    });
    grid.append(
      h('div', { class: 'choice cm-new' }, h('b', null, '+ Someone you know'), h('small', null, 'Feed it recordings and messages, and the coach learns to talk like them.'), h('div', { class: 'cm-new-row' }, name, h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void start() }, 'Start'))),
    );
    peopleBox.append(h('h3', null, 'Or someone you know'), h('p', { class: 'muted' }, 'Your mum, your boss, your old coach: give Lock In recordings and messages of them, and it distills how they talk into every line.'), grid);
  };
  drawPersona();
  void drawPeople();

  const tol = h('div', { class: 'inline' });
  const drawTol = () => {
    clear(tol);
    for (const m of [2, 5, 10] as const) tol.append(h('button', { class: 'seg', type: 'button', 'aria-pressed': String(p.toleranceMin === m), onclick: () => { p.toleranceMin = m; void api.invoke('profile:save', p); drawTol(); } }, h('b', null, String(m)), h('span', null, 'minutes')));
  };
  drawTol();

  const voiceHooks: { refresh?: () => void } = {};
  page.append(
    h('div', { class: 'section', id: 'persona-sec' }, h('h2', null, 'Personality'), personaGrid, peopleBox),
    voicePicker(voiceHooks),
    h('div', { class: 'section' }, h('h2', null, 'Tolerance'), h('p', { class: 'sub' }, 'How long you can drift before the coach speaks. Every level scales with this.'), tol),
  );

  // Live conversations
  const talkStatus = h('p', { class: 'sub' }, 'Checking…');
  const holdNote = h('span', { class: 'help hold-note' });
  void api.invoke<{ voice: boolean; error: string; holdSpace?: string }>('talk:status').then((t) => {
    const hs = t.holdSpace;
    holdNote.textContent =
      hs === 'permission'
        ? 'Needs Accessibility for Lock In: System Settings, Privacy & Security, Accessibility.'
        : hs === 'missing'
          ? "Not installed yet. Double-click Start Lock In once more; it needs Apple's command line tools."
          : '';
    holdNote.classList.toggle('bad', hs === 'permission' || hs === 'missing');
    talkStatus.textContent = !t.voice
      ? 'Add your ElevenLabs key above to talk out loud. Until then you can type to the coach.'
      : t.error
        ? t.error
        : 'Ready. Lock In talks with you through an ElevenLabs voice agent on your account (it uses your ElevenLabs credits by the minute).';
    talkStatus.classList.toggle('sheet-error', !!t.error);
  });
  const maxSel = h('select', { 'aria-label': 'Longest conversation' }, [3, 5, 10, 15].map((m) => h('option', { value: String(m), selected: st.talk.maxMinutes === m }, `${m} minutes`)));
  maxSel.addEventListener('change', () => saveSt({ talk: { ...st.talk, maxMinutes: Number(maxSel.value) } }));
  page.append(
    h(
      'div',
      { class: 'section' },
      h('h2', null, 'Talking with Lock In'),
      talkStatus,
      h('p', { class: 'muted' }, `Tell it what you did ("I sent the deck and called the bank") and it ticks matching tasks off your list or adds them to Done today. It can also start a session, give you space, or add a to-do. Hold the space bar or press ${MOD}Space anywhere to talk, or pick "Talk to Lock In" in the menu bar.`),
      field(
        'Hold space to talk',
        'Hold the space bar for half a second anywhere to start talking; hold it again to hang up. A quick tap still types a space. Stays off in Figma, Photoshop and the like, on calls, and in Lock In itself.',
        h('div', { class: 'hold-row' }, sw(st.talk.holdSpace !== false, (v) => saveSt({ talk: { ...st.talk, holdSpace: v } }), 'Hold space to talk'), holdNote),
      ),
      field('Answer roasts out loud', 'After a to-do roast, the mic opens so you can say what you were actually doing. It hangs up if you stay quiet.', sw(st.talk.afterRoast, (v) => saveSt({ talk: { ...st.talk, afterRoast: v } }), 'Answer roasts out loud')),
      field('Longest conversation', 'A hard stop, so a forgotten call does not use up credits.', maxSel),
      field('Try it', null, h('div', { class: 'test-row' }, h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('talk:open', 'checkin') }, '🎙 Talk to Lock In'))),
    ),
  );

  // Voice
  const vol = h('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(st.volumeCap), 'aria-label': 'Maximum volume' });
  vol.addEventListener('change', () => saveSt({ volumeCap: Number(vol.value) }));
  const text = (key: keyof Settings, ph = '') => {
    const i = h('input', { type: 'text', value: String(st[key] ?? ''), placeholder: ph });
    i.addEventListener('change', () => saveSt({ [key]: i.value.trim() } as Partial<Settings>));
    return i;
  };
  page.append(
    h(
      'div',
      { class: 'section' },
      h('h2', null, 'Speaking and listening'),
      field('Coach speaks', 'Turn off for text-only nudges.', sw(p.voice.speak, (v) => { p.voice.speak = v; void api.invoke('profile:save', p); }, 'Coach speaks')),
      field('Coach listens', 'The mic opens only during an intervention.', sw(p.voice.listen, (v) => { p.voice.listen = v; void api.invoke('profile:save', p); if (v) void api.invoke('setup:askMic'); }, 'Coach listens')),
      field('Maximum volume', 'The coach never plays louder than this.', vol),
      field('Mac fallback voice', 'Used without an ElevenLabs key. Leave blank for the system voice.', text('sayVoice', 'Samantha')),
      field('Test', null, h('div', { class: 'test-row' }, h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('voice:test') }, 'Play a test line'))),
      h(
        'details',
        { class: 'how advanced' },
        h('summary', null, 'Advanced'),
        field('ElevenLabs voice ID', 'Paste any voice ID instead of picking one above.', text('voiceId')),
        field('Shouting model', 'Used for drill-sergeant call-outs.', text('ttsModelShout', 'eleven_v3')),
        field('Everyday model', 'Used for everything else; pick a fast one.', text('ttsModelLive', 'eleven_flash_v2_5')),
      ),
    ),
  );


  // Guardrails
  const time = (key: 'quietStart' | 'quietEnd') => {
    const i = h('input', { type: 'time', value: st[key] });
    i.addEventListener('change', () => saveSt({ [key]: i.value } as Partial<Settings>));
    return i;
  };
  const num = (key: 'maxSpokenPerHour' | 'breakMinutes', min: number, max: number) => {
    const i = h('input', { type: 'number', min: String(min), max: String(max), value: String(st[key]) });
    i.addEventListener('change', () => saveSt({ [key]: Math.max(min, Math.min(max, Number(i.value) || min)) } as Partial<Settings>));
    return i;
  };
  page.append(
    h(
      'div',
      { class: 'section' },
      h('h2', null, 'Limits'),
      h('p', { class: 'sub' }, 'How far the coach goes. It is always silent during calls and screen-share meetings.'),
      field('Quiet hours', 'No voice between these times.', h('div', { class: 'inline' }, time('quietStart'), 'to', time('quietEnd'))),
      field('Spoken interventions per hour', 'After this, visual nudges only.', num('maxSpokenPerHour', 1, 30)),
      field('Default break length', 'Minutes, for "I need a real break".', num('breakMinutes', 3, 15)),
      field('Mild profanity', 'Lets the drill sergeant swear a little.', sw(st.profanityOk, (v) => saveSt({ profanityOk: v }), 'Mild profanity')),
      field('Commitment mode', 'Ending a session early means typing a sentence first.', sw(st.commitmentMode, (v) => saveSt({ commitmentMode: v }), 'Commitment mode')),
      field('Keep titles on this Mac', 'Only app and site names are sent to Claude, never window or page titles.', sw(st.titlesStayLocal, (v) => saveSt({ titlesStayLocal: v }), 'Keep titles on this Mac')),
    ),
  );

  page.append(
    h(
      'div',
      { class: 'section' },
      h('h2', null, 'Try the coach'),
      h('p', { class: 'sub' }, 'Shows each level with a pretend YouTube drift. Nothing is logged.'),
      h('div', { class: 'test-row' }, ([1, 2, 3, 4] as const).map((l) => h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('coach:preview', l) }, ['Nudge', 'Coach speaks', 'Yellow card', 'Red card'][l - 1]))),
    ),
  );
  if (route === 'coach') {
    clear(view);
    view.append(page);
  }
}

/** Settings → Keys: Claude and ElevenLabs, encrypted with your keychain. */
function keysSection(): HTMLElement {
  const keyRow = (name: 'anthropic' | 'elevenlabs' | 'todoist', label: string, help: string, has: boolean) => {
    const input = h('input', { type: 'password', placeholder: has ? 'Saved. Paste a new key to replace it.' : 'Paste your key', autocomplete: 'off' });
    const note = h('span', { class: 'saved' }, '');
    const save = h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
      const ks = await api.invoke<KeyStatus>('keys:save', { [name]: input.value.trim() });
      input.value = '';
      input.placeholder = ks[name] ? 'Saved. Paste a new key to replace it.' : 'Paste your key';
      note.textContent = ks[name] ? (ks.encrypted ? 'Saved in your keychain' : 'Saved') : 'Removed';
    } }, 'Save');
    return field(label, help, h('div', { class: 'inline' }, input, save, has ? h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => { input.value = ''; save.click(); } }, 'Remove') : null, note));
  };
  const keys = state?.keys ?? { anthropic: false, elevenlabs: false, todoist: false, encrypted: false };
  return h(
    'div',
    { class: 'section', id: 'keys-sec' },
    h('h2', null, 'Keys'),
    h('p', { class: 'sub' }, 'Both are optional. Without them the coach uses pre-written lines and the Mac voice. Keys are encrypted with your keychain and only sent to their own service.'),
    keyRow('anthropic', 'Claude API key', 'Live coach lines and answers, labeling sites Lock In doesn’t know, and smarter goals (what counts toward each one, and how to ask about it). From console.anthropic.com.', keys.anthropic),
    keyRow('elevenlabs', 'ElevenLabs API key', 'The coach voice, hearing your replies, and live conversations. The key needs Text to Speech, Speech to Text and ElevenAgents (Write).', keys.elevenlabs),
  );
}

// -----------------------------------------------------------------------------
// Settings

async function renderSettingsPage(): Promise<void> {
  const s = await api.invoke<SetupStatus>('setup:status');
  settings = await api.invoke<Settings>('settings:get');
  const st = settings;
  const saveSt = (patch: Partial<Settings>) => {
    Object.assign(st, patch);
    void api.invoke('settings:save', patch);
  };
  const toSec = (id: string) => (e: Event) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const jump: [string, string][] = [['profile-sec', 'Profile'], ['perm-sec', 'Permissions'], ['keys-sec', 'Keys'], ['notif-sec', 'Notifications'], ['routines-sec', 'Routines'], ['calendar-sec', 'Calendar'], ['phone-sec', 'Phone'], ['look-sec', 'Look'], ['data-sec', 'Your data']];
  const page = h(
    'section',
    { class: 'page settings-page' },
    h('h1', { class: 'display' }, 'Settings'),
    h('p', { class: 'lede' }, 'Your profile, permissions, keys, how Lock In reaches you, your calendar and phone, and your data.'),
    h('nav', { class: 'jump', 'aria-label': 'On this page' }, jump.map(([id, label]) => h('a', { href: `#settings#${id}`, onclick: toSec(id) }, label))),
  );
  page.append(await profileSection());
  const step = (done: boolean, title: string, body: Node[], action?: Node) => h('li', { class: done ? 'done' : '' }, h('div', null, h('h3', null, title), ...body), action ?? h('span'));
  const mac = s.platform === 'darwin';

  const list = h(
    'ol',
    { class: 'steps' },
    step(
      s.accessibility === 'granted',
      'Allow Accessibility',
      [h('p', null, mac ? 'Lets Lock In read window titles and the open file, so it can reopen exactly what you were working on. It never reads keystrokes or the screen.' : 'Only needed on macOS.')],
      mac && s.accessibility !== 'granted' ? h('button', { class: 'btn btn-small', type: 'button', onclick: async () => { await api.invoke('setup:promptAccessibility'); setTimeout(() => void renderSettingsPage(), 1500); } }, 'Open the permission') : undefined,
    ),
    step(
      s.helperRunning,
      'Start the window sensor',
      [
        h('p', null, s.helperBuilt ? (s.helperRunning ? 'Running.' : 'Built but not running yet. It starts automatically; restart Lock In if this stays off.') : 'The small Swift sensor is not built yet. In the project folder, run:'),
        !s.helperBuilt ? h('p', null, h('code', null, 'npm run helper')) : null,
        !s.helperBuilt ? h('p', null, 'It needs the Xcode Command Line Tools (', h('code', null, 'xcode-select --install'), '). Without it, Lock In still sees which app is in front.') : null,
      ].filter(Boolean) as Node[],
    ),
    step(
      s.extensionConnected,
      'Add the browser extension',
      [
        h('p', null, 'Works in Chrome, Arc, Brave and Edge. Press the button: your browser opens on its extensions page and Finder shows the extension folder. Turn on Developer mode (top right) and drag the folder onto the page. (Or choose Load unpacked, press ⌘⇧G and paste: the folder’s address is already copied.)'),
        h('p', null, s.extensionConnected ? 'Connected.' : 'Not connected yet. Keep Lock In running and the extension connects within 30 seconds.'),
        s.extensionOutdated
          ? h('p', { class: 'sheet-error' }, 'Lock In was updated and the extension needs one reload: open ', h('code', null, 'chrome://extensions'), ' and press the reload arrow ↻ on Lock In. After this, updates reload it on their own.')
          : null,
      ].filter(Boolean) as Node[],
      s.extensionConnected ? undefined : h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('setup:addExtension') }, mac ? 'Add to browser' : 'Show the folder'),
    ),
    step(
      s.microphone === 'granted' || s.microphone === 'n/a',
      'Allow the microphone (optional)',
      [h('p', null, 'So you can answer the coach out loud. The mic opens only during an intervention or when you press ', h('code', null, `${MOD}Space`), '.')],
      mac && s.microphone !== 'granted' ? h('button', { class: 'btn btn-small', type: 'button', onclick: async () => { await api.invoke('setup:askMic'); void renderSettingsPage(); } }, 'Allow') : undefined,
    ),
    step(
      s.keys.anthropic && s.keys.elevenlabs,
      'Add your keys (optional)',
      [h('p', null, `Claude: ${s.keys.anthropic ? 'added' : 'not added'}. ElevenLabs: ${s.keys.elevenlabs ? 'added' : 'not added'}. Without them the coach still works with pre-written lines and the Mac voice.`)],
      h('a', { class: 'btn btn-small', href: '#settings#keys-sec', onclick: toSec('keys-sec') }, 'Add keys'),
    ),
  );
  page.append(h('div', { class: 'section', id: 'perm-sec' }, h('h2', null, 'Permissions'), h('p', { class: 'sub' }, 'What Lock In needs to see what you’re working on. It never reads keystrokes or the screen.'), list));

  if (mac) {
    const where = h(
      'div',
      { class: 'section' },
      h('h2', null, 'Finding Lock In'),
      s.installed
        ? h('p', { class: 'sub' }, 'Lock In lives in your menu bar: the padlock near the top right of your screen. Click it to lock in on your next task, see your list, or open this window. You can also press ', h('kbd', null, `${MOD}L`), ' anywhere, or search for Lock In with Spotlight.')
        : h('p', { class: 'sub' }, 'You are running Lock In from Terminal. To make it a normal app (in Applications, Spotlight and your menu bar), double-click ', h('b', null, 'Start Lock In'), ' in the lockin-app folder once.'),
      s.installed ? field('Open when I log in', 'Starts quietly in the menu bar, so it is always there.', sw(s.openAtLogin, async (v) => { await api.invoke('app:loginItem', v); void renderSettingsPage(); }, 'Open when I log in')) : null,
      h('p', { class: 'muted' }, "Can't see the padlock? A full menu bar hides icons behind the camera notch. Hold ", h('kbd', null, '⌘'), ' and drag other icons out of the way, or quit a few menu bar apps.'),
    );
    page.append(where);
  }

  page.append(keysSection());
  const notif = notificationsSection(st, saveSt);
  notif.id = 'notif-sec';
  page.append(notif, reachSection());
  const routinesBox = h('div', { class: 'section', id: 'routines-sec' });
  await routinesSection(routinesBox);
  page.append(routinesBox);
  const calBox = h('div', { class: 'section', id: 'calendar-sec' });
  await calendarSection(calBox);
  page.append(calBox);
  page.append(await phoneSection());
  page.append(await lookSection());
  page.append(await goalsBetaSection());
  page.append(await exportSection());
  page.append(await dataSection());

  const logBox = h('pre', { class: 'log', hidden: true });
  page.append(
    h(
      'div',
      { class: 'section' },
      h('h2', null, 'Activity log'),
      h('p', { class: 'sub' }, 'What the app has been doing, for troubleshooting.'),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => {
        const lines = await api.invoke<string[]>('setup:log');
        logBox.textContent = lines.join('\n') || 'Nothing logged yet.';
        logBox.hidden = !logBox.hidden;
      } }, 'Show the log'),
      logBox,
    ),
  );
  if (route === 'settings') {
    clear(view);
    view.append(page);
  }
}


/** Settings → Your data: where everything is kept, backups, and moving to another Mac. */
/** The jailbreak look or the classic one, and the key cursor. */
async function lookSection(): Promise<HTMLElement> {
  const st = settings ?? (settings = await api.invoke<Settings>('settings:get'));
  const box = h('div', { class: 'section', id: 'look-sec' });
  const draw = () => {
    clear(box);
    const look = st.look ?? { theme: 'jail', keyCursor: true };
    const set = (patch: Partial<Settings['look']>) => {
      st.look = { ...look, ...patch };
      applyLook(st.look);
      void api.invoke('settings:save', { look: st.look });
      draw();
    };
    const pick = (id: Settings['look']['theme'], name: string, desc: string) =>
      h('button', { class: 'choice', type: 'button', 'aria-pressed': String(look.theme === id), onclick: () => set({ theme: id }) }, h('b', null, name), h('small', null, desc));
    const ui = st.ui ?? 'panel';
    const where = (id: Settings['ui'], name: string, desc: string) =>
      h('button', { class: 'choice', type: 'button', 'aria-pressed': String(ui === id), onclick: () => {
        st.ui = id;
        void api.invoke('settings:save', { ui: id });
        draw();
      } }, h('b', null, name), h('small', null, desc));
    box.append(
      h('h2', null, 'Where Lock In lives'),
      h('div', { class: 'choices' },
        where('panel', 'Menu bar panel', 'Click the padlock in the menu bar: start a session, tick off to-dos, see today and your crew. This window opens only for settings.'),
        where('window', 'Classic window', 'The full app window with every page, and a plain menu under the padlock.'),
      ),
      h('h2', null, 'How Lock In looks'),
      h('div', { class: 'choices' }, pick('jail', 'Jailbreak', 'A cell block at night. Your cursor is a key, and pages and to-dos are padlocks you unlock.'), pick('classic', 'Classic', 'Light and plain, like the first version.')),
    );
    if (look.theme === 'jail') box.append(field('Key cursor', 'Your pointer becomes a small key that turns when you click. Over text fields it steps aside for the usual cursor.', sw(look.keyCursor, (v) => set({ keyCursor: v }), 'Key cursor')));
  };
  draw();
  return box;
}

/** Goals (beta), on or off. The Goals page has the rest of its settings. */
async function goalsBetaSection(): Promise<HTMLElement> {
  const st = settings ?? (settings = await api.invoke<Settings>('settings:get'));
  const box = h('div', { class: 'section', id: 'goals-beta-sec' });
  const draw = () => {
    clear(box);
    box.append(
      h('h2', null, 'Goals ', h('span', { class: 'beta-tag' }, 'Beta')),
      field('Goals', 'Set the big things you’re working toward, and get goals suggested from your patterns, like long stretches without a break.', sw(st.goals.enabled, async (on) => {
        const r = await api.invoke<{ settings: Settings['goals'] }>('goals:settings', { enabled: on });
        st.goals = r.settings;
        draw();
      }, 'Goals')),
    );
    if (st.goals.enabled) box.append(h('p', { class: 'muted' }, h('a', { href: '#goals' }, 'Open Goals')));
  };
  draw();
  return box;
}

interface PhoneStatus {
  enabled: boolean;
  running: boolean;
  error: string;
  urls: string[];
  qr: string;
  pairing: { code: string; expiresAt: number } | null;
  devices: { id: string; name: string; pairedAt: number; lastSeen: number }[];
}

/** Lock In on your phone: turn it on, pair a phone with a 6-digit code, see paired phones. */
async function phoneSection(): Promise<HTMLElement> {
  const box = h('div', { class: 'section', id: 'phone-sec' });
  let countdown: number | null = null;
  const day = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const draw = (s: PhoneStatus) => {
    clear(box);
    if (countdown) clearInterval(countdown);
    countdown = null;
    box.append(
      h('h2', null, 'Your phone'),
      h('p', { class: 'sub' }, 'Use Lock In from your phone: start and end sessions, tick off to-dos, bomb friends, talk to the coach, and send recordings to a coach made from someone you know. Your phone needs to be on the same Wi-Fi as this Mac, and the Mac awake with Lock In open.'),
      field('Use Lock In on my phone', 'This Mac answers your phone over Wi-Fi. Everything between them is encrypted with a key only they share.', sw(s.enabled, async (on) => draw(await api.invoke<PhoneStatus>('phone:enable', on)), 'Use Lock In on my phone')),
    );
    if (s.error) box.append(h('p', { class: 'sheet-error phone-err' }, s.error));
    if (!s.enabled || !s.running) return;
    const [main, ...more] = s.urls;
    const pairBtn = h('button', { class: 'btn btn-ink', type: 'button', onclick: async () => draw(await api.invoke<PhoneStatus>('phone:pair')) }, s.devices.length ? 'Pair another phone' : 'Pair a phone');
    let codeBox: HTMLElement;
    if (s.pairing) {
      const left = h('span', { class: 'phone-left' });
      const tickLeft = () => {
        const sec = Math.max(0, Math.round((s.pairing!.expiresAt - Date.now()) / 1000));
        left.textContent = sec ? `Type it on your phone. It works for ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} more.` : 'This code ran out.';
        if (!box.isConnected && countdown) clearInterval(countdown);
      };
      tickLeft();
      countdown = window.setInterval(tickLeft, 1000);
      codeBox = h(
        'div',
        { class: 'phone-code' },
        h('div', { class: 'phone-digits', 'aria-label': `Code ${s.pairing.code.split('').join(' ')}` }, s.pairing.code.slice(0, 3), h('span'), s.pairing.code.slice(3)),
        left,
        h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => draw(await api.invoke<PhoneStatus>('phone:cancelPair')) }, 'Cancel'),
      );
    } else {
      codeBox = h('div', { class: 'phone-code' }, pairBtn);
    }
    box.append(
      h(
        'div',
        { class: 'phone-pair' },
        h(
          'div',
          { class: 'phone-qr' },
          s.qr ? h('img', { src: s.qr, alt: `QR code for ${main ?? ''}`, width: 180, height: 180 }) : null,
          h('small', null, "Point your phone's camera here"),
        ),
        h(
          'div',
          { class: 'phone-steps' },
          h(
            'ol',
            null,
            h('li', null, 'Open ', h('code', { class: 'file-path' }, main ?? '…'), ' on your phone (scan the code).', more.length ? h('span', { class: 'help' }, ` If that doesn't open, try ${more.join(' or ')}.`) : null),
            h('li', null, 'On an iPhone, tap Share, then ', h('b', null, 'Add to Home Screen'), ', and open Lock In from your Home Screen.'),
            h('li', null, 'Press ', h('b', null, s.devices.length ? 'Pair another phone' : 'Pair a phone'), ' and type the code on your phone.'),
          ),
          codeBox,
        ),
      ),
    );
    if (s.devices.length) {
      box.append(
        h('h3', { class: 'phone-h3' }, 'Paired phones'),
        h(
          'ul',
          { class: 'phone-devices' },
          s.devices.map((d) =>
            h('li', null, h('div', null, h('b', null, d.name), h('small', null, `Paired ${day(d.pairedAt)} · last used ${Date.now() - d.lastSeen < 120_000 ? 'just now' : day(d.lastSeen)}`)), h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => draw(await api.invoke<PhoneStatus>('phone:remove', d.id)) }, 'Remove')),
          ),
        ),
      );
    }
    box.append(h('p', { class: 'muted phone-notes' }, 'The first time, macOS may ask whether Lock In can accept incoming connections: choose Allow. Campus and office Wi-Fi often stop devices from seeing each other; then use it at home, or turn on your phone\'s hotspot and join it from this Mac.'));
  };
  draw(await api.invoke<PhoneStatus>('phone:status'));
  const off = api.on('phone:update', async () => {
    if (!box.isConnected) {
      off();
      return;
    }
    draw(await api.invoke<PhoneStatus>('phone:status'));
  });
  return box;
}

async function dataSection(): Promise<HTMLElement> {
  const where = await api.invoke<{ folder: string; backups: string }>('data:where');
  const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
  const note = h('p', { class: 'muted', 'aria-live': 'polite' });
  const backupBtn = h('button', { class: 'btn btn-small btn-ink', type: 'button' }, 'Back up now');
  backupBtn.addEventListener('click', async () => {
    const file = await api.invoke<string>('data:export');
    note.className = 'muted';
    note.textContent = `Saved ${file.split('/').pop()}. It's open in Finder.`;
  });
  const restoreBtn = h('button', { class: 'btn btn-small', type: 'button' }, 'Restore from a backup…');
  restoreBtn.addEventListener('click', async () => {
    const r = await api.invoke<{ ok: boolean; error?: string }>('data:restore');
    if (r.error) {
      note.className = 'sheet-error';
      note.textContent = r.error;
    }
  });
  const kept = [
    ['Lock In - to-dos by day.csv', 'every to-do on your list each day, open or done, with project, due date and when you finished it'],
    ['Lock In - done log.csv', 'everything you ever finished'],
    ['Lock In - deadlines.csv', 'every deadline, done or not'],
    ['Lock In - daily summary.csv and sessions.csv', 'focus, drift, meetings and sessions'],
    ['Days', 'a file per day, in order, ending with what was still open'],
    ['Backups', 'a full backup every day (the last 14 are kept)'],
  ];
  return h(
    'div',
    { class: 'section', id: 'data-sec' },
    h('h2', null, 'Your data'),
    h('p', { class: 'sub' }, 'Everything stays on this Mac (audio is never stored). Lock In keeps a copy you can open, take elsewhere or move to a new Mac in one folder, updated every hour:'),
    h('p', null, h('code', { class: 'file-path', title: where.folder }, short(where.folder))),
    h('ul', { class: 'kept' }, kept.map(([name, what]) => h('li', null, h('b', null, name), `: ${what}.`))),
    h('p', { class: 'muted' }, 'The spreadsheets open in Excel, Numbers or Google Sheets, and most to-do apps can import them. To move to a new Mac, copy a backup over, install Lock In, then choose Restore. Backups hold everything except your API keys (those stay in this Mac’s keychain), including your calendar links and crew code, so keep them to yourself.'),
    h(
      'div',
      { class: 'test-row' },
      backupBtn,
      restoreBtn,
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void api.invoke('data:openFolder') }, 'Open the folder'),
      h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => {
        if (confirm('Delete all sessions, activity (including your rhythm for Goals) and learned labels? Your to-dos, goals, profile and settings stay.')) await api.invoke('data:delete');
      } }, 'Delete all activity'),
    ),
    note,
  );
}

// -----------------------------------------------------------------------------
// Setup

// Setup is three questions: what you're going after, what's on today, and what pulls you off
// track. Everything else (work apps, the coach's style, check-ins) starts from good defaults and
// lives in Settings and on the Coach page.
interface Draft {
  /** Big goals: what you're going after, and by when (optional). */
  bigGoals: { title: string; until: string }[];
  /** Daily habits Lock In measures (HABITS ids). */
  habits: Set<string>;
  /** Today's to-dos, for Lock In's own list. */
  todayTodos: string[];
  todoProvider: TodoProviderId;
  todoistToken: string;
  remindersList: string;
  sheet: SheetSettings;
  /** Distracting site groups (DISTRACTION_CHOICES ids) and your own sites. */
  distractions: Set<string>;
  customDistractions: string[];
  /** Apps that count as distractions. */
  distractionApps: Set<string>;
  /** What you do: decides what counts as work. Optional. */
  roles: Set<Role>;
  firstRun: boolean;
  /** Big goals and habits you already have (doing setup again doesn't add them twice). */
  hadGoals: Set<string>;
}

let installed: AppUsage[] = [];
const MONTH_MS = 30 * 86_400_000;
let draft: Draft;
let qStep = 0;

const GOAL_IDEAS = ['Fundraise well', 'Launch my side projects', 'Ship the MVP', 'Land a summer internship', 'Finish my thesis', 'Get in shape'];
const HABITS: { id: string; label: string; goal: { kind: string; target: number; days?: 'weekdays' } }[] = [
  { id: 'focus', label: 'Focus 4 hours a day', goal: { kind: 'focus', target: 4 } },
  { id: 'breaks', label: 'A break at least every 90 minutes', goal: { kind: 'breaks', target: 90 } },
  { id: 'water', label: 'Drink water 8 times a day', goal: { kind: 'water', target: 8 } },
  { id: 'start', label: 'Start focusing by 9:30 on weekdays', goal: { kind: 'start', target: 570, days: 'weekdays' } },
  { id: 'bedtime', label: 'Off the computer by 11:30 pm', goal: { kind: 'bedtime', target: 1410 } },
];
const sameApp = (a: string, b: string) => a.toLowerCase().replace(/\.app$/, '') === b.toLowerCase().replace(/\.app$/, '');
/** The distraction apps to offer: the known ones on this Mac (or all of them when the list of apps isn't available). */
const appChoices = () => (installed.length ? DISTRACTION_APP_CHOICES.filter((k) => installed.some((a) => sameApp(a.name, k.name))) : DISTRACTION_APP_CHOICES);
const siteChoices = () => DISTRACTION_CHOICES.filter((c) => c.domains.length);
const toggleIn = <T,>(set: Set<T>, x: T) => (set.has(x) ? set.delete(x) : set.add(x));

async function openQuiz(): Promise<void> {
  installed = await api.invoke<AppUsage[]>('quiz:apps').catch(async () => (await api.invoke<string[]>('quiz:installedApps').catch(() => [] as string[])).map((name) => ({ name, uses: 0, lastUsed: 0 })));
  const gv = await api.invoke<GoalsView>('goals:get').catch(() => null);
  const big = (gv?.goals ?? []).filter((g) => g.kind === 'custom' && !g.paused);
  const p = profile;
  // Doing setup again starts from what you have.
  const boosted = (d: string) => !!p && (p.distractionDomains[d] ?? 0) > (COMMON_DISTRACTIONS[d] ?? 1);
  const inGroups = new Set(DISTRACTION_CHOICES.flatMap((c) => c.domains));
  draft = {
    bigGoals: [0, 1, 2].map((i) => ({ title: big[i]?.title ?? '', until: big[i]?.until ?? '' })),
    habits: new Set(gv?.goals.length ? HABITS.filter((x) => gv.goals.some((g) => g.kind === x.goal.kind && !g.paused)).map((x) => x.id) : ['focus']),
    todayTodos: [],
    // Lock In's own list unless you already use another.
    todoProvider: p ? settings?.todo.provider ?? 'builtin' : 'builtin',
    todoistToken: '',
    remindersList: settings?.todo.remindersList ?? '',
    sheet: { ...(settings?.todo.sheet ?? DEFAULT_TODO.sheet) },
    distractions: new Set(p ? siteChoices().filter((c) => c.domains.some(boosted)).map((c) => c.id) : ['youtube', 'x', 'reddit', 'instagram', 'tiktok']),
    customDistractions: p ? Object.keys(p.distractionDomains).filter((d) => !(d in COMMON_DISTRACTIONS) && !inGroups.has(d)) : [],
    distractionApps: new Set(
      p
        ? Object.keys(p.distractionApps)
        : appChoices()
            .filter((k) => k.group === 'usual')
            .map((k) => installed.find((a) => sameApp(a.name, k.name))?.name ?? k.name),
    ),
    roles: new Set((p?.roles ?? (p ? [p.role] : [])).filter((r) => r !== 'other')),
    firstRun: !p,
    hadGoals: new Set([...big.map((g) => (g.title ?? '').trim().toLowerCase()), ...(gv?.goals ?? []).filter((g) => g.kind !== 'custom').map((g) => `kind:${g.kind}`)]),
  };
  qStep = 0;
  drawnStep = -1;
  quizEl.hidden = false;
  drawQuiz();
}

interface QStep {
  id: string;
  title: string;
  lede: string;
  body: () => HTMLElement;
  /** "Next", or "Skip for now" when nothing was filled in. */
  nextLabel?: () => string;
}

/** A pick-many chip that toggles in place. */
function pickChip(label: string, on: () => boolean, toggle: () => void): HTMLElement {
  return h('button', { class: 'chip pick', type: 'button', 'aria-pressed': String(on()), onclick: (e: Event) => {
    toggle();
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on()));
  } }, label);
}

const QUIZ: QStep[] = [
  {
    id: 'goals',
    title: 'What are you going after?',
    lede: 'One to three big things for the next few months. Lock In keeps them in front of you every day and notices what moves them forward.',
    body: () => {
      const wrap = h('div', { class: 'onb' });
      const rows = h('div', { class: 'goal-rows' });
      const examples = ['e.g. Fundraise well', 'e.g. Launch my side projects', 'Another one (optional)'];
      const today = new Date().toISOString().slice(0, 10);
      draft.bigGoals.forEach((g, i) => {
        const t = h('input', { type: 'text', value: g.title, placeholder: examples[i], maxlength: 120, 'aria-label': `Big goal ${i + 1}` });
        t.addEventListener('input', () => {
          g.title = t.value;
          refreshQuizFoot();
        });
        const d = h('input', { type: 'date', value: g.until, min: today, 'aria-label': `Big goal ${i + 1}: by when (optional)` });
        d.addEventListener('change', () => (g.until = d.value));
        rows.append(h('div', { class: 'goal-row-in' }, h('b', null, String(i + 1)), t, h('label', { class: 'by' }, h('span', null, 'by'), d)));
      });
      const taken = (x: string) => draft.bigGoals.some((g) => g.title.trim().toLowerCase() === x.toLowerCase());
      const ideas = GOAL_IDEAS.filter((x) => !taken(x)).map((x) =>
        h('button', { class: 'chip pick', type: 'button', onclick: () => {
          const slot = draft.bigGoals.find((g) => !g.title.trim());
          if (!slot) return;
          slot.title = x;
          drawQuiz();
        } }, `+ ${x}`),
      );
      const habits = HABITS.map((x) => pickChip(x.label, () => draft.habits.has(x.id), () => {
        toggleIn(draft.habits, x.id);
        refreshQuizFoot();
      }));
      wrap.append(
        rows,
        h('div', { class: 'chips' }, ideas),
        h('h3', { class: 'onb-sub' }, 'Daily habits'),
        h('p', { class: 'sub' }, 'Optional. Lock In counts these from what you do, so there’s nothing to log.'),
        h('div', { class: 'chips' }, habits),
      );
      return wrap;
    },
    nextLabel: () => (draft.bigGoals.some((g) => g.title.trim()) || draft.habits.size ? 'Next' : 'Skip for now'),
  },
  {
    id: 'todos',
    title: 'What’s on your plate today?',
    lede: 'Lock In cheers when you finish things, and has words when hours go by without one.',
    body: () => {
      const wrap = h('div', { class: 'onb' });
      if (draft.todoProvider === 'builtin') {
        const list = h('div', { class: 'today-list' });
        const input = h('input', { type: 'text', placeholder: 'Add a to-do and press Enter', maxlength: 300, 'aria-label': 'Add a to-do for today' });
        const add = () => {
          const t = input.value.trim();
          if (!t) return;
          draft.todayTodos.push(t);
          input.value = '';
          drawList();
          refreshQuizFoot();
          input.focus();
        };
        const drawList = () => {
          clear(list);
          draft.todayTodos.forEach((t, i) =>
            list.append(h('div', { class: 'today-row' }, h('span', { class: 'ring' }), h('span', { class: 't' }, t), h('button', { type: 'button', 'aria-label': `Remove ${t}`, onclick: () => { draft.todayTodos.splice(i, 1); drawList(); refreshQuizFoot(); } }, '×'))),
          );
          if (!draft.todayTodos.length) list.append(h('p', { class: 'muted' }, 'Nothing yet. Three is a good start.'));
        };
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') add();
        });
        drawList();
        // A first step toward each big goal is a good first to-do.
        const steps = draft.bigGoals.filter((x) => x.title.trim()).map((x) =>
          h('button', { class: 'chip pick', type: 'button', onclick: () => {
            input.value = `${x.title.trim()}: `;
            input.focus();
          } }, `+ A step toward “${x.title.trim()}”`),
        );
        wrap.append(
          list,
          h('div', { class: 'add-row' }, input, h('button', { class: 'btn btn-ink', type: 'button', onclick: add }, 'Add')),
          ...(steps.length ? [h('div', { class: 'chips', style: 'margin-top:12px' }, steps)] : []),
        );
        setTimeout(() => input.focus(), 30);
      }
      // Your list lives somewhere else: one row of small choices.
      const where = h('div', { class: 'chips' });
      const order: TodoProviderId[] = ['builtin', 'reminders', 'things', 'todoist', 'sheet', 'none'];
      for (const id of order) {
        const p = TODO_PROVIDERS.find((x) => x.id === id);
        if (!p) continue;
        where.append(h('button', { class: 'chip pick', type: 'button', title: p.help, 'aria-pressed': String(draft.todoProvider === id), onclick: () => { draft.todoProvider = id; drawQuiz(); } }, id === 'builtin' ? 'Here in Lock In' : p.label));
      }
      wrap.append(h('p', { class: 'list-head', style: `margin-top:${draft.todoProvider === 'builtin' ? 32 : 0}px` }, draft.todoProvider === 'builtin' ? 'Already keep your to-dos somewhere else?' : 'Where your to-dos live'), where);
      if (draft.todoProvider === 'todoist') {
        const tok = h('input', { type: 'password', placeholder: 'Paste your Todoist API token', value: draft.todoistToken, autocomplete: 'off' });
        tok.addEventListener('input', () => (draft.todoistToken = tok.value.trim()));
        wrap.append(h('div', { style: 'margin-top:20px' }, field('Todoist API token', 'Todoist: Settings, Integrations, Developer.', tok)));
      }
      if (draft.todoProvider === 'reminders') {
        const list = h('input', { type: 'text', placeholder: 'All lists', value: draft.remindersList });
        list.addEventListener('input', () => (draft.remindersList = list.value));
        wrap.append(h('div', { style: 'margin-top:20px' }, field('Reminders list', 'Leave blank to use every list. Only items due today or earlier count.', list)));
      }
      if (draft.todoProvider === 'things') wrap.append(h('p', { class: 'sub', style: 'margin-top:16px' }, 'Lock In reads your Today list in Things. macOS asks permission once.'));
      if (draft.todoProvider === 'sheet') wrap.append(sheetSetup(draft.sheet, (c) => (draft.sheet = c), true));
      return wrap;
    },
    nextLabel: () => (draft.todoProvider !== 'builtin' || draft.todayTodos.length ? 'Next' : 'Skip for now'),
  },
  {
    id: 'distractions',
    title: 'What pulls you off track?',
    lede: 'Time on these counts as drifting, and a friend’s Lock In bomb locks them for 5 minutes. The usual ones are already picked.',
    body: () => {
      const wrap = h('div', { class: 'onb' });
      const sites = siteChoices().map((c) => pickChip(c.label, () => draft.distractions.has(c.id), () => toggleIn(draft.distractions, c.id)));
      const appChip = (name: string) => pickChip(name, () => draft.distractionApps.has(name), () => toggleIn(draft.distractionApps, name));
      const known = appChoices().map((k) => installed.find((a) => sameApp(a.name, k.name))?.name ?? k.name);
      const extraApps = [...draft.distractionApps].filter((a) => !known.some((k) => sameApp(k, a)));
      const extra = [
        ...draft.customDistractions.map((d) => h('span', { class: 'chip' }, d, h('button', { type: 'button', 'aria-label': `Remove ${d}`, onclick: () => { draft.customDistractions = draft.customDistractions.filter((x) => x !== d); drawQuiz(); } }, '×'))),
        ...extraApps.map(appChip),
      ];
      // One box for anything else: a site (it has a dot) or an app.
      const input = h('input', { type: 'text', placeholder: 'Anything else? A site (espn.com) or an app', 'aria-label': 'Add a site or app' });
      const add = () => {
        const v = input.value.trim();
        if (!v) return;
        const d = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(d) && !/\.app$/.test(d)) {
          if (!draft.customDistractions.includes(d)) draft.customDistractions.push(d);
        } else draft.distractionApps.add(installed.find((a) => sameApp(a.name, v))?.name ?? v.replace(/\.app$/i, ''));
        drawQuiz();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') add();
      });
      const roles = ROLE_ORDER.filter((r) => r !== 'other').map((r) => pickChip(ROLE_TEMPLATES[r].label, () => draft.roles.has(r), () => {
        toggleIn(draft.roles, r);
      }));
      wrap.append(
        h('p', { class: 'list-head' }, 'Sites'),
        h('div', { class: 'chips' }, sites),
        h('p', { class: 'list-head', style: 'margin-top:22px' }, installed.length ? 'Apps on this Mac' : 'Apps'),
        known.length ? h('div', { class: 'chips' }, known.map(appChip)) : h('p', { class: 'muted' }, 'None of the usual ones are on this Mac.'),
        ...(extra.length ? [h('div', { class: 'chips', style: 'margin-top:10px' }, extra)] : []),
        h('div', { class: 'add-row' }, input, h('button', { class: 'btn btn-ink', type: 'button', onclick: add }, 'Add')),
        h('h3', { class: 'onb-sub' }, 'What do you do?'),
        h('p', { class: 'sub' }, 'Optional. It decides which apps and sites count as work (you can fine-tune them in Settings).'),
        h('div', { class: 'chips' }, roles),
      );
      return wrap;
    },
  },
];

let drawnStep = -1;
let quizNext: HTMLButtonElement | null = null;

function refreshQuizFoot(): void {
  const step = QUIZ[qStep];
  if (!quizNext || !step || qStep === QUIZ.length - 1) return;
  quizNext.textContent = step.nextLabel?.() ?? 'Next';
}

function drawQuiz(): void {
  qStep = Math.max(0, Math.min(qStep, QUIZ.length - 1));
  const keep = drawnStep === qStep ? quizEl.scrollTop : 0;
  drawnStep = qStep;
  clear(quizEl);
  const step = QUIZ[qStep];
  const last = qStep === QUIZ.length - 1;
  quizNext = h('button', { class: `btn quiz-next ${last ? 'btn-primary' : 'btn-ink'}`, type: 'button', onclick: () => (last ? void finishQuiz() : (qStep++, drawQuiz())) }, last ? 'Finish' : 'Next');
  const back = h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { if (qStep === 0) { quizEl.hidden = true; if (!profile) go('home'); } else { qStep--; drawQuiz(); } } }, qStep === 0 ? (profile ? 'Cancel' : 'Skip setup') : 'Back');
  quizEl.append(
    h(
      'div',
      { class: 'quiz-inner' },
      h('div', { class: 'quiz-progress', 'aria-hidden': 'true' }, QUIZ.map((_, i) => h('i', { class: i <= qStep ? 'on' : '' }))),
      h('p', { class: 'quiz-count' }, `${qStep + 1} of ${QUIZ.length}`),
      h('h1', { class: 'display' }, step.title),
      h('p', { class: 'lede' }, step.lede),
      h('div', { class: 'quiz-body' }, step.body()),
    ),
    h('div', { class: 'quiz-foot' }, back, quizNext),
  );
  refreshQuizFoot();
  quizEl.scrollTop = keep;
}

async function finishQuiz(): Promise<void> {
  const picked = draft.roles.size > 0;
  const roles: Role[] = picked ? [...draft.roles] : ['other'];
  // First setup starts from the defaults; doing it again keeps everything you set in Settings.
  const p: Profile = draft.firstRun || !profile ? buildDefaultProfile(roles) : structuredClone(profile);
  const picks = [...draft.distractionApps];
  const roleKey = (rs: Role[]) => rs.filter((r) => r !== 'other').sort().join();
  if (draft.firstRun || roleKey(roles) !== roleKey(profile?.roles ?? [])) {
    p.roles = roles;
    p.role = roles[0];
    // What counts as work: your roles' apps that you actually use (or, when you skipped the
    // question, any role's apps you opened this month) and your roles' sites. Doing setup again
    // adds the new roles' ones to what you have.
    const t = combineRoles(picked ? roles : ROLE_ORDER);
    const recent = installed.some((a) => a.lastUsed >= Date.now() - MONTH_MS);
    const apps = picked || recent ? suggestWorkApps(t.workApps, installed) : [...combineRoles(['other']).workApps];
    const sites = picked ? t.workDomains : combineRoles(['other']).workDomains;
    p.workApps = draft.firstRun ? apps : [...new Set([...p.workApps, ...apps])];
    p.workDomains = draft.firstRun ? [...sites] : [...new Set([...p.workDomains, ...sites])];
    if (picked) {
      for (const d of t.notDistractions) delete p.distractionDomains[d];
      // "Sometimes work": a marketer's X, a creator's YouTube.
      for (const id of t.graySuggest) {
        if (!draft.distractions.has(id)) continue;
        for (const d of DISTRACTION_CHOICES.find((x) => x.id === id)?.domains ?? []) {
          if (!p.grayRules.some((r) => r.domain === d)) p.grayRules.push({ domain: d, workIfTitleContains: [...DEFAULT_GRAY_KEYWORDS] });
        }
      }
    }
  }
  // An app you call a distraction is never a work app.
  p.workApps = p.workApps.filter((a) => !picks.some((x) => sameApp(x, a)));

  // Distracting sites: the usual suspects always count a little; the ones you picked count more.
  for (const c of DISTRACTION_CHOICES) {
    for (const d of c.domains) {
      const base = COMMON_DISTRACTIONS[d];
      if (draft.distractions.has(c.id)) p.distractionDomains[d] = Math.round((base ?? 1) * 1.2 * 10) / 10;
      else if ((p.distractionDomains[d] ?? 0) > (base ?? 1)) {
        if (base) p.distractionDomains[d] = base;
        else delete p.distractionDomains[d];
      }
    }
  }
  const inGroups = new Set(DISTRACTION_CHOICES.flatMap((c) => c.domains));
  for (const d of Object.keys(p.distractionDomains)) if (!(d in COMMON_DISTRACTIONS) && !inGroups.has(d) && !draft.customDistractions.includes(d)) delete p.distractionDomains[d];
  for (const d of draft.customDistractions) p.distractionDomains[d] = p.distractionDomains[d] ?? 1.2;
  for (const d of p.workDomains) delete p.distractionDomains[d];
  // Distracting apps: the ones picked (a known one left off doesn't count).
  for (const a of Object.keys(p.distractionApps)) {
    const offered = !draft.firstRun || DISTRACTION_APP_CHOICES.some((k) => sameApp(k.name, a));
    if (offered && !picks.some((x) => sameApp(x, a))) delete p.distractionApps[a];
  }
  for (const a of picks) p.distractionApps[a] = p.distractionApps[a] ?? Math.round((COMMON_DISTRACTION_APPS[a] ?? 1.2) * 10) / 10;
  await api.invoke('profile:save', p);
  profile = p;
  const cur = settings ?? (await api.invoke<Settings>('settings:get'));
  settings = await api.invoke<Settings>('settings:save', { todo: { ...cur.todo, provider: draft.todoProvider, remindersList: draft.remindersList.trim(), sheet: draft.sheet } });
  if (draft.todoProvider === 'todoist' && draft.todoistToken) await api.invoke('keys:save', { todoist: draft.todoistToken });

  // Your goals and today's to-dos (doing setup again doesn't add the same ones twice).
  const bigs = draft.bigGoals.filter((g) => g.title.trim());
  for (const g of bigs) {
    if (draft.hadGoals.has(g.title.trim().toLowerCase())) continue;
    await api.invoke('goals:add', { kind: 'custom', title: g.title.trim(), until: g.until || undefined });
  }
  for (const x of HABITS) {
    if (!draft.habits.has(x.id) || draft.hadGoals.has(`kind:${x.goal.kind}`)) continue;
    await api.invoke('goals:add', x.goal);
  }
  if (draft.todoProvider === 'builtin' && draft.todayTodos.length) {
    await api.invoke('todos:refresh');
    const have = new Set((await api.invoke<{ open: Task[] }>('todos:get')).open.map((t) => t.title.trim().toLowerCase()));
    for (const t of draft.todayTodos) if (!have.has(t.trim().toLowerCase())) await api.invoke('todos:add', t);
  }
  void api.invoke('todos:refresh');
  drawQuizDone({
    goals: bigs.length,
    habits: draft.habits.size,
    todos: draft.todoProvider === 'builtin' ? draft.todayTodos.length : null,
    distractions: Object.keys(p.distractionApps).length + Object.keys(p.distractionDomains).length,
  });
}

/**
 * Setup's last screen: what was saved, then the four things that make Lock In work, each one or
 * two clicks, ticking themselves off as they happen: the padlock in the menu bar, Accessibility,
 * the browser extension and the calendar. Any of them can wait; Settings has them all.
 */
let connectRun = 0;
function drawQuizDone(n: { goals: number; habits: number; todos: number | null; distractions: number }): void {
  clear(quizEl);
  quizEl.scrollTop = 0;
  const run = ++connectRun;
  const live = () => run === connectRun && !quizEl.hidden;
  const panel = state?.ui !== 'window';
  const saved = [
    n.goals ? plural(n.goals, 'big goal') : '',
    n.habits ? plural(n.habits, 'daily habit') : '',
    n.todos ? plural(n.todos, 'to-do') : '',
    plural(n.distractions, 'distraction'),
  ].filter(Boolean);
  const savedLine = saved.length > 1 ? `${saved.slice(0, -1).join(', ')} and ${saved[saved.length - 1]}` : saved[0];

  let s: SetupStatus | null = null;
  let cal: MacCalView | null = null;
  let calCount = 0;
  let calNote = '';
  let peeked = false;
  let extOpened: string | null = null;
  let browsers: { id: string; name: string }[] = [];
  let waitAccounts = 0;

  const rows = h('ol', { class: 'connect' });
  const doneCount = h('span', { class: 'muted' });
  const finish = h('button', { class: 'btn btn-primary quiz-open', type: 'button', onclick: () => {
    quizEl.hidden = true;
    connectRun++;
    if (panel) void api.invoke('panel:show');
    else go('home');
  } }, 'Done for now');

  const row = (key: string, done: boolean, title: string, body: (Node | string | null)[], actions: (Node | null)[]) =>
    h('li', { class: `connect-row${done ? ' done' : ''}`, 'data-key': key },
      h('span', { class: 'connect-tick', 'aria-label': done ? 'Done' : 'Not yet' }, done ? '✓' : ''),
      h('div', { class: 'connect-body' }, h('h3', null, title), ...body.filter((x): x is Node | string => x !== null).map((x) => (typeof x === 'string' ? h('p', null, x) : x))),
      h('div', { class: 'connect-actions' }, ...actions.filter((x): x is Node => !!x)),
    );

  const checkCalendar = async (): Promise<void> => {
    const r = await api.invoke<{ ok: boolean; status: string; error?: string; calendars?: number; count?: number; next?: string }>('calendar:mac', 'connect');
    cal = await api.invoke<MacCalView>('calendar:mac', 'status');
    calCount = r.ok ? r.calendars ?? 0 : 0;
    calNote = !r.ok
      ? r.error ?? 'That didn’t work.'
      : calCount
        ? `Connected: ${plural(calCount, 'calendar')}${r.next ? `. Next up: ${r.next}` : ''}.`
        : 'Allowed, but there are no calendars on this Mac yet. Add your Google account and they show up here by themselves.';
  };

  let drawn = '';
  const draw = (force = true) => {
    if (!live() || !s) return;
    // The poll redraws only when something changed (so a click is never lost mid-redraw).
    const key = JSON.stringify([s.accessibility, s.extensionConnected, s.openAtLogin, cal?.on, cal?.status, cal?.calendars.length, calCount, calNote, peeked, extOpened, waitAccounts > 0, browsers.length]);
    if (!force && key === drawn) return;
    drawn = key;
    const mac = s.platform === 'darwin';
    const accOk = s.accessibility !== 'missing';
    const calOk = !!cal?.on && cal.status === 'granted' && calCount > 0;
    const padOk = peeked || s.openAtLogin;
    const extOk = s.extensionConnected;
    const hasAccount = !!cal?.calendars.some((c) => c.source.includes('@'));
    clear(rows);

    // 1. The padlock in the menu bar
    rows.append(row('padlock', padOk, 'Find the padlock in your menu bar', [
      panel
        ? 'Lock In lives at the top right of your screen. Click the padlock (or press ⌘⇧L) to lock in, tick off to-dos and see your day.'
        : 'The padlock at the top right of your screen opens Lock In from anywhere (or press ⌘⇧L).',
      s.installed ? h('div', { class: 'connect-switch' }, sw(s.openAtLogin, async (v) => { s = await api.invoke<SetupStatus>('app:loginItem', v); draw(); }, 'Open when I log in'), h('span', null, 'Open when I log in, so it’s always there')) : null,
      h('p', { class: 'muted' }, 'Don’t see it? The camera notch can hide it: hold ⌘ and drag other menu bar icons aside.'),
    ], [h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => { peeked = true; void api.invoke('panel:peek'); draw(); } }, 'Show me')]));

    // 2. Accessibility
    rows.append(row('accessibility', accOk, 'Let it see which window you’re in', [
      'macOS asks once: switch on Lock In under Accessibility. It reads window titles and the open file, never what you type or your screen.',
    ], [!accOk && mac ? h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void api.invoke('setup:promptAccessibility') }, 'Allow') : null]));

    // 3. The browser extension
    const b = browsers[0];
    const extSteps = extOpened
      ? h('ol', { class: 'connect-steps' },
          h('li', null, `In ${extOpened}, turn on `, h('b', null, 'Developer mode'), ' (top right).'),
          h('li', null, 'Drag the highlighted ', h('b', null, 'extension'), ' folder from the Finder window onto the page.'),
          h('li', { class: 'muted' }, 'Or click ', h('b', null, 'Load unpacked'), ', press ⌘⇧G, then ⌘V and Return (the folder’s address is already copied), and click Select.'),
        )
      : null;
    rows.append(row('extension', extOk, 'Add the browser extension', [
      extOk ? 'Connected. Lock In knows the site you’re on, and can lock it when a friend bombs you.' : 'So Lock In knows which site you’re on, and can lock it when a friend bombs you. Takes about 30 seconds.',
      extOk ? null : extSteps,
      !extOk && extOpened ? h('p', { class: 'muted' }, 'Waiting for the extension…') : null,
      !extOk && !b && mac ? h('p', { class: 'muted' }, 'Works in Chrome, Arc, Brave and Edge.') : null,
      !extOk && browsers.length > 1 ? h('p', { class: 'muted' }, 'Use another browser: ', ...browsers.slice(1).flatMap((x, i) => [i ? ', ' : '', h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); void addExt(x.id); } }, x.name)])) : null,
    ], [extOk ? null : h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: () => void addExt(b?.id) }, b ? (extOpened ? `Open ${b.name} again` : `Open ${b.name}`) : 'Show the folder')]));

    // 4. The calendar
    const calBtns: (Node | null)[] = [];
    if (cal?.available) {
      if (!calOk) calBtns.push(h('button', { class: 'btn btn-small btn-ink', type: 'button', onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; calNote = 'Waiting for macOS… choose Allow Full Access.'; draw(); await checkCalendar(); draw(); } }, cal.on ? 'Try again' : 'Connect'));
      if (cal.on && cal.status === 'granted' && !hasAccount) calBtns.push(h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => { waitAccounts = Date.now(); void api.invoke('calendar:mac', 'accounts'); } }, 'Add Google account'));
      if (cal.on && cal.status !== 'granted' && cal.status !== 'missing') calBtns.push(h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: () => void api.invoke('calendar:mac', 'privacy') }, 'Open Privacy settings'));
    }
    rows.append(row('calendar', calOk, 'Connect your calendar', [
      cal?.available === false
        ? 'Connect it later in Settings → Calendar.'
        : 'So it stays quiet in meetings and warns you before them. One click: Lock In reads the calendars already on this Mac (Google, iCloud and Outlook), and never changes them.',
      calNote ? h('p', { class: calOk ? 'connect-ok' : 'muted', 'aria-live': 'polite' }, calNote) : null,
      calOk && !hasAccount ? h('p', { class: 'muted' }, 'Missing your Google calendar? Add your Google account to this Mac and it appears here by itself.') : null,
      waitAccounts && !hasAccount ? h('p', { class: 'muted' }, 'In Internet Accounts, choose Google, sign in and leave Calendars on. Lock In picks it up within a minute.') : null,
    ], calBtns));

    const done = [padOk, accOk, extOk, calOk].filter(Boolean).length;
    doneCount.textContent = done === 4 ? 'All four connected.' : `${done} of 4 connected. The rest can wait: it’s all in Settings.`;
    finish.textContent = done === 4 ? (panel ? 'Open Lock In' : 'Start') : 'Done for now';
  };

  const addExt = async (id?: string) => {
    const r = await api.invoke<{ browser: string | null; path: string }>('setup:addExtension', id);
    extOpened = r.browser ?? 'your browser';
    draw();
  };

  quizEl.append(
    h(
      'div',
      { class: 'quiz-inner quiz-done' },
      h('h1', { class: 'display' }, 'Hook it up.'),
      h('p', { class: 'lede' }, `Saved: ${savedLine}. Now four quick connections, a click or two each.`),
      rows,
    ),
    h('div', { class: 'quiz-foot' }, doneCount, finish),
  );

  // Live: ticks appear as soon as each one works.
  let calCheckedAt = 0;
  const poll = async (first = false): Promise<void> => {
    if (!live()) return;
    s = await api.invoke<SetupStatus>('setup:status');
    if (first) {
      browsers = await api.invoke<{ id: string; name: string }[]>('setup:browsers').catch(() => []);
      cal = await api.invoke<MacCalView>('calendar:mac', 'status').catch(() => null);
      if (cal?.on && cal.status === 'granted') await checkCalendar().catch(() => undefined);
    } else if (waitAccounts && Date.now() - waitAccounts < 5 * 60_000 && Date.now() - calCheckedAt > 6000 && cal?.on && !cal.calendars.some((c) => c.source.includes('@'))) {
      // Just added a Google account in System Settings: look again until its calendars arrive.
      calCheckedAt = Date.now();
      await checkCalendar().catch(() => undefined);
    }
    draw(first);
    setTimeout(() => void poll(), 2500);
  };
  void poll(true);
}

// -----------------------------------------------------------------------------
// To-dos

function duration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const hrs = Math.floor(m / 60);
  const r = m % 60;
  if (!hrs) return `${r} min`;
  return r ? `${hrs} h ${r} min` : `${hrs} h`;
}

function dueLabel(due: string): { text: string; late: boolean } {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (due === today) return { text: 'today', late: false };
  if (due < today) return { text: `overdue, ${new Date(`${due}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}`, late: true };
  return { text: new Date(`${due}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), late: false };
}

async function saveTodo(patch: Partial<TodoSettings>): Promise<void> {
  const cur = settings ?? (await api.invoke<Settings>('settings:get'));
  settings = await api.invoke<Settings>('settings:save', { todo: { ...cur.todo, ...patch } });
}

async function renderTodos(): Promise<void> {
  settings = await api.invoke<Settings>('settings:get');
  const st = settings;
  const data = await api.invoke<{ summary: TodoSummary; open: Task[]; done: Task[] }>('todos:get');
  const s = data.summary;
  const page = h('section', { class: 'page' });
  const none = s.provider === 'none';
  // The count to go, big; what's done is scratched on the wall next to it.
  const tallyBox = none
    ? null
    : h(
        'figure',
        { class: `tally${s.doneToday ? '' : ' empty'}`, 'aria-label': `${s.doneToday} done today` },
        s.doneToday ? tally(s.doneToday) : null,
        h('figcaption', null, s.doneToday ? `${s.doneToday} done today${s.doneToday > 30 ? ' (the wall is full)' : ''}` : 'Nothing scratched on the wall yet today.'),
      );
  page.append(
    h(
      'div',
      { class: 'todo-head' },
      h(
        'div',
        null,
        h('h1', { class: 'display' }, none ? 'No to-do list yet' : s.open ? `${s.open} to go` : 'All done'),
        h(
          'p',
          { class: 'lede' },
          none
            ? 'Connect a list and the coach will hold you to it.'
            : `${duration(s.activeMinToday)} at the computer today. ` +
                (s.minSinceProgress >= 1 ? `${duration(s.minSinceProgress)} since you last finished something.` : 'You just finished something.') +
                (st.todo.roastsEnabled && s.nextRoastInMin !== undefined ? ` Next roast in about ${duration(s.nextRoastInMin)} of screen time.` : ''),
        ),
      ),
      tallyBox,
    ),
  );
  if (s.error) page.append(h('div', { class: 'empty error', role: 'alert' }, s.error));

  if (!none) {
    const list = h('ul', { class: 'todos' });
    const err = h('p', { class: 'sheet-error', role: 'alert', hidden: true });
    const icon = (paths: string) => {
      const span = h('span');
      span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
      return span.firstElementChild as SVGSVGElement;
    };
    for (const t of data.open) {
      const row = h('li', { class: 'todo' });
      // Each to-do is a padlock: unlock it to mark it done.
      const lock = h('button', { class: 'lock-btn', type: 'button', disabled: !s.canComplete, title: s.canComplete ? 'Unlock: mark it done' : 'Tick this off in your list', 'aria-label': `Mark "${t.title}" done` }, padlock());
      lock.addEventListener('click', async () => {
        lock.disabled = true;
        row.classList.add('unlocking');
        const [r] = await Promise.all([api.invoke<{ ok: boolean; error?: string }>('todos:complete', t.id), new Promise((ok) => setTimeout(ok, 260))]);
        if (!r.ok) {
          row.classList.remove('unlocking');
          lock.disabled = false;
          err.hidden = false;
          err.textContent = r.error ?? 'Could not tick that off.';
          return;
        }
        row.classList.add('released');
        setTimeout(() => void renderTodos(), 820);
      });
      const due = t.due ? dueLabel(t.due) : null;
      row.append(
        lock,
        h(
          'div',
          { class: 'todo-main' },
          h('span', { class: 'task-title' }, t.title),
          due ? h('span', { class: `due${due.late ? ' late' : ''}` }, due.text) : null,
          (t.priority ?? 0) >= 3 ? h('span', { class: 'pill distraction' }, 'urgent') : null,
        ),
        h(
          'div',
          { class: 'todo-tools' },
          t.due
            ? h('button', { class: 'icon-btn', type: 'button', title: 'Make it a deadline: reminders before it is due, pinned on the day', 'aria-label': `Make "${t.title}" a deadline`, onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).textContent = 'Pinned'; await api.invoke('deadlines:fromTask', t.id); } }, icon('<path d="M9 4h6l-1 5 3 3H7l3-3z"/><path d="M12 12v8"/>'))
            : null,
          s.provider === 'builtin'
            ? h('button', { class: 'icon-btn del', type: 'button', title: 'Delete', 'aria-label': `Delete "${t.title}"`, onclick: async () => { await api.invoke('todos:remove', t.id); void renderTodos(); } }, icon('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'))
            : h('button', { class: 'icon-btn', type: 'button', title: 'Hide this row from Lock In', 'aria-label': `"${t.title}" is not a task`, onclick: async () => { await api.invoke('todos:hide', t.id); void renderTodos(); } }, 'Not a task'),
        ),
      );
      list.append(row);
    }
    if (!data.open.length) list.append(h('li', { class: 'todo empty' }, s.connected ? 'Nothing locked up. Suspicious, but congratulations.' : 'Connecting…'));
    const add = h('input', { type: 'text', placeholder: 'Add a to-do for today' });
    const addBtn = h('button', { class: 'btn btn-small btn-ink', type: 'button' }, 'Add');
    addBtn.addEventListener('click', async () => {
      if (!add.value.trim()) return;
      addBtn.disabled = true;
      const r = await api.invoke<{ ok: boolean; error?: string }>('todos:add', add.value.trim());
      if (!r.ok) {
        addBtn.disabled = false;
        err.hidden = false;
        err.textContent = r.error ?? 'Could not add that.';
        return;
      }
      void renderTodos();
    });
    add.addEventListener('keydown', (e) => e.key === 'Enter' && addBtn.click());
    page.append(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'row-head' }, h('h2', null, 'All to-dos'), h('button', { class: 'btn btn-small btn-quiet', type: 'button', onclick: async () => { await api.invoke('todos:refresh'); void renderTodos(); } }, 'Refresh')),
        list,
        err,
        s.canAdd ? h('div', { class: 'add-row' }, add, addBtn) : null,
        s.hidden
          ? h('p', { class: 'muted', style: 'margin-top:10px' }, `${s.hidden} ${s.hidden === 1 ? 'row' : 'rows'} hidden as not tasks. `, h('button', { class: 'link-btn', type: 'button', onclick: async () => { await api.invoke('todos:unhide'); void renderTodos(); } }, 'Show them again'))
          : null,
        s.tickNote || !s.canAdd
          ? h('p', { class: 'muted', style: 'margin-top:10px' }, [s.tickNote, s.canAdd ? '' : 'Add new tasks in your list itself; Lock In checks it every two minutes.'].filter(Boolean).join(' '))
          : null,
      ),
    );

    {
      const doneList = h('ul', { class: 'todos done-list' });
      if (!data.done.length) doneList.append(h('li', { class: 'todo empty' }, 'Nothing yet. Did something that is not on the list? Tell Lock In.'));
      for (const t of data.done) {
        const undoable = !!(t.localOnly || t.said);
        const row = h('li', { class: 'todo done' });
        const lock = h('button', { class: 'lock-btn', type: 'button', disabled: !undoable, title: undoable ? 'Lock it again: not done after all' : 'Done in your list', 'aria-label': undoable ? `Un-tick "${t.title}"` : `"${t.title}" is done` }, padlock());
        lock.addEventListener('click', async () => {
          lock.disabled = true;
          row.classList.remove('done');
          await api.invoke('todos:undo', t.id);
          setTimeout(() => void renderTodos(), 300);
        });
        row.append(
          lock,
          h('div', { class: 'todo-main' }, h('span', { class: 'task-title' }, t.title), h('span', { class: 'due' }, [t.completedAt ? clockTime(t.completedAt) : '', t.said ? 'you told Lock In' : t.localOnly ? 'ticked in Lock In' : 'ticked in your list'].filter(Boolean).join(', '))),
          h('span'),
        );
        doneList.append(row);
      }
      const tell = h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('talk:open', 'checkin') }, '🎙 Tell Lock In what you did');
      page.append(h('div', { class: 'section' }, h('div', { class: 'row-head' }, h('h2', null, 'Done today'), tell), doneList));
    }
  }
  deadlinesBox = h('div', { class: 'section', id: 'deadlines-sec' });
  page.append(await weekSection(), deadlinesBox, h('div', { class: 'section list-settings' }, h('h2', null, 'Your list'), h('p', { class: 'sub' }, 'Where your to-dos come from, and how Lock In nudges you about them.')));

  const prov = h('div', { class: 'choices' });
  for (const p of TODO_PROVIDERS) {
    prov.append(h('button', { class: 'choice', type: 'button', 'aria-pressed': String(st.todo.provider === p.id), onclick: async () => { await saveTodo({ provider: p.id }); await api.invoke('todos:refresh'); void renderTodos(); } }, h('b', null, p.label), h('small', null, p.help)));
  }
  const conn = h('div', { class: 'section sub-section' }, h('h3', null, 'Where your to-dos live'), prov);
  const textField = (label: string, help: string, key: 'remindersList' | 'thingsList' | 'todoistFilter', ph: string) => {
    const i = h('input', { type: 'text', value: st.todo[key], placeholder: ph });
    i.addEventListener('change', async () => { await saveTodo({ [key]: i.value.trim() }); await api.invoke('todos:refresh'); void renderTodos(); });
    return field(label, help, i);
  };
  if (st.todo.provider === 'reminders') {
    const scope = h('select', null, h('option', { value: 'today', selected: st.todo.remindersScope === 'today' }, 'Due today or overdue'), h('option', { value: 'all', selected: st.todo.remindersScope === 'all' }, 'Everything open'));
    scope.addEventListener('change', async () => { await saveTodo({ remindersScope: scope.value as 'today' | 'all' }); await api.invoke('todos:refresh'); void renderTodos(); });
    conn.append(h('div', { class: 'fields' }, textField('List', 'Leave blank for every list.', 'remindersList', 'All lists'), field('Which reminders count', null, scope)));
  }
  if (st.todo.provider === 'things') conn.append(h('div', { class: 'fields' }, textField('Things list', 'Usually Today.', 'thingsList', 'Today')));
  if (st.todo.provider === 'sheet') {
    let timer: ReturnType<typeof setTimeout> | null = null;
    conn.append(
      sheetSetup(st.todo.sheet, (c) => {
        st.todo.sheet = c;
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          await saveTodo({ sheet: c });
          await api.invoke('todos:refresh');
        }, 400);
      }, false),
    );
  }
  if (st.todo.provider === 'todoist') {
    const tok = h('input', { type: 'password', placeholder: state?.keys.todoist ? 'Saved. Paste a new token to replace it.' : 'Paste your API token', autocomplete: 'off' });
    const note = h('span', { class: 'saved' });
    const save = h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
      const ks = await api.invoke<KeyStatus>('keys:save', { todoist: tok.value.trim() });
      tok.value = '';
      note.textContent = ks.todoist ? 'Saved in your keychain' : 'Removed';
      setTimeout(() => void renderTodos(), 1500);
    } }, 'Save');
    conn.append(h('div', { class: 'fields' }, field('Todoist API token', 'Todoist: Settings, Integrations, Developer.', h('div', { class: 'inline' }, tok, save, note)), textField('Filter', 'Any Todoist filter.', 'todoistFilter', 'today | overdue')));
  }
  page.append(conn);

  const thr = h('select', { 'aria-label': 'Roast after' }, [45, 60, 90, 120, 180].map((m) => h('option', { value: String(m), selected: st.todo.noProgressMin === m }, duration(m))));
  thr.addEventListener('change', () => void saveTodo({ noProgressMin: Number(thr.value) }));
  const max = h('input', { type: 'number', min: '1', max: '20', value: String(st.todo.maxRoastsPerDay) });
  max.addEventListener('change', () => void saveTodo({ maxRoastsPerDay: Math.max(1, Math.min(20, Number(max.value) || 6)) }));
  page.append(
    h(
      'div',
      { class: 'section sub-section' },
      h('h3', null, 'Roasts'),
      h('p', { class: 'sub' }, 'Only time you are actually at the computer counts. No roasts during a focus session, a call, or a mute. Each roast after the first comes sooner and hits harder.'),
      field('Roast me when nothing gets done', null, sw(st.todo.roastsEnabled, (v) => void saveTodo({ roastsEnabled: v }), 'Roast me when nothing gets done')),
      field('First roast after', 'Of screen time without finishing a task.', thr),
      field('Most roasts in a day', null, max),
      field('Cheer when I finish something', null, sw(st.todo.celebrate, (v) => void saveTodo({ celebrate: v }), 'Cheer when I finish something')),
      field('Try it', null, h('div', { class: 'test-row' }, ['Raised eyebrow', 'Proper roast', 'Full intervention'].map((l, i) => h('button', { class: 'btn btn-small', type: 'button', onclick: () => void api.invoke('todos:roastTest', i + 1) }, l)))),
    ),
  );
  if (route === 'todos') {
    const keep = view.scrollTop;
    clear(view);
    view.append(page);
    view.scrollTop = keep;
    await refreshDeadlines();
  }
}

// -----------------------------------------------------------------------------
// Progress: how it's going (today, this week, streaks and achievements)

async function renderProgress(): Promise<void> {
  const [today, crew, goals] = await Promise.all([todaySections(), api.invoke<CrewPayload>('crew:get'), state?.goals !== false ? api.invoke<GoalsView>('goals:get') : Promise.resolve(null)]);
  const page = h(
    'section',
    { class: 'page progress' },
    h('h1', { class: 'display' }, 'Progress'),
    h('p', { class: 'lede' }, 'How your focus is going: today, this week, and your streaks.'),
    ...today,
    goals ? rhythmSection(goals) : null,
    achievementsSection(crew),
  );
  if (route !== 'progress') return;
  clear(view);
  view.append(page);
}

// -----------------------------------------------------------------------------
// Spreadsheet setup (setup and To-dos page)

function describeMap(pv: SheetPreview): string {
  const name = (i: number | null) => (i === null ? null : pv.columns[i] ?? null);
  const parts = [`tasks in ${name(pv.map.task)}`];
  parts.push(pv.map.done !== null ? `ticked off in ${name(pv.map.done)}` : 'no done column, so deleting a row counts as finishing it');
  if (pv.map.due !== null) parts.push(`due dates in ${name(pv.map.due)}`);
  if (pv.map.priority !== null) parts.push(`priority in ${name(pv.map.priority)}`);
  if (pv.map.assignee !== null) parts.push(`who it's for in ${name(pv.map.assignee)}`);
  return `Reading ${parts.join(', ')}.`;
}

/**
 * Paste a Google Sheets link or pick a file, see what Lock In found, fix the columns.
 * `compact` (setup) hides the column pickers and the row filter.
 */
function sheetSetup(initial: SheetSettings, onChange: (c: SheetSettings) => void, compact: boolean): HTMLElement {
  let c: SheetSettings = { ...initial };
  const box = h('div', { class: 'sheet-setup' });
  const status = h('div', { class: 'sheet-status', 'aria-live': 'polite' });
  let lastPreview: SheetPreview | null = null;
  let seq = 0;

  const set = (patch: Partial<SheetSettings>, recheck = true) => {
    c = { ...c, ...patch };
    onChange(c);
    if (recheck) void check();
    else draw();
  };

  const check = async () => {
    const mine = ++seq;
    if ((c.kind === 'google' && !c.url.trim()) || (c.kind === 'file' && !c.path.trim())) {
      lastPreview = null;
      draw();
      return;
    }
    clear(status);
    status.append(h('p', { class: 'muted' }, 'Reading your sheet…'));
    const pv = await api.invoke<SheetPreview>('todos:sheetPreview', c);
    if (mine !== seq) return;
    lastPreview = pv;
    draw();
  };

  const connector = () => {
    const out = h('span', { class: 'saved' });
    return h(
      'div',
      { class: 'connector' },
      h('h3', null, 'Keep the sheet private and tick tasks off from Lock In'),
      h(
        'ol',
        null,
        h('li', null, 'In your Google Sheet, open Extensions, then Apps Script.'),
        h('li', null, 'Delete what is there and paste the Lock In script. ', h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
          const code = await api.invoke<string>('todos:connectorScript');
          await api.invoke('clipboard:write', code);
          out.textContent = 'Copied. It only answers requests that carry your secret.';
        } }, 'Copy the script'), ' ', out),
        h('li', null, 'Click Deploy, then New deployment. Choose Web app, set "Execute as" to Me and "Who has access" to Anyone, then Deploy and allow access.'),
        h('li', null, 'Copy the Web app URL (it ends in /exec) and paste it into the box above instead of the sheet link.'),
      ),
    );
  };

  const draw = () => {
    clear(box);
    const kinds = h(
      'div',
      { class: 'tri', role: 'group', 'aria-label': 'Where the sheet is' },
      h('button', { type: 'button', 'aria-pressed': String(c.kind === 'google'), onclick: () => set({ kind: 'google' }) }, 'Google Sheets'),
      h('button', { type: 'button', 'aria-pressed': String(c.kind === 'file'), onclick: () => set({ kind: 'file' }) }, 'Excel, Numbers or CSV file'),
    );
    box.append(kinds);

    if (c.kind === 'google') {
      const url = h('input', { type: 'text', value: c.url, placeholder: 'Paste the link to your sheet', 'aria-label': 'Google Sheets link' });
      url.addEventListener('change', () => set({ url: url.value.trim() }));
      url.addEventListener('paste', () => setTimeout(() => set({ url: url.value.trim() }), 0));
      box.append(h('div', { class: 'add-row' }, url, h('button', { class: 'btn btn-small', type: 'button', onclick: () => set({ url: url.value.trim() }) }, 'Check')));
      box.append(h('p', { class: 'hint-line' }, 'Works with a link shared as "Anyone with the link can view", or with the private connector below.'));
    } else {
      const pick = h('button', { class: 'btn btn-small', type: 'button', onclick: async () => {
        const path = await api.invoke<string | null>('todos:pickSheetFile');
        if (path) set({ path });
      } }, c.path ? 'Choose a different file' : 'Choose file');
      box.append(h('div', { class: 'add-row' }, pick, c.path ? h('span', { class: 'file-path', title: c.path }, c.path.split('/').pop() ?? c.path) : h('span', { class: 'muted' }, 'No file chosen')));
    }

    const tabs = lastPreview?.tabs ?? [];
    let tab: HTMLElement;
    if (tabs.length) {
      const cur = tabs.find((x) => x.toLowerCase() === c.tab.trim().toLowerCase()) ?? (c.tab.trim() ? c.tab.trim() : '');
      const sel = h(
        'select',
        { 'aria-label': 'Tab' },
        h('option', { value: '', selected: cur === '' }, 'Pick the right one for me'),
        cur && !tabs.includes(cur) ? h('option', { value: cur, selected: true }, `${cur} (not found)`) : null,
        tabs.map((x) => h('option', { value: x, selected: cur === x }, x)),
      );
      sel.addEventListener('change', () => set({ tab: sel.value }));
      tab = sel;
    } else {
      const inp = h('input', { type: 'text', value: c.tab, placeholder: 'Blank = pick it for me', 'aria-label': 'Tab name' });
      inp.addEventListener('change', () => set({ tab: inp.value.trim() }));
      tab = inp;
    }
    box.append(h('div', { class: 'add-row tab-row' }, h('label', null, 'Tab'), tab));

    box.append(status);
    clear(status);
    const pv = lastPreview;
    if (pv) {
      if (pv.error) status.append(h('p', { class: 'sheet-error', role: 'alert' }, pv.error));
      if (pv.ok) {
        const where = pv.tab ? ` in the "${pv.tab}" tab` : '';
        const why = pv.tabWhy && !c.tab.trim() ? ` (picked because ${pv.tabWhy})` : '';
        status.append(
          h(
            'p',
            { class: 'sheet-found' },
            h('b', null, `Found ${pv.open} open ${pv.open === 1 ? 'task' : 'tasks'}`),
            pv.done ? ` and ${pv.done} done` : '',
            `${where}${why}.`,
            pv.owner ? ` Only rows for ${pv.owner}.` : '',
            pv.sample.length ? ` Up next: ${pv.sample.slice(0, 3).join('; ')}.` : '',
          ),
          h('p', { class: 'muted' }, describeMap(pv), pv.headerRow ? ` Column names are on row ${pv.headerRow}; everything above it is ignored.` : ''),
        );
        if (pv.skipped) status.append(h('p', { class: 'muted' }, `Left out ${pv.skipped} ${pv.skipped === 1 ? 'row that isn\u2019t a task' : 'rows that aren\u2019t tasks'} (titles, totals, notes): ${pv.skippedSample.map((x) => `"${x.length > 40 ? `${x.slice(0, 40)}…` : x}"`).join(', ')}${pv.skipped > pv.skippedSample.length ? '…' : ''}`));
        if (pv.map.assignee !== null && pv.owners.length >= 2) {
          const cur = c.owner === null ? '__auto' : c.owner;
          const who = h(
            'select',
            { 'aria-label': 'Whose tasks' },
            h('option', { value: '__auto', selected: cur === '__auto' }, `Mine${c.owner === null && pv.owner ? ` (${pv.owner})` : ''}`),
            h('option', { value: '', selected: cur === '' }, 'Everyone'),
            pv.owners.map((o) => h('option', { value: o, selected: cur === o }, o)),
          );
          who.addEventListener('change', () => set({ owner: who.value === '__auto' ? null : who.value }));
          status.append(h('label', { class: 'col-pick wide' }, 'Whose tasks count', who));
        }
        if (!pv.canComplete) status.append(h('p', { class: 'muted' }, 'Ticking a task in Lock In marks it done here, but the sheet itself stays as it is. Ticks you make in the sheet show up within two minutes.'));
      }
      if (!compact && pv.columns.length) {
        const sel = (label: string, key: 'task' | 'done' | 'due' | 'priority' | 'assignee', allowNone: boolean) => {
          const cur = c[key];
          const s = h(
            'select',
            { 'aria-label': `${label} column` },
            h('option', { value: '', selected: cur === null }, `Auto${pv.map[key] !== null ? ` (${pv.columns[pv.map[key]!]})` : ''}`),
            allowNone ? h('option', { value: '-1', selected: cur === -1 }, 'None') : null,
            pv.columns.map((col, i) => h('option', { value: String(i), selected: cur === i }, col)),
          );
          s.addEventListener('change', () => set({ [key]: s.value === '' ? null : Number(s.value) } as Partial<SheetSettings>));
          return h('label', { class: 'col-pick' }, label, s);
        };
        const scope = h('select', { 'aria-label': 'Which rows count' }, h('option', { value: 'all', selected: c.scope === 'all' }, 'Every open row'), h('option', { value: 'due', selected: c.scope === 'due' }, 'Only rows due today or earlier, plus undated ones'));
        scope.addEventListener('change', () => set({ scope: scope.value as SheetSettings['scope'] }));
        status.append(h('div', { class: 'col-picks' }, sel('Task', 'task', false), sel('Done', 'done', true), sel('Due date', 'due', true), sel('Priority', 'priority', true), sel('Assigned to', 'assignee', true)), h('label', { class: 'col-pick wide' }, 'Rows that count', scope));
      }
    }
    if (c.kind === 'google' && (!compact || /private/i.test(pv?.error ?? '')) && !/\/exec\b/.test(c.url)) box.append(connector());
  };

  draw();
  void check();
  return box;
}

// -----------------------------------------------------------------------------
// Routines

const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayPicker(days: number[], onChange: (d: number[]) => void): HTMLElement {
  const wrap = h('div', { class: 'days', role: 'group', 'aria-label': 'Days' });
  DAY_NAMES.forEach((d, i) => {
    const b = h('button', { class: 'chip pick day', type: 'button', 'aria-pressed': String(days.includes(i)), 'aria-label': DAY_FULL[i] }, d);
    b.addEventListener('click', () => {
      const next = days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort();
      days.splice(0, days.length, ...next);
      b.setAttribute('aria-pressed', String(days.includes(i)));
      onChange(days);
    });
    wrap.append(b);
  });
  return wrap;
}

// -----------------------------------------------------------------------------
// Notifications (in Settings)

const SHORT: Record<Channel, string> = { toast: 'Corner card', card: 'Full screen', tab: 'Chrome card', voice: 'Voice', sound: 'Sound', system: 'macOS', menubar: 'Menu bar', dock: 'Dock', phone: 'Phone', webhook: 'Slack or Discord' };

function notificationsSection(st: Settings, saveSt: (p: Partial<Settings>) => void): HTMLElement {
  const sec = h('div', { class: 'section' }, h('h2', null, 'Notifications'), h('p', { class: 'sub' }, 'Pick how each moment reaches you. Calls, quiet hours and mute still win.'));
  const table = h('table', { class: 'table matrix' });
  table.append(h('thead', null, h('tr', null, h('th', null, 'When'), CHANNELS.map((c) => h('th', { class: 'c', title: c.help }, SHORT[c.id])), h('th', null, 'Sound'))));
  const body = h('tbody');
  for (const k of NOTIFY_KINDS) {
    const row = h('tr', null, h('td', null, h('b', null, k.label), h('div', { class: 'muted', style: 'font-size:12px' }, k.help)));
    for (const c of CHANNELS) {
      const cb = h('input', { type: 'checkbox', checked: st.notify[k.id].includes(c.id), 'aria-label': `${k.label}: ${c.label}` });
      cb.addEventListener('change', () => {
        const set = new Set(st.notify[k.id]);
        if (cb.checked) set.add(c.id);
        else set.delete(c.id);
        st.notify = { ...st.notify, [k.id]: CHANNELS.map((x) => x.id).filter((x) => set.has(x)) };
        saveSt({ notify: st.notify });
      });
      row.append(h('td', { class: 'c' }, cb));
    }
    const sel = h('select', { 'aria-label': `${k.label} sound` }, SOUNDS.map((s) => h('option', { value: s.id, selected: st.sounds[k.id as NotifyKind] === s.id }, s.label)));
    sel.addEventListener('change', () => {
      st.sounds = { ...st.sounds, [k.id]: sel.value as SoundId };
      saveSt({ sounds: st.sounds });
      void api.invoke('sound:test', sel.value);
    });
    row.append(h('td', { class: 'snd' }, sel, h('button', { class: 'play', type: 'button', 'aria-label': `Play ${k.label} sound`, onclick: () => void api.invoke('sound:test', sel.value) }, '▶')));
    body.append(row);
  }
  table.append(body);
  sec.append(h('div', { class: 'matrix-wrap' }, table));

  const result = h('span', { class: 'saved', 'aria-live': 'polite' });
  const test = (c: Channel, label: string) => h('button', { class: 'btn btn-small', type: 'button', onclick: async () => { result.textContent = '…'; result.textContent = await api.invoke<string>('notify:test', c); } }, label);
  const server = h('input', { type: 'text', value: st.ntfyServer, placeholder: 'https://ntfy.sh' });
  server.addEventListener('change', () => saveSt({ ntfyServer: server.value.trim() || 'https://ntfy.sh' }));
  const topic = h('input', { type: 'text', value: st.ntfyTopic, placeholder: 'lockin-grace-7f3k2' });
  topic.addEventListener('change', () => saveSt({ ntfyTopic: topic.value.trim() }));
  const hook = h('input', { type: 'password', value: st.webhookUrl, placeholder: 'https://hooks.slack.com/services/…', autocomplete: 'off' });
  hook.addEventListener('change', () => saveSt({ webhookUrl: hook.value.trim() }));
  sec.append(
    h('h3', { class: 'sub-head' }, 'Phone and channel setup'),
    field('Phone push topic', 'Install the free ntfy app, subscribe to a topic name only you know, and paste the same name here.', h('div', { class: 'inline' }, topic, test('phone', 'Send a test'))),
    field('ntfy server', 'Leave as ntfy.sh unless you run your own.', server),
    field('Slack or Discord webhook', 'Opt-in accountability: posts to a channel you choose. Only events you tick in the Slack or Discord column are sent.', h('div', { class: 'inline' }, hook, test('webhook', 'Send a test'))),
    field('Test on this Mac', null, h('div', { class: 'test-row' }, test('system', 'macOS banner'), test('menubar', 'Menu bar flash'), test('dock', 'Dock bounce'), test('card', 'Full-screen card'), test('tab', 'Chrome card'))),
    h('p', { style: 'margin-top:8px' }, result),
  );
  return sec;
}

// -----------------------------------------------------------------------------
// Boot


// -----------------------------------------------------------------------------
// Friends: your crew, Lock In bombs, the weekly roast board, achievements

interface CrewPayload {
  view: CrewView;
  achievements: AchievementView[];
  streak: number;
}

let crewStrip: HTMLElement | null = null;
let crewData: CrewPayload | null = null;
/** The bomb picker: who it's aimed at and what you've typed so far (kept across live updates). */
const aim: { id: string; preset: string; custom: string } = { id: '', preset: '', custom: '' };
let crewDirty = false;
let inviteOpen = false;

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

function stateText(m: CrewMemberView): string {
  switch (m.state) {
    case 'locked':
      return `Locked in${m.goal ? ` on ${m.goal}` : ''}${m.sessionMin !== undefined ? `, ${minutes(m.sessionMin)} in` : ''}`;
    case 'break':
      return 'On a break';
    case 'drifting':
      return m.distraction ? `Drifting on ${m.distraction}` : 'Drifting';
    case 'free':
      return 'Not locked in';
    case 'meeting':
      return 'In a meeting';
    case 'away':
      return 'Away from the computer';
    default:
      return `Offline since ${clockTime(m.since)}`;
  }
}

function whyNot(m: CrewMemberView, left: number): string {
  if (m.state === 'locked' || m.state === 'break') return `${m.name} is locked in. Leave them be.`;
  if (m.state === 'meeting') return `${m.name} is in a meeting.`;
  if (m.state === 'away' || m.state === 'offline') return `${m.name} isn't at their computer.`;
  if (left <= 0) return 'No bombs left today. 3 more tomorrow.';
  return '';
}

function drawCrewStrip(p: CrewPayload): void {
  crewData = p;
  if (!crewStrip) return;
  clear(crewStrip);
  const bits: (Node | string)[] = [];
  if (p.streak > 0) bits.push(h('span', { class: 'streak-chip' }, `🔥 ${p.streak}-day streak`));
  const friends = p.view.joined ? p.view.members.filter((m) => !m.me && m.state !== 'offline') : [];
  if (friends.length) {
    const locked = friends.filter((m) => m.state === 'locked');
    const loose = friends.filter((m) => m.bombable);
    const names = (list: CrewMemberView[]) => (list.length < 3 ? list.map((m) => m.name).join(' and ') : `${list.slice(0, -1).map((m) => m.name).join(', ')} and ${list[list.length - 1].name}`);
    const line = [
      locked.length ? `${names(locked)} ${locked.length === 1 ? 'is' : 'are'} locked in.` : '',
      loose.length ? `${names(loose)} ${loose.length === 1 ? "isn't" : "aren't"}. 💣 ${p.view.bombsLeft} left today.` : '',
    ].filter(Boolean).join(' ');
    bits.push(h('a', { href: '#friends', class: 'crew-line' }, line || 'Your crew is quiet.'));
  } else if (!p.view.joined) {
    bits.push(h('a', { href: '#friends', class: 'crew-line muted' }, 'Lock in with friends →'));
  }
  crewStrip.append(...bits);
  crewStrip.hidden = !bits.length;
}

api.on('crew:update', (raw) => {
  const p = raw as CrewPayload;
  crewData = p;
  drawCrewStrip(p);
  if (route !== 'friends') return;
  // Don't redraw under someone's fingers: wait until they leave the field.
  const active = document.activeElement;
  if (active && view.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    crewDirty = true;
    return;
  }
  void renderFriends(p, true);
});

view.addEventListener('focusout', () => {
  if (!crewDirty || route !== 'friends') return;
  setTimeout(() => {
    const active = document.activeElement;
    if (active && view.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    crewDirty = false;
    void renderFriends(crewData ?? undefined, true);
  }, 50);
});

async function renderFriends(p?: CrewPayload, keepScroll = false): Promise<void> {
  const data = p ?? (await api.invoke<CrewPayload>('crew:get'));
  crewData = data;
  if (anchor.startsWith('aim-')) {
    aim.id = anchor.slice(4);
    anchor = 'crew-sec';
  }
  const top = view.scrollTop;
  clear(view);
  const v = data.view;
  const page = h('section', { class: 'page friends' });
  if (!v.joined) page.append(...crewJoinView());
  else page.append(...crewView(v));
  if (v.joined) page.append(crewSettingsSection(v));
  view.append(page);
  if (keepScroll) view.scrollTop = top;
}

function crewJoinView(): Node[] {
  const st = settings?.crew;
  const crewName = h('input', { type: 'text', placeholder: 'Crew name, e.g. Library gremlins', maxLength: 40 });
  const nameA = h('input', { type: 'text', placeholder: 'Your name', value: st?.name ?? '', maxLength: 32 });
  const code = h('input', { type: 'text', placeholder: 'Invite code, e.g. K7Q2M-9XW4T-…', autocomplete: 'off', spellcheck: false });
  const nameB = h('input', { type: 'text', placeholder: 'Your name', value: st?.name ?? '', maxLength: 32 });
  const note = h('p', { class: 'muted', 'aria-live': 'polite' });
  const start = h('button', { class: 'btn btn-primary', type: 'button' }, 'Start a crew');
  start.addEventListener('click', async () => {
    if (!nameA.value.trim()) return nameA.focus();
    const r = await api.invoke<CrewPayload>('crew:create', { crewName: crewName.value, name: nameA.value });
    settings = await api.invoke<Settings>('settings:get');
    inviteOpen = true;
    void renderFriends(r);
  });
  const join = h('button', { class: 'btn btn-ink', type: 'button' }, 'Join');
  join.addEventListener('click', async () => {
    if (!nameB.value.trim()) return nameB.focus();
    const r = await api.invoke<CrewPayload & { ok: boolean; error?: string }>('crew:join', { code: code.value, name: nameB.value });
    if (!r.ok) {
      note.textContent = r.error ?? "That code didn't work.";
      note.className = 'sheet-error';
      return;
    }
    settings = await api.invoke<Settings>('settings:get');
    void renderFriends(r);
  });
  return [
    h('h1', { class: 'display' }, 'Lock in with friends'),
    h('p', { class: 'lede' }, "See who's locked in, throw Lock In bombs at friends who aren't, and fight your way off the top of the weekly roast board."),
    h(
      'div',
      { class: 'crew-doors' },
      h('div', { class: 'crew-door' }, h('h2', null, 'Start a crew'), h('p', { class: 'muted' }, "You'll get an invite code to send your friends."), crewName, nameA, start),
      h('div', { class: 'crew-door' }, h('h2', null, 'Join a crew'), h('p', { class: 'muted' }, 'Paste the code a friend sent you.'), code, nameB, join),
    ),
    note,
    h(
      'p',
      { class: 'muted crew-how' },
      'Each of you needs Lock In on your Mac. Everyone gets 3 bombs a day. A bomb only lands on a friend who is at their computer and not locked in: every distraction on their Mac locks for 5 minutes, and their screen goes red for 5 seconds. Messages go through ntfy, encrypted with your crew code, so only your crew can read them.',
    ),
  ];
}

function crewView(v: CrewView): Node[] {
  const out: Node[] = [];
  const conn = v.connected ? 'Connected' : v.error ? `Can't reach the relay (${v.error}). Retrying.` : 'Connecting…';
  const inviteBtn = h('button', { class: 'btn btn-small', type: 'button' }, inviteOpen ? 'Hide the code' : 'Invite friends');
  inviteBtn.addEventListener('click', () => {
    inviteOpen = !inviteOpen;
    void renderFriends(crewData ?? undefined, true);
  });
  out.push(
    h('div', { class: 'crew-head' }, h('h1', { class: 'display' }, v.crewName || 'Your crew'), inviteBtn),
    h('p', { class: 'lede crew-sub' }, h('span', { class: `bombs-left${v.bombsLeft ? '' : ' empty'}` }, `💣 ${v.bombsLeft} of ${v.bombsPerDay} bombs left today`), h('span', { class: `conn${v.connected ? ' on' : ''}` }, conn)),
  );
  if (inviteOpen) {
    const copy = h('button', { class: 'btn btn-small btn-ink', type: 'button' }, 'Copy code');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(v.code).catch(() => undefined);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy code'), 1500);
    });
    out.push(
      h(
        'div',
        { class: 'invite' },
        h('p', null, 'Send this code to friends. In Lock In they open Friends, choose Join, and paste it. Anyone with the code can join, so keep it to the crew.'),
        h('div', { class: 'invite-row' }, h('code', { class: 'invite-code' }, v.code), copy),
      ),
    );
  }

  // The crew, with a bomb for anyone not locked in.
  const list = h('ul', { class: 'crew-list' });
  for (const m of v.members) {
    const row = h(
      'li',
      { class: `crew-row${aim.id === m.id ? ' aiming' : ''}`, 'data-state': m.state },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, (m.name || '?').slice(0, 1).toUpperCase()),
      h(
        'div',
        { class: 'who' },
        h('b', null, m.name, m.me ? h('span', { class: 'you' }, ' (you)') : null),
        h('span', { class: 'what' }, stateText(m)),
        h('span', { class: 'stats' }, `${minutes(m.stats.todayMin)} today${m.stats.streak ? `, ${m.stats.streak}-day streak` : ''}`),
      ),
    );
    if (!m.me) {
      const reason = whyNot(m, v.bombsLeft);
      const btn = h('button', { class: 'btn btn-small bomb-btn', type: 'button', disabled: !!reason, title: reason || `Throw a Lock In bomb at ${m.name}` }, aim.id === m.id ? 'Cancel' : '💣 Bomb');
      btn.addEventListener('click', () => {
        aim.id = aim.id === m.id ? '' : m.id;
        aim.preset = '';
        aim.custom = '';
        void renderFriends(crewData ?? undefined, true);
      });
      row.append(h('div', { class: 'act' }, btn, reason ? h('span', { class: 'why' }, reason) : null));
    }
    list.append(row);
    if (aim.id === m.id && m.bombable && v.bombsLeft > 0) list.append(bombPicker(m, v));
  }
  out.push(h('div', { class: 'section', id: 'crew-sec' }, h('h2', null, 'Your crew'), list, v.members.length === 1 ? h('p', { class: 'muted' }, "It's just you so far. Invite friends with the code.") : null));

  // Most roasted this week.
  const ranked = [...v.members].sort((a, b) => b.stats.roastedWeek - a.stats.roastedWeek || b.stats.weekMin - a.stats.weekMin || a.name.localeCompare(b.name));
  const table = h(
    'table',
    { class: 'table board' },
    h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Who'), h('th', { class: 'num' }, 'Roasted'), h('th', { class: 'num' }, 'Locked in'), h('th', { class: 'num' }, 'Bombs thrown'), h('th', { class: 'num' }, 'Streak'))),
    h(
      'tbody',
      null,
      ranked.map((m, i) =>
        h(
          'tr',
          { class: m.me ? 'me' : '' },
          h('td', { class: 'rank' }, i === 0 && m.stats.roastedWeek > 0 ? '🔥' : String(i + 1)),
          h('td', null, m.name, m.me ? ' (you)' : ''),
          h('td', { class: 'num' }, String(m.stats.roastedWeek)),
          h('td', { class: 'num' }, minutes(m.stats.weekMin)),
          h('td', { class: 'num' }, String(m.stats.bombsThrownWeek)),
          h('td', { class: 'num' }, m.stats.streak ? `${m.stats.streak} d` : '–'),
        ),
      ),
    ),
  );
  out.push(
    h(
      'div',
      { class: 'section', id: 'board-sec' },
      h('h2', null, 'Most roasted this week'),
      h('p', { class: 'sub' }, 'Bombs that landed, yellow and red cards, and to-do roasts since Monday. Top of this board is not where you want to be.'),
      table,
    ),
  );

  // What's been happening.
  const feed = h('ul', { class: 'crew-feed' }, v.feed.slice(0, 15).map((f) => h('li', { 'data-kind': f.kind }, h('span', { class: 'when' }, clockTime(f.at)), h('span', null, f.text))));
  out.push(h('div', { class: 'section', id: 'feed-sec' }, h('h2', null, 'Crew feed'), v.feed.length ? feed : h('p', { class: 'muted' }, 'Nothing yet. Bombs, lock-ins and achievements show up here.')));
  return out;
}

function bombPicker(m: CrewMemberView, v: CrewView): HTMLElement {
  const note = h('p', { class: 'picker-note', 'aria-live': 'polite' });
  const custom = h('input', { type: 'text', maxLength: 140, placeholder: 'Or write your own (keep it loving)', value: aim.custom });
  const throwBtn = h('button', { class: 'btn throw-btn', type: 'button' }, `Throw it at ${m.name}`);
  const chips = h('div', { class: 'insults' });
  const pickText = () => custom.value.trim() || aim.preset;
  const sync = () => {
    throwBtn.disabled = !pickText();
    for (const c of chips.querySelectorAll('button')) c.setAttribute('aria-pressed', String(!custom.value.trim() && c.textContent === aim.preset));
  };
  for (const text of v.insults) {
    const c = h('button', { class: 'insult', type: 'button', 'aria-pressed': 'false' }, text);
    c.addEventListener('click', () => {
      aim.preset = text;
      aim.custom = '';
      custom.value = '';
      sync();
    });
    chips.append(c);
  }
  custom.addEventListener('input', () => {
    aim.custom = custom.value;
    sync();
  });
  throwBtn.addEventListener('click', async () => {
    const insult = pickText();
    if (!insult) return;
    throwBtn.disabled = true;
    throwBtn.textContent = 'Throwing…';
    const r = await api.invoke<CrewPayload & { ok: boolean; error?: string }>('crew:bomb', { to: m.id, insult });
    if (!r.ok) {
      note.textContent = r.error ?? "That didn't go through.";
      throwBtn.disabled = false;
      throwBtn.textContent = `Throw it at ${m.name}`;
      return;
    }
    aim.id = '';
    aim.preset = '';
    aim.custom = '';
    void renderFriends(r, true);
  });
  sync();
  return h(
    'li',
    { class: 'picker' },
    h('p', { class: 'picker-head' }, `Pick an insult for ${m.name}. Every distraction on their Mac locks for 5 minutes, their screen goes red for 5 seconds, and their coach reads it out. You have ${v.bombsLeft} left today.`),
    chips,
    h('div', { class: 'picker-row' }, custom, throwBtn),
    note,
  );
}

function achievementsSection(p: CrewPayload): HTMLElement {
  const got = p.achievements.filter((a) => a.unlockedAt).length;
  const grid = h(
    'ul',
    { class: 'badges' },
    p.achievements.map((a) =>
      h(
        'li',
        { class: `badge${a.unlockedAt ? ' got' : ''}`, title: a.unlockedAt ? `Unlocked ${new Date(a.unlockedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'Not yet' },
        h('b', null, a.name),
        h('span', null, a.desc),
      ),
    ),
  );
  return h(
    'div',
    { class: 'section', id: 'ach-sec' },
    h('h2', null, 'Achievements'),
    h('p', { class: 'sub' }, `${got} of ${p.achievements.length} unlocked. ${p.streak ? `You're on a ${p.streak}-day streak (25 focused minutes a day keeps it going).` : 'Lock in for 25 minutes today to start a streak.'}`),
    grid,
  );
}

function crewSettingsSection(v: CrewView): HTMLElement {
  const st: CrewSettings = settings?.crew ?? ({} as CrewSettings);
  const save = async (patch: Partial<CrewSettings>) => {
    const r = await api.invoke<CrewPayload>('crew:settings', patch);
    settings = await api.invoke<Settings>('settings:get');
    crewData = r;
  };
  const name = h('input', { type: 'text', value: st.name ?? '', maxLength: 32 });
  name.addEventListener('change', () => void save({ name: name.value.trim() || 'Me' }));
  const server = h('input', { type: 'text', value: st.server ?? 'https://ntfy.sh', placeholder: 'https://ntfy.sh' });
  server.addEventListener('change', () => void save({ server: server.value.trim() || 'https://ntfy.sh' }));
  const leave = h('button', { class: 'btn btn-small btn-quiet', type: 'button' }, `Leave ${v.crewName || 'the crew'}`);
  leave.addEventListener('click', async () => {
    if (leave.dataset.sure !== '1') {
      leave.dataset.sure = '1';
      leave.textContent = 'Click again to leave';
      return;
    }
    const r = await api.invoke<CrewPayload>('crew:leave');
    settings = await api.invoke<Settings>('settings:get');
    void renderFriends(r);
  });
  return h(
    'details',
    { class: 'section how crew-settings' },
    h('summary', null, 'Crew settings'),
    field('Your name', 'What your crew sees.', name),
    field('Share what I’m working on', 'Friends see your session goal while you’re locked in.', sw(st.shareGoal, (on) => void save({ shareGoal: on }), 'Share what I’m working on')),
    field('Share what’s distracting me', 'Friends see the site or app you’re drifting on (never private or sensitive ones). Makes for better bombs.', sw(st.shareDistraction, (on) => void save({ shareDistraction: on }), 'Share what’s distracting me')),
    field('Bombs take over my screen', 'Off: friends’ bombs arrive as a corner card instead. They’re always gentle in meetings, on calls, on mute and in quiet hours.', sw(st.bombsFullScreen, (on) => void save({ bombsFullScreen: on }), 'Bombs take over my screen')),
    field('Bombs lock my distractions', 'For 5 minutes after a bomb lands, distracting sites are blocked (with the browser extension) and distracting apps are hidden as soon as you open them.', sw(st.bombsLockout !== false, (on) => void save({ bombsLockout: on }), 'Bombs lock my distractions')),
    field('Relay', 'Any ntfy server. Everyone in the crew must use the same one.', server),
    field('Leave', null, leave),
  );
}

async function boot(): Promise<void> {
  // The opening animation, once per launch; the logo plays it again.
  void api.invoke<boolean>('intro:claim').then((play) => {
    if (play) void playIntro();
  });
  const brand = document.querySelector<HTMLElement>('.brand');
  brand?.addEventListener('click', () => void playIntro());
  brand?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void playIntro();
    }
  });
  [state, profile, settings] = await Promise.all([api.invoke<LiveState>('state:get'), api.invoke<Profile | null>('profile:get'), api.invoke<Settings>('settings:get')]);
  if (settings.look) applyLook(settings.look);
  document.body.classList.toggle('panel-mode', panelMode());
  renderRail();
  setTimeout(() => (booted = true), 0);
  if (route === 'quiz' || !profile) {
    route = 'home';
    go('home');
    void openQuiz();
  } else go(route);
}

void boot();
