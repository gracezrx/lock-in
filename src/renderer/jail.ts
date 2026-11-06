// The jailbreak look: your cursor is a small key, every page in the rail sits behind a padlock
// that opens when you go there, a cell door slides away to show the page, a searchlight follows
// the key around the cell-block wall, and to-dos are padlocks you unlock.
// All of it is presentation: turn it off (Settings, How Lock In looks) and the classic look is back.

export interface Look {
  theme: 'jail' | 'classic';
  keyCursor: boolean;
}

const CACHE = 'lockin.look';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const root = document.documentElement;

/** The look saved last time, applied before anything is drawn so there's no flash. */
export function cachedLook(): Look {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE) ?? 'null') as Look | null;
    if (v && (v.theme === 'jail' || v.theme === 'classic')) return { theme: v.theme, keyCursor: v.keyCursor !== false };
  } catch {
    /* no storage */
  }
  return { theme: 'jail', keyCursor: true };
}

export function applyLook(look: Look): void {
  try {
    localStorage.setItem(CACHE, JSON.stringify(look));
  } catch {
    /* no storage */
  }
  const jail = look.theme === 'jail';
  root.classList.toggle('jail', jail);
  root.classList.toggle('key-cursor', jail && look.keyCursor);
  if (jail) {
    searchlight();
    decorateRail();
  }
  if (jail && look.keyCursor) keyCursor();
  else key?.hide();
}

export const isJail = () => root.classList.contains('jail');

// ---- padlocks ---------------------------------------------------------------------------------

/** A padlock drawing. Its shackle lifts on hover and swings open with `.open` on a parent. */
export function padlock(): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="padlock" viewBox="0 0 24 28" aria-hidden="true" focusable="false">
    <path class="shackle" d="M7.2 13.5V9.2a4.8 4.8 0 0 1 9.6 0v4.3" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
    <rect class="body" x="3.5" y="12.5" width="17" height="13" rx="3.2"/>
    <circle class="hole" cx="12" cy="18.2" r="1.9"/>
    <rect class="hole" x="11.05" y="18.6" width="1.9" height="3.6" rx=".9"/>
  </svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** Puts a padlock in front of every page in the rail (open on the page you're on). */
function decorateRail(): void {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.rail a[data-route]')) {
    if (a.querySelector('.padlock')) continue;
    a.prepend(padlock());
  }
}

// ---- the cell door between pages ------------------------------------------------------------------

let door: HTMLElement | null = null;

/** Slides a cell door off the page you just unlocked. */
export function cellDoor(): void {
  if (!isJail() || reduced()) return;
  const view = document.getElementById('view');
  if (!view) return;
  door?.remove();
  const r = view.getBoundingClientRect();
  door = document.createElement('div');
  door.className = 'cell-door';
  door.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  document.body.append(door);
  const d = door;
  // Two frames: the closed door is drawn, then it slides.
  requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add('open')));
  setTimeout(() => d.remove(), 900);
}

// ---- the searchlight ---------------------------------------------------------------------------------

let lightOn = false;
function searchlight(): void {
  if (lightOn) return;
  lightOn = true;
  let raf = 0;
  let x = innerWidth * 0.6;
  let y = innerHeight * 0.35;
  const put = () => {
    raf = 0;
    root.style.setProperty('--mx', `${x}px`);
    root.style.setProperty('--my', `${y}px`);
  };
  put();
  addEventListener('pointermove', (e) => {
    x = e.clientX;
    y = e.clientY;
    if (!raf) raf = requestAnimationFrame(put);
  }, { passive: true });
}

// ---- the key ---------------------------------------------------------------------------------------

/** What the key treats as something to unlock. */
const CLICKABLE = 'a[href], button:not(:disabled), [role="button"], label.switch, summary, select, input[type="checkbox"], input[type="radio"], input[type="range"], .choice, .voice-card, .cm-speaker';
/** Where you type: the key steps aside for the usual text cursor. */
const TYPING = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]), textarea, [contenteditable="true"]';

const KEY_SVG = `<svg viewBox="0 0 52 24" aria-hidden="true" focusable="false">
  <path class="key-bit" d="M5 12.6h12v2.2h-2.6v4.4h-3v-2.6H9.6v3.8H6.4v-5.6H5z"/>
  <rect class="key-shaft" x="4" y="10.4" width="30" height="3.4" rx="1.4"/>
  <circle class="key-bow" cx="41.5" cy="12" r="7.6" fill="none" stroke-width="3.6"/>
  <circle class="key-gem" cx="41.5" cy="12" r="2.2"/>
</svg>`;

let key: { hide: () => void; retarget: () => void } | null = null;

/** After a page change or a scroll, what's under the key may be different. */
export function retargetKey(): void {
  key?.retarget();
}

function keyCursor(): void {
  if (key) return;
  const el = document.createElement('div');
  el.className = 'jail-key';
  el.innerHTML = KEY_SVG;
  el.hidden = true;
  document.body.append(el);
  let x = 0;
  let y = 0;
  let raf = 0;
  const place = () => {
    raf = 0;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };
  const enabled = () => root.classList.contains('key-cursor');
  let seen = false;
  const look = (t: Element | null) => {
    const typing = !!t?.closest?.(TYPING);
    el.hidden = typing || !seen;
    el.classList.toggle('over', !typing && !!t?.closest?.(CLICKABLE));
  };
  addEventListener('pointermove', (e) => {
    if (!enabled() || e.pointerType === 'touch') return;
    x = e.clientX;
    y = e.clientY;
    seen = true;
    look(e.target as Element | null);
    if (!raf) raf = requestAnimationFrame(place);
  }, { passive: true });
  const retarget = () => {
    if (enabled() && seen) look(document.elementFromPoint(x, y));
  };
  addEventListener('scroll', retarget, { capture: true, passive: true });
  document.addEventListener('pointerleave', () => (el.hidden = true));
  addEventListener('blur', () => (el.hidden = true));
  addEventListener('pointerdown', (e) => {
    if (!enabled() || el.hidden || e.button !== 0) return;
    // The key turns in the lock, and the lock clicks.
    el.classList.remove('turn');
    void el.offsetWidth;
    el.classList.add('turn');
    if (!reduced()) {
      const spark = document.createElement('i');
      spark.className = 'key-spark';
      spark.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
      document.body.append(spark);
      setTimeout(() => spark.remove(), 500);
    }
  });
  el.addEventListener('animationend', () => el.classList.remove('turn'));
  key = { hide: () => (el.hidden = true), retarget };
}

// ---- tally marks ---------------------------------------------------------------------------------

/** Scratches on the wall: one stroke per thing you finished today, crossed in fives. */
export function tally(n: number): SVGSVGElement {
  const groups = Math.min(Math.ceil(n / 5), 6);
  const shown = Math.min(n, 30);
  const w = Math.max(1, groups) * 46;
  let seed = n * 9301 + 49297;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280 - 0.5;
  };
  let strokes = '';
  for (let i = 0; i < shown; i++) {
    const g = Math.floor(i / 5);
    const k = i % 5;
    const x0 = g * 46 + 6;
    const delay = (i * 0.07).toFixed(2);
    if (k < 4) {
      const x = x0 + k * 8 + rnd() * 2;
      strokes += `<path pathLength="1" style="animation-delay:${delay}s" d="M${x.toFixed(1)} ${(6 + rnd() * 3).toFixed(1)} L${(x + rnd() * 3).toFixed(1)} ${(46 + rnd() * 3).toFixed(1)}"/>`;
    } else {
      strokes += `<path pathLength="1" style="animation-delay:${delay}s" d="M${(x0 - 4).toFixed(1)} ${(36 + rnd() * 4).toFixed(1)} L${(x0 + 30 + rnd() * 3).toFixed(1)} ${(14 + rnd() * 4).toFixed(1)}"/>`;
    }
  }
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="tally-marks" viewBox="0 0 ${w} 52" width="${w}" height="52" aria-hidden="true" focusable="false">
    <defs><filter id="chalk" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="1" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.6"/></filter></defs>
    <g filter="url(#chalk)">${strokes}</g>
  </svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}
