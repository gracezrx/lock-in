// Local link to the browser extension: a WebSocket server on 127.0.0.1 that only
// accepts connections from browser extensions (web pages cannot fake that origin).
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export const BRIDGE_PORT = 47615;

export interface TabState {
  tabId: number;
  windowId: number;
  url?: string;
  title?: string;
  audible: boolean;
  playing: boolean;
  incognito: boolean;
}

/** "0.2.0" > "0.1.0". */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((x) => Number(x) || 0);
  const pb = b.split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

interface Conn {
  ws: WebSocket;
  browser: string;
  /** The extension's version, from its hello. */
  version?: string;
  tab: TabState | null;
  focused: boolean;
  updatedAt: number;
}

export type ExtensionCommand =
  | { cmd: 'pause_media' }
  | { cmd: 'close_tab'; tabId: number }
  | { cmd: 'focus_or_open'; url: string; tabId?: number }
  | { cmd: 'block_domain'; domain: string; from?: string; until?: number }
  | { cmd: 'unblock_all' }
  /** The big Lock In card over the page (extension 0.2.0+). */
  | { cmd: 'card'; tabId?: number; title: string; text: string; goal?: string; seconds: number; tone: 'yellow' | 'red' | 'orange' | 'lime' }
  /** Reload the extension from disk (0.2.0+). */
  | { cmd: 'reload' };

export class Bridge {
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  private pending = new Map<string, (ok: boolean) => void>();

  private reloadAsked = new Set<string>();

  /** `bundled` is the version of the extension that ships with this Lock In. */
  constructor(private log: (msg: string) => void, private onChange: () => void, private bundled: () => string | null = () => null) {}

  /** A connected extension older than the one on disk (it needs a reload in chrome://extensions). */
  get outdated(): boolean {
    const want = this.bundled();
    if (!want) return false;
    for (const c of this.conns) if (c.ws.readyState === WebSocket.OPEN && newerVersion(want, c.version ?? '0')) return true;
    return false;
  }

  /** Can the connected extension show the card over a page? */
  get canCard(): boolean {
    for (const c of this.conns) if (c.ws.readyState === WebSocket.OPEN && !newerVersion('0.2.0', c.version ?? '0')) return true;
    return false;
  }

  start(): void {
    try {
      this.wss = new WebSocketServer({
        host: '127.0.0.1',
        port: BRIDGE_PORT,
        verifyClient: (info: { origin: string }) => {
          const origin = info.origin ?? '';
          return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
        },
      });
    } catch (e) {
      this.log(`[bridge] could not start: ${(e as Error).message}`);
      return;
    }
    this.wss.on('error', (e) => this.log(`[bridge] ${e.message}`));
    this.wss.on('connection', (ws) => {
      const conn: Conn = { ws, browser: 'browser', tab: null, focused: false, updatedAt: Date.now() };
      this.conns.add(conn);
      this.onChange();
      ws.on('message', (raw) => this.handle(conn, String(raw)));
      ws.on('close', () => {
        this.conns.delete(conn);
        this.onChange();
      });
      ws.on('error', () => undefined);
    });
    this.log(`[bridge] listening on 127.0.0.1:${BRIDGE_PORT}`);
  }

  get connected(): boolean {
    for (const c of this.conns) if (c.ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  /** The active tab of the browser window that most recently had focus. */
  activeTab(): (TabState & { browser: string }) | null {
    let best: Conn | null = null;
    for (const c of this.conns) {
      if (!c.tab) continue;
      if (!best || (c.focused && !best.focused) || (c.focused === best.focused && c.updatedAt > best.updatedAt)) best = c;
    }
    return best?.tab ? { ...best.tab, browser: best.browser } : null;
  }

  /** Send a command to every connected browser (or only the last focused one); true if any succeeded. */
  async send(command: ExtensionCommand, target: 'all' | 'active' = 'all'): Promise<boolean> {
    let targets = [...this.conns].filter((c) => c.ws.readyState === WebSocket.OPEN);
    if (target === 'active' && targets.length > 1) {
      targets.sort((a, b) => Number(b.focused) - Number(a.focused) || b.updatedAt - a.updatedAt);
      targets = targets.slice(0, 1);
    }
    if (!targets.length) return false;
    const results = await Promise.all(
      targets.map(
        (c) =>
          new Promise<boolean>((resolve) => {
            const id = randomUUID();
            const timer = setTimeout(() => {
              this.pending.delete(id);
              resolve(false);
            }, 3000);
            this.pending.set(id, (ok) => {
              clearTimeout(timer);
              resolve(ok);
            });
            c.ws.send(JSON.stringify({ type: 'cmd', id, ...command }));
          }),
      ),
    );
    return results.some(Boolean);
  }

  stop(): void {
    for (const c of this.conns) c.ws.close();
    this.wss?.close();
  }

  private handle(conn: Conn, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    conn.updatedAt = Date.now();
    switch (msg.type) {
      case 'hello': {
        conn.browser = String(msg.browser ?? 'browser');
        conn.version = String(msg.version ?? '0');
        const want = this.bundled();
        // Lock In was updated: an extension that knows how reloads itself from disk (once per version).
        if (want && newerVersion(want, conn.version) && !newerVersion('0.2.0', conn.version) && !this.reloadAsked.has(conn.version)) {
          this.reloadAsked.add(conn.version);
          this.log(`[bridge] extension ${conn.version} is older than ${want}; asking it to reload`);
          conn.ws.send(JSON.stringify({ type: 'cmd', id: randomUUID(), cmd: 'reload' }));
        } else if (want && newerVersion(want, conn.version)) {
          this.log(`[bridge] extension ${conn.version} is older than ${want}; reload it in chrome://extensions`);
        }
        this.onChange();
        break;
      }
      case 'tab': {
        const t = msg as unknown as TabState & { focused?: boolean };
        conn.tab = {
          tabId: Number(t.tabId),
          windowId: Number(t.windowId),
          url: t.url ? String(t.url) : undefined,
          title: t.title ? String(t.title) : undefined,
          audible: !!t.audible,
          playing: !!t.playing,
          incognito: !!t.incognito,
        };
        if (typeof t.focused === 'boolean') conn.focused = t.focused;
        break;
      }
      case 'focus':
        conn.focused = !!msg.focused;
        break;
      case 'media':
        if (conn.tab && Number(msg.tabId) === conn.tab.tabId) conn.tab.playing = !!msg.playing;
        break;
      case 'ack': {
        const cb = this.pending.get(String(msg.id));
        if (cb) {
          this.pending.delete(String(msg.id));
          cb(!!msg.ok);
        }
        break;
      }
      case 'ping':
        conn.ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }
}
