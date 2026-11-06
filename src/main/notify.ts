// Fans one event out to every channel the user picked for it:
// corner card, full-screen card, voice, sound, macOS Notification Center,
// menu bar flash, Dock bounce, phone push (ntfy) and Slack/Discord webhook.
import type { ActionButton, Channel, NotifyKind, OverlayPayload, Profile, Settings, SoundId, ToastPayload } from '../shared/types';
import type { Guardrails } from './guardrails';
import { inQuietHours } from './guardrails';

export type Priority = 'low' | 'normal' | 'high' | 'critical';

export interface NotifyPayload {
  kind: NotifyKind;
  title: string;
  body: string;
  /** What the voice says; defaults to the body. */
  speak?: string;
  shout?: boolean;
  priority?: Priority;
  actions?: ActionButton[];
  toastKind?: ToastPayload['kind'];
  autoHideMs?: number;
  /** Used when the "card" channel is on (non-intervention full-screen cards). */
  card?: { cardName: string; tone: 'yellow' | 'red' | 'paper'; meta?: string };
  /** Channels added on top of the user's choice (e.g. a severity-3 roast adds the full-screen card). */
  extra?: Channel[];
  /** Channels the caller handles itself (the coach shows its own interactive card and voice). */
  exclude?: Channel[];
  /** From the test buttons in Settings. */
  test?: boolean;
  /** Passed to the corner card, so its buttons can be traced back (see attention.ts). */
  tag?: string;
}

export interface NotifierDeps {
  settings: () => Settings;
  profile: () => Profile;
  guard: Guardrails;
  inCall: () => boolean;
  /** True while the coach's own full-screen card is up. */
  cardBusy: () => boolean;
  toast: (p: ToastPayload) => void;
  card: (p: OverlayPayload) => void;
  /** Is a distracting browser tab in front, with the extension able to cover it? */
  tabReady?: () => boolean;
  /** The big Lock In card over that tab. */
  tab?: (p: NotifyPayload) => Promise<boolean>;
  speak: (text: string, shout: boolean) => Promise<void>;
  /** Resolves when the sound has finished. */
  sound: (id: SoundId) => Promise<void>;
  system: (title: string, body: string, critical: boolean) => void;
  menubar: (text: string, ms: number) => void;
  dock: (critical: boolean) => void;
  http: typeof fetch;
  log: (m: string) => void;
  now?: () => number;
}

const NTFY_TAGS: Record<NotifyKind, string> = {
  nudge: 'eyes',
  speak: 'loudspeaker',
  yellow: 'yellow_square',
  red: 'red_square,rotating_light',
  todo_roast: 'clipboard,fire',
  todo_win: 'tada',
  routine: 'alarm_clock',
  wellness: 'droplet',
  bedtime: 'zzz',
  session: 'stopwatch',
  meeting: 'calendar',
  deadline: 'hourglass_flowing_sand',
};

const NTFY_PRIORITY: Record<Priority, string> = { low: 'low', normal: 'default', high: 'high', critical: 'urgent' };

const MENUBAR_TEXT: Partial<Record<NotifyKind, string>> = {
  yellow: '🟨 HEY',
  red: '🟥 HEY',
  todo_roast: '📋 HELLO?',
  bedtime: '😴 BED',
  routine: '⏰',
  wellness: '💧',
  speak: '📣',
};

export class Notifier {
  private sent: Record<'phone' | 'webhook', number[]> = { phone: [], webhook: [] };

  constructor(private d: NotifierDeps) {}

  channelsFor(kind: NotifyKind): Channel[] {
    return this.d.settings().notify[kind] ?? [];
  }

  /** Which channels would fire right now, after guardrails. */
  plan(p: NotifyPayload): Channel[] {
    const st = this.d.settings();
    const now = this.d.now?.() ?? Date.now();
    const wanted = new Set<Channel>([...this.channelsFor(p.kind), ...(p.extra ?? [])]);
    for (const c of p.exclude ?? []) wanted.delete(c);
    const inCall = this.d.inCall();
    const muted = this.d.guard.muted(now) && p.kind !== 'session' && p.kind !== 'bedtime';
    const quiet = inQuietHours(st, new Date(now));
    const out: Channel[] = [];
    for (const c of wanted) {
      if (muted && c !== 'toast' && c !== 'menubar') continue;
      if (inCall && (c === 'voice' || c === 'sound' || c === 'card' || c === 'tab')) continue;
      if (c === 'tab' && !this.d.tabReady?.()) continue;
      if (c === 'voice' && !this.d.guard.canSpeak(this.d.profile(), st, inCall, now)) continue;
      if (c === 'sound' && quiet && p.kind !== 'bedtime') continue;
      if (c === 'card' && this.d.cardBusy()) continue;
      if (c === 'phone' && (!st.ntfyTopic.trim() || !this.budget('phone', now))) continue;
      if (c === 'webhook' && (!/^https:\/\//.test(st.webhookUrl.trim()) || !this.budget('webhook', now))) continue;
      out.push(c);
    }
    // A full-screen card replaces the corner card.
    if (out.includes('card') && out.includes('toast')) out.splice(out.indexOf('toast'), 1);
    return out;
  }

  /** Delivers the payload. Resolves after the sound and speech finish (network sends run in the background). */
  async notify(p: NotifyPayload): Promise<Channel[]> {
    const channels = this.plan(p);
    const st = this.d.settings();
    const critical = p.priority === 'critical' || p.kind === 'red';
    const now = this.d.now?.() ?? Date.now();

    for (const c of channels) {
      try {
        switch (c) {
          case 'toast':
            this.d.toast({ kind: p.toastKind ?? 'info', title: p.title, body: p.body, actions: p.actions, autoHideMs: p.autoHideMs, tag: p.tag });
            break;
          case 'card':
            this.d.card({
              interventionId: `notice-${now}`,
              level: p.card?.tone === 'red' ? 4 : p.card?.tone === 'paper' ? 2 : 3,
              line: p.body,
              distraction: '',
              driftMin: 0,
              goal: '',
              options: [],
              canTalk: false,
              cardName: p.card?.cardName ?? p.title,
              meta: p.card?.meta,
              tone: p.card?.tone ?? 'yellow',
              actions: p.actions?.length ? p.actions : [{ id: 'dismiss', label: 'Okay, okay' }],
            });
            break;
          case 'tab':
            void this.d.tab?.(p).catch(() => false);
            break;
          case 'system':
            this.d.system(p.title, p.body, critical);
            break;
          case 'menubar':
            this.d.menubar(MENUBAR_TEXT[p.kind] ?? '❗', critical ? 15_000 : 8_000);
            break;
          case 'dock':
            this.d.dock(critical);
            break;
          case 'phone':
            this.sent.phone.push(now);
            void this.push(st, p).catch((e) => this.d.log(`[notify] phone: ${(e as Error).message}`));
            break;
          case 'webhook':
            this.sent.webhook.push(now);
            void this.webhook(st, p).catch((e) => this.d.log(`[notify] webhook: ${(e as Error).message}`));
            break;
        }
      } catch (e) {
        this.d.log(`[notify] ${c}: ${(e as Error).message}`);
      }
    }

    // Sound first, then the voice, so they don't talk over each other.
    if (channels.includes('sound')) {
      const id = st.sounds[p.kind] ?? 'none';
      if (id !== 'none') await this.d.sound(id).catch(() => undefined);
    }
    if (channels.includes('voice')) await this.d.speak(p.speak ?? p.body, !!p.shout).catch(() => undefined);
    return channels;
  }

  /** Test one channel from Settings, ignoring the routing table and guardrails. */
  async test(channel: Channel): Promise<string> {
    const st = this.d.settings();
    const p: NotifyPayload = { kind: 'yellow', title: 'Lock In test', body: 'This is how Lock In gets your attention.', priority: 'high' };
    switch (channel) {
      case 'phone':
        if (!st.ntfyTopic.trim()) return 'Add an ntfy topic first.';
        return (await this.push(st, p)) ? 'Sent. Check your phone.' : 'ntfy did not accept it. Check the server and topic.';
      case 'webhook':
        if (!/^https:\/\//.test(st.webhookUrl.trim())) return 'Paste a Slack or Discord webhook URL first.';
        return (await this.webhook(st, p)) ? 'Posted.' : 'The webhook did not accept it. Check the URL.';
      case 'system':
        this.d.system(p.title, p.body, false);
        return 'Sent. If nothing shows, allow notifications for Lock In (or Electron) in System Settings.';
      case 'menubar':
        this.d.menubar('🟨 HEY', 6000);
        return 'Flashing the menu bar.';
      case 'dock':
        this.d.dock(true);
        return 'Bouncing the Dock icon (only visible when Lock In is in the background).';
      case 'sound':
        await this.d.sound(st.sounds.yellow);
        return 'Played.';
      case 'voice':
        await this.d.speak('This is how Lock In gets your attention.', false);
        return 'Spoken.';
      case 'toast':
        this.d.toast({ kind: 'info', title: p.title, body: p.body, autoHideMs: 5000 });
        return 'Shown.';
      case 'tab':
        if (!this.d.tab) return 'Not available.';
        return (await this.d.tab({ ...p, kind: 'nudge', test: true, body: 'This is how Lock In covers a distracting tab.' }))
          ? 'Shown in your browser.'
          : 'Open Chrome with the Lock In extension connected (and reloaded after updating), on a normal web page, then try again.';
      case 'card':
        this.d.card({ interventionId: 'test', level: 3, line: p.body, distraction: '', driftMin: 0, goal: '', options: [], canTalk: false, cardName: 'Test card', tone: 'yellow', actions: [{ id: 'dismiss', label: 'Close' }] });
        return 'Shown.';
    }
  }

  private budget(ch: 'phone' | 'webhook', now: number): boolean {
    this.sent[ch] = this.sent[ch].filter((t) => now - t < 3_600_000);
    return this.sent[ch].length < 12;
  }

  private async push(st: Settings, p: NotifyPayload): Promise<boolean> {
    const server = (st.ntfyServer.trim() || 'https://ntfy.sh').replace(/\/+$/, '');
    const res = await this.d.http(`${server}/${encodeURIComponent(st.ntfyTopic.trim())}`, {
      method: 'POST',
      body: p.body,
      headers: {
        'X-Title': p.title,
        'X-Priority': NTFY_PRIORITY[p.priority ?? (p.kind === 'red' ? 'critical' : 'normal')],
        'X-Tags': NTFY_TAGS[p.kind],
      },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  }

  private async webhook(st: Settings, p: NotifyPayload): Promise<boolean> {
    const url = st.webhookUrl.trim();
    const text = `Lock In: ${p.title}. ${p.body}`;
    const body = /discord(app)?\.com\/api\/webhooks/.test(url) ? { content: text } : { text };
    const res = await this.d.http(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return res.ok;
  }
}
