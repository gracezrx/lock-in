// The talk panel: a live voice conversation with Lock In's ElevenLabs agent, or a typed chat.
// The agent's actions (log what you did, start a session…) run in the main process.
import { Conversation } from '@elevenlabs/client';
import type { TalkEvent, TalkStart } from '../main/talk/talk';
import { api, clear, h } from './lib';

type Conv = Awaited<ReturnType<typeof Conversation.startSession>>;

const talk = document.getElementById('talk') as HTMLElement;
const titleEl = document.getElementById('title') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const noticeEl = document.getElementById('notice') as HTMLElement;
const logEl = document.getElementById('log') as HTMLOListElement;
const chipsEl = document.getElementById('chips') as HTMLElement;
const form = document.getElementById('say') as HTMLFormElement;
const input = document.getElementById('input') as HTMLInputElement;
const micBtn = document.getElementById('mic') as HTMLButtonElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;
const orb = document.getElementById('orb') as HTMLElement;

let conv: Conv | null = null;
let voice = false;
let finished = false;
let heardUser = false;
let endWhenQuiet = false;
let muted = false;
let mode: 'speaking' | 'listening' = 'listening';
const timers: ReturnType<typeof setTimeout>[] = [];

function setState(s: 'connecting' | 'listening' | 'speaking' | 'text' | 'ended', text?: string): void {
  talk.dataset.state = s;
  statusEl.textContent =
    text ?? { connecting: 'Connecting…', listening: muted ? 'Mic muted. Type below.' : 'Listening. Just talk.', speaking: 'Talking…', text: 'Typing mode', ended: 'Ended' }[s];
}

function notice(text: string): void {
  noticeEl.hidden = !text;
  noticeEl.textContent = text;
}

function bubble(who: 'agent' | 'user' | 'sys', text: string): void {
  if (!text.trim()) return;
  logEl.append(h('li', { class: who }, text.trim()));
  logEl.scrollTop = logEl.scrollHeight;
}

function chip(text: string, kind: 'ticked' | 'added' | 'action'): void {
  chipsEl.append(h('span', { class: `chip ${kind}` }, text));
}

const short = (t: string) => (t.length > 34 ? `${t.slice(0, 33)}…` : t);

function onEvent(e: TalkEvent): void {
  switch (e.type) {
    case 'agent':
      bubble('agent', e.text);
      break;
    case 'logged':
      for (const t of e.ticked) chip(`✓ Ticked: ${short(t)}`, 'ticked');
      for (const t of e.added) chip(`+ Done: ${short(t)}`, 'added');
      break;
    case 'action':
      chip(e.text, 'action');
      break;
    case 'notice':
      notice(e.text);
      break;
    case 'end':
      void finish();
      break;
  }
}

async function finish(reason?: string): Promise<void> {
  if (finished) return;
  finished = true;
  for (const t of timers) clearTimeout(t);
  if (reason) bubble('sys', reason);
  setState('ended');
  const c = conv;
  conv = null;
  try {
    await c?.endSession();
  } catch {
    /* already closed */
  }
  setTimeout(() => void api.invoke('talk:closed'), reason ? 1400 : 300);
}

const tool = (name: string) => async (params: Record<string, unknown>) => {
  if (name === 'end_conversation') {
    endWhenQuiet = true;
    // End once the sign-off has been said (or after a few seconds regardless).
    timers.push(setTimeout(() => void finish(), 6000));
  }
  return api.invoke<string>('talk:tool', name, params ?? {});
};

const TOOL_NAMES = ['log_done', 'start_focus', 'snooze_nagging', 'back_to_work', 'start_break', 'mark_current_as_work', 'add_todo', 'end_conversation'];

/** The orb follows the mic (listening) or the coach's voice (speaking). */
function animateOrb(): void {
  if (finished) return;
  const c = conv;
  if (c) {
    const lvl = mode === 'speaking' ? c.getOutputVolume() : muted ? 0 : c.getInputVolume();
    orb.style.setProperty('--lvl', String(1 + Math.min(1, lvl * 2.2)));
  }
  requestAnimationFrame(animateOrb);
}

async function startVoice(p: TalkStart): Promise<void> {
  setState('connecting');
  const base = (f: string) => new URL(`vendor/${f}`, location.href).href;
  const clientTools: Record<string, (x: Record<string, unknown>) => Promise<string>> = {};
  for (const n of TOOL_NAMES) clientTools[n] = tool(n);
  try {
    conv = await Conversation.startSession({
      signedUrl: p.signedUrl!,
      connectionType: 'websocket',
      dynamicVariables: p.dynamicVariables,
      workletPaths: { rawAudioProcessor: base('rawAudioProcessor.js'), audioConcatProcessor: base('audioConcatProcessor.js') },
      clientTools,
      onConnect: () => {
        setState('listening');
        // Nobody answers: close quietly instead of leaving the mic on.
        timers.push(setTimeout(() => {
          if (!heardUser && !finished) void finish('No answer, so I hung up. Press ⌘⇧Space to talk.');
        }, 35_000));
      },
      onModeChange: ({ mode: m }) => {
        mode = m;
        if (finished) return;
        setState(m === 'speaking' ? 'speaking' : 'listening');
        if (m === 'listening' && endWhenQuiet) timers.push(setTimeout(() => void finish(), 500));
      },
      onMessage: ({ message, role }) => {
        if (!message?.trim()) return;
        if (role === 'user') heardUser = true;
        bubble(role === 'user' ? 'user' : 'agent', message);
        void api.invoke('talk:transcript', role === 'user' ? 'user' : 'agent', message);
      },
      onDisconnect: (d) => {
        if (finished) return;
        void finish(d.reason === 'error' ? `Disconnected: ${d.message}` : undefined);
      },
      onError: (message) => notice(String(message)),
    });
    conv.setVolume({ volume: Math.max(0.2, p.volume) });
    requestAnimationFrame(animateOrb);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const mic = /permission|notallowed|denied|microphone/i.test(msg);
    notice(mic ? 'Lock In cannot use the microphone. Allow it in System Settings, Privacy and Security, Microphone. You can type meanwhile.' : `Voice did not connect (${msg}). You can type instead.`);
    startText(p, false);
  }
}

function startText(p: TalkStart, showOpener: boolean): void {
  voice = false;
  micBtn.hidden = true;
  setState('text');
  if (showOpener) bubble('agent', p.opener);
  input.focus();
  // Walked away mid-chat: close after a while.
  timers.push(setTimeout(() => void finish('Closed after a few quiet minutes.'), Math.max(3, p.maxMinutes) * 60_000));
}

api.on('talk:start', (raw) => {
  const p = raw as TalkStart;
  titleEl.textContent = p.title;
  clear(logEl);
  clear(chipsEl);
  notice(p.notice ?? '');
  voice = p.mode === 'voice' && !!p.signedUrl;
  // A hard stop so a forgotten conversation doesn't run up ElevenLabs credits.
  timers.push(setTimeout(() => void finish('Time limit reached.'), Math.max(1, p.maxMinutes) * 60_000 + 5000));
  if (voice) void startVoice(p);
  else startText(p, true);
});

api.on('talk:event', (e) => onEvent(e as TalkEvent));

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text || finished) return;
  input.value = '';
  bubble('user', text);
  if (voice && conv) {
    heardUser = true;
    conv.sendUserMessage(text);
    void api.invoke('talk:transcript', 'user', text);
  } else {
    void api.invoke('talk:text', text);
  }
});

input.addEventListener('input', () => {
  if (voice && conv) conv.sendUserActivity();
});

micBtn.addEventListener('click', () => {
  if (!conv) return;
  muted = !muted;
  conv.setMicMuted(muted);
  micBtn.setAttribute('aria-pressed', String(muted));
  micBtn.setAttribute('aria-label', muted ? 'Unmute the microphone' : 'Mute the microphone');
  talk.dataset.muted = String(muted);
  if (mode === 'listening') setState('listening');
});

closeBtn.addEventListener('click', () => void finish());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void finish();
});
