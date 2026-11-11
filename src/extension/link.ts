// The link to Lock In for Mac: a WebSocket to the app on this computer (127.0.0.1:47615; the app
// only lets browser extensions in). Linked, the Mac does the coaching: this reports the tab in
// front, carries out the coach's commands (pause, close, focus, block, the card over the page),
// and runs the panel's actions on the Mac. It also keeps the Mac's live state for the panel.
import type { LiveState } from '../shared/types';

const URL_WS = 'ws://127.0.0.1:47615';

export interface LinkDeps {
  enabled: () => boolean;
  onLinked: () => void;
  onUnlinked: (last: LiveState | null) => void;
  onState: (s: LiveState) => void;
  log: (m: string) => void;
  /** Media playing per tab (from the content script). */
  playing: (tabId: number) => boolean;
}

export class DesktopLink {
  private ws: WebSocket | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  state: LiveState | null = null;
  /** The Mac app runs the panel's actions (an older Lock In only coaches through the extension). */
  full = false;

  constructor(private d: LinkDeps) {}

  /** Lock In for Mac is running and linked: it does the coaching. */
  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (!this.d.enabled()) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(URL_WS);
    } catch {
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.send({ type: 'hello', browser: browserName(), version: chrome.runtime.getManifest().version, caps: ['call', 'state'], name: 'Lock In Extended' });
      void this.reportActive();
      if (this.keepAlive) clearInterval(this.keepAlive);
      // Talking every 20 seconds also keeps Chrome from putting the service worker to sleep.
      this.keepAlive = setInterval(() => this.send({ type: 'ping' }), 20_000);
      this.full = false;
      // An older Mac app has no panel actions: it still coaches, the panel just can't drive it.
      this.call('state:get', [], 4000)
        .then((s) => {
          this.full = true;
          this.state = s as LiveState;
          this.d.onLinked();
        })
        .catch(() => {
          this.d.log('[link] this Lock In for Mac is too old to run the panel; update it');
          this.d.onLinked();
        });
    };
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'cmd') void this.command(msg);
      else if (msg.type === 'state') {
        this.state = msg.state as LiveState;
        this.d.onState(this.state);
      } else if (msg.type === 'result') {
        const p = this.pending.get(String(msg.id));
        if (!p) return;
        this.pending.delete(String(msg.id));
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(String(msg.error ?? 'That did not work.')));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.ws = null;
      this.full = false;
      if (this.keepAlive) clearInterval(this.keepAlive);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Lock In for Mac went away.'));
      }
      this.pending.clear();
      if (opened) this.d.onUnlinked(this.state);
    };
    ws.onerror = () => undefined;
  }

  disconnect(): void {
    try {
      this.ws?.close();
    } catch {
      /* */
    }
  }

  /** Runs one of the Mac panel's actions on the Mac. */
  call<T = unknown>(method: string, args: unknown[] = [], timeoutMs = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Lock In for Mac is not running.'));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Lock In for Mac did not answer.'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ type: 'call', id, method, args });
    });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async reportActive(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || tab.id === undefined) return;
      let focused = true;
      try {
        focused = (await chrome.windows.get(tab.windowId)).focused;
      } catch {
        /* */
      }
      this.send({ type: 'tab', tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title, audible: !!tab.audible, playing: this.d.playing(tab.id), incognito: tab.incognito, focused });
    } catch {
      /* */
    }
  }

  focusLost(): void {
    this.send({ type: 'focus', focused: false });
  }

  media(tabId: number, playing: boolean): void {
    this.send({ type: 'media', tabId, playing });
  }

  // ---- the coach's commands (the same as the plain Lock In extension) ------------------------

  private async command(msg: Record<string, unknown>): Promise<void> {
    let ok = false;
    try {
      switch (msg.cmd) {
        case 'pause_media':
          ok = await pauseMedia();
          break;
        case 'close_tab':
          await chrome.tabs.remove(Number(msg.tabId));
          ok = true;
          break;
        case 'focus_or_open':
          ok = await focusOrOpen(String(msg.url ?? ''), typeof msg.tabId === 'number' ? msg.tabId : undefined);
          break;
        case 'block_domain':
          ok = await blockDomain(String(msg.domain), msg.from ? String(msg.from) : undefined, Number(msg.until) || undefined);
          break;
        case 'unblock_all':
          ok = await unblockMac();
          break;
        case 'card':
          ok = await showCard(msg);
          break;
        case 'reload':
          this.send({ type: 'ack', id: msg.id, ok: true });
          setTimeout(() => chrome.runtime.reload(), 200);
          return;
      }
    } catch (e) {
      this.send({ type: 'ack', id: msg.id, ok: false, error: String(e) });
      return;
    }
    this.send({ type: 'ack', id: msg.id, ok });
  }
}

export function browserName(): string {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] }; brave?: unknown };
  const brands = (nav.userAgentData?.brands ?? []).map((b) => b.brand);
  if (nav.brave) return 'Brave';
  if (brands.includes('Microsoft Edge')) return 'Edge';
  if (brands.includes('Opera')) return 'Opera';
  if (brands.includes('Google Chrome')) return 'Chrome';
  return 'Chromium';
}

async function pauseMedia(): Promise<boolean> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => t.id !== undefined && (t.audible || t.active))
      .map((t) =>
        chrome.scripting
          .executeScript({
            target: { tabId: t.id!, allFrames: true },
            func: () => document.querySelectorAll('video, audio').forEach((m) => (m as HTMLMediaElement).pause()),
          })
          .catch(() => undefined),
      ),
  );
  return true;
}

const sameUrl = (a?: string, b?: string) => !!a && !!b && a.split('#')[0] === b.split('#')[0];

async function focusOrOpen(url: string, tabId?: number): Promise<boolean> {
  let target: chrome.tabs.Tab | null = null;
  if (typeof tabId === 'number') {
    target = await chrome.tabs.get(tabId).catch(() => null);
    if (target && url && !sameUrl(target.url, url)) target = null;
  }
  if (!target && url) target = (await chrome.tabs.query({})).find((t) => sameUrl(t.url, url)) ?? null;
  if (target?.id !== undefined) {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
  } else if (url) await chrome.tabs.create({ url, active: true });
  return true;
}

// The Mac's blocks use rule ids 3000 and up (the extension's own use 1000s and 2000s).
const MAC_RULES = 3000;

async function blockDomain(domain: string, from?: string, until?: number): Promise<boolean> {
  const query = `d=${encodeURIComponent(domain)}${from ? `&from=${encodeURIComponent(from)}` : ''}${until ? `&until=${until}` : ''}`;
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const old = existing.filter((r) => r.id >= MAC_RULES && (r.condition.requestDomains ?? []).includes(domain));
  const id = existing.filter((r) => r.id >= MAC_RULES).reduce((m, r) => Math.max(m, r.id), MAC_RULES) + 1;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: [{ id, priority: 1, action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: `/blocked.html?${query}` } }, condition: { requestDomains: [domain], resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] } }],
  });
  for (const t of await chrome.tabs.query({})) {
    try {
      const host = new URL(t.url ?? '').hostname.replace(/^www\./, '');
      if ((host === domain || host.endsWith(`.${domain}`)) && t.id !== undefined) await chrome.tabs.update(t.id, { url: chrome.runtime.getURL(`blocked.html?${query}`) });
    } catch {
      /* */
    }
  }
  return true;
}

async function unblockMac(): Promise<boolean> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.filter((r) => r.id >= MAC_RULES).map((r) => r.id) });
  return true;
}

/** The Mac's card over a distracting page, for a few seconds (runs in the page). */
function lockInCard(opts: { title?: string; text?: string; goal?: string; seconds?: number; tone?: string }): void {
  const ID = 'lockin-card-host';
  document.getElementById(ID)?.remove();
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  document.querySelectorAll('video, audio').forEach((m) => (m as HTMLMediaElement).pause());
  const secs = Math.max(2, Math.min(15, Number(opts.seconds) || 5));
  const accent = ({ yellow: '#ffcf00', red: '#e5202e', orange: '#ff7a1a', lime: '#d4ff3a' } as Record<string, string>)[opts.tone ?? ''] || '#ffcf00';
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .back{position:fixed;inset:0;display:grid;place-items:center;padding:24px;background:rgba(10,14,18,.72);backdrop-filter:blur(10px) saturate(.6);font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#101820;animation:in .22s ease-out both}
    .back.out{animation:out .35s ease-in both}
    .card{width:min(560px,100%);box-sizing:border-box;padding:34px 36px 26px;border-radius:22px;background:#f3f4f1;box-shadow:0 30px 80px rgba(0,0,0,.45);border-top:10px solid ${accent};animation:pop .32s cubic-bezier(.2,1.4,.4,1) both}
    .brand{font-weight:800;font-size:15px;color:#47515a}
    h1{margin:18px 0 8px;font-size:54px;line-height:1;font-weight:900;letter-spacing:-.02em}
    p{margin:0;font-size:19px;color:#26313b;white-space:pre-wrap;overflow-wrap:anywhere}
    .goal{margin-top:14px;font-size:14px;color:#78818a}
    .bar{margin-top:24px;height:6px;border-radius:3px;background:#e3e5e0;overflow:hidden}
    .bar i{display:block;height:100%;background:#101820;transform-origin:left;animation:shrink ${secs}s linear both}
    @keyframes in{from{opacity:0}}@keyframes out{to{opacity:0}}@keyframes pop{from{transform:scale(.92);opacity:0}}@keyframes shrink{to{transform:scaleX(0)}}
  </style><div class="back" role="alertdialog" aria-modal="true"><div class="card"><div class="brand">Lock In</div><h1 id="t"></h1><p id="b"></p><div class="goal" id="g"></div><div class="bar"><i></i></div></div></div>`;
  root.getElementById('t')!.textContent = String(opts.title || 'Lock in.').slice(0, 60);
  root.getElementById('b')!.textContent = String(opts.text || '').slice(0, 400);
  const goal = root.getElementById('g')!;
  if (opts.goal) goal.textContent = `You said you'd work on: ${String(opts.goal).slice(0, 120)}`;
  else goal.remove();
  const swallow = (e: Event) => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  const evs = ['keydown', 'keyup', 'keypress', 'wheel'];
  evs.forEach((t) => window.addEventListener(t, swallow, { capture: true, passive: false }));
  document.documentElement.appendChild(host);
  setTimeout(() => {
    evs.forEach((t) => window.removeEventListener(t, swallow, { capture: true }));
    root.querySelector('.back')?.classList.add('out');
    setTimeout(() => host.remove(), 360);
  }, secs * 1000);
}

async function showCard(msg: Record<string, unknown>): Promise<boolean> {
  let tabId = typeof msg.tabId === 'number' ? msg.tabId : undefined;
  if (tabId === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab?.id;
  }
  if (tabId === undefined) return false;
  await chrome.scripting.executeScript({ target: { tabId }, func: lockInCard, args: [{ title: String(msg.title ?? ''), text: String(msg.text ?? ''), goal: msg.goal ? String(msg.goal) : undefined, seconds: Number(msg.seconds) || 5, tone: String(msg.tone ?? 'yellow') }] });
  return true;
}
