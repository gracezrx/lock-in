// Talking with Lock In: a live voice conversation (ElevenLabs agent) in a small panel at
// the top right, or a typed chat when voice is not available. What you say you did lands on
// your done list; the coach can also start a session, give you space, or add a to-do.
import type { Persona, Settings } from '../../shared/types';
import type { Block, Claude, Msg } from '../coach/llm';
import { cleanSpoken } from '../coach/llm';
import type { ElevenAgent } from './agent';
import { claudeTools, dynamicVariables, filledPrompt, type Situation, type TalkContext } from './prompt';

export interface TalkStart {
  mode: 'voice' | 'text';
  signedUrl?: string;
  dynamicVariables: Record<string, string>;
  opener: string;
  title: string;
  volume: number;
  maxMinutes: number;
  /** Shown at the top of the panel, e.g. why voice is off. */
  notice?: string;
  /** False when it opened on its own (after a roast): don't take the keyboard from what you're typing in. */
  focus: boolean;
}

export type TalkEvent =
  | { type: 'agent'; text: string }
  | { type: 'logged'; ticked: string[]; added: string[] }
  | { type: 'action'; text: string }
  | { type: 'notice'; text: string }
  | { type: 'end' };

export interface TalkActions {
  /** Returns a short description of what happened, for the agent. */
  startFocus(goal: string, minutes: number): string;
  snooze(minutes: number): string;
  route(option: 'back' | 'break' | 'is_work', minutes?: number): Promise<string>;
  addTodo(title: string): Promise<string>;
  logDone(items: string[] | string, via: 'said' | 'typed'): Promise<{ ticked: string[]; added: string[]; already?: string[] }>;
}

export interface TalkDeps {
  agent: ElevenAgent;
  claude: Claude;
  hasVoiceKey: () => boolean;
  settings: () => Settings;
  persona: () => Persona;
  context: (situation: Situation, detail?: string) => TalkContext;
  actions: TalkActions;
  show: (p: TalkStart) => void;
  send: (e: TalkEvent) => void;
  hide: () => void;
  speak: (text: string) => Promise<void>;
  logTurn: (speaker: 'user' | 'coach', text: string) => void;
  log: (m: string) => void;
}

const SITUATION_TITLE: Record<Situation, string> = {
  checkin: 'Talk to Lock In',
  roast: 'Explain yourself',
  drift: 'Talk it out',
  midday: 'Midday check-in',
  shutdown: 'End of day',
  kickoff: 'Morning',
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export class Talk {
  isOpen = false;
  mode: 'voice' | 'text' = 'text';
  situation: Situation = 'checkin';
  private onEnd: (() => void) | null = null;
  private history: Msg[] = [];
  private vars: Record<string, string> = {};
  private busy = false;

  constructor(private d: TalkDeps) {}

  get voiceReady(): boolean {
    return this.d.hasVoiceKey();
  }

  /** Opens the panel and starts talking. `first` replaces the opening line. */
  async start(situation: Situation, opts: { detail?: string; first?: string; onEnd?: () => void; focus?: boolean } = {}): Promise<void> {
    if (this.isOpen) {
      this.d.send({ type: 'notice', text: 'Already talking. Say what you did, or press End.' });
      return;
    }
    this.isOpen = true;
    this.situation = situation;
    this.onEnd = opts.onEnd ?? null;
    this.history = [];
    const ctx = this.d.context(situation, opts.detail);
    this.vars = dynamicVariables(ctx, opts.first);
    const st = this.d.settings();
    let signedUrl: string | undefined;
    let notice: string | undefined;
    if (this.d.hasVoiceKey()) {
      try {
        signedUrl = await this.d.agent.signedUrl();
      } catch (e) {
        notice = `Voice is off: ${(e as Error).message} You can type instead.`;
        this.d.log(`[talk] ${(e as Error).message}`);
      }
    } else {
      notice = 'Add your ElevenLabs key in Settings, Keys to talk out loud. For now, type.';
    }
    if (!this.isOpen) return; // closed while connecting
    this.mode = signedUrl ? 'voice' : 'text';
    this.d.log(`[talk] start ${situation} (${this.mode})`);
    this.d.show({
      mode: this.mode,
      signedUrl,
      dynamicVariables: this.vars,
      opener: this.vars.opener,
      title: SITUATION_TITLE[situation],
      volume: st.volumeCap,
      maxMinutes: st.talk.maxMinutes,
      notice,
      focus: opts.focus !== false,
    });
    if (this.mode === 'text') {
      // The panel shows the opener itself; say it out loud too.
      this.history.push({ role: 'assistant', content: this.vars.opener });
      void this.d.speak(this.vars.opener);
    }
  }

  /** The panel closed (End, a sign-off, silence, or the time limit). */
  closed(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.d.hide();
    const cb = this.onEnd;
    this.onEnd = null;
    this.d.log('[talk] closed');
    cb?.();
  }

  /** Close from Lock In itself (hotkey, mute). */
  close(): void {
    if (!this.isOpen) return;
    this.d.send({ type: 'end' });
    setTimeout(() => this.closed(), 1500).unref?.();
  }

  /** An action the coach took during the conversation. Returns what to tell it. */
  async tool(name: string, params: Record<string, unknown>): Promise<string> {
    this.d.log(`[talk] tool ${name} ${JSON.stringify(params).slice(0, 200)}`);
    try {
      switch (name) {
        case 'log_done': {
          const raw = params.items;
          const items = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw : [];
          const r = await this.d.actions.logDone(items, this.mode === 'voice' ? 'said' : 'typed');
          if (r.ticked.length || r.added.length) this.d.send({ type: 'logged', ticked: r.ticked, added: r.added });
          const parts = [];
          if (r.ticked.length) parts.push(`Ticked off their list: ${r.ticked.join('; ')}.`);
          if (r.added.length) parts.push(`Added to today's done list: ${r.added.join('; ')}.`);
          if (r.already?.length) parts.push(`Already done earlier today: ${r.already.join('; ')}.`);
          return parts.join(' ') || 'Nothing to log.';
        }
        case 'start_focus': {
          const goal = String(params.goal ?? '').trim() || 'Deep work';
          const out = this.d.actions.startFocus(goal, clamp(Number(params.minutes) || 50, 10, 120));
          this.d.send({ type: 'action', text: out });
          return `${out} Say a short send-off and end the conversation.`;
        }
        case 'snooze_nagging': {
          const out = this.d.actions.snooze(clamp(Number(params.minutes) || 30, 10, 120));
          this.d.send({ type: 'action', text: out });
          return out;
        }
        case 'back_to_work':
        case 'start_break':
        case 'mark_current_as_work': {
          const opt = name === 'back_to_work' ? 'back' : name === 'start_break' ? 'break' : 'is_work';
          const out = await this.d.actions.route(opt, Number(params.minutes) || undefined);
          this.d.send({ type: 'action', text: out });
          return out;
        }
        case 'add_todo': {
          const out = await this.d.actions.addTodo(String(params.title ?? '').trim());
          this.d.send({ type: 'action', text: out });
          return out;
        }
        case 'end_conversation':
          return 'ok';
        default:
          return 'Unknown action.';
      }
    } catch (e) {
      this.d.log(`[talk] tool ${name} failed: ${(e as Error).message}`);
      return `That did not work: ${(e as Error).message}`;
    }
  }

  /** A line said or typed during the conversation (for the coach log). */
  transcript(role: 'user' | 'agent', text: string): void {
    if (text.trim()) this.d.logTurn(role === 'user' ? 'user' : 'coach', text.trim());
  }

  /** Typed chat (no voice): Claude with the same actions when there is a key, simple parsing otherwise. */
  async text(message: string): Promise<void> {
    const msg = message.trim();
    if (!msg || this.busy) return;
    this.busy = true;
    this.transcript('user', msg);
    try {
      const reply = this.d.claude.available ? await this.claudeTurn(msg) : null;
      const say = reply ?? (await this.simpleTurn(msg));
      if (!this.isOpen) return;
      this.d.send({ type: 'agent', text: say });
      this.transcript('agent', say);
      void this.d.speak(say);
      if (this.endAfterReply) {
        this.endAfterReply = false;
        setTimeout(() => this.close(), 2500).unref?.();
      }
    } finally {
      this.busy = false;
    }
  }

  private endAfterReply = false;

  private async claudeTurn(msg: string): Promise<string | null> {
    const st = this.d.settings();
    this.history.push({ role: 'user', content: msg });
    const system = `${filledPrompt(this.vars)}\n\nThis conversation is typed, not spoken. Keep replies to one or two short sentences.`;
    for (let i = 0; i < 4; i++) {
      const res = await this.d.claude.messages({ model: st.coachModel, system, messages: this.history, tools: claudeTools(), maxTokens: 300, timeoutMs: 12_000 });
      if (!res) {
        this.history.pop();
        return null;
      }
      this.history.push({ role: 'assistant', content: res.content });
      const uses = res.content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      const text = cleanSpoken(res.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(' '));
      if (!uses.length) return text || 'Mm-hm.';
      const results: Block[] = [];
      for (const u of uses) {
        if (u.name === 'end_conversation') this.endAfterReply = true;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: await this.tool(u.name, u.input) });
      }
      this.history.push({ role: 'user', content: results });
      if (text && this.endAfterReply) return text;
    }
    return 'Okay.';
  }

  private async simpleTurn(msg: string): Promise<string> {
    if (/^(bye|thanks|thank you|ok(ay)?|cool|got it|later|that'?s it|done|nothing else)[.! ]*$/i.test(msg)) {
      this.endAfterReply = true;
      return 'Okay. Go get the next thing done.';
    }
    const r = await this.d.actions.logDone(msg, 'typed');
    const n = r.ticked.length + r.added.length;
    if (n) this.d.send({ type: 'logged', ticked: r.ticked, added: r.added });
    if (!n && r.already?.length) return `You already ticked that off today. What else?`;
    const p = this.d.persona();
    const top = /^"([^"]+)"/.exec(this.vars.open_tasks ?? '')?.[1];
    const next = top && !r.ticked.includes(top) ? ` Next up: ${top}. Want to lock in on it?` : ' What is next?';
    if (!n) return "Tell me what you got done, like: sent the deck, called the bank.";
    if (p === 'sassy') return `Fine. ${n === 1 ? 'That counts' : n === 2 ? 'Both count' : `All ${n} count`}, I guess.${next}`;
    if (p === 'drill') return `Logged ${n}.${next}`;
    if (p === 'gentle') return `Nice, I logged ${n === 1 ? 'that' : `all ${n}`}.${next}`;
    return `Logged.${next}`;
  }
}
