// The wire between friends: one ntfy topic per crew (ntfy.sh by default, or your own server).
// We subscribe over a WebSocket and publish with a plain POST. Messages are already encrypted.
import { WebSocket } from 'ws';

export interface RelayMessage {
  id: string;
  time: number;
  text: string;
}

export interface Relay {
  start(topic: string, sinceSec: number): void;
  stop(): void;
  publish(topic: string, text: string): Promise<boolean>;
  connected: boolean;
}

export interface NtfyRelayDeps {
  server: () => string;
  onMessage: (m: RelayMessage) => void;
  onState: (connected: boolean, error?: string) => void;
  log: (m: string) => void;
  http?: typeof fetch;
  socket?: (url: string) => WebSocket;
}

export function relayUrls(server: string, topic: string, since: string): { ws: string; post: string } {
  const base = server.trim().replace(/\/+$/, '') || 'https://ntfy.sh';
  return {
    post: `${base}/${encodeURIComponent(topic)}`,
    ws: `${base.replace(/^http/i, 'ws')}/${encodeURIComponent(topic)}/ws?since=${encodeURIComponent(since)}`,
  };
}

export class NtfyRelay implements Relay {
  private ws: WebSocket | null = null;
  private topic = '';
  private lastId = '';
  private retry = 0;
  private timer: NodeJS.Timeout | null = null;
  private alive = false;
  connected = false;

  constructor(private d: NtfyRelayDeps) {}

  start(topic: string, sinceSec: number): void {
    this.stop();
    this.topic = topic;
    this.alive = true;
    this.lastId = '';
    const sec = Math.max(1, Math.round(sinceSec));
    this.open(sec % 3600 === 0 ? `${sec / 3600}h` : `${sec}s`);
  }

  private open(since: string): void {
    if (!this.alive) return;
    const { ws: url } = relayUrls(this.d.server(), this.topic, since);
    let ws: WebSocket;
    try {
      ws = this.d.socket ? this.d.socket(url) : new WebSocket(url, { handshakeTimeout: 15_000 });
    } catch (e) {
      this.fail((e as Error).message);
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      this.setConnected(true);
    });
    ws.on('message', (raw) => {
      let m: { id?: string; time?: number; event?: string; message?: string };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.event !== 'message' || typeof m.message !== 'string') return;
      if (m.id) this.lastId = m.id;
      this.d.onMessage({ id: m.id ?? '', time: (m.time ?? Date.now() / 1000) * 1000, text: m.message });
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.fail('');
    });
    ws.on('error', (e) => this.d.log(`[crew] relay: ${e.message}`));
  }

  private fail(reason: string): void {
    this.setConnected(false, reason || undefined);
    if (!this.alive) return;
    // Back off: 2 s, 4 s, 8 s… up to a minute. Pick up where we left off.
    const wait = Math.min(60_000, 2000 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.open(this.lastId || '10m'), wait);
  }

  private setConnected(on: boolean, error?: string): void {
    if (this.connected === on && !error) return;
    this.connected = on;
    this.d.onState(on, error);
  }

  stop(): void {
    this.alive = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    this.connected = false;
  }

  async publish(topic: string, text: string): Promise<boolean> {
    const { post } = relayUrls(this.d.server(), topic, '0');
    try {
      const res = await (this.d.http ?? fetch)(post, { method: 'POST', body: text, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) this.d.log(`[crew] relay said ${res.status} ${(await res.text()).slice(0, 120)}`);
      return res.ok;
    } catch (e) {
      this.d.log(`[crew] could not send: ${(e as Error).message}`);
      return false;
    }
  }
}
