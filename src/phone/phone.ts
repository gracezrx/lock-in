// Lock In on your phone: opened from your Mac over the same Wi-Fi. Everything it asks the Mac
// is sealed with the key made when you paired (see shared/seal.ts), so it works over plain http.
import type { CoachSource, CrewMemberView, CrewView, CustomCoachView, GoalsView, LiveState, Task, TodoSummary } from '../shared/types';
import {
  b64, hex, keyPair, randomBytes, sealJson, sealParts, sharedKey, unb64, unseal, unsealJson, type RpcReply,
} from '../shared/seal';

// ---- tiny DOM helpers ------------------------------------------------------------------------

type Child = Node | string | number | false | null | undefined | Child[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (cs: Child[]) => {
    for (const c of cs) {
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) add(c);
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  };
  add(children);
  return el;
}
/** Appends children, skipping the empty ones. */
const add = (el: Element, ...cs: Child[]) => {
  const tmp = h('div', null, cs);
  while (tmp.firstChild) el.appendChild(tmp.firstChild);
};
const clear = (el: Element) => {
  while (el.firstChild) el.removeChild(el.firstChild);
};
const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  const hh = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const fmt = (n: number) => n.toLocaleString();

const ls = {
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
      /* private mode */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

// ---- talking to the Mac ---------------------------------------------------------------------------

interface Creds {
  id: string;
  key: string;
  mac: string;
}

let creds: Creds | null = (() => {
  try {
    return JSON.parse(ls.get('lockin.pair') ?? 'null') as Creds | null;
  } catch {
    return null;
  }
})();

const app = document.getElementById('app') as HTMLElement;
let online = true;

class Unpaired extends Error {}

function setOnline(on: boolean): void {
  if (online === on) return;
  online = on;
  document.body.classList.toggle('offline', !on);
}

async function post(path: string, body: Uint8Array): Promise<Response> {
  if (!creds) throw new Unpaired('not paired');
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'x-lockin-device': creds.id, 'content-type': 'application/octet-stream' }, body: body as BodyInit, cache: 'no-store' });
  } catch {
    setOnline(false);
    throw new Error("Can't reach your Mac.");
  }
  setOnline(true);
  if (res.status === 401) {
    unpair();
    throw new Unpaired('pair again');
  }
  return res;
}

const req = (m: string, a: unknown[]) => ({ t: Date.now(), n: hex(randomBytes(12)), m, a });

async function rpc<T = unknown>(m: string, ...a: unknown[]): Promise<T> {
  const key = unb64(creds!.key);
  const res = await post('/api/rpc', sealJson(key, req(m, a)));
  if (!res.ok) throw new Error(`Your Mac said no (${res.status}).`);
  const reply = unsealJson<RpcReply>(key, new Uint8Array(await res.arrayBuffer()));
  if (!reply) throw new Error('Garbled answer from your Mac.');
  if (!reply.ok) throw new Error(reply.e ?? 'That did not work.');
  return reply.r as T;
}

async function blob(kind: string, id: string): Promise<Uint8Array | null> {
  const key = unb64(creds!.key);
  const res = await post('/api/blob', sealJson(key, req('blob', [kind, id])));
  if (!res.ok) return null;
  return unseal(key, new Uint8Array(await res.arrayBuffer()));
}

const CHUNK = 2 * 1024 * 1024;

async function upload(coach: string, file: File, progress: (f: number) => void): Promise<unknown> {
  const key = unb64(creds!.key);
  const up = hex(randomBytes(8));
  const total = Math.max(1, Math.ceil(file.size / CHUNK));
  const name = file.name && file.name !== 'image.MOV' ? file.name : `Recording ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.${(file.type.split('/')[1] || 'mov').replace('quicktime', 'mov')}`;
  let last: unknown = null;
  for (let i = 0; i < total; i++) {
    const chunk = new Uint8Array(await file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
    const body = sealParts(key, { t: Date.now(), n: hex(randomBytes(12)), up, i, last: i === total - 1, name, size: file.size, coach }, chunk);
    const res = await post('/api/upload', body);
    const reply = unsealJson<RpcReply>(key, new Uint8Array(await res.arrayBuffer()));
    if (!reply?.ok) throw new Error(reply?.e ?? 'Upload failed.');
    last = reply.r;
    progress((i + 1) / total);
  }
  return last;
}

function unpair(): void {
  creds = null;
  ls.del('lockin.pair');
  render();
}

// ---- pairing ---------------------------------------------------------------------------------------

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
const deviceName = () => (/iPad/.test(navigator.userAgent) ? 'iPad' : isIos ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone');

async function pair(code: string, name: string): Promise<string | null> {
  const hello = await fetch('/api/pair', { cache: 'no-store' }).catch(() => null);
  if (!hello) return "Can't reach your Mac. Is your phone on the same Wi-Fi?";
  if (hello.status === 409) return 'Press "Pair a phone" on your Mac first (Settings, Your phone), then type the code it shows.';
  const { pub } = (await hello.json()) as { pub: string; mac: string };
  const kp = keyPair();
  const key = sharedKey(unb64(pub), kp.secretKey);
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pub: b64(kp.publicKey), box: b64(sealJson(key, { code, name })) }) });
  const j = (await res.json().catch(() => ({}))) as { error?: string; left?: number; box?: string };
  if (res.status === 403) return j.error === 'too-many' ? 'Too many wrong tries. Press "Pair a phone" on your Mac for a new code.' : `That's not the code on your Mac.${j.left ? ` ${j.left} tries left.` : ''}`;
  if (res.status === 409) return j.error === 'stale' ? 'Your Mac made a new code. Type the new one.' : 'The code ran out. Press "Pair a phone" on your Mac again.';
  if (!res.ok || !j.box) return `Your Mac said no (${res.status}).`;
  const inner = unsealJson<{ id: string; mac: string }>(key, unb64(j.box));
  if (!inner) return 'Pairing went wrong. Try again.';
  creds = { id: inner.id, key: b64(key), mac: inner.mac };
  ls.set('lockin.pair', JSON.stringify(creds));
  return null;
}

function pairScreen(): HTMLElement {
  const code = h('input', { class: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '000000', 'aria-label': '6-digit code' });
  const name = h('input', { type: 'text', value: deviceName(), 'aria-label': 'Name for this phone' });
  const note = h('p', { class: 'err', 'aria-live': 'polite' });
  const go = h('button', { class: 'btn big ink', type: 'button' }, 'Pair');
  const submit = async () => {
    const c = code.value.replace(/\D/g, '');
    if (c.length !== 6) {
      note.textContent = 'The code has 6 digits.';
      return;
    }
    go.disabled = true;
    go.textContent = 'Pairing…';
    const err = await pair(c, name.value.trim() || deviceName());
    go.disabled = false;
    go.textContent = 'Pair';
    if (err) note.textContent = err;
    else render();
  };
  go.addEventListener('click', () => void submit());
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6);
    if (code.value.length === 6) void submit();
  });
  const homeFirst =
    isIos && !standalone
      ? h(
          'div',
          { class: 'card tip' },
          h('b', null, 'First, put Lock In on your Home Screen'),
          h('p', null, 'Tap ', h('span', { class: 'share' }, 'Share'), ' at the bottom of Safari, then ', h('b', null, 'Add to Home Screen'), '. Open Lock In from your Home Screen and pair there (the Home Screen app keeps its own pairing).'),
          h('p', { class: 'muted' }, 'Or pair right here to use it in Safari.'),
        )
      : null;
  return h(
    'main',
    { class: 'pair' },
    h('div', { class: 'brand' }, h('img', { src: '/icon.png', alt: '' }), h('span', null, 'Lock In')),
    h('h1', null, 'Pair with your Mac'),
    homeFirst,
    h('ol', { class: 'how' }, h('li', null, 'On your Mac: Lock In, ', h('b', null, 'Settings'), ', ', h('b', null, 'Your phone'), ', ', h('b', null, 'Pair a phone'), '.'), h('li', null, 'Type the 6-digit code it shows.')),
    code,
    h('label', { class: 'lbl' }, 'This phone is called', name),
    go,
    note,
    h('p', { class: 'muted small' }, 'Your phone and Mac need the same Wi-Fi. Everything between them is encrypted with a key only they know.'),
  );
}

// ---- the shell: top bar, tabs ---------------------------------------------------------------------

type Tab = 'home' | 'todos' | 'friends' | 'coach';
let tab: Tab = (ls.get('lockin.tab') as Tab) || 'home';
let view: HTMLElement;
let poll: (() => Promise<void>) | null = null;

const ICONS: Record<Tab, string> = {
  home: '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  todos: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/></svg>',
  friends: '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.2"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="16.8" cy="8.6" r="2.6"/><path d="M15.6 13.8c2.6-.3 4.5 1.4 5 4.4"/></svg>',
  coach: '<svg viewBox="0 0 24 24"><path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6l-4.5 3.8V16H7a2.5 2.5 0 0 1-2.5-2.5z"/></svg>',
};
const TAB_NAMES: Record<Tab, string> = { home: 'Lock in', todos: 'To-dos', friends: 'Friends', coach: 'Coach' };

function render(): void {
  clear(app);
  poll = null;
  if (!creds) {
    app.append(pairScreen());
    return;
  }
  view = h('main', { class: 'view' });
  const nav = h('nav', { class: 'tabs' });
  for (const t of Object.keys(TAB_NAMES) as Tab[]) {
    const b = h('button', { type: 'button', class: t === tab ? 'on' : '', 'aria-current': t === tab ? 'page' : null, onclick: () => go(t) });
    const icon = h('span', { class: 'ic' });
    icon.innerHTML = ICONS[t];
    b.append(icon, h('span', null, TAB_NAMES[t]));
    nav.append(b);
  }
  app.append(
    h('header', { class: 'top' }, h('div', { class: 'brand' }, h('img', { src: '/icon.png', alt: '' }), h('span', null, 'Lock In')), h('span', { class: 'mac' }, h('i'), creds.mac)),
    h('div', { class: 'offline-bar' }, "Can't reach your Mac. Same Wi-Fi? Is it awake with Lock In open?"),
    view,
    nav,
  );
  void show();
}

function go(t: Tab): void {
  if (t === tab) return;
  tab = t;
  ls.set('lockin.tab', t);
  coachScreen = coachScreen === 'detail' ? 'people' : coachScreen;
  render();
}

async function show(): Promise<void> {
  clear(view);
  view.classList.toggle('talk', tab === 'coach' && coachScreen === 'talk');
  poll = null;
  window.scrollTo(0, 0);
  try {
    if (tab === 'home') await homeTab();
    else if (tab === 'todos') await todosTab();
    else if (tab === 'friends') await friendsTab();
    else await coachTab();
  } catch (e) {
    if (e instanceof Unpaired) return;
    view.append(h('div', { class: 'card empty' }, h('b', null, "Can't reach your Mac"), h('p', null, 'Check that your phone is on the same Wi-Fi as your Mac, and that your Mac is awake with Lock In open.'), h('button', { class: 'btn', type: 'button', onclick: () => void show() }, 'Try again')));
  }
}

// Refresh what's on screen every few seconds, unless you're typing.
setInterval(() => {
  if (!poll || document.visibilityState !== 'visible') return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
  void poll().catch(() => undefined);
}, 4000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && poll) void poll().catch(() => undefined);
});

const toast = (msg: string, bad = false) => {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}`, role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
};

async function act<T>(fn: () => Promise<T>, done?: string): Promise<T | null> {
  try {
    const r = await fn();
    if (done) toast(done);
    return r;
  } catch (e) {
    if (!(e instanceof Unpaired)) toast((e as Error).message, true);
    return null;
  }
}

// ---- Lock in ---------------------------------------------------------------------------------------

let minutes = Number(ls.get('lockin.minutes')) || 50;
let tick: number | null = null;

async function homeTab(): Promise<void> {
  const box = h('div');
  const goalsBox = h('div');
  view.append(box, goalsBox);
  // Goals (beta): today's progress, a custom goal to tick, and a glass of water to log.
  const drawGoals = (g: GoalsView | null) => {
    clear(goalsBox);
    if (!g || !g.enabled) return;
    const live = g.goals.filter((x) => !x.paused);
    if (!live.length && !g.suggestions.length && !g.now.water) {
      goalsBox.append(h('section', { class: 'card goals' }, h('div', { class: 'goals-head' }, h('h2', null, 'Goals'), h('span', { class: 'beta' }, 'Beta')), h('p', { class: 'muted' }, 'Set goals on your Mac: Goals, in the side menu.'), waterBtn(g)));
      return;
    }
    goalsBox.append(
      h(
        'section',
        { class: 'card goals' },
        h('div', { class: 'goals-head' }, h('h2', null, 'Today’s goals'), h('span', { class: 'beta' }, 'Beta')),
        live.length
          ? h(
              'ul',
              null,
              live.map((x) =>
                h(
                  'li',
                  { class: `tone-${x.tone}` },
                  // A stop time is about tonight; last night goes underneath.
                  h('div', { class: 'goal-line' }, h('b', null, x.name), x.kind === 'bedtime' ? null : h('span', null, x.progress)),
                  x.pct !== null ? h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(2, Math.round(x.pct * 100))}%` })) : null,
                  h('small', null, x.kind === 'bedtime' ? `${x.status}. ${x.progress}.` : x.status),
                  x.kind === 'custom'
                    ? h('button', { class: `btn small${x.tone === 'done' ? '' : ' ink'}`, type: 'button', onclick: async () => {
                        const v = await act(() => rpc<GoalsView>('goals:check', x.id, x.tone !== 'done'));
                        if (v) drawGoals(v);
                      } }, x.tone === 'done' ? '✓ Moved it forward' : 'I moved it forward today')
                    : null,
                ),
              ),
            )
          : null,
        !live.length && g.suggestions[0] ? h('p', { class: 'noticed' }, h('b', null, 'Lock In noticed: '), g.suggestions[0].evidence, ' Open Goals on your Mac to try it.') : null,
        waterBtn(g),
      ),
    );
  };
  const waterBtn = (g: GoalsView) =>
    h('button', { class: 'btn water', type: 'button', onclick: async () => {
      const v = await act(() => rpc<GoalsView>('goals:water'), 'Logged a glass of water.');
      if (v) drawGoals(v);
    } }, `💧 Drank a glass${g.now.water ? ` · ${g.now.water} today` : ''}`);
  const draw = (s: LiveState) => {
    clear(box);
    if (tick) clearInterval(tick);
    tick = null;
    const ses = s.session;
    if (ses) {
      const fetched = Date.now();
      const left0 = ses.plannedMin * 60 - ses.elapsedSec;
      const onBreak = !!ses.onBreakUntil && ses.onBreakUntil > Date.now();
      const timer = h('div', { class: 'timer' });
      const upd = () => {
        timer.textContent = onBreak ? mmss((ses.onBreakUntil! - Date.now()) / 1000) : mmss(left0 - (Date.now() - fetched) / 1000);
      };
      upd();
      tick = window.setInterval(upd, 1000);
      const focusMin = Math.round(ses.focusSec / 60);
      const pct = ses.elapsedSec > 60 ? Math.round((ses.focusSec / ses.elapsedSec) * 100) : null;
      const cur = s.current;
      const label = cur ? (cur.label === 'distraction' ? 'drifting' : cur.label) : null;
      const muted = s.muteUntil && s.muteUntil > Date.now();
      box.append(
        h(
          'section',
          { class: `live${ses.level >= 3 ? ' red' : ses.level >= 1 ? ' warn' : ''}` },
          h('p', { class: 'kicker' }, onBreak ? 'On a break' : 'Locked in'),
          h('h1', null, ses.goal || 'Focus'),
          timer,
          h('p', { class: 'sub' }, onBreak ? 'until the break ends' : 'left'),
          h('div', { class: 'stats' }, h('span', null, h('b', null, String(focusMin)), ' min focused'), pct !== null ? h('span', null, h('b', null, `${pct}%`), ' on task') : null),
          cur ? h('p', { class: 'now' }, h('span', { class: `pill ${label}` }, LABEL[label!] ?? label), ` ${cur.domain ?? cur.app}`) : null,
        ),
        h(
          'div',
          { class: 'row' },
          endButton(),
          muted
            ? h('button', { class: 'btn', type: 'button', onclick: async () => { await act(() => rpc('unmute'), 'Coach is back on.'); await refresh(); } }, `Paused till ${clock(s.muteUntil!)}`)
            : h('button', { class: 'btn', type: 'button', onclick: async () => { await act(() => rpc('mute', 30), 'Coach paused for 30 minutes.'); await refresh(); } }, 'Pause 30 min'),
        ),
      );
    } else {
      const top = s.todos.top;
      const goal = h('input', { type: 'text', class: 'goal', placeholder: top || s.lastGoal || 'Finish the pitch deck', enterkeyhint: 'go', 'aria-label': 'What are you locking in on?' });
      const chips = h('div', { class: 'chips' });
      const drawChips = () => {
        clear(chips);
        for (const m of [25, 50, 90]) chips.append(h('button', { type: 'button', class: `chip${m === minutes ? ' on' : ''}`, onclick: () => { minutes = m; ls.set('lockin.minutes', String(m)); drawChips(); } }, h('b', null, String(m)), ' min'));
      };
      drawChips();
      const start = async (g: string) => {
        const r = await act(() => rpc('session:start', { goal: g, minutes }), `Locked in for ${minutes} minutes.`);
        if (r !== null) await refresh();
      };
      goal.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') void start(goal.value.trim() || goal.placeholder);
      });
      box.append(
        h(
          'section',
          { class: 'start' },
          h('h1', null, 'What are you locking in on?'),
          goal,
          chips,
          h('button', { class: 'btn big ink', type: 'button', onclick: () => void start(goal.value.trim() || goal.placeholder) }, 'Lock in'),
          top ? h('button', { class: 'link', type: 'button', onclick: () => void start(top) }, `or lock in on “${top}”`) : null,
        ),
      );
      if (s.muteUntil && s.muteUntil > Date.now()) box.append(h('div', { class: 'card note' }, `Coach paused until ${clock(s.muteUntil)}. `, h('button', { class: 'link', type: 'button', onclick: async () => { await act(() => rpc('unmute')); await refresh(); } }, 'Unpause')));
    }
    const info: Node[] = [];
    if (s.calendar.now) info.push(h('li', null, h('span', { class: 'dot red' }), `In “${s.calendar.now.title}” until ${clock(s.calendar.now.end)}`));
    else if (s.calendar.next) info.push(h('li', null, h('span', { class: 'dot' }), `Next: ${s.calendar.next.title} at ${clock(s.calendar.next.start)}`));
    for (const d of s.deadlines.pinned.slice(0, 3)) info.push(h('li', null, h('span', { class: `dot ${d.overdue ? 'red' : 'yellow'}` }), `${d.overdue ? 'Overdue' : 'Due today'}: ${d.title}`));
    info.push(h('li', null, h('span', { class: 'dot green' }), `${s.todos.doneToday} done today · ${s.todos.open} to go`));
    box.append(h('ul', { class: 'info card' }, info));
  };
  const endButton = () => {
    const b = h('button', { class: 'btn', type: 'button' }, 'End session');
    let armed = false;
    b.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        b.textContent = 'Tap again to end';
        b.classList.add('danger');
        setTimeout(() => {
          armed = false;
          b.textContent = 'End session';
          b.classList.remove('danger');
        }, 3000);
        return;
      }
      await act(() => rpc('session:end'), 'Session ended.');
      await refresh();
    });
    return b;
  };
  const refresh = async () => {
    const s = await rpc<LiveState>('state:get');
    draw(s);
    // A Mac without Goals (or with it off) just leaves the card out.
    drawGoals(s.goals ? await rpc<GoalsView>('goals:get').catch(() => null) : null);
  };
  await refresh();
  poll = refresh;
}

// ---- To-dos -----------------------------------------------------------------------------------------

async function todosTab(): Promise<void> {
  const box = h('div');
  view.append(box);
  const add = h('input', { type: 'text', placeholder: 'Add a to-do', enterkeyhint: 'done', 'aria-label': 'Add a to-do' });
  const draw = (d: { summary: TodoSummary; open: Task[]; done: Task[] }) => {
    clear(box);
    const s = d.summary;
    box.append(
      h('h1', { class: 'page-title' }, 'To-dos'),
      h('div', { class: 'summary' }, h('span', null, h('b', null, String(s.doneToday)), ' done'), h('span', null, h('b', null, String(s.open)), ' to go'), s.overdue ? h('span', { class: 'red' }, h('b', null, String(s.overdue)), ' overdue') : null),
    );
    if (s.provider === 'none') {
      box.append(h('div', { class: 'card empty' }, 'No to-do list connected yet. Connect one on your Mac (To-dos, Your list).'));
      return;
    }
    if (s.canAdd) box.append(h('div', { class: 'add' }, add, h('button', { class: 'btn ink', type: 'button', onclick: () => void addTodo() }, 'Add')));
    const today = new Date().toISOString().slice(0, 10);
    const list = h('ul', { class: 'tasks card' });
    for (const t of d.open) {
      const overdue = !!t.due && t.due < today;
      const check = h('button', { class: 'check', type: 'button', disabled: !s.canComplete, 'aria-label': `Done: ${t.title}` });
      check.addEventListener('click', async () => {
        li.classList.add('ticking');
        const r = await act(() => rpc<{ ok: boolean; error?: string }>('todos:complete', t.id));
        if (r && !r.ok) toast(r.error ?? "Couldn't tick it off.", true);
        await refresh();
      });
      const li = h('li', null, check, h('div', null, h('span', { class: 'title' }, t.title), t.due || t.project ? h('small', { class: overdue ? 'red' : '' }, [t.project, t.due ? (overdue ? `was due ${t.due}` : `due ${t.due}`) : ''].filter(Boolean).join(' · ')) : null));
      list.append(li);
    }
    if (!d.open.length) list.append(h('li', { class: 'none' }, 'Nothing left. Go outside.'));
    box.append(list);
    if (s.tickNote) box.append(h('p', { class: 'muted small' }, s.tickNote));
    if (d.done.length) {
      box.append(h('h2', null, 'Done today'), h('ul', { class: 'tasks done card' }, d.done.map((t) => h('li', null, h('span', { class: 'check on' }), h('div', null, h('span', { class: 'title' }, t.title), t.completedAt ? h('small', null, `${clock(t.completedAt)}${t.said ? ' · told the coach' : ''}`) : null)))));
    }
  };
  const addTodo = async () => {
    const title = add.value.trim();
    if (!title) return;
    add.value = '';
    const r = await act(() => rpc<{ ok: boolean; error?: string }>('todos:add', title));
    if (r && !r.ok) toast(r.error ?? "Couldn't add it.", true);
    await refresh();
  };
  add.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addTodo();
  });
  const refresh = async () => draw(await rpc('todos:get'));
  await refresh();
  poll = refresh;
}

// ---- Friends ------------------------------------------------------------------------------------------

const LABEL: Record<string, string> = { work: 'Work', neutral: 'Neutral', drifting: 'Drifting', away: 'Away', private: 'Private' };
const STATE: Record<CrewMemberView['state'], string> = { locked: 'Locked in', break: 'On a break', drifting: 'Drifting', free: 'Free', meeting: 'In a meeting', away: 'Away', offline: 'Offline' };

async function friendsTab(): Promise<void> {
  const box = h('div');
  view.append(box);
  const draw = (p: { view: CrewView }) => {
    const v = p.view;
    clear(box);
    box.append(h('h1', { class: 'page-title' }, v.joined ? v.crewName || 'Your crew' : 'Friends'));
    if (!v.joined) {
      box.append(h('div', { class: 'card empty' }, h('b', null, 'Not in a crew yet'), h('p', null, 'Make one or join one on your Mac (Friends tab), and your crew shows up here.')));
      return;
    }
    box.append(h('div', { class: 'bombs' }, h('span', { class: 'bomb-row' }, Array.from({ length: v.bombsPerDay }, (_x, i) => h('i', { class: i < v.bombsLeft ? 'on' : '' }))), `${v.bombsLeft} of ${v.bombsPerDay} Lock In bombs left today`));
    if (!v.connected) box.append(h('p', { class: 'muted small' }, v.error || 'Your Mac is reconnecting to your crew…'));
    const list = h('ul', { class: 'crew card' });
    for (const m of [...v.members].sort((a, b) => Number(b.me) - Number(a.me))) {
      const detail = m.state === 'locked' && m.goal ? m.goal : m.state === 'drifting' && m.distraction ? `on ${m.distraction}` : m.state === 'offline' ? `seen ${ago(m.lastSeen)}` : `since ${clock(m.since)}`;
      list.append(
        h(
          'li',
          null,
          h('div', { class: 'who' }, h('b', null, m.name, m.me ? h('small', null, ' (you)') : null), h('span', { class: `pill ${m.state}` }, STATE[m.state]), h('small', null, detail)),
          m.bombable && v.bombsLeft > 0 ? h('button', { class: 'btn bomb', type: 'button', onclick: () => bombSheet(v, m) }, 'Bomb') : null,
        ),
      );
    }
    box.append(list);
    const ranked = [...v.members].filter((m) => m.stats.roastedWeek > 0).sort((a, b) => b.stats.roastedWeek - a.stats.roastedWeek);
    if (ranked.length) {
      box.append(h('h2', null, 'Most roasted this week'), h('ol', { class: 'board card' }, ranked.slice(0, 5).map((m, i) => h('li', null, h('span', { class: 'rank' }, String(i + 1)), h('span', { class: 'name' }, m.name), h('b', null, String(m.stats.roastedWeek))))));
    }
    if (v.feed.length) box.append(h('h2', null, 'Crew feed'), h('ul', { class: 'feed card' }, v.feed.slice(0, 12).map((f) => h('li', null, h('span', null, f.text), h('small', null, ago(f.at))))));
  };
  const refresh = async () => draw(await rpc('crew:get'));
  await refresh();
  poll = refresh;
}

function bombSheet(v: CrewView, m: CrewMemberView): void {
  let pick = v.insults[0] ?? '';
  const own = h('textarea', { rows: 2, maxlength: 140, placeholder: 'Or write your own', 'aria-label': 'Your own insult' });
  const chips = h('div', { class: 'insults' });
  const draw = () => {
    clear(chips);
    for (const t of v.insults) chips.append(h('button', { type: 'button', class: `chip${t === pick && !own.value.trim() ? ' on' : ''}`, onclick: () => { pick = t; own.value = ''; draw(); } }, t));
  };
  draw();
  own.addEventListener('input', draw);
  const close = () => sheet.remove();
  const sheet = h(
    'div',
    { class: 'sheet-bg', onclick: (e: Event) => e.target === sheet && close() },
    h(
      'div',
      { class: 'sheet' },
      h('h2', null, `Bomb ${m.name}`),
      h('p', { class: 'muted small' }, `Every distraction on their Mac locks for 5 minutes, then their screen goes red for 5 seconds. ${v.bombsLeft} left today.`),
      chips,
      own,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
        h('button', { class: 'btn ink red-btn', type: 'button', onclick: async () => {
          const insult = own.value.trim() || pick;
          if (!insult) return;
          close();
          const r = await act(() => rpc<{ ok: boolean; error?: string }>('crew:bomb', { to: m.id, insult }));
          if (r?.ok) toast(`Bomb thrown at ${m.name}.`);
          else if (r) toast(r.error ?? "It didn't go.", true);
          await poll?.();
        } }, 'Throw it'),
      ),
    ),
  );
  document.body.append(sheet);
}

// ---- Coach: talk, and coaches made from someone you know --------------------------------------------

let coachScreen: 'talk' | 'people' | 'detail' = (ls.get('lockin.coachScreen') as 'talk' | 'people') || 'talk';
let coachId = '';
let chat: { who: 'coach' | 'me' | 'note'; text: string }[] = [];
let chatStarted = false;
let soundOn = ls.get('lockin.sound') !== 'off';
const player = new Audio();
let unlocked = false;
// A tenth of a second of silence: playing it on a tap lets later replies play on their own.
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  player.src = SILENCE;
  void player.play().catch(() => undefined);
}

async function playReply(id: string): Promise<void> {
  if (!soundOn) return;
  const bytes = await blob('audio', id).catch(() => null);
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/mpeg' }));
  player.src = url;
  player.onended = () => URL.revokeObjectURL(url);
  void player.play().catch(() => undefined);
}

async function coachTab(): Promise<void> {
  const seg = h(
    'div',
    { class: 'seg' },
    h('button', { type: 'button', class: coachScreen === 'talk' ? 'on' : '', onclick: () => { coachScreen = 'talk'; ls.set('lockin.coachScreen', 'talk'); void show(); } }, 'Talk'),
    h('button', { type: 'button', class: coachScreen !== 'talk' ? 'on' : '', onclick: () => { coachScreen = 'people'; ls.set('lockin.coachScreen', 'people'); void show(); } }, 'Someone you know'),
  );
  view.append(seg);
  if (coachScreen === 'talk') await talkScreen();
  else if (coachScreen === 'detail' && coachId) await coachDetail(coachId);
  else await peopleScreen();
}

async function talkScreen(): Promise<void> {
  const log = h('div', { class: 'chat', 'aria-live': 'polite' });
  const draw = () => {
    clear(log);
    for (const m of chat) log.append(h('div', { class: `msg ${m.who}` }, m.text));
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
  };
  const take = (events: { type: string; text?: string; ticked?: string[]; added?: string[]; id?: string }[]) => {
    for (const e of events) {
      if (e.type === 'agent' && e.text) chat.push({ who: 'coach', text: e.text });
      else if (e.type === 'logged') chat.push({ who: 'note', text: [e.ticked?.length ? `Ticked off: ${e.ticked.join(', ')}` : '', e.added?.length ? `Added to done: ${e.added.join(', ')}` : ''].filter(Boolean).join(' · ') });
      else if ((e.type === 'action' || e.type === 'notice') && e.text) chat.push({ who: 'note', text: e.text });
      else if (e.type === 'end') {
        chatStarted = false;
        chat.push({ who: 'note', text: 'Conversation over. Type to start a new one.' });
      } else if (e.type === 'audio' && e.id) void playReply(e.id);
    }
    chat = chat.slice(-60);
    draw();
  };
  const input = h('textarea', { rows: 1, placeholder: 'What did you get done?', enterkeyhint: 'send', 'aria-label': 'Message' });
  const send = h('button', { class: 'btn ink', type: 'button', 'aria-label': 'Send' }, 'Send');
  const sound = h('button', { class: 'sound', type: 'button', 'aria-pressed': String(soundOn), title: 'Hear the coach' }, soundOn ? 'Sound on' : 'Sound off');
  sound.addEventListener('click', () => {
    soundOn = !soundOn;
    ls.set('lockin.sound', soundOn ? 'on' : 'off');
    sound.textContent = soundOn ? 'Sound on' : 'Sound off';
    sound.setAttribute('aria-pressed', String(soundOn));
    if (soundOn) unlockAudio();
  });
  const say = async () => {
    const text = input.value.trim();
    if (!text) return;
    unlockAudio();
    input.value = '';
    input.style.height = '';
    chat.push({ who: 'me', text });
    chat.push({ who: 'note', text: '…' });
    draw();
    send.disabled = true;
    const events = await act(() => rpc<{ type: string }[]>('chat:say', text));
    chat = chat.filter((m) => m.text !== '…');
    chatStarted = true;
    send.disabled = false;
    take(events ?? []);
  };
  send.addEventListener('click', () => void say());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void say();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    input.style.overflowY = input.scrollHeight > 140 ? 'auto' : 'hidden';
  });
  view.append(
    log,
    h(
      'div',
      { class: 'composer' },
      h('div', { class: 'compose-row' }, input, send),
      h('div', { class: 'compose-meta' }, h('span', null, 'Tap the mic on your keyboard to talk.'), sound),
      h('div', { class: 'compose-meta' }, h('button', { class: 'link', type: 'button', onclick: () => void act(() => rpc('talk:open', 'checkin'), 'Opened on your Mac. Talk to it there.') }, 'Talk out loud on my Mac instead'), chatStarted ? h('button', { class: 'link', type: 'button', onclick: async () => { await act(() => rpc('chat:end')); chatStarted = false; chat = []; void show(); } }, 'New conversation') : null),
    ),
  );
  draw();
  if (!chatStarted && !chat.length) {
    chat.push({ who: 'note', text: '…' });
    draw();
    const events = await act(() => rpc<{ type: string }[]>('chat:start'));
    chat = chat.filter((m) => m.text !== '…');
    chatStarted = true;
    take(events ?? []);
  }
}

const READY_WORD: Record<CustomCoachView['readiness']['style'], string> = { empty: 'Keep feeding it', sketch: 'A first sketch', good: 'Sounds like them', great: 'Spot on' };

async function peopleScreen(): Promise<void> {
  const list = await rpc<CustomCoachView[]>('coaches:list');
  view.append(h('p', { class: 'muted small lead' }, 'Coaches that talk like your mum, your boss, anyone. Send recordings and messages straight from your phone.'));
  const ul = h('div', { class: 'people' });
  for (const c of list) {
    const r = c.readiness;
    ul.append(
      h(
        'button',
        { class: `person card${c.active ? ' on' : ''}`, type: 'button', onclick: () => { coachScreen = 'detail'; coachId = c.id; void show(); } },
        h('b', null, c.name, c.active ? h('span', { class: 'tick' }, ' ✓ your coach') : null),
        h('small', null, [c.relation, r.pending ? 'listening…' : `${fmt(r.words)} words · ${READY_WORD[r.style]}`].filter(Boolean).join(' · ')),
      ),
    );
  }
  const name = h('input', { type: 'text', placeholder: 'Mum, Dad, Sam from work…', 'aria-label': 'Their name' });
  const rel = h('input', { type: 'text', placeholder: 'my mum, my boss', 'aria-label': 'Who they are to you' });
  ul.append(
    h(
      'div',
      { class: 'card new' },
      h('b', null, '+ Someone new'),
      name,
      rel,
      h('button', { class: 'btn ink', type: 'button', onclick: async () => {
        if (!name.value.trim()) {
          name.focus();
          return;
        }
        const c = await act(() => rpc<CustomCoachView>('coaches:create', { name: name.value.trim(), relation: rel.value.trim() }));
        if (c) {
          coachScreen = 'detail';
          coachId = c.id;
          void show();
        }
      } }, 'Start'),
    ),
  );
  view.append(ul);
  poll = null;
}

async function coachDetail(id: string): Promise<void> {
  const head = h('div');
  const meters = h('div', { class: 'meters' });
  const sources = h('div', { class: 'sources' });
  const style = h('div');
  const uploads = h('div', { class: 'uploads' });
  let v: CustomCoachView | null = null;

  const draw = (next: CustomCoachView | null) => {
    if (!next) {
      coachScreen = 'people';
      void show();
      return;
    }
    v = next;
    const c = next;
    const r = c.readiness;
    clear(head);
    const hasLines = Object.keys(c.lines).length > 0 || !!c.style?.persona;
    add(
      head,
      h('button', { class: 'back', type: 'button', onclick: () => { coachScreen = 'people'; void show(); } }, '‹ Everyone'),
      h('h1', { class: 'who-name' }, c.name),
      c.relation ? h('p', { class: 'muted' }, c.relation) : null,
      c.active
        ? h('p', { class: 'active' }, `✓ ${c.name} is your coach`)
        : hasLines
          ? h('button', { class: 'btn ink', type: 'button', onclick: async () => { await act(() => rpc('coaches:use', c.id), `${c.name} is your coach now.`); await refresh(); } }, `Make ${c.name} my coach`)
          : null,
    );
    clear(meters);
    const wf = Math.min(1, r.words / 3000);
    meters.append(
      h('div', { class: 'meter card' }, h('div', null, h('b', null, fmt(r.words)), ` of ${c.name}'s words`), h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(2, Math.round(Math.sqrt(wf) * 100))}%` })), h('small', null, r.pending ? `${READY_WORD[r.style]} · listening to ${r.pending} more…` : READY_WORD[r.style])),
      h('div', { class: 'meter card voice' }, h('div', null, h('b', null, mmss(r.theirSec)), ` of ${c.name}'s voice`), h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(2, Math.round(Math.min(1, r.theirSec / 120) * 100))}%` })), h('small', null, c.voice ? 'Their voice is made' : r.theirSec >= 60 ? 'Enough to copy their voice (on your Mac)' : 'A minute of them alone copies their voice')),
    );
    clear(sources);
    for (const s of [...c.sources].reverse()) sources.append(sourceRow(c, s));
    clear(style);
    const busy = c.busy === 'distilling';
    add(
      style,
      h('h2', null, 'How they talk'),
      c.lastError ? h('p', { class: 'err' }, c.lastError) : null,
      c.style?.summary ? h('p', { class: 'summary card' }, c.style.summary) : h('p', { class: 'muted small' }, r.canDistill ? `Ready to distill. At ${fmt(800)} words it happens by itself.` : 'Send about 150 of their words to start.'),
      h('button', { class: `btn${c.distilledAt ? '' : ' ink'}`, type: 'button', disabled: busy || !r.canDistill || r.pending > 0, onclick: async () => {
        toast('Claude is reading everything they said. About a minute.');
        const res = await act(() => rpc<{ ok: boolean; error?: string }>('coaches:distill', c.id));
        if (res && !res.ok) toast(res.error ?? 'Distilling failed.', true);
        await refresh();
      } }, busy ? 'Distilling…' : c.distilledAt ? (r.newWords > 0 ? `Distill again (+${fmt(r.newWords)} words)` : 'Distill again') : `Distill ${c.name}'s voice`),
      h('p', { class: 'muted small' }, 'Edit their lines and copy their voice on your Mac (Coach).'),
    );
  };

  const sourceRow = (c: CustomCoachView, s: CoachSource) => {
    const status =
      s.status === 'waiting' ? 'Waiting…'
      : s.status === 'transcribing' ? 'Turning it into words…'
      : s.status === 'error' ? s.error ?? 'Something went wrong.'
      : s.status === 'pick-speaker' ? `${s.speakers?.length ?? 0} voices. Which is ${c.name}?`
      : s.kind === 'recording' ? (s.speaker === 'none' ? `${c.name} isn't in it` : `${fmt(s.words)} words · ${mmss(s.theirSec ?? 0)} of them`)
      : `${fmt(s.words)} words`;
    const row = h('div', { class: `src card st-${s.status}` }, h('div', { class: 'src-top' }, h('span', { class: 'ic' }, s.kind === 'recording' ? '🎙' : '💬'), h('div', null, h('b', null, s.title), h('small', null, status)), h('button', { class: 'x', type: 'button', 'aria-label': `Remove ${s.title}`, onclick: async () => { await act(() => rpc('coaches:removeSource', c.id, s.id)); await refresh(); } }, '×')));
    if (s.status === 'error' && s.kind === 'recording') row.append(h('button', { class: 'btn small', type: 'button', onclick: async () => { await act(() => rpc('coaches:retry', c.id, s.id)); await refresh(); } }, 'Try again'));
    if (s.status === 'pick-speaker') {
      for (const [i, sp] of (s.speakers ?? []).entries()) {
        row.append(
          h('button', { class: 'speaker', type: 'button', onclick: async () => { await act(() => rpc('coaches:pickSpeaker', c.id, s.id, sp.id)); await refresh(); } }, h('b', null, `Voice ${i + 1}`, h('small', null, ` · ${mmss(sp.seconds)}`)), ...sp.quotes.slice(0, 2).map((q) => h('q', null, q)), h('span', { class: 'pick' }, `That's ${c.name}`)),
        );
      }
      row.append(h('button', { class: 'link', type: 'button', onclick: async () => { await act(() => rpc('coaches:pickSpeaker', c.id, s.id, null)); await refresh(); } }, `${c.name} isn't in this one`));
    }
    return row;
  };

  // Sending: recordings and videos from the phone, a fresh video, or pasted messages.
  const files = h('input', { type: 'file', multiple: true, accept: 'audio/*,video/*,.m4a,.mp3,.wav,.aac,.caf,.amr,.mp4,.mov,.txt,.md,.srt,.vtt', hidden: true });
  const camera = h('input', { type: 'file', accept: 'video/*', capture: 'environment', hidden: true });
  const send = async (list: FileList | null) => {
    for (const f of [...(list ?? [])]) {
      if (f.size > 150 * 1024 * 1024) {
        toast(`${f.name} is over 150 MB. Add it on your Mac.`, true);
        continue;
      }
      const bar = h('i');
      const row = h('div', { class: 'up card' }, h('span', null, f.name || 'Recording'), h('div', { class: 'bar' }, bar));
      uploads.append(row);
      const r = await act(() => upload(id, f, (p) => (bar.style.width = `${Math.round(p * 100)}%`)));
      row.remove();
      const res = r as { added?: number; skipped?: { name: string; reason: string }[] } | null;
      if (res?.skipped?.length) toast(res.skipped[0].reason, true);
      else if (res?.added) toast('Sent. Your Mac is turning it into words.');
    }
    files.value = '';
    camera.value = '';
    await refresh();
  };
  files.addEventListener('change', () => void send(files.files));
  camera.addEventListener('change', () => void send(camera.files));
  const pasteTitle = h('input', { type: 'text', placeholder: 'Where from (WeChat with Mum, emails from Sam)', 'aria-label': 'Where it is from' });
  const pasteText = h('textarea', { rows: 6, placeholder: 'Paste their messages. In a chat, keep the names on each line ("Mum: …").', 'aria-label': 'Their messages' });
  const paste = h(
    'div',
    { class: 'card paste', hidden: true },
    pasteTitle,
    pasteText,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => { paste.hidden = true; } }, 'Cancel'), h('button', { class: 'btn ink', type: 'button', onclick: async () => {
      const r = await act(() => rpc<{ ok: boolean; error?: string }>('coaches:addText', id, { title: pasteTitle.value || 'Messages', text: pasteText.value }));
      if (r && !r.ok) {
        toast(r.error ?? "Couldn't add that.", true);
        return;
      }
      pasteTitle.value = '';
      pasteText.value = '';
      paste.hidden = true;
      await refresh();
    } }, 'Add')),
  );

  view.append(
    head,
    meters,
    h(
      'div',
      { class: 'feed-buttons' },
      h('button', { class: 'btn ink', type: 'button', onclick: () => files.click() }, 'Send recordings or files'),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => camera.click() }, 'Record a video'), h('button', { class: 'btn', type: 'button', onclick: () => { paste.hidden = false; pasteText.focus(); } }, 'Paste messages')),
      h('p', { class: 'muted small' }, isIos ? 'Voice memos: in Voice Memos tap ⋯ on one, Save to Files, then pick it here. Videos from your camera roll work too (only the sound is used).' : 'Voice memos, calls and videos all work (only the sound is used).'),
    ),
    files,
    camera,
    paste,
    uploads,
    sources,
    style,
  );
  const refresh = async () => draw(await rpc<CustomCoachView | null>('coaches:get', id));
  await refresh();
  // Keep checking while recordings are being transcribed or Claude is distilling.
  poll = async () => {
    if (v && (v.readiness.pending > 0 || v.busy)) await refresh();
  };
}

// ---- go ---------------------------------------------------------------------------------------------

document.body.classList.toggle('standalone', standalone);
render();
