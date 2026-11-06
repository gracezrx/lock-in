// The coach: turns ladder levels into nudges, spoken call-outs and overlays,
// listens for answers, and routes the user back to work.
import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import type {
  Channel, InterventionRecord, LabeledSample, LastWork, Level, NotifyKind, OptionButton, OverlayPayload, Persona, Profile, RouteOption,
  SessionRecord, Settings, Task, ToastPayload,
} from '../../shared/types';
import type { NotifyPayload } from '../notify';
import { OPTION_LABELS } from '../../shared/types';
import type { Classifier } from '../engine/classifier';
import type { Session } from '../engine/session';
import type { Guardrails } from '../guardrails';
import type { Router } from '../router';
import type { Store } from '../store';
import { confirmLine, levelLine, miscLine, parseReply, repeatLine, unclearLine, wellbeingLine, type LineCtx } from './lines';
import {
  COACH_TOOLS, TOOL_TO_OPTION, cleanSpoken, coachSystem, contextText, recapLine, starterStep,
  type Block, type Claude, type Msg,
} from './llm';
import type { Voice } from './voice';

export interface CoachUI {
  showToast(p: ToastPayload): void;
  hideToast(kind?: ToastPayload['kind']): void;
  showOverlay(p: OverlayPayload): void;
  updateOverlay(p: Partial<OverlayPayload>): void;
  hideOverlay(): void;
  refresh(): void;
}

export interface CoachDeps {
  store: Store;
  profile: () => Profile;
  settings: () => Settings;
  classifier: Classifier;
  claude: Claude;
  voice: Voice;
  router: Router;
  guard: Guardrails;
  ui: CoachUI;
  session: () => Session | null;
  endSession: (by: 'user' | 'timer') => void;
  current: () => LabeledSample | null;
  log: (m: string) => void;
  /** The notification router: extra channels (sound, macOS, menu bar, Dock, phone, webhook) and session messages. */
  notify: (p: NotifyPayload) => Promise<unknown>;
  channels: (kind: NotifyKind) => Channel[];
  todos: () => { open: number; overdue: number; done: number; top?: Task } | null;
  /** Hands "talk it out" to the live voice conversation. False when it is not available. */
  liveTalk?: (o: { detail: string; onEnd: () => void }) => boolean;
}

const LEVEL_KIND: Record<1 | 2 | 3 | 4, NotifyKind> = { 1: 'nudge', 2: 'speak', 3: 'yellow', 4: 'red' };

interface Active {
  rec: InterventionRecord;
  sample: LabeledSample;
  line: string;
  messages: Msg[];
  pendingResults: Block[];
  repeatTimer: ReturnType<typeof setInterval> | null;
  talkTimer: ReturnType<typeof setTimeout> | null;
  talkTurns: number;
  talkMode: boolean;
  preview: boolean;
  spoken: boolean;
  busy: boolean;
  listening: boolean;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Background timers must never keep the process alive on their own. */
function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

export function workName(lw: LastWork | null | undefined): string {
  if (!lw) return 'your work';
  if (lw.documentPath) return basename(lw.documentPath, extname(lw.documentPath));
  if (lw.title) return lw.title.split(/\s+[-–—|]\s+/)[0].slice(0, 48);
  return lw.app;
}

export class Coach {
  active: Active | null = null;
  wellbeing = false;
  private breakCheckAt = 0;
  private lastInterventionAt = 0;
  private returnWatch: InterventionRecord[] = [];

  constructor(private d: CoachDeps) {}

  // ---------------------------------------------------------------------------
  // Engine events

  async onLevel(level: Level, reason: 'score' | 'pattern' | 'repeat' | 'break_over', s: LabeledSample): Promise<void> {
    const sess = this.d.session();
    if (!sess || sess.onBreakUntil || level === 0) return;
    if (this.d.guard.muted()) {
      sess.engine.acknowledge();
      return;
    }
    if (s.inCall) return;
    const now = Date.now();
    if (this.active && !this.active.preview) {
      if (this.active.talkMode) return;
      this.active.rec.level = level;
      if (s.label === 'distraction') this.active.sample = s;
      this.d.store.logIntervention(this.active.rec);
    } else {
      this.clearActive();
      const rec: InterventionRecord = {
        id: randomUUID(),
        sessionId: sess.record.id,
        level,
        trigger: reason === 'pattern' ? 'pattern' : reason === 'repeat' ? 'repeat' : reason === 'break_over' ? 'break_over' : 'score',
        distraction: s.domain ?? s.app,
        startedAt: now,
      };
      sess.record.interventions += 1;
      this.lastInterventionAt = now;
      this.d.store.logIntervention(rec);
      this.active = this.newActive(rec, s, false);
    }
    await this.present(level);
  }

  onRecovered(): void {
    const a = this.active;
    if (!a || a.preview) return;
    a.rec.option = 'self';
    a.rec.resolvedAt = Date.now();
    a.rec.secToReturn = Math.round((a.rec.resolvedAt - a.rec.startedAt) / 1000);
    a.rec.worked = true;
    this.d.store.logIntervention(a.rec);
    this.clearActive();
    this.resumeEngine();
    this.d.ui.showToast({ kind: 'info', title: 'Back on track', body: confirmLine('self', this.persona(), this.ctx(null)), autoHideMs: 4000 });
    this.d.ui.refresh();
  }

  async onAwayCheckin(): Promise<void> {
    const line = miscLine('away', this.persona(), this.ctx(null));
    await this.d.notify({ kind: 'session', title: 'Still there?', body: line, autoHideMs: 20_000 });
  }

  async onTick(s: LabeledSample | null, sess: Session, now = Date.now()): Promise<void> {
    if (s) {
      for (const rec of [...this.returnWatch]) {
        if (s.label === 'work' && rec.resolvedAt && rec.secToReturn === undefined) {
          rec.secToReturn = Math.round((now - rec.resolvedAt) / 1000);
          this.d.store.logIntervention(rec);
        }
      }
    }

    if (sess.onBreakUntil && now >= sess.onBreakUntil) {
      sess.endBreak();
      this.d.ui.hideToast('break');
      const line = miscLine('breakOver', this.persona(), this.ctx(null));
      this.breakCheckAt = now + 60_000;
      void this.d.notify({ kind: 'session', title: "Break's over", body: line, autoHideMs: 60_000, actions: [{ id: 'route:back', label: OPTION_LABELS.back }] });
    }

    if (this.breakCheckAt && now >= this.breakCheckAt) {
      this.breakCheckAt = 0;
      if (s && s.label !== 'work') {
        for (const ev of sess.engine.force(2)) if (ev.type === 'level') await this.onLevel(ev.level, 'break_over', s);
      }
    }

    if (!sess.halfwayDone && sess.elapsedSec(now) >= sess.record.plannedMin * 30) {
      sess.halfwayDone = true;
      if (!this.active && sess.record.plannedMin >= 20) {
        const line = miscLine('halfway', this.persona(), { ...this.ctx(null), focus: Math.round(sess.record.focusSec / 60) });
        void this.d.notify({ kind: 'session', title: 'Halfway', body: line, autoHideMs: 8000 });
      }
    }

    if (!this.active && sess.engine.workStreakSec >= 1500 && now - sess.streakPraisedAt > 1_500_000) {
      sess.streakPraisedAt = now;
      const line = miscLine('streak', this.persona(), this.ctx(null));
      void this.d.notify({ kind: 'session', title: '25-minute streak', body: line, autoHideMs: 8000 });
    }
  }

  async onSessionEnd(rec: SessionRecord): Promise<void> {
    this.clearActive();
    this.d.ui.hideOverlay();
    this.d.ui.hideToast();
    this.wellbeing = false;
    this.breakCheckAt = 0;
    void this.d.router.unblockAll();
    const focusMin = Math.round(rec.focusSec / 60);
    const totalMin = Math.max(1, Math.round(((rec.endedAt ?? Date.now()) - rec.startedAt) / 60_000));
    const top = Object.entries(rec.topDistractions).sort((a, b) => b[1] - a[1])[0];
    const template =
      `Session done. ${focusMin} focused minute${focusMin === 1 ? '' : 's'} out of ${totalMin}. ` +
      (rec.interventions === 0 ? 'Not a single call-out. Clean run.' : `${rec.interventions} drift${rec.interventions === 1 ? '' : 's'}${top ? `, mostly ${top[0]}` : ''}.`);
    let line = template;
    if (this.d.claude.available) {
      const facts = `Goal: ${rec.goal || 'focused work'}. Planned ${rec.plannedMin} min, ran ${totalMin} min. Focused ${focusMin} min. Distracted ${Math.round(rec.driftSec / 60)} min. Interventions: ${rec.interventions}. Top distraction: ${top ? `${top[0]} (${Math.round(top[1] / 60)} min)` : 'none'}. Highest level reached: ${rec.maxLevel}. Ended by: ${rec.endedBy}.`;
      line = (await recapLine(this.d.claude, this.d.settings(), this.persona(), facts)) ?? template;
    }
    await this.d.notify({ kind: 'session', title: 'Session recap', body: line, autoHideMs: 20_000, actions: [{ id: 'open:today', label: 'See your progress' }] });
  }

  // ---------------------------------------------------------------------------
  // User actions

  /** A route-back option was picked by button, voice keyword or the model's tool call. */
  async choose(option: RouteOption, via: 'button' | 'voice' | 'model', args: Record<string, unknown> = {}, sayOverride?: string, quiet = false): Promise<void> {
    const a = this.active;
    const sess = this.d.session();
    const persona = this.persona();
    const st = this.d.settings();
    this.d.voice.stop();
    this.d.voice.stopListening();

    if (option === 'talk' && a) return this.startTalk(a);
    if (option === 'end' && st.commitmentMode && a && !a.preview) {
      const line = 'Commitment mode is on. End the session from the Lock In window if you really mean it.';
      this.d.ui.updateOverlay({ status: line });
      await this.speakActive(line, false);
      return;
    }

    const c = this.ctx(a);
    if (a?.preview) {
      this.clearActive();
      this.d.ui.hideOverlay();
      this.d.ui.hideToast();
      await this.sayIfAllowed(sayOverride || confirmLine(option === 'talk' ? 'back' : option, persona, { ...c, n: st.breakMinutes, step: 'Write the first sentence.' }));
      return;
    }

    if (a) {
      a.rec.option = option;
      a.rec.resolvedAt = Date.now();
      this.d.store.logIntervention(a.rec);
      this.d.store.logTurn({ interventionId: a.rec.id, speaker: 'user', text: `[${via}] ${option}`, createdAt: Date.now() });
      this.watchReturn(a.rec);
    }
    this.clearActive();
    this.d.ui.hideOverlay();
    this.d.ui.hideToast();
    this.resumeEngine();

    let line = '';
    switch (option) {
      case 'back': {
        if (sess?.onBreakUntil) sess.endBreak();
        if (a && a.rec.level >= 2) await this.d.router.pauseMedia();
        if (a && a.rec.level >= 3 && a.sample.browser && a.sample.tabId !== undefined && a.sample.label === 'distraction') {
          await this.d.router.closeTab(a.sample.tabId);
        }
        await this.d.router.openWork(sess?.lastWork ?? null);
        sess?.engine.acknowledge();
        line = sayOverride || confirmLine('back', persona, c);
        break;
      }
      case 'starter': {
        const step =
          (typeof args.step === 'string' && cleanSpoken(args.step)) ||
          (this.d.claude.available ? await starterStep(this.d.claude, st, sess?.record.goal ?? '', c.work) : null) ||
          `Open ${c.work} and do the very next small piece of ${c.goal || 'your work'}.`;
        await this.d.router.pauseMedia();
        await this.d.router.openWork(sess?.lastWork ?? null);
        sess?.engine.acknowledge();
        const ends = Date.now() + 5 * 60_000;
        this.d.ui.showToast({ kind: 'starter', title: 'Your 5-minute starter', body: step, timerEndsAt: ends });
        later(() => {
          if (this.d.session() === sess && !this.active) {
            this.d.ui.showToast({ kind: 'checkin', title: 'Starter done', body: 'Five minutes in. Keep the momentum going.', autoHideMs: 8000 });
          }
        }, 5 * 60_000);
        line = sayOverride ? `${sayOverride} ${step}` : confirmLine('starter', persona, { ...c, step: /[.!?]$/.test(step) ? step : `${step}.` });
        break;
      }
      case 'break': {
        const n = clamp(Math.round(Number(args.minutes) || st.breakMinutes), 3, 15);
        if (sess) {
          sess.startBreak(n);
          await this.d.router.unblockAll();
          this.d.ui.showToast({ kind: 'break', title: 'On a break', body: `${n} minutes. Distractions allowed. I will call you back.`, timerEndsAt: sess.onBreakUntil, options: [{ id: 'back', label: 'End break early' }] });
        }
        line = sayOverride || confirmLine('break', persona, { ...c, n });
        break;
      }
      case 'is_work': {
        if (a) this.d.classifier.setUserLabel(a.sample, 'work');
        sess?.engine.acknowledge();
        line = sayOverride || confirmLine('is_work', persona, c);
        break;
      }
      case 'end': {
        if (sayOverride) await this.sayIfAllowed(sayOverride);
        this.d.endSession('user');
        return;
      }
      case 'talk':
        break;
    }
    this.d.ui.refresh();
    if (line && !quiet) await this.sayIfAllowed(line);
  }

  /** A typed or transcribed answer to the coach. */
  async reply(text: string, via: 'voice' | 'typed'): Promise<void> {
    const a = this.active;
    if (!a || a.busy || !text.trim()) return;
    a.busy = true;
    this.d.store.logTurn({ interventionId: a.rec.id, speaker: 'user', text, createdAt: Date.now() });
    this.d.ui.updateOverlay({ status: `You said: "${text}"` });
    try {
      const kw = parseReply(text);
      if (kw === 'wellbeing') {
        this.wellbeing = true;
        const line = wellbeingLine(this.ctx(a));
        a.line = line;
        this.d.ui.showOverlay(this.overlayPayload(a, ['break', 'end', 'back']));
        await this.speakActive(line, false);
        return;
      }
      if (this.d.claude.available && !a.preview) {
        const r = await this.modelTurn(a, text);
        if (r?.option) {
          a.busy = false;
          await this.choose(r.option, 'model', r.args, r.say || undefined);
          return;
        }
        if (r?.say) {
          a.talkTurns += 1;
          a.line = r.say;
          this.d.ui.updateOverlay({ line: r.say, status: '' });
          await this.speakActive(r.say, false);
          if (a.talkTurns < 5 && this.active === a) void this.autoListen(a);
          return;
        }
      }
      if (kw) {
        a.busy = false;
        await this.choose(kw, via === 'voice' ? 'voice' : 'button');
        return;
      }
      const line = unclearLine();
      this.d.ui.updateOverlay({ line, status: '' });
      await this.speakActive(line, false);
      a.talkTurns += 1;
      if (a.talkTurns < 3 && this.active === a) void this.autoListen(a);
    } finally {
      a.busy = false;
    }
  }

  /** Push-to-talk (hotkey or the overlay's mic button). */
  async pushToTalk(): Promise<void> {
    if (this.d.voice.recording) {
      this.d.voice.stopListening();
      return;
    }
    if (!this.active) return;
    await this.autoListen(this.active, true);
  }

  /** Settings → "Test the coach": shows and speaks a level without a session. */
  async preview(level: 1 | 2 | 3 | 4): Promise<void> {
    this.clearActive();
    const now = Date.now();
    const sample: LabeledSample = {
      t: now, app: 'Google Chrome', domain: 'youtube.com', title: 'Top 10 fails of the year', browser: true, idleSec: 0,
      mediaPlaying: true, inCall: false, isPrivate: false, label: 'distraction', weight: 1.5, itemKey: 'site:youtube.com', source: 'rule',
    };
    const rec: InterventionRecord = { id: randomUUID(), sessionId: 'preview', level, trigger: 'manual', distraction: 'youtube.com', startedAt: now };
    this.active = this.newActive(rec, sample, true);
    await this.present(level);
  }

  /** Mute: drop whatever intervention is open, stop talking, clear the ladder. */
  silence(): void {
    this.d.voice.stop();
    this.d.voice.stopListening();
    const a = this.active;
    if (a && !a.preview) {
      a.rec.option = 'self';
      a.rec.resolvedAt = Date.now();
      this.d.store.logIntervention(a.rec);
    }
    this.clearActive();
    this.d.ui.hideOverlay();
    this.d.ui.hideToast();
    this.resumeEngine();
    this.d.session()?.engine.acknowledge();
  }

  dismissPreview(): void {
    if (this.active?.preview) {
      this.clearActive();
      this.d.ui.hideOverlay();
      this.d.ui.hideToast();
    }
  }

  // ---------------------------------------------------------------------------
  // Presenting a level

  private async present(level: Level): Promise<void> {
    const a = this.active;
    if (!a) return;
    const persona = this.persona();
    const c = this.ctx(a);
    const shownLevel = (this.wellbeing ? Math.min(level, 2) : level) as Level;

    const kind = LEVEL_KIND[shownLevel as 1 | 2 | 3 | 4];
    const ch = this.d.channels(kind);

    if (shownLevel === 1) {
      a.line = levelLine(1, persona, c);
      if (ch.includes('toast')) this.d.ui.showToast({ kind: 'nudge', title: 'Drifting', body: a.line, options: this.buttons(['back', 'break']), interventionId: a.rec.id });
      void this.extras(kind, 'Drifting', a.line, a);
      return;
    }

    if (shownLevel === 2) {
      a.line = levelLine(2, persona, c);
      const voiceOk = ch.includes('voice') && this.voiceAllowed(a);
      const title = `${Math.max(1, Math.round(c.min))} min on ${c.site}`;
      if (ch.includes('toast')) {
        this.d.ui.showToast({
          kind: 'speak',
          title,
          body: a.line,
          options: this.buttons(this.order().slice(0, 3)),
          canTalk: voiceOk && this.d.profile().voice.listen && this.d.voice.canListen,
          interventionId: a.rec.id,
        });
      }
      await this.extras(kind, title, a.line, a);
      if (voiceOk && this.active === a) {
        await this.speakActive(a.line, persona === 'drill');
        if (this.active === a) void this.autoListen(a);
      }
      return;
    }

    // Levels 3 and 4: pause media, take over the screen, speak a live line.
    if (!a.preview) {
      await this.d.router.pauseMedia();
      if (shownLevel === 4) {
        if (a.sample.browser && a.sample.domain) await this.d.router.blockDomain(a.sample.domain);
        else if (!a.sample.browser && a.sample.label === 'distraction') await this.d.router.hideApp(a.sample.app);
      }
    }
    this.d.ui.hideToast();
    const canned = levelLine(shownLevel as 3 | 4, persona, c);
    a.line = canned;
    const useCard = ch.includes('card') || !ch.includes('toast');
    const showSurface = (line: string) => {
      if (useCard) this.d.ui.showOverlay({ ...this.overlayPayload(a), line });
      else this.d.ui.showToast({ kind: 'speak', title: shownLevel === 4 ? 'Red card' : 'Yellow card', body: line, options: this.buttons([...this.order(), 'is_work']), canTalk: this.d.profile().voice.listen && this.d.voice.canListen, interventionId: a.rec.id });
    };
    showSurface(canned);
    const [live] = await Promise.all([this.liveLine(a, shownLevel, canned, 2500), this.extras(kind, shownLevel === 4 ? 'Red card' : 'Yellow card', `${c.site}: ${canned}`, a)]);
    if (this.active !== a) return;
    a.line = live;
    if (useCard) this.d.ui.updateOverlay({ line: live, level: shownLevel });
    else showSurface(live);
    if (ch.includes('voice') && this.voiceAllowed(a)) {
      const shout = !this.wellbeing && (persona === 'drill' || (persona === 'sassy' && shownLevel === 4));
      await this.speakActive(live, shout);
      if (this.active === a) void this.autoListen(a);
    }
    this.startRepeat(a);
  }

  private startRepeat(a: Active): void {
    if (a.repeatTimer) clearInterval(a.repeatTimer);
    a.repeatTimer = setInterval(async () => {
      if (this.active !== a || a.busy || a.listening || a.talkMode || this.d.voice.speaking) return;
      const persona = this.persona();
      const c = this.ctx(a);
      const line = await this.liveLine(a, a.rec.level, repeatLine(persona, c), 2500, true);
      if (this.active !== a) return;
      a.line = line;
      this.d.ui.updateOverlay({ line });
      if (this.voiceAllowed(a)) {
        await this.speakActive(line, persona === 'drill' && !this.wellbeing);
        if (this.active === a) void this.autoListen(a);
      }
    }, 30_000);
    a.repeatTimer.unref?.();
  }

  private async liveLine(a: Active, level: number, fallback: string, timeoutMs: number, repeat = false): Promise<string> {
    if (!this.d.claude.available || a.preview) return fallback;
    const st = this.d.settings();
    const prompt =
      `${contextText(this.pack(a))}\n\n` +
      (repeat
        ? `The user has not responded to your last line ("${a.line}"). Say a new, different line (do not repeat yourself).`
        : `Trigger: ladder level ${level}. ${level === 4 ? 'The site is now blocked for the rest of the session.' : 'Their video has been paused.'} Say your call-out line.`);
    const line = await this.d.claude.text({ model: st.coachModel, system: coachSystem(this.d.profile().persona, st.profanityOk, this.wellbeing), prompt, maxTokens: 80, timeoutMs });
    return line && line.length > 3 ? line : fallback;
  }

  private async modelTurn(a: Active, text: string): Promise<{ say: string; option?: RouteOption; args?: Record<string, unknown> } | null> {
    const st = this.d.settings();
    if (a.messages.length === 0) {
      a.messages.push({ role: 'user', content: `${contextText(this.pack(a))}\n\nTrigger: ladder level ${a.rec.level}. Say your line.` });
      a.messages.push({ role: 'assistant', content: a.line });
    }
    const content: Block[] = [...a.pendingResults, { type: 'text', text: `The user replied out loud: "${text}"` }];
    a.pendingResults = [];
    a.messages.push({ role: 'user', content });
    const res = await this.d.claude.messages({
      model: st.coachModel,
      system: coachSystem(this.d.profile().persona, st.profanityOk, this.wellbeing),
      messages: a.messages,
      tools: COACH_TOOLS,
      maxTokens: 300,
      timeoutMs: 8000,
    });
    if (!res) {
      a.messages.pop();
      return null;
    }
    a.messages.push({ role: 'assistant', content: res.content });
    const say = cleanSpoken(res.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(' '));
    const tool = res.content.find((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (say) this.d.store.logTurn({ interventionId: a.rec.id, speaker: 'coach', text: say, toolCall: tool?.name, createdAt: Date.now() });
    if (tool) {
      a.pendingResults.push({ type: 'tool_result', tool_use_id: tool.id, content: 'done' });
      return { say, option: TOOL_TO_OPTION[tool.name], args: tool.input };
    }
    return { say };
  }

  private async startTalk(a: Active): Promise<void> {
    const c0 = this.ctx(a);
    const live =
      !a.preview &&
      this.d.liveTalk?.({
        detail: `Their session goal: "${c0.goal || 'focused work'}". They drifted to ${c0.site} for about ${Math.round(c0.min)} minutes.`,
        onEnd: () => {
          if (this.active === a && a.talkMode) void this.choose('back', 'button', {}, undefined, true);
        },
      });
    if (live) {
      a.talkMode = true;
      const s = this.d.session();
      if (s) s.engine.paused = true;
      if (a.repeatTimer) clearInterval(a.repeatTimer);
      a.repeatTimer = null;
      this.d.voice.stop();
      this.d.ui.hideOverlay();
      this.d.ui.hideToast();
      return;
    }
    a.talkMode = true;
    const sess = this.d.session();
    if (sess && !a.preview) sess.engine.paused = true;
    if (a.repeatTimer) clearInterval(a.repeatTimer);
    a.repeatTimer = null;
    const line = confirmLine('talk', this.persona(), this.ctx(a));
    a.line = line;
    this.d.ui.hideToast();
    this.d.ui.showOverlay({ ...this.overlayPayload(a, ['back', 'starter', 'break', 'end']), status: 'Talk it out' });
    a.talkTimer = later(() => {
      if (this.active === a && a.talkMode) void this.choose('back', 'button');
    }, 150_000);
    await this.speakActive(line, false, true);
    if (this.active === a) void this.autoListen(a, true);
  }

  private async autoListen(a: Active, force = false): Promise<void> {
    const p = this.d.profile();
    if (this.active !== a || a.listening) return;
    if (!force && (!p.voice.listen || !this.voiceAllowed(a))) return;
    if (!this.d.voice.canListen) {
      this.d.ui.updateOverlay({ status: 'Add an ElevenLabs key in Settings to answer by voice. You can type instead.' });
      return;
    }
    a.listening = true;
    this.d.ui.updateOverlay({ status: 'Listening…' });
    this.d.ui.refresh();
    const text = await this.d.voice.listen(15_000);
    a.listening = false;
    if (this.active !== a) return;
    this.d.ui.updateOverlay({ status: '' });
    if (text) await this.reply(text, 'voice');
  }

  // ---------------------------------------------------------------------------
  // Helpers

  private newActive(rec: InterventionRecord, sample: LabeledSample, preview: boolean): Active {
    return { rec, sample, line: '', messages: [], pendingResults: [], repeatTimer: null, talkTimer: null, talkTurns: 0, talkMode: false, preview, spoken: false, busy: false, listening: false };
  }

  private clearActive(): void {
    const a = this.active;
    if (!a) return;
    if (a.repeatTimer) clearInterval(a.repeatTimer);
    if (a.talkTimer) clearTimeout(a.talkTimer);
    this.active = null;
  }

  private resumeEngine(): void {
    const sess = this.d.session();
    if (sess && sess.engine.paused && !sess.onBreakUntil) sess.engine.paused = false;
  }

  private watchReturn(rec: InterventionRecord): void {
    this.returnWatch.push(rec);
    const resolvedAt = rec.resolvedAt ?? Date.now();
    later(() => {
      const cur = this.d.current();
      const returned = cur?.label === 'work' || rec.secToReturn !== undefined;
      later(() => {
        rec.worked = returned && this.lastInterventionAt <= resolvedAt;
        this.d.store.logIntervention(rec);
        this.returnWatch = this.returnWatch.filter((r) => r !== rec);
      }, 10 * 60_000);
    }, 2 * 60_000);
  }

  private persona(): Persona {
    return this.wellbeing ? 'gentle' : this.d.profile().persona;
  }

  private order(): RouteOption[] {
    const seen = new Set<RouteOption>();
    const out: RouteOption[] = [];
    for (const o of [...this.d.profile().routeBackOrder, 'back', 'starter', 'break', 'talk'] as RouteOption[]) {
      if (!seen.has(o) && o !== 'is_work' && o !== 'end') {
        seen.add(o);
        out.push(o);
      }
    }
    return out;
  }

  private buttons(ids: RouteOption[]): OptionButton[] {
    return ids.map((id) => ({ id, label: id === 'break' ? `${OPTION_LABELS.break} (${this.d.settings().breakMinutes} min)` : OPTION_LABELS[id] }));
  }

  private overlayPayload(a: Active, ids?: RouteOption[]): OverlayPayload {
    const sess = this.d.session();
    const c = this.ctx(a);
    const all = (ids ?? [...this.order(), 'is_work', 'end']).filter((o) => o !== 'end' || !this.d.settings().commitmentMode);
    const p = this.d.profile();
    return {
      interventionId: a.rec.id,
      level: (this.wellbeing ? Math.min(a.rec.level, 2) : a.rec.level) as Level,
      line: a.line,
      distraction: c.site,
      driftMin: Math.max(1, Math.round(c.min)),
      goal: sess?.record.goal ?? 'your goal',
      options: this.buttons(all),
      status: '',
      canTalk: p.voice.listen && this.d.voice.canListen,
    };
  }

  private ctx(a: Active | null): LineCtx {
    const sess = this.d.session();
    const site = a ? a.sample.domain ?? a.sample.app : 'that';
    const min = a && sess ? (sess.record.topDistractions[site] ?? 0) / 60 : a?.preview ? 9 : 0;
    const t = this.d.todos();
    return {
      site,
      goal: sess?.record.goal || (a?.preview ? 'your goal' : ''),
      min: Math.max(1, min),
      work: workName(sess?.lastWork),
      tasks: t?.open,
      top: t?.top?.title,
      overdue: t?.overdue,
    };
  }

  /** Sound, macOS banner, menu bar, Dock, phone and webhook for a ladder level (the coach handles card, corner card and voice). */
  private async extras(kind: NotifyKind, title: string, body: string, a: Active): Promise<void> {
    const exclude: Channel[] = ['toast', 'card', 'voice'];
    if (a.preview) exclude.push('phone', 'webhook');
    await this.d.notify({ kind, title, body, exclude, priority: kind === 'red' ? 'critical' : kind === 'yellow' ? 'high' : 'normal' });
  }

  private pack(a: Active) {
    const sess = this.d.session();
    const p = this.d.profile();
    const st = this.d.settings();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ivs = this.d.store.interventions();
    const todays = ivs.filter((i) => i.startedAt >= today.getTime());
    const tops: Record<string, number> = {};
    for (const i of todays) tops[i.distraction] = (tops[i.distraction] ?? 0) + 1;
    const stats: Record<string, { used: number; worked: number }> = {};
    for (const i of ivs) {
      if (!i.option || i.option === 'self') continue;
      stats[i.option] = stats[i.option] ?? { used: 0, worked: 0 };
      stats[i.option].used += 1;
      if (i.worked) stats[i.option].worked += 1;
    }
    const c = this.ctx(a);
    return {
      profile: p,
      goal: sess?.record.goal ?? '',
      minutesLeft: sess ? sess.record.plannedMin - sess.elapsedSec() / 60 : 25,
      plannedMin: sess?.record.plannedMin ?? 25,
      app: a.sample.app,
      title: a.sample.title,
      domain: a.sample.domain,
      minutesOnIt: c.min,
      level: a.rec.level,
      lastWork: sess?.lastWork ? `${sess.lastWork.app}${sess.lastWork.title ? ` "${workName(sess.lastWork)}"` : ''}` : undefined,
      driftsToday: todays.length,
      topDistraction: Object.entries(tops).sort((x, y) => y[1] - x[1])[0]?.[0],
      whatWorked: Object.entries(stats).map(([k, v]) => `${k} ${v.worked}/${v.used}`).join(', '),
      titlesStayLocal: st.titlesStayLocal,
      tasksOpen: this.d.todos()?.open,
      topTask: this.d.todos()?.top?.title,
      tasksDoneToday: this.d.todos()?.done,
    };
  }

  private voiceAllowed(a: Active): boolean {
    const p = this.d.profile();
    const st = this.d.settings();
    if (!this.d.guard.canSpeak(p, st, a.sample.inCall && !a.preview)) return false;
    return a.spoken || a.preview || this.d.guard.spokenBudgetLeft(st);
  }

  private async speakActive(line: string, shout: boolean, force = false): Promise<void> {
    const a = this.active;
    if (!a) return;
    if (!force && !this.voiceAllowed(a)) return;
    if (!this.d.guard.canSpeak(this.d.profile(), this.d.settings(), false)) return;
    if (!a.spoken && !a.preview) this.d.guard.noteSpokenIntervention();
    a.spoken = true;
    if (!a.preview) this.d.store.logTurn({ interventionId: a.rec.id, speaker: 'coach', text: line, createdAt: Date.now() });
    await this.d.voice.speak(line, { shout });
  }

  private async sayIfAllowed(line: string): Promise<void> {
    const cur = this.d.current();
    if (!this.d.guard.canSpeak(this.d.profile(), this.d.settings(), !!cur?.inCall)) return;
    await this.d.voice.speak(line);
  }
}
