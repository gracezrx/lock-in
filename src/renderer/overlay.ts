import type { OverlayPayload } from '../shared/types';
import { api, clear, h } from './lib';

const card = document.getElementById('card') as HTMLElement;
const cardName = document.getElementById('cardName') as HTMLElement;
const meta = document.getElementById('meta') as HTMLElement;
const line = document.getElementById('line') as HTMLElement;
const goal = document.getElementById('goal') as HTMLElement;
const options = document.getElementById('options') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const mic = document.getElementById('mic') as HTMLButtonElement;
const micLabel = document.getElementById('micLabel') as HTMLElement;
const form = document.getElementById('replyForm') as HTMLFormElement;
const reply = document.getElementById('reply') as HTMLInputElement;

let current: OverlayPayload | null = null;
let busy = false;
/** A friend's bomb: nothing can be clicked or pressed until this passes. */
let lockedUntil = 0;
let lockTimer = 0;

const NAMES: Record<number, string> = { 1: 'Heads up', 2: 'Heads up', 3: 'Yellow card', 4: 'Red card' };

function render(p: OverlayPayload): void {
  current = p;
  card.dataset.level = String(p.tone === 'red' ? 4 : p.tone === 'paper' ? 2 : p.tone === 'yellow' ? 3 : p.level);
  cardName.textContent = p.cardName ?? NAMES[p.level] ?? 'Heads up';
  meta.textContent = p.meta ?? (p.distraction ? `${p.driftMin} min on ${p.distraction}` : '');
  line.textContent = p.line;
  card.classList.toggle('long', p.line.length > 110);
  goal.textContent = p.goal ? `Your goal: ${p.goal}` : '';
  clear(options);
  const notice = !!p.actions?.length;
  const buttons: { id: string; label: string }[] = notice ? p.actions! : p.options;
  buttons.forEach((o, i) =>
    options.appendChild(
      h('button', { class: `opt${i === 0 ? ' primary' : ''}`, type: 'button', onclick: () => (notice ? runAction(o.id) : choose(o.id)) }, h('kbd', null, String(i + 1)), o.label),
    ),
  );
  (document.querySelector('.answer') as HTMLElement).hidden = notice;
  mic.hidden = !p.canTalk;
  setStatus(p.status ?? '');
  busy = false;
  clearInterval(lockTimer);
  document.body.classList.toggle('bomb', !!p.lockSec);
  if (p.lockSec && p.lockSec > 0) {
    // Locked: the buttons appear when the countdown ends.
    lockedUntil = Date.now() + p.lockSec * 1000;
    card.classList.add('locked');
    options.hidden = true;
    const tick = () => {
      const left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left > 0) {
        status.textContent = `Locked for ${left}…`;
        return;
      }
      clearInterval(lockTimer);
      lockedUntil = 0;
      // Stay put: dropping .locked would otherwise swap bomb-in for the raise animation and
      // fly the card in again. The next card clears this.
      card.style.animation = 'none';
      card.classList.remove('locked');
      options.hidden = false;
      status.textContent = '';
      (options.querySelector('button') as HTMLButtonElement | null)?.focus();
    };
    tick();
    lockTimer = window.setInterval(tick, 250);
    return;
  }
  lockedUntil = 0;
  card.classList.remove('locked');
  options.hidden = false;
  setTimeout(() => (options.querySelector('button') as HTMLButtonElement | null)?.focus(), 50);
}

function setStatus(text: string): void {
  status.textContent = text;
  const listening = text.startsWith('Listening');
  mic.classList.toggle('live', listening);
  micLabel.textContent = listening ? 'Listening… click to stop' : 'Answer out loud';
}

async function runAction(id: string): Promise<void> {
  if (busy || lockedUntil > Date.now()) return;
  busy = true;
  await api.invoke('action:run', id);
}

async function choose(id: string): Promise<void> {
  if (busy) return;
  busy = true;
  await api.invoke('coach:choose', id);
}

api.on('overlay:show', (p) => {
  // Replay the raise animation for a new card.
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
  render(p as OverlayPayload);
});

api.on('overlay:update', (raw) => {
  const p = raw as Partial<OverlayPayload>;
  if (!current) return;
  current = { ...current, ...p };
  if (p.line !== undefined) {
    line.textContent = p.line;
    card.classList.toggle('long', p.line.length > 110);
  }
  if (p.level !== undefined) {
    card.dataset.level = String(p.level);
    cardName.textContent = NAMES[p.level] ?? 'Heads up';
  }
  if (p.status !== undefined) setStatus(p.status);
});

api.on('overlay:hide', () => {
  current = null;
  reply.value = '';
});

mic.addEventListener('click', () => void api.invoke('coach:talk'));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = reply.value.trim();
  if (!text) return;
  reply.value = '';
  void api.invoke('coach:reply', text);
});

document.addEventListener('keydown', (e) => {
  if (lockedUntil > Date.now()) {
    e.preventDefault();
    return;
  }
  if (!current || document.activeElement === reply) return;
  const n = Number(e.key);
  const list = current.actions?.length ? current.actions : current.options;
  if (n >= 1 && n <= list.length) {
    e.preventDefault();
    if (current.actions?.length) void runAction(list[n - 1].id);
    else void choose(list[n - 1].id);
  }
});
