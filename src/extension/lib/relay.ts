// The crew's wire for the extension: the same ntfy topic as the Mac app, read by polling (a
// service worker can't hold a socket open for hours). start() only says where; poll() reads, on
// an alarm every 30 seconds and every few seconds while the panel is open. ntfy keeps 12 hours
// of messages, so a bomb still lands within the 2 minutes the crew allows.
import type { Relay, RelayMessage } from '../../main/crew/relay';

export interface PollRelayDeps {
  server: () => string;
  onMessage: (m: RelayMessage) => void;
  onState: (connected: boolean, error?: string) => void;
  log: (m: string) => void;
  /** Where to pick up next time (survives the service worker going to sleep). */
  cursor: { get: () => string; set: (id: string) => void };
}

const base = (server: string) => server.trim().replace(/\/+$/, '') || 'https://ntfy.sh';

export class PollRelay implements Relay {
  connected = false;
  private topic = '';
  private since = '';
  private busy: Promise<void> | null = null;

  constructor(private d: PollRelayDeps) {}

  start(topic: string, sinceSec: number): void {
    const resume = this.topic === topic;
    this.topic = topic;
    const sec = Math.max(1, Math.round(sinceSec));
    this.since = resume ? this.since : `${sec}s`;
  }

  stop(): void {
    this.topic = '';
    this.connected = false;
  }

  /** Fetch whatever arrived since last time. */
  poll(): Promise<void> {
    if (!this.topic) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.fetchNew().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async fetchNew(): Promise<void> {
    const topic = this.topic;
    const since = this.d.cursor.get() || this.since || '10m';
    const url = `${base(this.d.server())}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`relay said ${res.status}`);
      const text = await res.text();
      if (topic !== this.topic) return;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let m: { id?: string; time?: number; event?: string; message?: string };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.event !== 'message' || typeof m.message !== 'string') continue;
        if (m.id) this.d.cursor.set(m.id);
        this.d.onMessage({ id: m.id ?? '', time: (m.time ?? Date.now() / 1000) * 1000, text: m.message });
      }
      this.setConnected(true);
    } catch (e) {
      this.setConnected(false, (e as Error).message);
    }
  }

  private setConnected(on: boolean, error?: string): void {
    if (this.connected === on && !error) return;
    this.connected = on;
    this.d.onState(on, error);
  }

  async publish(topic: string, text: string): Promise<boolean> {
    try {
      const res = await fetch(`${base(this.d.server())}/${encodeURIComponent(topic)}`, { method: 'POST', body: text, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) this.d.log(`[crew] relay said ${res.status}`);
      return res.ok;
    } catch (e) {
      this.d.log(`[crew] could not send: ${(e as Error).message}`);
      return false;
    }
  }
}
