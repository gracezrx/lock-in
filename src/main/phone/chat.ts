// Talking to the coach from your phone: a typed conversation (the phone keyboard's mic turns
// speech into text) run by the same Talk logic as the Mac panel, so the coach can log what you
// did, start a session or add a to-do. Replies come back as text, and as audio in the coach's
// voice for the phone to play.
import { randomBytes } from 'node:crypto';
import type { Talk, TalkEvent, TalkStart } from '../talk/talk';

export type ChatEvent = TalkEvent | { type: 'audio'; id: string };

export interface ChatHooks {
  show: (p: TalkStart) => void;
  send: (e: TalkEvent) => void;
  hide: () => void;
  speak: (text: string) => Promise<void>;
}

export class PhoneChat {
  readonly talk: Talk;
  private events: ChatEvent[] = [];
  private audio = new Map<string, Buffer>();
  private speaking: Promise<void> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private quiet = false;

  constructor(make: (hooks: ChatHooks) => Talk, private tts: (text: string) => Promise<Buffer | null>, private idleMs = 15 * 60_000) {
    this.talk = make({
      show: (p) => this.events.push({ type: 'agent', text: p.opener }),
      send: (e) => this.events.push(e),
      hide: () => this.events.push({ type: 'end' }),
      speak: (text) => {
        if (this.quiet) return Promise.resolve();
        this.speaking = this.voice(text);
        return this.speaking;
      },
    });
  }

  private async voice(text: string): Promise<void> {
    try {
      const buf = await this.tts(text);
      if (!buf) return;
      const id = randomBytes(8).toString('hex');
      this.audio.set(id, buf);
      // Only the last few replies are kept.
      while (this.audio.size > 6) this.audio.delete(this.audio.keys().next().value as string);
      this.events.push({ type: 'audio', id });
    } catch {
      /* text still arrives */
    }
  }

  private async drain(): Promise<ChatEvent[]> {
    // Wait (a little) for the reply's audio, so text and voice arrive together.
    await Promise.race([this.speaking, new Promise((r) => setTimeout(r, 8000))]);
    const out = this.events;
    this.events = [];
    return out;
  }

  private keepAlive(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.end(), this.idleMs);
    this.idle.unref?.();
  }

  async start(): Promise<ChatEvent[]> {
    if (!this.talk.isOpen) await this.talk.start('checkin', { focus: false });
    this.keepAlive();
    return this.drain();
  }

  async say(text: string): Promise<ChatEvent[]> {
    const msg = String(text ?? '').trim().slice(0, 2000);
    if (!msg) return [];
    if (!this.talk.isOpen) {
      // You're already talking: no opener needed.
      this.quiet = true;
      try {
        await this.talk.start('checkin', { focus: false });
      } finally {
        this.quiet = false;
      }
      this.events = [];
    }
    this.keepAlive();
    await this.talk.text(msg);
    return this.drain();
  }

  end(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.talk.closed();
    this.events = [];
  }

  sound(id: string): Buffer | null {
    return this.audio.get(id) ?? null;
  }
}
