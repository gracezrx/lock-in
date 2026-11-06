import type { ToastPayload } from '../shared/types';
import { api, clear, h, mmss } from './lib';

const toast = document.getElementById('toast') as HTMLElement;
const title = document.getElementById('title') as HTMLElement;
const body = document.getElementById('body') as HTMLElement;
const timer = document.getElementById('timer') as HTMLElement;
const actions = document.getElementById('actions') as HTMLElement;
const closeBtn = document.getElementById('close') as HTMLButtonElement;

let tick: ReturnType<typeof setInterval> | null = null;

/** A short two-note whistle, so a silent nudge still gets noticed. */
function chime(): void {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    for (const [i, f] of [[0, 1568], [1, 2093]] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.12);
      g.gain.linearRampToValueAtTime(0.18, t + i * 0.12 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.22);
      o.connect(g).connect(ctx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.25);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* no audio device */
  }
}

function resize(): void {
  requestAnimationFrame(() => api.send('toast:resize', document.body.scrollHeight));
}

function render(p: ToastPayload): void {
  toast.dataset.kind = p.kind;
  toast.style.animation = 'none';
  void toast.offsetWidth;
  toast.style.animation = '';
  title.textContent = p.title;
  body.textContent = p.body;
  clear(actions);

  if (tick) clearInterval(tick);
  tick = null;
  if (p.timerEndsAt) {
    timer.hidden = false;
    const update = () => {
      const left = (p.timerEndsAt! - Date.now()) / 1000;
      timer.textContent = left > 0 ? mmss(left) : 'Time';
    };
    update();
    tick = setInterval(update, 1000);
  } else {
    timer.hidden = true;
  }

  (p.options ?? []).forEach((o, i) =>
    actions.appendChild(h('button', { class: `btn ${i === 0 ? 'btn-ink' : 'btn-quiet'}`, type: 'button', onclick: () => void api.invoke('coach:choose', o.id) }, o.label)),
  );
  (p.actions ?? []).forEach((a, i) =>
    actions.appendChild(h('button', { class: `btn ${i === 0 && !(p.options ?? []).length ? 'btn-ink' : 'btn-quiet'}`, type: 'button', onclick: () => void api.invoke('action:run', a.id) }, a.label)),
  );
  if (p.canTalk) actions.appendChild(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => void api.invoke('coach:talk') }, 'Answer out loud'));
  if (p.kind === 'schedule') {
    actions.appendChild(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => void api.invoke('session:startQuick') }, 'Lock in now'));
    actions.appendChild(h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => api.send('toast:close') }, 'Not now'));
  }
  if (p.chime) chime();
  resize();
}

closeBtn.addEventListener('click', () => {
  api.send('toast:close');
  void api.invoke('coach:dismissPreview');
});

api.on('toast:show', (p) => render(p as ToastPayload));
