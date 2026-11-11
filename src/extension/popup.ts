// Lock In Extended's control panel (the toolbar icon). One panel whether it's linked to Lock In
// for Mac (then it drives the Mac's session, to-dos, goals and crew) or running on its own.
import type { CrewMemberView, Persona, Role } from '../shared/types';
import { ROLE_ORDER, ROLE_TEMPLATES } from '../shared/templates';
import { h, clear, mmss, clockTime } from '../renderer/lib';
import type { Action, ExtSettings, PanelGoal, PanelTodo, PanelView } from './lib/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const mainBox = $('main');
const settingsBox = $('settings');
const alertsBox = $('alerts');
const hero = $('hero');
const siteBox = $('site');
const todayBox = $('today');
const todosBox = $('todos');
const goalsBox = $('goals');
const crewBox = $('crew');
const foot = $('foot');
const muteChip = $<HTMLButtonElement>('muteChip');
const linkChip = $('linkChip');

let view: PanelView | null = null;
/** When `view` arrived, so the clock can tick between updates. */
let viewAt = 0;
let page: 'main' | 'settings' = 'main';
let heroMode = '';
let commitOpen = false;
let adding = false;
let addingGoal = false;
let bombing: string | null = null;
let crewForm: 'create' | 'join' | null = null;
const ticked = new Set<string>();

const MINUTES = [25, 50, 90];
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* fine */
    }
  },
};
let minutes = MINUTES.includes(Number(store.get('minutes'))) ? Number(store.get('minutes')) : 50;

const ICON = {
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" stroke-width="2.4"/><rect x="5" y="10.5" width="14" height="10.5" rx="2.4" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.5v9l7.5-4.5z"/></svg>',
  check: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};
const svg = (html: string) => {
  const s = h('span', { style: 'display:contents' });
  s.innerHTML = html;
  return s;
};
const short = (t: string, n = 46) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const PERSONAS: { id: Persona; name: string; desc: string }[] = [
  { id: 'sassy', name: 'Sassy best friend', desc: 'Dry, dramatic, secretly on your side.' },
  { id: 'gentle', name: 'Gentle friend', desc: 'Warm and quiet. Never shouts.' },
  { id: 'firm', name: 'Firm coach', desc: 'Short sentences. No small talk.' },
  { id: 'drill', name: 'Drill sergeant', desc: 'Loud, fast, relentless.' },
];

// ---- talking to the service worker -----------------------------------------------------

function send<T>(msg: object): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r: T) => {
        void chrome.runtime.lastError;
        resolve(r);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function refresh(poll = false): Promise<void> {
  const v = await send<PanelView>({ type: 'panel', poll });
  if (v) apply(v);
}

async function act(action: Action, quiet = false): Promise<boolean> {
  const r = await send<{ ok: boolean; error?: string; view: PanelView }>({ type: 'act', action });
  if (r?.view) apply(r.view);
  if (!r) {
    flash('Lock In Extended didn’t answer. Try again.', true);
    return false;
  }
  if (!r.ok && !quiet) flash(r.error ?? 'That didn’t work.', true);
  return r.ok;
}

let sig = '';
function apply(v: PanelView): void {
  view = v;
  viewAt = Date.now();
  for (const id of [...ticked]) if (!v.todos.open.some((t) => t.id === id)) ticked.delete(id);
  renderTop();
  renderFoot();
  if (page === 'settings') {
    renderSettings();
    return;
  }
  renderAlerts();
  renderHero();
  // Lists only when they changed, and never under someone typing.
  const next = JSON.stringify([v.mode, v.current, v.today, v.todos, v.goals, v.crew && { ...v.crew, feed: undefined }, v.settings.onboarded, [...ticked]]);
  if (next !== sig) {
    sig = next;
    renderLists();
  }
}

// ---- header and footer ---------------------------------------------------------------------

function renderTop(): void {
  if (!view) return;
  const muted = view.muteUntil;
  muteChip.hidden = !muted || page === 'settings';
  if (muted) muteChip.textContent = `Muted till ${clockTime(muted)}`;
  clear(linkChip);
  const linked = view.mode === 'linked';
  linkChip.className = `chip link${linked ? ' on' : ''}`;
  linkChip.append(h('i'), linked ? 'Mac' : 'Chrome');
  linkChip.title = linked
    ? 'Linked to Lock In for Mac: the same you, your crew, to-dos and goals. The Mac does the coaching.'
    : view.desktop.connected
      ? 'Lock In for Mac is open but needs an update to link up.'
      : 'Running on its own in Chrome. Open Lock In for Mac and it links up by itself.';
  $('backBtn').hidden = page !== 'settings';
  foot.hidden = page === 'settings';
  $('settingsBtn').hidden = page === 'settings';
  $('brandText').textContent = page === 'settings' ? 'Settings' : 'Lock In';
  mainBox.hidden = page !== 'main';
  settingsBox.hidden = page !== 'settings';
}

let footSig = '';
function renderFoot(): void {
  if (!view) return;
  const linked = view.mode === 'linked';
  const s = `${linked}|${view.desktop.connected}`;
  if (s === footSig) return;
  footSig = s;
  clear(foot);
  if (linked) {
    foot.append(
      h('button', { class: 'talk', type: 'button', onclick: () => void act({ a: 'mac:talk' }).then(() => window.close()) }, svg(ICON.mic), h('span', null, 'Talk to Lock In')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Open Lock In for Mac', 'aria-label': 'Open Lock In for Mac', onclick: () => void act({ a: 'mac:open', route: 'settings' }) }, svg(ICON.open)),
    );
  } else {
    foot.append(
      h('div', { class: 'foot-note' }, h('b', null, 'Coaching in Chrome.'), view.desktop.connected ? ' Lock In for Mac is open but too old to link: update it.' : ' Open Lock In for Mac and this links up to it, as you.'),
    );
  }
}

// ---- alerts ---------------------------------------------------------------------------------

let alertsSig = '';
function renderAlerts(): void {
  if (!view) return;
  const lock = view.lockout && view.lockout.until > Date.now() ? view.lockout : undefined;
  const left = lock ? Math.max(0, Math.ceil((lock.until - Date.now()) / 1000)) : 0;
  const meet = view.meeting?.now;
  const s = JSON.stringify([lock?.from, left, meet]);
  if (s === alertsSig) return;
  alertsSig = s;
  clear(alertsBox);
  alertsBox.hidden = !lock && !meet;
  if (lock)
    alertsBox.append(
      h('div', { class: 'alert red' },
        h('div', { class: 'what' }, h('span', { class: 'tag' }, `💣 Bomb from ${lock.from}`), h('span', { class: 'title' }, 'Every distraction is locked')),
        h('b', { class: 'left' }, mmss(left)),
      ),
    );
  if (meet)
    alertsBox.append(
      h('div', { class: 'alert' },
        h('div', { class: 'what' }, h('span', { class: 'tag' }, 'In a meeting'), h('span', { class: 'title', title: meet }, meet)),
        h('span', { class: 'muted' }, 'Coach is quiet'),
      ),
    );
}

// ---- hero -----------------------------------------------------------------------------------

let goalInput: HTMLInputElement | null = null;
let ideasBox: HTMLElement | null = null;

function renderHero(): void {
  if (!view) return;
  const mode = view.session ? 'live' : view.mode === 'solo' && !view.settings.onboarded ? 'hello' : 'idle';
  if (mode !== heroMode) {
    heroMode = mode;
    commitOpen = false;
    clear(hero);
    hero.className = `hero${mode === 'live' ? ' live' : ''}${mode === 'hello' ? ' hello' : ''}`;
    if (mode === 'idle') buildIdle();
    else if (mode === 'live') buildLive();
    else buildHello();
  }
  if (mode === 'live') tickLive();
}

function buildHello(): void {
  const st = view!.settings;
  let persona: Persona = st.persona;
  const name = h('input', { class: 'text-in', type: 'text', placeholder: 'Your first name', value: st.name, maxlength: 32, 'aria-label': 'Your first name' });
  const grid = h('div', { class: 'personas' });
  const drawP = () => {
    clear(grid);
    for (const p of PERSONAS)
      grid.append(h('button', { class: 'persona', type: 'button', 'aria-pressed': String(p.id === persona), onclick: () => {
        persona = p.id;
        drawP();
      } }, h('b', null, p.name), h('small', null, p.desc)));
  };
  drawP();
  const role = roleSelect(st.role);
  hero.append(
    h('h2', null, 'Hi. I’m your coach.'),
    h('p', null, 'Start a session and I watch your tabs. Drift to a distraction and I nudge, then talk, then shout, then lock it.'),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Call you'), name),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Your coach'), grid),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'What you do'), role),
    h('button', { class: 'cta', type: 'button', onclick: async () => {
      await act({ a: 'settings', patch: { name: name.value.trim().slice(0, 32), persona, role: role.value as Role, onboarded: true } });
    } }, svg(ICON.lock), 'Let’s go'),
  );
  setTimeout(() => name.focus(), 30);
}

function roleSelect(current: Role): HTMLSelectElement {
  const sel = h('select', { class: 'sel', 'aria-label': 'What you do' });
  for (const r of ROLE_ORDER) sel.append(h('option', { value: r, selected: r === current }, ROLE_TEMPLATES[r].label));
  return sel;
}

function buildIdle(): void {
  goalInput = h('input', {
    class: 'goal-in',
    type: 'text',
    placeholder: 'What are you working on?',
    value: view?.lastGoal && view.lastGoal !== 'Deep work' ? view.lastGoal : '',
    'aria-label': 'What are you locking in on',
    maxlength: 140,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') start();
    },
    oninput: () => renderIdeas(),
  });
  ideasBox = h('div', { class: 'ideas' });
  const mins = h('div', { class: 'mins', role: 'group', 'aria-label': 'How long' });
  const drawMins = () => {
    clear(mins);
    for (const m of MINUTES)
      mins.append(
        h('button', { type: 'button', 'aria-pressed': String(m === minutes), title: `${m} minutes`, onclick: () => {
          minutes = m;
          store.set('minutes', String(m));
          drawMins();
        } }, h('b', null, String(m)), h('small', null, 'min')),
      );
  };
  drawMins();
  hero.append(h('div', { class: 'label' }, 'Lock in on'), goalInput, ideasBox, h('div', { class: 'go' }, mins, h('button', { class: 'cta', id: 'cta', type: 'button', onclick: () => start() }, svg(ICON.lock), 'Lock in')));
  renderIdeas();
  setTimeout(() => goalInput?.focus(), 30);
}

/** A couple of things to lock in on: the last goal, and to-dos past the five listed below. */
function renderIdeas(): void {
  if (!ideasBox || !goalInput || !view) return;
  clear(ideasBox);
  const typed = goalInput.value.trim().toLowerCase();
  const open = view.todos.open;
  const listed = new Set(open.slice(0, 5).map((t) => t.title.toLowerCase()));
  const titles = open.slice(5).map((t) => t.title).filter((t) => t.toLowerCase() !== typed).slice(0, 1);
  const last = view.lastGoal;
  if (last && last !== 'Deep work' && last.toLowerCase() !== typed && !listed.has(last.toLowerCase())) titles.unshift(last);
  for (const t of titles.slice(0, 2))
    ideasBox.append(h('button', { class: 'idea', type: 'button', title: t, onclick: () => {
      goalInput!.value = t;
      renderIdeas();
      goalInput!.focus();
    } }, h('b', null, '↳'), short(t, 34)));
  ideasBox.hidden = !ideasBox.childElementCount;
}

async function start(goal?: string): Promise<void> {
  const g = (goal ?? goalInput?.value ?? '').trim() || view?.todos.open[0]?.title || 'Deep work';
  const cta = document.getElementById('cta') as HTMLButtonElement | null;
  if (cta) cta.disabled = true;
  const ok = await act({ a: 'start', goal: g, minutes });
  if (ok) setTimeout(() => window.close(), 700);
  else if (cta) cta.disabled = false;
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
  live.patience = h('i');
  live.patienceText = h('span');
  live.acts = h('div', { class: 'live-acts' });
  hero.append(
    h('div', { class: 'status' }, live.state, live.round),
    live.goal,
    h('div', { class: 'clock' }, live.clock, live.clockSub),
    h('div', { class: 'bar' }, live.fill),
    h('div', { class: 'tallies' }, h('span', null, live.focus, 'min focused'), h('span', null, live.drift, 'min drifting')),
    h('div', { class: 'patience', title: 'How close the coach is to stepping in' }, live.patienceText, h('div', { class: 'track' }, live.patience)),
    live.acts,
  );
  actsSig = '';
}

let actsSig = '';
function renderLiveActs(): void {
  if (!view?.session) return;
  const muted = !!view.muteUntil;
  const onBreak = !!view.session.onBreakUntil && view.session.onBreakUntil > Date.now();
  const s = `${muted}|${commitOpen}|${onBreak}`;
  if (s === actsSig) return;
  actsSig = s;
  clear(live.acts);
  if (commitOpen) {
    const phrase = 'I choose to stop';
    const input = h('input', { type: 'text', placeholder: `Type "${phrase}"`, 'aria-label': 'Confirm ending early' });
    const ok = h('button', { class: 'btn-s danger', type: 'button', disabled: true, onclick: () => end() }, 'End session');
    input.addEventListener('input', () => (ok.disabled = input.value.trim().toLowerCase() !== phrase.toLowerCase()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !ok.disabled) end();
    });
    live.acts.className = 'commit';
    live.acts.append(input, h('div', null, h('button', { class: 'btn-s ghost', type: 'button', onclick: () => {
      commitOpen = false;
      renderLiveActs();
    } }, 'Keep going'), ok));
    setTimeout(() => input.focus(), 20);
    return;
  }
  live.acts.className = 'live-acts';
  if (!onBreak) live.acts.append(h('button', { class: 'btn-s ghost', type: 'button', title: 'A 5-minute break: distractions allowed', onclick: () => void act({ a: 'break', minutes: 5 }) }, 'Take 5'));
  live.acts.append(
    h('button', { class: 'btn-s ghost', type: 'button', onclick: () => void act(muted ? { a: 'unmute' } : { a: 'mute', minutes: 30 }) }, muted ? 'Unmute' : 'Mute 30m'),
    h('button', { class: 'btn-s danger', type: 'button', onclick: () => {
      if (view?.commitment) {
        commitOpen = true;
        renderLiveActs();
      } else end();
    } }, 'End'),
  );
}

function end(): void {
  commitOpen = false;
  void act({ a: 'end' });
}

function tickLive(): void {
  const s = view?.session;
  if (!s || !live.clock) return;
  const now = Date.now();
  const elapsed = s.elapsedSec + (now - viewAt) / 1000;
  const onBreak = !!s.onBreakUntil && s.onBreakUntil > now;
  let tone = 'var(--good)';
  let glow = 'var(--good-soft)';
  let label = 'Locked in';
  if (onBreak) [tone, glow, label] = ['var(--warn)', 'var(--warn-soft)', 'On a break'];
  else if (s.status === 'away') [tone, glow, label] = ['var(--text-3)', 'transparent', 'Away'];
  else if (s.level >= 3) [tone, glow, label] = ['var(--bad)', 'var(--bad-soft)', 'Drifting'];
  else if (s.level >= 1 || s.status === 'drifting' || s.drift > 0.1) [tone, glow, label] = ['var(--warn)', 'var(--warn-soft)', s.level >= 2 ? 'Drifting' : 'Wobbling'];
  hero.style.setProperty('--tone', tone);
  hero.style.setProperty('--glow', glow);
  (live.state.lastChild as HTMLElement).textContent = label;
  live.round.textContent = s.where && !onBreak ? `on ${s.where}` : view?.muteUntil ? 'Coach muted' : '';
  live.goal.textContent = s.goal || 'Deep work';
  live.goal.title = s.goal;
  if (onBreak) {
    live.clock.textContent = mmss((s.onBreakUntil! - now) / 1000);
    live.clockSub.textContent = 'of break left';
  } else {
    live.clock.textContent = mmss(s.plannedMin * 60 - elapsed);
    live.clockSub.textContent = `left of ${s.plannedMin} min`;
  }
  live.fill.style.width = `${Math.min(100, (elapsed / (s.plannedMin * 60)) * 100).toFixed(1)}%`;
  live.focus.textContent = String(Math.round(s.focusSec / 60));
  live.drift.textContent = String(Math.round(s.driftSec / 60));
  live.patience.style.width = `${Math.round(s.drift * 100)}%`;
  live.patienceText.textContent = s.level > 0 ? `Coach stepped in (level ${s.level})` : s.drift > 0.05 ? 'Coach is watching' : 'All good';
  renderLiveActs();
}

// ---- this site, today, lists -------------------------------------------------------------

function renderLists(): void {
  renderSite();
  renderToday();
  if (!todosBox.contains(document.activeElement)) renderTodos();
  if (!goalsBox.contains(document.activeElement)) renderGoals();
  if (!crewBox.contains(document.activeElement)) renderCrew();
  renderIdeas();
}

function renderSite(): void {
  const c = view?.current;
  siteBox.hidden = !c?.domain;
  clear(siteBox);
  if (!c?.domain) return;
  const seg = h('div', { class: 'seg3', role: 'group', 'aria-label': `What ${c.domain} is` });
  for (const [id, name] of [['work', 'Work'], ['neutral', 'Neutral'], ['distraction', 'Distraction']] as const)
    seg.append(h('button', { class: id, type: 'button', 'aria-pressed': String(c.label === id), onclick: () => void act({ a: 'label', label: id }) }, name));
  siteBox.append(h('div', { class: 'where' }, h('span', { class: 'label' }, 'This site'), h('b', { title: c.domain }, c.domain)), seg);
}

function renderToday(): void {
  if (!view) return;
  const f = view.today.focusMin;
  const focus = f >= 60 ? [String(Math.floor(f / 60)), h('small', null, 'h'), ` ${f % 60}`, h('small', null, 'm')] : [String(f), h('small', null, 'm')];
  const tiles: [(Node | string)[], string][] = [
    [focus, 'Focused today'],
    [[String(view.today.sessions)], view.today.sessions === 1 ? 'Session' : 'Sessions'],
    [[String(view.today.streak), h('small', null, 'd')], 'Streak'],
  ];
  clear(todayBox);
  for (const [v, l] of tiles) todayBox.append(h('div', { class: 'tile' }, h('b', null, ...v), h('span', null, l)));
}

function head(title: string, meta?: string | Node | null, action?: Node | null): HTMLElement {
  return h('div', { class: 'block-head' }, h('div', { class: 'label' }, title, meta ? h('small', null, meta) : null), action ?? null);
}

function dueBadge(t: PanelTodo): Node | null {
  if (!t.due) return null;
  const d = todayKey();
  if (t.due < d) return h('span', { class: 'due over' }, 'Overdue');
  if (t.due === d) return h('span', { class: 'due' }, 'Today');
  return null;
}

function renderTodos(): void {
  if (!view) return;
  const td = view.todos;
  clear(todosBox);
  const plus = td.canAdd
    ? h('button', { class: 'icon-btn', type: 'button', title: 'Add a to-do', 'aria-label': 'Add a to-do', onclick: () => {
        adding = !adding;
        renderTodos();
      } }, svg(ICON.plus))
    : null;
  todosBox.append(head('Up next', td.open.length ? `${td.open.length} to go${view.mode === 'linked' ? ' · from your Mac' : ''}` : null, plus));
  const rows = h('div', { class: 'rows' });
  const solo = view.mode === 'solo';
  for (const t of td.open.slice(0, 6)) {
    const done = ticked.has(t.id);
    rows.append(
      h('div', { class: `row${done ? ' done' : ''}` },
        td.canComplete ? h('button', { class: 'tick', type: 'button', title: 'Done', 'aria-label': `Mark "${t.title}" done`, onclick: () => void tick(t) }, svg(ICON.check)) : null,
        h('div', { class: 'grow' }, h('span', { class: 't', title: t.title }, t.title)),
        dueBadge(t),
        solo && !t.mac ? h('button', { class: 'x', type: 'button', title: 'Remove', 'aria-label': `Remove "${t.title}"`, onclick: () => void act({ a: 'todo:remove', id: t.id }) }, '×') : null,
        h('button', { class: 'play', type: 'button', title: `Lock in on "${t.title}"`, 'aria-label': `Lock in on ${t.title}`, onclick: () => void start(t.title) }, svg(ICON.play)),
      ),
    );
  }
  for (const t of td.done.slice(0, 3))
    rows.append(
      h('div', { class: 'row done' },
        h('button', { class: 'tick', type: 'button', title: 'Not done', 'aria-label': `Mark "${t.title}" not done`, onclick: () => void act({ a: 'todo:undo', id: t.id }) }, svg(ICON.check)),
        h('div', { class: 'grow' }, h('span', { class: 't', title: t.title }, t.title)),
      ),
    );
  if (!td.open.length && !td.done.length && !adding)
    rows.append(h('div', { class: 'empty' }, 'Nothing on your list. ', td.canAdd ? h('button', { type: 'button', onclick: () => {
      adding = true;
      renderTodos();
    } }, 'Add one') : null));
  else if (!td.open.length && !adding) rows.append(h('div', { class: 'empty' }, 'All clear.'));
  if (adding) {
    const input = h('input', { type: 'text', placeholder: 'Add a to-do', 'aria-label': 'New to-do', maxlength: 200 });
    const save = async () => {
      const title = input.value.trim();
      if (!title) return;
      input.value = '';
      await act({ a: 'todo:add', title });
      input.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
      if (e.key === 'Escape') {
        e.preventDefault();
        adding = false;
        renderTodos();
      }
    });
    rows.append(h('div', { class: 'add' }, input, h('button', { class: 'btn-s accent', type: 'button', onclick: () => void save() }, 'Add')));
    setTimeout(() => input.focus(), 10);
  }
  todosBox.append(rows);
}

async function tick(t: PanelTodo): Promise<void> {
  ticked.add(t.id);
  renderTodos();
  const ok = await act({ a: 'todo:done', id: t.id }, true);
  if (!ok) {
    ticked.delete(t.id);
    flash('Couldn’t tick it off.', true);
    renderTodos();
  }
}

function renderGoals(): void {
  if (!view) return;
  const goals = view.goals;
  clear(goalsBox);
  goalsBox.append(head('Goals', null, h('button', { class: 'icon-btn', type: 'button', title: 'Add a goal', 'aria-label': 'Add a goal', onclick: () => {
    addingGoal = !addingGoal;
    renderGoals();
  } }, svg(ICON.plus))));
  const rows = h('div', { class: 'rows' });
  for (const g of goals) rows.append(goalRow(g));
  if (!goals.length && !addingGoal) rows.append(h('div', { class: 'empty' }, 'No goals yet. ', h('button', { type: 'button', onclick: () => {
    addingGoal = true;
    renderGoals();
  } }, 'Add a deadline'), ' and I’ll count it down.'));
  if (addingGoal) {
    const name = h('input', { type: 'text', placeholder: 'Ship the deck', 'aria-label': 'Goal', maxlength: 120 });
    const due = h('input', { type: 'date', 'aria-label': 'Due', min: todayKey() });
    const save = async () => {
      if (!name.value.trim()) return;
      await act({ a: 'goal:add', name: name.value.trim(), due: due.value || undefined });
      addingGoal = false;
      renderGoals();
    };
    for (const el of [name, due])
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void save();
        if (e.key === 'Escape') {
          e.preventDefault();
          addingGoal = false;
          renderGoals();
        }
      });
    rows.append(h('div', { class: 'add' }, name, due, h('button', { class: 'btn-s accent', type: 'button', onclick: () => void save() }, 'Add')));
    setTimeout(() => name.focus(), 10);
  }
  goalsBox.append(rows);
}

function goalRow(g: PanelGoal): HTMLElement {
  const right = g.daysLeft !== undefined ? (g.daysLeft < 0 ? 'Past due' : g.daysLeft === 0 ? 'Today' : `${g.daysLeft} ${g.daysLeft === 1 ? 'day' : 'days'}`) : (g.progress ?? '');
  const soon = g.daysLeft !== undefined && g.daysLeft <= 2;
  return h('div', { class: `row goal-row${g.tone ? ` tone-${g.tone}` : ''}${soon ? ' soon' : ''}` },
    h('span', { class: 't grow', title: g.name }, g.name),
    typeof g.pct === 'number' ? h('span', { class: 'gbar' }, h('i', { style: `width:${Math.round(Math.min(1, Math.max(0, g.pct)) * 100)}%` })) : null,
    h('span', { class: 'p' }, right),
    g.water ? h('button', { class: 'btn-s ghost plus', type: 'button', title: 'Drank a glass of water', onclick: () => void act({ a: 'goal:water' }) }, '+1 💧') : null,
    g.own ? h('button', { class: 'x', type: 'button', title: 'Remove', 'aria-label': `Remove "${g.name}"`, onclick: () => void act({ a: 'goal:remove', id: g.id }) }, '×') : null,
  );
}

const STATE: Record<CrewMemberView['state'], string> = { locked: 'Locked in', break: 'On a break', drifting: 'Drifting', free: 'Free', meeting: 'In a meeting', away: 'Away', offline: 'Offline' };

function renderCrew(): void {
  if (!view) return;
  const c = view.crew;
  clear(crewBox);
  if (!c) {
    crewBox.append(head('Friends'));
    const card = h('div', { class: 'rows' });
    card.append(
      h('div', { class: 'door' },
        h('p', null, 'Lock in with friends. See who’s focused, and bomb whoever drifts: their distractions lock for 5 minutes.'),
        crewForm ? null : h('div', { class: 'acts' },
          h('button', { class: 'btn-s accent', type: 'button', onclick: () => openCrewForm('create') }, 'Start a crew'),
          h('button', { class: 'btn-s ghost', type: 'button', onclick: () => openCrewForm('join') }, 'Join with a code'),
        ),
      ),
    );
    if (crewForm) card.append(crewFormEl(crewForm));
    crewBox.append(card);
    return;
  }
  const others = c.members.filter((m) => !m.me);
  const dots = h('span', { class: 'bombs', title: `${c.bombsLeft} of ${c.bombsPerDay} bombs left today` }, Array.from({ length: c.bombsPerDay }, (_x, i) => h('i', { class: i < c.bombsLeft ? 'on' : '' })));
  crewBox.append(head(c.crewName || 'Crew', c.connected ? null : 'offline', dots));
  const rows = h('div', { class: 'rows' });
  for (const m of others) {
    const detail = m.state === 'locked' && m.goal ? m.goal : m.state === 'drifting' && m.distraction ? `on ${m.distraction}` : '';
    const canBomb = m.bombable && c.bombsLeft > 0;
    rows.append(
      h('div', { class: 'row' },
        h('span', { class: `av ${m.state}` }, (m.name[0] ?? '?').toUpperCase()),
        h('div', { class: 'grow' }, h('span', { class: 't' }, m.name), h('span', { class: 'sub' }, [STATE[m.state], detail].filter(Boolean).join(' · '))),
        canBomb ? h('button', { class: 'btn-s danger', type: 'button', onclick: () => {
          bombing = bombing === m.id ? null : m.id;
          renderCrew();
        } }, bombing === m.id ? 'Cancel' : 'Bomb') : null,
      ),
    );
    if (bombing === m.id && canBomb)
      rows.append(
        h('div', { class: 'insults' },
          h('p', { class: 'hint' }, `Locks ${m.name}’s distractions for 5 minutes. Pick a line:`),
          c.insults.slice(0, 5).map((t) => h('button', { type: 'button', onclick: () => void bomb(m, t) }, t)),
        ),
      );
  }
  if (!others.length) rows.append(h('div', { class: 'empty' }, 'Just you so far. Send your friends the code below.'));
  rows.append(
    h('div', { class: 'invite' }, 'Invite', h('code', null, c.code), h('button', { class: 'btn-s ghost', type: 'button', onclick: async (e: MouseEvent) => {
      const b = e.currentTarget as HTMLButtonElement;
      try {
        await navigator.clipboard.writeText(`Join my Lock In crew: ${c.code}`);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select it';
      }
    } }, 'Copy')),
  );
  crewBox.append(rows);
}

function openCrewForm(kind: 'create' | 'join'): void {
  crewForm = kind;
  renderCrew();
}

function crewFormEl(kind: 'create' | 'join'): HTMLElement {
  const name = h('input', { type: 'text', placeholder: 'Your name (friends see it)', value: view?.settings.name ?? '', maxlength: 32, 'aria-label': 'Your name' });
  const other = h('input', { type: 'text', placeholder: kind === 'create' ? 'Crew name (e.g. Library gang)' : 'Invite code', maxlength: kind === 'create' ? 40 : 40, 'aria-label': kind === 'create' ? 'Crew name' : 'Invite code' });
  const go = h('button', { class: 'btn-s accent', type: 'button' }, kind === 'create' ? 'Start it' : 'Join');
  const submit = async () => {
    const n = name.value.trim();
    const o = other.value.trim();
    if (!n) return name.focus();
    if (!o && kind === 'join') return other.focus();
    go.disabled = true;
    const ok = await act(kind === 'create' ? { a: 'crew:create', crewName: o || `${n}’s crew`, name: n } : { a: 'crew:join', code: o, name: n });
    go.disabled = false;
    if (ok) {
      crewForm = null;
      sig = '';
      await refresh(true);
    }
  };
  go.addEventListener('click', () => void submit());
  for (const el of [name, other])
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit();
      if (e.key === 'Escape') {
        e.preventDefault();
        crewForm = null;
        renderCrew();
      }
    });
  setTimeout(() => (name.value ? other : name).focus(), 10);
  return h('div', { class: 'form' }, name, other, h('div', { class: 'acts' }, h('button', { class: 'btn-s ghost', type: 'button', onclick: () => {
    crewForm = null;
    renderCrew();
  } }, 'Cancel'), go));
}

async function bomb(m: CrewMemberView, insult: string): Promise<void> {
  bombing = null;
  const ok = await act({ a: 'crew:bomb', to: m.id, insult });
  if (ok) flash(`💣 Bomb thrown at ${m.name}.`);
  sig = '';
  await refresh();
}

/** A one-line note at the top, for a few seconds. */
let flashTimer: number | undefined;
function flash(text: string, bad = false): void {
  let el = document.getElementById('note');
  if (!el) {
    el = h('div', { class: 'toast-line', id: 'note', role: 'status' });
    const box = page === 'settings' ? settingsBox : mainBox;
    box.insertBefore(el, box.firstChild);
  }
  el.className = `toast-line${bad ? ' bad' : ''}`;
  el.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => document.getElementById('note')?.remove(), 3800);
}

// ---- settings -------------------------------------------------------------------------------

let settingsSig = '';
function renderSettings(force = false): void {
  if (!view) return;
  const v = view;
  const s = JSON.stringify([v.mode, v.settings, v.distractions, v.voices, v.crew?.code, v.desktop]);
  if (!force && (s === settingsSig || settingsBox.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT')) return;
  settingsSig = s;
  const top = settingsBox.scrollTop;
  clear(settingsBox);
  const st = v.settings;
  const linked = v.mode === 'linked';
  const patch = (p: Partial<ExtSettings>) => void act({ a: 'settings', patch: p });

  // You
  const name = h('input', { class: 'text-in', type: 'text', value: st.name, placeholder: 'Your first name', maxlength: 32, 'aria-label': 'Your name' });
  name.addEventListener('change', () => patch({ name: name.value.trim() }));
  const role = roleSelect(st.role);
  role.disabled = linked;
  role.addEventListener('change', () => patch({ role: role.value as Role }));
  settingsBox.append(
    section('You',
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', null, 'Name'), name),
        h('label', { class: 'field' }, h('span', null, 'What you do'), role, h('span', { class: 'help' }, linked ? 'From your Mac profile.' : 'Decides which sites count as work out of the box.')),
      ),
    ),
  );

  // Coach
  const grid = h('div', { class: 'personas' });
  for (const p of PERSONAS)
    grid.append(h('button', { class: 'persona', type: 'button', 'aria-pressed': String(p.id === st.persona), onclick: () => patch({ persona: p.id }) }, h('b', null, p.name), h('small', null, p.desc)));
  const tol = h('div', { class: 'segs', role: 'group', 'aria-label': 'Patience' });
  for (const m of [2, 5, 10] as const) tol.append(h('button', { type: 'button', 'aria-pressed': String(st.toleranceMin === m), onclick: () => patch({ toleranceMin: m }) }, `${m} min`));
  const voiceOn = toggle('Coach talks out loud', 'Uses Chrome’s voices.', st.voice, (on) => patch({ voice: on }));
  const voiceSel = h('select', { class: 'sel', 'aria-label': 'Voice', disabled: !st.voice }, h('option', { value: '' }, 'Chrome’s default voice'), v.voices.map((n) => h('option', { value: n, selected: n === st.voiceName }, n)));
  voiceSel.addEventListener('change', () => patch({ voiceName: voiceSel.value }));
  settingsBox.append(
    section('Coach',
      h('div', { class: 'card' },
        h('div', { class: 'field' }, grid),
        h('div', { class: 'field' }, h('span', null, 'Patience before it steps in'), tol),
        voiceOn,
        h('div', { class: 'field' }, h('div', { class: 'inline' }, voiceSel, h('button', { class: 'btn-s ghost', type: 'button', disabled: !st.voice, onclick: () => void act({ a: 'voice:test' }) }, 'Test'))),
        linked ? h('p', { class: 'help muted', style: 'margin-top:8px' }, 'Linked: your Mac does the coaching with its own voice. These apply when Chrome is on its own.') : null,
      ),
    ),
  );

  // Distractions
  const chips = h('div', { class: 'chips' });
  for (const d of v.distractions)
    chips.append(linked ? h('span', { class: 'dchip ro' }, d) : h('span', { class: 'dchip' }, d, h('button', { type: 'button', title: `Remove ${d}`, 'aria-label': `Remove ${d}`, onclick: () => void act({ a: 'distraction:remove', domain: d }) }, '×')));
  if (!v.distractions.length) chips.append(h('span', { class: 'muted' }, 'None yet.'));
  const addD = h('input', { class: 'text-in', type: 'text', placeholder: 'Add a site, like reddit.com', 'aria-label': 'Add a distraction' });
  const saveD = () => {
    const d = addD.value.trim();
    if (!d) return;
    addD.value = '';
    void act({ a: 'distraction:add', domain: d }).then(() => renderSettings(true));
  };
  addD.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveD();
  });
  settingsBox.append(
    section('Distractions',
      h('div', { class: 'card' },
        chips,
        linked
          ? h('div', { class: 'inline', style: 'margin-top:10px' }, h('span', { class: 'muted', style: 'flex:1' }, 'From your Mac.'), h('button', { class: 'btn-s ghost', type: 'button', onclick: () => void act({ a: 'mac:open', route: 'distractions' }) }, 'Edit on Mac'))
          : h('div', { class: 'inline', style: 'margin-top:10px' }, addD, h('button', { class: 'btn-s accent', type: 'button', onclick: saveD }, 'Add')),
      ),
    ),
  );

  // Calendar (a private link: stored here, never shown)
  const cal = h('div', { class: 'card' });
  if (st.calendarUrl) {
    cal.append(h('div', { class: 'ok-line' }, h('i', { class: 'dot' }), h('span', null, linked ? 'Calendar from your Mac' : 'Calendar connected'), linked ? null : h('button', { class: 'btn-s ghost', type: 'button', onclick: () => patch({ calendarUrl: '' }) }, 'Remove')));
  } else {
    const url = h('input', { class: 'text-in', type: 'password', placeholder: 'Paste your private iCal link', autocomplete: 'off', 'aria-label': 'Private iCal link' });
    const saveC = () => {
      const u = url.value.trim();
      if (!/^(https?|webcal):\/\//i.test(u)) return flash('That isn’t an iCal link (it starts with https:// or webcal://).', true);
      url.value = '';
      patch({ calendarUrl: u.replace(/^webcal:/i, 'https:') });
    };
    url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveC();
    });
    cal.append(h('div', { class: 'inline' }, url, h('button', { class: 'btn-s accent', type: 'button', onclick: saveC }, 'Save')), h('p', { class: 'help muted', style: 'margin-top:6px' }, 'Google Calendar: Settings → your calendar → Secret address in iCal format. It stays in this browser.'));
  }
  cal.append(toggle('Quiet in meetings', 'No nudges while a meeting is on.', st.quietInMeetings, (on) => patch({ quietInMeetings: on })));
  settingsBox.append(section('Calendar', cal));

  // Crew
  if (v.crew)
    settingsBox.append(
      section('Crew',
        h('div', { class: 'card' },
          h('div', { class: 'ok-line' }, h('i', { class: `dot${v.crew.connected ? '' : ' off'}` }), h('span', null, v.crew.crewName || 'Your crew', h('small', { class: 'muted' }, v.crew.connected ? ' · connected' : ' · can’t reach the relay')), h('button', { class: 'btn-s danger', type: 'button', onclick: () => void act({ a: 'crew:leave' }).then(() => renderSettings(true)) }, 'Leave')),
          h('p', { class: 'code-line' }, h('span', { class: 'muted' }, 'Invite code'), h('code', null, v.crew.code)),
        ),
      ),
    );

  // Lock In for Mac
  const mac = h('div', { class: 'card' },
    h('div', { class: 'ok-line' }, h('i', { class: `dot${linked ? '' : ' off'}` }), h('span', null, linked ? 'Linked to Lock In for Mac' : v.desktop.connected ? 'Lock In for Mac is open, but too old to link. Update it.' : 'Not linked right now')),
    h('p', { class: 'help muted', style: 'margin-top:6px' }, linked
      ? 'Same profile, site labels, crew, to-dos, goals and meetings. The Mac coaches (it sees every app); this panel drives it.'
      : `When Lock In for Mac is open, this links up by itself and uses the same you. Sessions you run here go into your Mac history.${v.desktop.syncedAt ? ` Last synced ${new Date(v.desktop.syncedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : ''}`),
    toggle('Link to Lock In for Mac', 'Off: this always runs on its own.', st.link, (on) => patch({ link: on })),
    linked || !st.link ? null : h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn-s ghost', type: 'button', onclick: () => void act({ a: 'relink' }).then(() => flash('Looking for Lock In for Mac…')) }, 'Look for it now')),
  );
  settingsBox.append(section('Lock In for Mac', mac));
  settingsBox.append(
    h('p', { class: 'about' }, `Lock In Extended ${chrome.runtime.getManifest().version}. Everything stays in this browser (and on your Mac when linked). Page titles never leave it. Crew updates go through an encrypted relay only your crew can read.`),
  );
  settingsBox.scrollTop = top;
}

function section(title: string, ...body: Node[]): HTMLElement {
  return h('section', { class: 'set' }, h('span', { class: 'label' }, title), ...body);
}

function toggle(label: string, help: string, on: boolean, change: (on: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: on, role: 'switch' });
  input.addEventListener('change', () => change(input.checked));
  return h('label', { class: 'toggle' }, h('span', null, label, h('small', null, help)), input);
}

function go(p: 'main' | 'settings'): void {
  page = p;
  heroMode = '';
  sig = '';
  settingsSig = '';
  footSig = '';
  document.getElementById('note')?.remove();
  if (view) apply(view);
  (p === 'settings' ? settingsBox : mainBox).scrollTop = 0;
}

// ---- wiring ---------------------------------------------------------------------------------

$('settingsBtn').addEventListener('click', () => go('settings'));
$('backBtn').addEventListener('click', () => go('main'));
muteChip.addEventListener('click', () => void act({ a: 'unmute' }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && page === 'settings') {
    e.preventDefault();
    go('main');
  } else if (e.key === 'Escape' && commitOpen) {
    e.preventDefault();
    commitOpen = false;
    renderLiveActs();
  }
});

// The clock ticks every second; the rest is fetched every 2 (and the crew read every 10).
let n = 0;
setInterval(() => {
  if (view?.session && page === 'main') tickLive();
  if (page === 'main') renderAlerts();
  n += 1;
  if (n % 2 === 0) void refresh(n % 10 === 0);
}, 1000);

void refresh(true);
