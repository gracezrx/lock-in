// Lock In extension: reports the active tab to the desktop app over a local
// WebSocket and carries out the coach's commands (pause, close, focus, block).
const PORT = 47615;
const URL_WS = `ws://127.0.0.1:${PORT}`;

let ws = null;
let keepAlive = null;
/** `${tabId}:${frameId}` → playing */
const framePlaying = new Map();

function browserName() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand);
  if (navigator.brave) return 'Brave';
  if (brands.includes('Microsoft Edge')) return 'Edge';
  if (brands.includes('Opera')) return 'Opera';
  if (brands.includes('Google Chrome')) return 'Chrome';
  return 'Chromium';
}

function tabPlaying(tabId) {
  for (const [k, v] of framePlaying) if (v && k.startsWith(`${tabId}:`)) return true;
  return false;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? '' : 'off' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#6b6b6b' }).catch(() => {});
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(URL_WS);
  } catch {
    ws = null;
    return;
  }
  ws.onopen = () => {
    send({ type: 'hello', browser: browserName(), version: chrome.runtime.getManifest().version });
    reportActive();
    setBadge(true);
    clearInterval(keepAlive);
    keepAlive = setInterval(() => send({ type: 'ping' }), 20000);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'cmd') handleCommand(msg);
  };
  ws.onclose = () => {
    ws = null;
    clearInterval(keepAlive);
    setBadge(false);
  };
  ws.onerror = () => {};
}

async function reportActive() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    let focused = true;
    try {
      const win = await chrome.windows.get(tab.windowId);
      focused = win.focused;
    } catch {}
    send({
      type: 'tab',
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
      audible: !!tab.audible,
      playing: tabPlaying(tab.id),
      incognito: tab.incognito,
      focused,
    });
  } catch {}
}

async function pauseMedia() {
  const tabs = await chrome.tabs.query({});
  const targets = tabs.filter((t) => t.audible || tabPlaying(t.id) || t.active);
  await Promise.all(
    targets.map((t) =>
      chrome.scripting
        .executeScript({
          target: { tabId: t.id, allFrames: true },
          func: () => {
            document.querySelectorAll('video, audio').forEach((m) => {
              try {
                m.pause();
              } catch {}
            });
          },
        })
        .catch(() => {}),
    ),
  );
  return true;
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  return a.split('#')[0] === b.split('#')[0];
}

async function focusOrOpen(url, tabId) {
  let target = null;
  if (typeof tabId === 'number') {
    try {
      target = await chrome.tabs.get(tabId);
      if (url && !sameUrl(target.url, url)) target = null;
    } catch {
      target = null;
    }
  }
  if (!target && url) {
    const tabs = await chrome.tabs.query({});
    target = tabs.find((t) => sameUrl(t.url, url)) || null;
  }
  if (target) {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } else if (url) {
    await chrome.tabs.create({ url, active: true });
  }
  return true;
}

/**
 * Blocks a site until Lock In says otherwise. `from` and `until`: a friend's Lock In bomb, so the
 * blocked page says whose it was and counts down.
 */
async function blockDomain(domain, from, until) {
  const query = `d=${encodeURIComponent(domain)}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${Number(until)}` : ''}`;
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const old = existing.filter((r) => (r.condition.requestDomains || []).includes(domain));
  const id = existing.reduce((m, r) => Math.max(m, r.id), 999) + 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: [
      {
        id,
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: `/blocked.html?${query}` } },
        condition: { requestDomains: [domain], resourceTypes: ['main_frame'] },
      },
    ],
  });
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    try {
      const host = new URL(t.url).hostname.replace(/^www\./, '');
      if (host === domain || host.endsWith('.' + domain)) {
        await chrome.tabs.update(t.id, { url: chrome.runtime.getURL(`blocked.html?${query}`) });
      }
    } catch {}
  }
  return true;
}

async function unblockAll() {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
  return true;
}

/**
 * The big Lock In card over a distracting page, for a few seconds. Runs inside the page, in a
 * closed shadow root so the site's styles can't touch it (and it can't touch the site's).
 */
function lockInCard(opts) {
  const ID = 'lockin-card-host';
  const old = document.getElementById(ID);
  if (old) old.remove();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.querySelectorAll('video, audio').forEach((m) => {
    try {
      m.pause();
    } catch {}
  });
  const secs = Math.max(2, Math.min(15, Number(opts.seconds) || 5));
  const accent = { yellow: '#ffcf00', red: '#e5202e', orange: '#ff7a1a', lime: '#d4ff3a' }[opts.tone] || '#d4ff3a';
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .back { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(10, 14, 18, 0.72);
        backdrop-filter: blur(10px) saturate(0.6); -webkit-backdrop-filter: blur(10px) saturate(0.6);
        font: 16px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; color: #101820;
        animation: in 0.22s ease-out both; cursor: default; }
      .back.out { animation: out 0.35s ease-in both; }
      .card { width: min(560px, 100%); box-sizing: border-box; padding: 34px 36px 26px; border-radius: 22px; background: #f3f4f1;
        box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45); border-top: 10px solid ${accent}; animation: pop 0.32s cubic-bezier(.2,1.4,.4,1) both; }
      .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 15px; letter-spacing: 0.01em; color: #47515a; }
      .brand svg { width: 30px; height: 30px; flex: none; }
      h1 { margin: 18px 0 8px; font-size: 54px; line-height: 1; font-weight: 900; letter-spacing: -0.02em; color: #101820; }
      p { margin: 0; font-size: 19px; color: #26313b; white-space: pre-wrap; overflow-wrap: anywhere; }
      .goal { margin-top: 14px; font-size: 14px; color: #78818a; }
      .bar { margin-top: 24px; height: 6px; border-radius: 3px; background: #e3e5e0; overflow: hidden; }
      .bar i { display: block; height: 100%; background: #101820; transform-origin: left; animation: shrink ${secs}s linear both; }
      .count { margin-top: 8px; font-size: 13px; color: #78818a; }
      @keyframes in { from { opacity: 0 } }
      @keyframes out { to { opacity: 0 } }
      @keyframes pop { from { transform: scale(0.92); opacity: 0 } }
      @keyframes shrink { to { transform: scaleX(0) } }
      @media (prefers-reduced-motion: reduce) { .back, .card, .bar i { animation-duration: 0.01s; } }
    </style>
    <div class="back" role="alertdialog" aria-modal="true" aria-labelledby="t" aria-describedby="b">
      <div class="card">
        <div class="brand"><svg viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" rx="230" fill="#111"/><g transform="translate(512 512) scale(0.82) translate(-512 -529)"><path d="M375 526V430a137 137 0 0 1 274 0V526" fill="none" stroke="#d4ff3a" stroke-width="70"/><rect x="292" y="486" width="440" height="314" rx="48" fill="#d4ff3a"/><circle cx="512" cy="615" r="42" fill="#111"/><rect x="491" y="622" width="42" height="94" rx="20" fill="#111"/></g></svg>Lock In</div>
        <h1 id="t"></h1>
        <p id="b"></p>
        <div class="goal" id="g"></div>
        <div class="bar"><i></i></div>
        <div class="count" id="c"></div>
      </div>
    </div>`;
  root.getElementById('t').textContent = String(opts.title || 'Lock in.').slice(0, 60);
  root.getElementById('b').textContent = String(opts.text || '').slice(0, 400);
  const goal = root.getElementById('g');
  if (opts.goal) goal.textContent = `You said you'd work on: ${String(opts.goal).slice(0, 120)}`;
  else goal.remove();
  const count = root.getElementById('c');
  // While it's up, the page can't be clicked or typed into (no sneaky space-bar to resume the video).
  const swallow = (e) => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  const evs = ['keydown', 'keyup', 'keypress', 'wheel'];
  evs.forEach((t) => window.addEventListener(t, swallow, { capture: true, passive: false }));
  document.documentElement.appendChild(host);
  let left = secs;
  const tick = () => {
    count.textContent = left > 0 ? `Back to the page in ${left}…` : '';
  };
  tick();
  const timer = setInterval(() => {
    left -= 1;
    tick();
    if (left <= 0) {
      clearInterval(timer);
      evs.forEach((t) => window.removeEventListener(t, swallow, { capture: true }));
      root.querySelector('.back').classList.add('out');
      setTimeout(() => host.remove(), 360);
    }
  }, 1000);
}

async function showCard(msg) {
  let tabId = msg.tabId;
  if (typeof tabId !== 'number') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return false;
    tabId = tab.id;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    func: lockInCard,
    args: [{ title: msg.title, text: msg.text, goal: msg.goal, seconds: msg.seconds, tone: msg.tone }],
  });
  return true;
}

async function handleCommand(msg) {
  let ok = false;
  try {
    switch (msg.cmd) {
      case 'pause_media':
        ok = await pauseMedia();
        break;
      case 'close_tab':
        await chrome.tabs.remove(msg.tabId);
        ok = true;
        break;
      case 'focus_or_open':
        ok = await focusOrOpen(msg.url, msg.tabId);
        break;
      case 'block_domain':
        ok = await blockDomain(msg.domain, msg.from, msg.until);
        break;
      case 'unblock_all':
        ok = await unblockAll();
        break;
      case 'card':
        ok = await showCard(msg);
        break;
      case 'reload':
        // A newer version is on disk (Lock In was updated): pick it up.
        send({ type: 'ack', id: msg.id, ok: true });
        setTimeout(() => chrome.runtime.reload(), 200);
        return;
    }
  } catch (e) {
    send({ type: 'ack', id: msg.id, ok: false, error: String(e) });
    return;
  }
  send({ type: 'ack', id: msg.id, ok });
}

chrome.tabs.onActivated.addListener(() => reportActive());
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab.active && (info.url || info.title || 'audible' in info || info.status === 'complete')) reportActive();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const k of [...framePlaying.keys()]) if (k.startsWith(`${tabId}:`)) framePlaying.delete(k);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) send({ type: 'focus', focused: false });
  else reportActive();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'media' && sender.tab) {
    framePlaying.set(`${sender.tab.id}:${sender.frameId ?? 0}`, !!msg.playing);
    if (sender.tab.active) send({ type: 'media', tabId: sender.tab.id, playing: tabPlaying(sender.tab.id) });
    return;
  }
  if (msg && msg.type === 'status') {
    sendResponse({ connected: !!ws && ws.readyState === WebSocket.OPEN });
    return;
  }
  if (msg && msg.type === 'reconnect') {
    connect();
    sendResponse({ ok: true });
  }
});

chrome.alarms.create('lockin-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'lockin-reconnect') connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
