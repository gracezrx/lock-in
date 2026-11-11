// Lock In Extended's service worker. Two modes, one panel:
//   linked  Lock In for Mac is running: it coaches (it sees every app, not just Chrome), this
//           reports tabs and carries out its commands, and the panel drives the Mac's session,
//           to-dos, goals and crew. It also keeps a copy of you for later.
//   solo    No Mac app: the same engine runs here, on Chrome's tabs (see solo.ts).
import type { LiveState, PanelData } from '../shared/types';
import { DesktopLink } from './link';
import { lockInPage, type PageOp } from './page';
import { Solo, type MacSync, type Tab } from './solo';
import type { Action, PanelView } from './lib/types';

const log = (m: string) => console.log(m);
const framePlaying = new Map<string, boolean>();
const tabPlaying = (tabId: number) => [...framePlaying].some(([k, v]) => v && k.startsWith(`${tabId}:`));

const solo = new Solo({
  log,
  page: showPage,
  speak,
  notify: (title, text) => {
    chrome.notifications.create({ type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: text, priority: 2 }, () => void chrome.runtime.lastError);
  },
  onChange: () => undefined,
});

const link = new DesktopLink({
  enabled: () => solo.d?.settings.link !== false,
  playing: tabPlaying,
  log,
  onLinked: () => void ready.then(onLinked),
  onUnlinked: (last) => void ready.then(() => onUnlinked(last)),
  onState: () => badge(),
});

let macPanel: { at: number; data: PanelData | null } = { at: 0, data: null };

const ready: Promise<void> = (async () => {
  await solo.load();
  solo.linked = false;
  chrome.idle.setDetectionInterval(60);
  link.connect();
  badge();
})();

// ---- what's in front -------------------------------------------------------------------

async function frontTab(): Promise<Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined) return null;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  return { tabId: tab.id, url: tab.url, title: tab.title, focused: !!win?.focused, audible: !!tab.audible, playing: tabPlaying(tab.id), incognito: tab.incognito };
}

async function observe(): Promise<void> {
  await ready;
  const tab = await frontTab();
  await solo.observe(tab);
  void link.reportActive();
  badge();
}

chrome.tabs.onActivated.addListener(() => void observe());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.url || info.title || 'audible' in info || info.status === 'complete')) void observe();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const k of [...framePlaying.keys()]) if (k.startsWith(`${tabId}:`)) framePlaying.delete(k);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    link.focusLost();
    void ready.then(async () => {
      const tab = await frontTab();
      await solo.observe(tab ? { ...tab, focused: false } : null);
    });
  } else void observe();
});
chrome.idle.onStateChanged.addListener((state) => {
  void ready.then(async () => {
    solo.setIdle(state);
    await solo.save();
  });
});

// Every 30 seconds: count time, read the crew's relay, find the Mac app.
chrome.alarms.create('lockin-tick', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'lockin-tick') return;
  void ready.then(async () => {
    link.connect();
    await solo.observe(undefined);
    await solo.pollCrew();
    await solo.refreshCalendar();
    // Linked: keep the copy of you fresh, for when the Mac app isn't running.
    if (link.full && Date.now() - (solo.d.mac?.syncedAt ?? 0) > 5 * 60_000) {
      try {
        solo.absorb(await link.call<MacSync>('ext:sync'));
        await solo.save();
      } catch {
        /* next time */
      }
    }
    badge();
  });
});
chrome.runtime.onStartup.addListener(() => void ready);
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// ---- linking ----------------------------------------------------------------------------

async function onLinked(): Promise<void> {
  const moving = solo.handOver();
  if (!link.full) {
    await solo.save();
    badge();
    return;
  }
  try {
    if (moving && !link.state?.session) await link.call('session:start', [{ goal: moving.goal, minutes: moving.minutes }]);
    const sync = await link.call<MacSync>('ext:sync');
    solo.absorb(sync);
    const out = solo.outbox();
    if (out.sessions.length) await link.call('ext:sessions', [out.sessions]);
    let done = 0;
    for (const op of out.todoOps) {
      if (op.op === 'add') await link.call('todos:add', [op.title]).catch(() => undefined);
      else await link.call('todos:complete', [op.id]).catch(() => undefined);
      done += 1;
    }
    solo.delivered(out.sessions.map((s) => s.id), done);
    // What was sent is on the Mac now: take its list again.
    if (done) solo.absorb(await link.call<MacSync>('ext:sync'));
    await refreshMacPanel(true);
  } catch (e) {
    log(`[link] ${(e as Error).message}`);
  }
  await solo.save();
  badge();
}

async function onUnlinked(last: LiveState | null): Promise<void> {
  const s = last?.session;
  solo.takeOver(s ? { goal: s.goal, plannedMin: s.plannedMin, startedAt: s.startedAt } : null);
  macPanel = { at: 0, data: null };
  await solo.save();
  badge();
}

/** Linked, after a change: take a fresh copy of you, so going solo later starts from it. */
let syncTimer: ReturnType<typeof setTimeout> | undefined;
function syncSoon(): void {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    if (!link.full) return;
    void link
      .call<MacSync>('ext:sync')
      .then(async (s) => {
        solo.absorb(s);
        await solo.save();
      })
      .catch(() => undefined);
  }, 1500);
}

async function refreshMacPanel(force = false): Promise<void> {
  if (!link.full) return;
  if (!force && Date.now() - macPanel.at < 2500) return;
  macPanel.at = Date.now();
  try {
    macPanel.data = await link.call<PanelData>('panel:data');
    link.state = await link.call<LiveState>('state:get');
  } catch {
    /* the Mac went away */
  }
}

// ---- the coach's voice, and what goes on pages --------------------------------------------

function speak(text: string): void {
  const persona = solo.d?.settings.persona ?? 'sassy';
  const rate = { sassy: 1.02, gentle: 0.95, firm: 1, drill: 1.12 }[persona];
  const voiceName = solo.d?.settings.voiceName || undefined;
  chrome.tts.speak(text, { voiceName, rate, enqueue: false }, () => void chrome.runtime.lastError);
}

const FONTS = () => ({
  display: chrome.runtime.getURL('fonts/big-shoulders-display-latin-800-normal.woff2'),
  displayBlack: chrome.runtime.getURL('fonts/big-shoulders-display-latin-900-normal.woff2'),
  body: chrome.runtime.getURL('fonts/public-sans-latin-400-normal.woff2'),
  bodyBold: chrome.runtime.getURL('fonts/public-sans-latin-700-normal.woff2'),
});

async function showPage(op: PageOp, tabId?: number): Promise<boolean> {
  let id = tabId;
  let url: string | undefined;
  if (id === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    id = tab?.id;
    url = tab?.url;
  }
  if (id === undefined || (url && !/^(https?|file):/.test(url))) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: id }, func: lockInPage, args: [op, FONTS()] });
    return true;
  } catch {
    return false;
  }
}

function badge(): void {
  const st = link.connected ? link.state : null;
  const sess = link.connected ? st?.session : solo.session;
  let text = '';
  let color = '#101820';
  if (sess) {
    const planned = 'plannedMin' in sess ? sess.plannedMin : 0;
    const startedAt = 'startedAt' in sess ? sess.startedAt : Date.now();
    const left = Math.max(0, Math.round(planned - (Date.now() - startedAt) / 60_000));
    text = `${left}m`;
    const level = link.connected ? (st?.session?.level ?? 0) : (solo.session?.engine.level ?? 0);
    color = level > 0 ? '#e5202e' : '#1e7f4f';
  }
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
  void chrome.action.setTitle({ title: link.connected ? 'Lock In Extended (linked to your Mac)' : 'Lock In Extended' });
}

// ---- the panel ----------------------------------------------------------------------------

async function voices(): Promise<string[]> {
  return new Promise((resolve) => chrome.tts.getVoices((v) => resolve([...new Set((v ?? []).filter((x) => !x.lang || /^en/i.test(x.lang)).map((x) => x.voiceName ?? '').filter(Boolean))].slice(0, 40))));
}

async function panelView(): Promise<PanelView> {
  await ready;
  const local = solo.view();
  const base = { settings: local.settings, distractions: local.distractions, voices: await voices() };
  if (!link.connected || !link.full) {
    return { ...local, ...base, mode: 'solo', desktop: { connected: link.connected, syncedAt: solo.d.mac?.syncedAt } };
  }
  void refreshMacPanel();
  if (!macPanel.data) await refreshMacPanel(true);
  const st = link.state;
  const pd = macPanel.data;
  const now = Date.now();
  const s = st?.session;
  const cur = st?.current;
  return {
    ...base,
    mode: 'linked',
    desktop: { connected: true, syncedAt: solo.d.mac?.syncedAt },
    session: s
      ? {
          goal: s.goal,
          plannedMin: s.plannedMin,
          startedAt: s.startedAt,
          elapsedSec: Math.round((now - s.startedAt) / 1000),
          focusSec: s.focusSec,
          driftSec: s.driftSec,
          level: s.level,
          status: s.onBreakUntil ? 'break' : s.level > 0 || cur?.label === 'distraction' ? 'drifting' : cur?.label === 'work' ? 'focused' : 'neutral',
          where: s.level > 0 || cur?.label === 'distraction' ? (cur?.domain ?? cur?.app) : undefined,
          onBreakUntil: s.onBreakUntil,
          drift: s.driftThresholdSec ? Math.min(1, s.drift / s.driftThresholdSec) : 0,
        }
      : null,
    current: cur ? { domain: cur.domain ?? cur.app, label: cur.label } : null,
    today: pd?.today ?? local.today,
    todos: { open: (pd?.todos.open ?? []).map((t) => ({ id: t.id, title: t.title, due: t.due })), done: [], canAdd: !!pd?.todos.canAdd, canComplete: !!pd?.todos.canComplete, from: 'your Mac' },
    goals: [...(pd?.goals ?? []).map((g) => ({ id: g.id, name: g.name, daysLeft: g.daysLeft, progress: g.progress, pct: g.pct, tone: g.tone, water: g.kind === 'water' })), ...local.goals.filter((g) => !g.id.startsWith('mac:'))],
    crew: pd?.crew ?? null,
    muteUntil: st?.muteUntil && st.muteUntil > now ? st.muteUntil : undefined,
    lockout: st?.lockout,
    lastGoal: st?.lastGoal ?? local.lastGoal,
    commitment: !!pd?.commitment,
    meeting: st?.calendar?.now || st?.calendar?.next ? { now: st.calendar.now?.title, next: st.calendar.next?.title, nextAt: st.calendar.next?.start } : undefined,
  };
}

async function act(x: Action): Promise<{ ok: boolean; error?: string }> {
  await ready;
  const mac = link.connected && link.full;
  const call = (m: string, ...args: unknown[]) => link.call(m, args);
  try {
    switch (x.a) {
      case 'start':
        if (mac) await call('session:start', { goal: x.goal, minutes: x.minutes });
        else solo.startSession(x.goal, x.minutes);
        break;
      case 'end':
        if (mac) await call('session:end');
        else solo.endSession('user');
        break;
      case 'break':
        if (mac) await call('coach:choose', 'break');
        else solo.startBreak(x.minutes);
        break;
      case 'todo:add':
        if (mac) await call('todos:add', x.title);
        else solo.addTodo(x.title);
        break;
      case 'todo:done':
        if (mac) await call('todos:complete', x.id);
        else solo.doneTodo(x.id, true);
        break;
      case 'todo:undo':
        if (mac) await call('todos:undo', x.id);
        else solo.doneTodo(x.id, false);
        break;
      case 'todo:remove':
        solo.removeTodo(x.id);
        break;
      case 'goal:add':
        solo.addGoal(x.name, x.due);
        break;
      case 'goal:remove':
        solo.removeGoal(x.id);
        break;
      case 'goal:water':
        if (mac) await call('goals:water');
        break;
      case 'label': {
        if (mac) await call('labels:current', x.label);
        const tab = await frontTab();
        const host = tab?.url ? new URL(tab.url).hostname.replace(/^www\./, '') : '';
        if (host) solo.label(host, x.label);
        break;
      }
      case 'mute':
        if (mac) await call('mute', x.minutes);
        solo.mute(x.minutes);
        break;
      case 'unmute':
        if (mac) await call('unmute');
        solo.mute(0);
        break;
      case 'crew:create':
        if (mac) await call('crew:create', { crewName: x.crewName, name: x.name });
        else {
          solo.crew.create(x.crewName, x.name);
          solo.setSettings({ name: x.name });
          await solo.pollCrew();
        }
        break;
      case 'crew:join': {
        if (mac) {
          const r = await call('crew:join', { code: x.code, name: x.name }) as { ok: boolean; error?: string };
          if (!r.ok) return { ok: false, error: r.error };
        } else {
          const r = solo.crew.join(x.code, x.name);
          if (!r.ok) return r;
          solo.setSettings({ name: x.name });
          await solo.pollCrew();
        }
        break;
      }
      case 'crew:leave':
        if (mac) await call('crew:leave');
        await solo.crew.leave();
        break;
      case 'crew:bomb': {
        const r = (mac ? await call('crew:bomb', { to: x.to, insult: x.insult }) : await solo.crew.throwBomb(x.to, x.insult)) as { ok: boolean; error?: string };
        if (!r.ok) return { ok: false, error: r.error };
        break;
      }
      case 'settings':
        // Linked, the coach and its patience are the Mac's: change them there too.
        if (mac && (x.patch.persona || x.patch.toleranceMin)) await call('ext:profile', { persona: x.patch.persona, toleranceMin: x.patch.toleranceMin });
        solo.setSettings(x.patch);
        if (x.patch.link === false) link.disconnect();
        if (x.patch.link === true) link.connect();
        break;
      case 'distraction:add':
        solo.addDistraction(x.domain);
        break;
      case 'distraction:remove':
        solo.removeDistraction(x.domain);
        break;
      case 'voice:test':
        speak(`Hi${solo.d.settings.name ? ` ${solo.d.settings.name}` : ''}. This is how I'll sound when you drift.`);
        break;
      case 'mac:open':
        if (mac) await call('panel:open', x.route ?? 'settings');
        else return { ok: false, error: 'Lock In for Mac is not running.' };
        break;
      case 'mac:talk':
        if (mac) await call('talk:open', 'checkin');
        break;
      case 'relink':
        link.connect();
        break;
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    await solo.save();
    if (mac) {
      void refreshMacPanel(true);
      syncSoon();
    }
    badge();
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'media' && sender.tab?.id !== undefined) {
    framePlaying.set(`${sender.tab.id}:${sender.frameId ?? 0}`, !!msg.playing);
    if (sender.tab.active) link.media(sender.tab.id, tabPlaying(sender.tab.id));
    return;
  }
  if (msg.type === 'page') {
    void ready.then(async () => {
      await solo.choose(String(msg.id ?? ''), String(msg.choice ?? ''));
      await solo.save();
    });
    return;
  }
  // The panel and the welcome page are the extension's own pages, never a website.
  if (sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith('http')) return;
  if (msg.type === 'panel') {
    void (async () => {
      if (msg.poll) {
        await ready;
        await solo.observe(undefined);
        await solo.pollCrew();
      }
      reply(await panelView());
    })();
    return true;
  }
  if (msg.type === 'act') {
    void act(msg.action as Action).then(async (r) => reply({ ...r, view: await panelView() }));
    return true;
  }
});

// For poking at it from the service worker's console (chrome://extensions → Inspect views).
(globalThis as unknown as { lockin: unknown }).lockin = { solo, link, panelView, act };
