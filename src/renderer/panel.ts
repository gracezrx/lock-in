// The menu bar panel: start a session, watch the one running, tick off to-dos, glance at today,
// goals and your crew. Everything else (setup, voices, routines) is in Settings.
import type { CrewMemberView, LiveState, PanelData, Task } from '../shared/types';
import { api, clear, clockTime, h, mmss } from './lib';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = $('panel');
const scroll = $('scroll');
const alertsBox = $('alerts');
const hero = $('hero');
const todayBox = $('today');
const todosBox = $('todos');
const goalsBox = $('goals');
const crewBox = $('crew');
const muteChip = $('muteChip');

let state: LiveState | null = null;
let data: PanelData | null = null;
let heroMode: 'idle' | 'live' | null = null;
let commitOpen = false;
let adding = false;
let bombing: string | null = null;
let note: { text: string; until: number } | null = null;
const ticked = new Set<string>();

const MINUTES = [25, 50, 90];
let minutes = (() => {
  try {
    const m = Number(localStorage.getItem('panel.minutes'));
    return MINUTES.includes(m) ? m : 50;
  } catch {
    return 50;
  }
})();

const ICON = {
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="5" y="10.5" width="14" height="10.5" rx="2.4" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5v9l7.5-4.5z"/></svg>',
  check: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};
const svg = (html: string) => {
  const s = h('span', { style: 'display:contents' });
  s.innerHTML = html;
  return s;
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const short = (t: string, n = 46) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

// ---- data -------------------------------------------------------------------------

async function refreshData(): Promise<void> {
  data = await api.invoke<PanelData>('panel:data');
  for (const id of [...ticked]) if (!data.todos.open.some((t) => t.id === id)) ticked.delete(id);
  renderLists();
}

let dataSig = '';
function onState(s: LiveState): void {
  state = s;
  const sig = JSON.stringify([s.todos.open, s.todos.doneToday, s.todos.top, s.todos.provider, s.todos.connected, s.goals, !!s.session, s.deadlines.pinned.length]);
  if (sig !== dataSig) {
    dataSig = sig;
    void refreshData();
  }
  renderTop();
  renderAlerts();
  renderHero();
  renderToday();
}

// ---- header and deadlines -------------------------------------------------------------

function renderTop(): void {
  const muted = state?.muteUntil;
  muteChip.hidden = !muted;
  if (muted) {
    muteChip.textContent = `Coach muted till ${clockTime(muted)}`;
    muteChip.title = 'Click to unmute';
  }
}

let alertsSig = '';
function renderAlerts(): void {
  const pinned = state?.deadlines.pinned.filter((d) => !d.done).slice(0, 2) ?? [];
  const lock = state?.lockout;
  const left = lock ? Math.max(0, Math.ceil((lock.until - Date.now()) / 1000)) : 0;
  const sig = JSON.stringify([pinned.map((d) => [d.id, d.overdue, d.title]), lock?.from, left]);
  if (sig === alertsSig) return;
  alertsSig = sig;
  clear(alertsBox);
  alertsBox.hidden = !pinned.length && !lock;
  // A friend's bomb: every distraction is locked for a few minutes.
  if (lock)
    alertsBox.append(
      h('div', { class: 'alert overdue lockout' },
        h('div', { class: 'what' }, h('span', { class: 'tag' }, `💣 Bomb from ${lock.from}`), h('span', { class: 'title' }, 'Every distraction is locked')),
        h('b', { class: 'left' }, mmss(left)),
      ),
    );
  for (const d of pinned) {
    alertsBox.append(
      h('div', { class: `alert${d.overdue ? ' overdue' : ''}` },
        h('div', { class: 'what' }, h('span', { class: 'tag' }, d.overdue ? 'Overdue' : d.time ? `Due today, ${d.time}` : 'Due today'), h('span', { class: 'title', title: d.title }, d.title)),
        h('div', { class: 'acts' },
          h('button', { class: 'btn-s accent', type: 'button', onclick: () => start(d.title) }, 'Lock in'),
          h('button', { class: 'btn-s ghost', type: 'button', title: 'Mark it done', onclick: () => void api.invoke('deadlines:done', d.id, true) }, 'Done'),
        ),
      ),
    );
  }
  measure();
}

// ---- hero ---------------------------------------------------------------------------

let goalInput: HTMLInputElement | null = null;
let ideasBox: HTMLElement | null = null;
let ctaBtn: HTMLButtonElement | null = null;

function renderHero(): void {
  const mode = state?.session ? 'live' : 'idle';
  if (mode !== heroMode) {
    heroMode = mode;
    commitOpen = false;
    clear(hero);
    hero.className = `hero${mode === 'live' ? ' live' : ''}`;
    if (mode === 'idle') buildIdle();
    else buildLive();
    measure();
  }
  if (mode === 'live') tickLive();
}

function buildIdle(): void {
  goalInput = h('input', {
    class: 'goal-in',
    type: 'text',
    placeholder: 'What are you working on?',
    value: state?.lastGoal && state.lastGoal !== 'Deep work' ? state.lastGoal : '',
    'aria-label': 'What are you locking in on',
    maxlength: 140,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') start();
    },
  });
  ideasBox = h('div', { class: 'ideas' });
  const mins = h('div', { class: 'mins', role: 'group', 'aria-label': 'How long' });
  const drawMins = () => {
    clear(mins);
    for (const m of MINUTES)
      mins.append(
        h('button', { type: 'button', 'aria-pressed': String(m === minutes), title: `${m} minutes`, onclick: () => {
          minutes = m;
          try {
            localStorage.setItem('panel.minutes', String(m));
          } catch {
            /* fine */
          }
          drawMins();
        } }, h('b', null, String(m)), h('small', null, 'min')),
      );
  };
  drawMins();
  ctaBtn = h('button', { class: 'cta', type: 'button', onclick: () => start() }, svg(ICON.lock), 'Lock in');
  hero.append(h('div', { class: 'label' }, 'Lock in on'), goalInput, ideasBox, h('div', { class: 'go' }, mins, ctaBtn));
  renderIdeas();
}

/** A few things to lock in on: the top to-dos (one tap fills the goal). */
function renderIdeas(): void {
  if (!ideasBox || !goalInput) return;
  clear(ideasBox);
  const typed = goalInput.value.trim().toLowerCase();
  // The to-do list below already has a lock-in button on every row: suggest only what isn't there.
  const listed = new Set((data?.todos.open ?? []).slice(0, 5).map((t) => t.title.toLowerCase()));
  const titles = (data?.todos.open ?? []).slice(5).map((t) => t.title).filter((t) => t.toLowerCase() !== typed).slice(0, 1);
  if (state?.lastGoal && state.lastGoal.toLowerCase() !== typed && !listed.has(state.lastGoal.toLowerCase()) && state.lastGoal !== 'Deep work') titles.unshift(state.lastGoal);
  for (const t of titles.slice(0, 2))
    ideasBox.append(h('button', { class: 'idea', type: 'button', title: t, onclick: () => {
      goalInput!.value = t;
      renderIdeas();
      goalInput!.focus();
    } }, h('b', null, '↳'), short(t, 34)));
  ideasBox.hidden = !ideasBox.childElementCount;
}

function start(goal?: string): void {
  const g = (goal ?? goalInput?.value ?? '').trim() || state?.todos.top || 'Deep work';
  if (ctaBtn) ctaBtn.disabled = true;
  void api.invoke('session:start', { goal: g, minutes }).then(() => setTimeout(() => void api.invoke('panel:hide'), 650));
}

const live: Record<string, HTMLElement> = {};

function buildLive(): void {
  live.state = h('span', { class: 'state' }, h('i'), h('span', null, 'Locked in'));
  live.round = h('small');
  live.goal = h('div', { class: 'live-goal' });
  live.clock = h('b');
  live.clockSub = h('span');
  live.fill = h('i');
  live.focus = h('b');
  live.drift = h('b');
  live.acts = h('div', { class: 'live-acts' });
  hero.append(
    h('div', { class: 'status' }, live.state, live.round),
    live.goal,
    h('div', { class: 'clock' }, live.clock, live.clockSub),
    h('div', { class: 'bar' }, live.fill),
    h('div', { class: 'tallies' }, h('span', null, live.focus, 'min focused'), h('span', null, live.drift, 'min drifting')),
    live.acts,
  );
  renderLiveActs();
}

let actsSig = '';
function renderLiveActs(): void {
  const muted = !!state?.muteUntil;
  const sig = `${muted}|${commitOpen}`;
  if (sig === actsSig && live.acts.childElementCount) return;
  actsSig = sig;
  clear(live.acts);
  if (commitOpen) {
    const phrase = 'I choose to stop';
    const input = h('input', { type: 'text', placeholder: `Type "${phrase}"`, 'aria-label': 'Confirm ending early' });
    const ok = h('button', { class: 'btn-s danger', type: 'button', disabled: true, onclick: () => end() }, 'End session');
    input.addEventListener('input', () => (ok.disabled = input.value.trim().toLowerCase() !== phrase.toLowerCase()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !ok.disabled) end();
    });
    const box = h('div', { class: 'commit' }, input, h('div', null, h('button', { class: 'btn-s ghost', type: 'button', onclick: () => {
      commitOpen = false;
      renderLiveActs();
      measure();
    } }, 'Keep going'), ok));
    live.acts.className = '';
    live.acts.append(box);
    setTimeout(() => input.focus(), 20);
    measure();
    return;
  }
  live.acts.className = 'live-acts';
  live.acts.append(
    h('button', { class: 'btn-s ghost', type: 'button', onclick: () => void api.invoke(muted ? 'unmute' : 'mute', 30) }, muted ? 'Unmute coach' : 'Mute 30 min'),
    h('button', { class: 'btn-s danger', type: 'button', onclick: () => {
      if (data?.commitment) {
        commitOpen = true;
        renderLiveActs();
      } else end();
    } }, 'End session'),
  );
}

function end(): void {
  commitOpen = false;
  void api.invoke('session:end');
}

function tickLive(): void {
  const s = state?.session;
  if (!s || !live.clock) return;
  const now = Date.now();
  const onBreak = !!s.onBreakUntil && s.onBreakUntil > now;
  const muted = !!state?.muteUntil;
  let tone = 'var(--good)';
  let glow = 'var(--good-soft)';
  let label = 'Locked in';
  if (onBreak) [tone, glow, label] = ['var(--warn)', 'var(--warn-soft)', 'On a break'];
  else if (s.level >= 3) [tone, glow, label] = ['var(--bad)', 'var(--bad-soft)', 'Drifting'];
  else if (s.level >= 1 || s.drift > s.driftThresholdSec * 0.1) [tone, glow, label] = ['var(--warn)', 'var(--warn-soft)', s.level >= 2 ? 'Drifting' : 'Wobbling'];
  hero.style.setProperty('--tone', tone);
  hero.style.setProperty('--glow', glow);
  (live.state.lastChild as HTMLElement).textContent = label;
  live.round.textContent = s.pomodoro ? `Round ${s.pomodoro.cycle} of ${s.pomodoro.cycles}` : muted ? 'Coach muted' : '';
  live.goal.textContent = s.goal || 'Deep work';
  live.goal.title = s.goal;
  if (onBreak) {
    live.clock.textContent = mmss((s.onBreakUntil! - now) / 1000);
    live.clockSub.textContent = 'of break left';
  } else {
    live.clock.textContent = mmss(s.plannedMin * 60 - s.elapsedSec);
    live.clockSub.textContent = s.pomodoro ? 'left in all rounds' : `left of ${s.plannedMin} min`;
  }
  live.fill.style.width = `${Math.min(100, (s.elapsedSec / (s.plannedMin * 60)) * 100).toFixed(1)}%`;
  live.focus.textContent = String(Math.round(s.focusSec / 60));
  live.drift.textContent = String(Math.round(s.driftSec / 60));
  renderLiveActs();
}

// ---- today ----------------------------------------------------------------------------

function renderToday(): void {
  if (!state || !data) return;
  const f = data.today.focusMin;
  const focus = f >= 60 ? [String(Math.floor(f / 60)), h('small', null, 'h'), ` ${f % 60}`, h('small', null, 'm')] : [String(f), h('small', null, 'm')];
  const td = state.todos;
  // Today in three numbers.
  const tiles: [unknown[], string][] = [[focus, 'Focused']];
  if (td.provider !== 'none' && td.connected) tiles.push([[String(td.doneToday), h('small', null, `/${td.doneToday + td.open}`)], 'To-dos done']);
  else tiles.push([[String(data.today.sessions)], data.today.sessions === 1 ? 'Session' : 'Sessions']);
  tiles.push(data.today.streak > 0 ? [[String(data.today.streak), h('small', null, 'd')], 'Streak'] : [[String(data.today.sessions)], data.today.sessions === 1 ? 'Session' : 'Sessions']);
  clear(todayBox);
  for (const [v, l] of tiles) todayBox.append(h('div', { class: 'tile' }, h('b', null, ...(v as (Node | string)[])), h('span', null, l)));
}

// ---- lists -----------------------------------------------------------------------------

function renderLists(): void {
  renderIdeas();
  renderToday();
  renderTodos();
  renderGoals();
  renderCrew();
  measure();
}

function head(title: string, meta?: string | Node | null, action?: Node | null): HTMLElement {
  return h('div', { class: 'block-head' }, h('div', { class: 'label' }, title, meta ? h('small', null, meta) : null), action ?? null);
}

function dueBadge(t: Task): Node | null {
  if (!t.due) return null;
  const d = today();
  if (t.due < d) return h('span', { class: 'due over' }, 'Overdue');
  if (t.due === d) return h('span', { class: 'due' }, 'Today');
  return null;
}

function renderTodos(): void {
  if (!state || !data) return;
  const td = state.todos;
  clear(todosBox);
  if (td.provider === 'none') {
    todosBox.append(head('Up next'), h('div', { class: 'rows' }, h('div', { class: 'empty' }, 'No to-do list yet. ', h('button', { type: 'button', onclick: () => void api.invoke('panel:open', 'todos') }, 'Connect one'), ' (Todoist, Things, Reminders, a sheet, or Lock In’s own).')));
    return;
  }
  if (!td.connected) {
    todosBox.append(head('Up next'), h('div', { class: 'rows' }, h('div', { class: 'empty' }, td.error ? `${short(td.error, 80)} ` : 'Your to-do list isn’t connected. ', h('button', { type: 'button', onclick: () => void api.invoke('panel:open', 'todos') }, 'Fix it'))));
    return;
  }
  const plus = data.todos.canAdd
    ? h('button', { class: 'icon-btn', type: 'button', title: 'Add a to-do', 'aria-label': 'Add a to-do', onclick: () => {
        adding = !adding;
        renderTodos();
        measure();
      } }, svg(ICON.plus))
    : null;
  todosBox.append(head('Up next', td.open ? `${td.open} to go` : null, plus));
  const rows = h('div', { class: 'rows' });
  const list = data.todos.open.slice(0, 5);
  for (const t of list) {
    const done = ticked.has(t.id);
    rows.append(
      h('div', { class: `row${done ? ' done' : ''}` },
        data.todos.canComplete
          ? h('button', { class: 'tick', type: 'button', title: 'Done', 'aria-label': `Mark "${t.title}" done`, onclick: () => tick(t) }, svg(ICON.check))
          : null,
        h('div', { class: 'grow' }, h('span', { class: 't', title: t.title }, t.title), t.project ? h('span', { class: 'sub' }, t.project) : null),
        dueBadge(t),
        h('button', { class: 'play', type: 'button', title: `Lock in on "${t.title}"`, 'aria-label': `Lock in on ${t.title}`, onclick: () => start(t.title) }, svg(ICON.play)),
      ),
    );
  }
  if (!list.length) rows.append(h('div', { class: 'empty' }, td.doneToday ? `All clear. ${td.doneToday} done today.` : 'Nothing on your list.'));
  if (adding) {
    const input = h('input', { type: 'text', placeholder: 'Add a to-do', 'aria-label': 'New to-do', maxlength: 300 });
    const save = async () => {
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      const r = await api.invoke<{ ok: boolean; error?: string }>('todos:add', title);
      if (!r.ok) flash(r.error ?? 'Couldn’t add it.');
      await refreshData();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
      if (e.key === 'Escape') {
        e.stopPropagation();
        adding = false;
        renderTodos();
        measure();
      }
    });
    rows.append(h('div', { class: 'add' }, input, h('button', { class: 'btn-s accent', type: 'button', onclick: () => void save() }, 'Add')));
    setTimeout(() => input.focus(), 10);
  }
  todosBox.append(rows);
}

async function tick(t: Task): Promise<void> {
  ticked.add(t.id);
  renderTodos();
  const r = await api.invoke<{ ok: boolean; error?: string }>('todos:complete', t.id);
  if (!r.ok) {
    ticked.delete(t.id);
    flash(r.error ?? 'Couldn’t tick it off.');
  }
  setTimeout(() => void refreshData(), 700);
}

function renderGoals(): void {
  if (!state || !data) return;
  const goals = data.goals;
  goalsBox.hidden = state.goals === false || !goals.length;
  clear(goalsBox);
  if (goalsBox.hidden) return;
  goalsBox.append(head('Goals', null, h('button', { class: 'icon-btn', type: 'button', title: 'All goals', 'aria-label': 'All goals', onclick: () => void api.invoke('panel:open', 'goals') }, svg(ICON.arrow))));
  const rows = h('div', { class: 'rows' });
  for (const g of goals) {
    const right = g.kind === 'custom' && g.daysLeft !== undefined ? `${g.daysLeft} ${g.daysLeft === 1 ? 'day' : 'days'} left` : g.progress;
    const water = g.kind === 'water'
      ? h('button', { class: 'btn-s ghost plus', type: 'button', title: 'Drank a glass of water', onclick: async () => {
          await api.invoke('goals:water');
          await refreshData();
        } }, '+1 💧')
      : null;
    rows.append(
      h('div', { class: `row goal-row ${g.tone}` },
        h('span', { class: 't grow', title: g.name }, g.name),
        g.pct !== null ? h('span', { class: 'gbar' }, h('i', { style: `width:${Math.round(Math.min(1, Math.max(0, g.pct)) * 100)}%` })) : null,
        h('span', { class: 'p' }, right),
        water,
      ),
    );
  }
  goalsBox.append(rows);
}

const STATE: Record<CrewMemberView['state'], string> = { locked: 'Locked in', break: 'On a break', drifting: 'Drifting', free: 'Free', meeting: 'In a meeting', away: 'Away', offline: 'Offline' };

function renderCrew(): void {
  const c = data?.crew;
  crewBox.hidden = !c;
  clear(crewBox);
  if (!c) return;
  const others = c.members.filter((m) => !m.me);
  const dots = h('span', { class: 'bombs', title: `${c.bombsLeft} of ${c.bombsPerDay} bombs left today` }, Array.from({ length: c.bombsPerDay }, (_x, i) => h('i', { class: i < c.bombsLeft ? 'on' : '' })));
  crewBox.append(head(c.crewName || 'Crew', null, dots));
  const rows = h('div', { class: 'rows' });
  for (const m of others) {
    const detail = m.state === 'locked' && m.goal ? m.goal : m.state === 'drifting' && m.distraction ? `on ${m.distraction}` : m.state === 'offline' ? 'offline' : '';
    const canBomb = m.bombable && c.bombsLeft > 0;
    rows.append(
      h('div', { class: 'row' },
        h('span', { class: `av ${m.state}` }, (m.name[0] ?? '?').toUpperCase()),
        h('div', { class: 'grow' }, h('span', { class: 't' }, m.name), h('span', { class: 'sub' }, [STATE[m.state], detail].filter(Boolean).join(' · '))),
        canBomb ? h('button', { class: 'btn-s danger', type: 'button', onclick: () => {
          bombing = bombing === m.id ? null : m.id;
          renderCrew();
          measure();
        } }, bombing === m.id ? 'Cancel' : 'Bomb') : null,
      ),
    );
    if (bombing === m.id && canBomb) {
      rows.append(
        h('div', { class: 'insults' },
          h('p', { class: 'hint' }, `Locks ${m.name}’s distractions for 5 minutes and their screen for 5 seconds. Pick a line:`),
          c.insults.slice(0, 5).map((t) => h('button', { type: 'button', onclick: () => void bomb(m, t) }, t)),
        ),
      );
    }
  }
  if (!others.length) rows.append(h('div', { class: 'empty' }, 'Just you so far. ', h('button', { type: 'button', onclick: () => void api.invoke('panel:open', 'friends') }, 'Invite someone')));
  crewBox.append(rows);
}

async function bomb(m: CrewMemberView, insult: string): Promise<void> {
  bombing = null;
  const r = await api.invoke<{ ok: boolean; error?: string; view: PanelData['crew'] }>('crew:bomb', { to: m.id, insult });
  flash(r.ok ? `💣 Bomb thrown at ${m.name}.` : r.error ?? 'It didn’t go.');
  if (data && r.view) data.crew = r.view.joined ? r.view : null;
  renderCrew();
  measure();
}

/** A one-line note at the top of the lists, for a few seconds. */
function flash(text: string): void {
  note = { text, until: Date.now() + 3500 };
  let el = document.getElementById('note');
  if (!el) {
    el = h('div', { class: 'toast-line', id: 'note' });
    scroll.insertBefore(el, todayBox);
  }
  el.textContent = text;
  measure();
  setTimeout(() => {
    if (note && Date.now() >= note.until) {
      note = null;
      document.getElementById('note')?.remove();
      measure();
    }
  }, 3600);
}

// ---- size, keys, buttons -------------------------------------------------------------

let lastHeight = 0;
let measureQueued = false;
/** Tell the window how tall the card wants to be (it's capped to the screen). */
function measure(): void {
  if (measureQueued) return;
  measureQueued = true;
  requestAnimationFrame(() => {
    measureQueued = false;
    const top = panel.querySelector('.top') as HTMLElement;
    const foot = panel.querySelector('.foot') as HTMLElement;
    const want = Math.ceil(top.offsetHeight + scroll.scrollHeight + foot.offsetHeight + 2);
    if (Math.abs(want - lastHeight) < 2) return;
    lastHeight = want;
    void api.invoke('panel:resize', want);
  });
}
new ResizeObserver(() => measure()).observe(scroll);

muteChip.addEventListener('click', () => void api.invoke('unmute'));
$('settingsBtn').addEventListener('click', () => void api.invoke('panel:open', 'settings'));
$('talkBtn').addEventListener('click', () => {
  void api.invoke('panel:hide');
  void api.invoke('talk:open', 'checkin');
});
$('quitBtn').addEventListener('click', () => void api.invoke('app:quit'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (commitOpen) {
      commitOpen = false;
      renderLiveActs();
      return;
    }
    void api.invoke('panel:hide');
  }
  if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void api.invoke('panel:open', 'settings');
  }
});

api.on('state', (s) => onState(s as LiveState));
api.on('crew:update', (p) => {
  const v = (p as { view?: PanelData['crew'] }).view;
  if (data && v) {
    data.crew = v.joined ? v : null;
    renderCrew();
    measure();
  }
});
api.on('panel:shown', () => {
  panel.classList.remove('in');
  void panel.offsetWidth;
  panel.classList.add('in');
  bombing = null;
  void api.invoke<LiveState>('state:get').then(onState);
  void refreshData();
  if (heroMode === 'idle' && goalInput) setTimeout(() => goalInput?.focus(), 30);
});

// Lists change slowly; keep them fresh while the panel is up.
setInterval(() => {
  if (document.visibilityState === 'visible') void refreshData();
}, 30_000);

void (async () => {
  onState(await api.invoke<LiveState>('state:get'));
  await refreshData();
})();
