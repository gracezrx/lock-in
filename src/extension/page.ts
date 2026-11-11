// What Lock In Extended shows inside a page: the corner card (it nudges), the voice pill (it
// talks), the big yellow card (it yells), a friend's bomb and small toasts. lockInPage runs in
// the page (chrome.scripting.executeScript sends its source), so it has to stand on its own:
// no imports, nothing from outside the function. Everything sits in a closed shadow root, so the
// site's styles can't touch it, and the buttons answer the service worker.

export interface PageButton {
  id: string;
  label: string;
  primary?: boolean;
}

export type PageOp =
  | { kind: 'nudge'; id: string; title: string; text: string; buttons: PageButton[] }
  | { kind: 'talk'; id: string; text: string; seconds: number }
  | { kind: 'yell'; id: string; name: string; meta: string; line: string; options: PageButton[]; tone: 'yellow' | 'red' }
  | { kind: 'bomb'; id: string; from: string; insult: string; until: number }
  | { kind: 'toast'; id: string; title: string; text: string; seconds: number }
  | { kind: 'clear' };

export function lockInPage(op: PageOp, fonts: { display: string; displayBlack: string; body: string; bodyBold: string }): void {
  const HOST = 'lockin-extended-host';
  const w = window as unknown as { __lockinTimers?: number[] };
  for (const t of w.__lockinTimers ?? []) clearTimeout(t);
  w.__lockinTimers = [];
  const later = (fn: () => void, ms: number) => w.__lockinTimers!.push(window.setTimeout(fn, ms));
  document.getElementById(HOST)?.remove();
  const unlock = (window as unknown as { __lockinUnlock?: () => void }).__lockinUnlock;
  unlock?.();
  if (op.kind === 'clear') return;

  if (!document.getElementById('lockin-extended-fonts')) {
    const f = document.createElement('style');
    f.id = 'lockin-extended-fonts';
    f.textContent = `@font-face{font-family:'LockIn Display';font-weight:800;src:url(${fonts.display}) format('woff2')}@font-face{font-family:'LockIn Display';font-weight:900;src:url(${fonts.displayBlack}) format('woff2')}@font-face{font-family:'LockIn Sans';font-weight:400 500;src:url(${fonts.body}) format('woff2')}@font-face{font-family:'LockIn Sans';font-weight:600 800;src:url(${fonts.bodyBold}) format('woff2')}`;
    (document.head || document.documentElement).appendChild(f);
  }

  const host = document.createElement('div');
  host.id = HOST;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const lock = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2.6"/><rect x="4.5" y="11" width="15" height="10" rx="2.5" fill="currentColor"/></svg>`;
  const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const answer = (choice: string) => {
    try {
      void chrome.runtime.sendMessage({ type: 'page', id: op.id, choice });
    } catch {
      /* the extension was reloaded */
    }
  };
  const close = (delay = 260) => {
    const el = root.querySelector('.out-able');
    el?.classList.add('leaving');
    later(() => {
      host.remove();
      (window as unknown as { __lockinUnlock?: () => void }).__lockinUnlock?.();
    }, delay);
  };
  const buttons = (list: PageButton[], numbered = false) =>
    list.map((b, i) => `<button data-id="${esc(b.id)}" class="${b.primary ? 'primary' : ''}">${numbered ? `<kbd>${i + 1}</kbd>` : ''}${esc(b.label)}</button>`).join('');

  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { font-family: 'LockIn Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #101820; -webkit-font-smoothing: antialiased; }
    .display { font-family: 'LockIn Display', 'Impact', 'Arial Narrow', sans-serif; font-weight: 800; text-transform: uppercase; letter-spacing: 0.01em; line-height: 0.95; }
    button { font: inherit; cursor: pointer; border: 0; }
    .corner { position: fixed; top: 18px; right: 18px; width: 380px; max-width: calc(100vw - 36px); pointer-events: auto; animation: slide 0.45s cubic-bezier(.2,1.2,.3,1) both; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 18px 50px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.06); overflow: hidden; display: flex; }
    .card .bar { width: 8px; background: #ffcf00; flex: none; }
    .card .in { padding: 16px 18px 16px 16px; flex: 1; min-width: 0; }
    .card h2 { margin: 0 0 6px; font-size: 26px; }
    .card p { margin: 0; font-size: 15px; line-height: 1.4; color: #26313b; }
    .x { position: absolute; top: 10px; right: 12px; width: 26px; height: 26px; border-radius: 50%; background: transparent; color: #8a939b; font-size: 18px; line-height: 26px; }
    .x:hover { background: #f0f1ee; color: #101820; }
    .row { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .row button { padding: 9px 14px; border-radius: 9px; font-weight: 700; font-size: 14px; background: #fff; color: #101820; box-shadow: inset 0 0 0 1.5px #101820; }
    .row button.primary { background: #101820; color: #fff; box-shadow: none; }
    .pill { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 16px; background: #101820; color: #fff; box-shadow: 0 18px 40px rgba(0,0,0,.35); }
    .pill .lk { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: #ffcf00; color: #101820; flex: none; }
    .pill .lk svg, .brand svg { width: 18px; height: 18px; }
    .pill .who { font-size: 22px; }
    .pill .who small { display: block; margin-top: 3px; font-family: 'LockIn Sans', sans-serif; font-weight: 600; font-size: 12px; text-transform: none; letter-spacing: 0; color: rgba(255,255,255,.6); }
    .bars { margin-left: auto; display: flex; gap: 3px; align-items: center; height: 30px; }
    .bars i { width: 4px; border-radius: 2px; background: #ffcf00; animation: eq 0.9s ease-in-out infinite; }
    .said { margin-top: 8px; padding: 12px 16px; border-radius: 14px; background: rgba(16,24,32,.94); color: #fff; font-size: 15px; line-height: 1.4; box-shadow: 0 12px 30px rgba(0,0,0,.3); }
    .scrim { position: fixed; inset: 0; display: grid; place-items: center; padding: 24px; background: rgba(10,14,18,.62); backdrop-filter: blur(8px) saturate(.7); -webkit-backdrop-filter: blur(8px) saturate(.7); pointer-events: auto; animation: fade 0.15s ease-out both; }
    .big { width: min(640px, 100%); padding: 26px 30px 24px; border-radius: 22px; background: #ffcf00; color: #101820; transform: rotate(-2deg); box-shadow: 0 30px 80px rgba(0,0,0,.5); animation: slam 0.5s cubic-bezier(.2,1.5,.35,1) both; }
    .big.red { background: #e5202e; color: #fff; }
    .big .head { display: flex; justify-content: space-between; gap: 12px; font-weight: 700; font-size: 14px; opacity: .8; }
    .big h1 { margin: 18px 0 20px; font-size: clamp(40px, 6vw, 64px); font-weight: 900; }
    .big .opts { display: flex; flex-wrap: wrap; gap: 8px; }
    .big .opts button { display: inline-flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 10px; background: rgba(255,255,255,.55); color: #101820; font-weight: 700; font-size: 14px; }
    .big .opts button.primary { background: #101820; color: #fff; }
    .big.red .opts button { background: rgba(255,255,255,.18); color: #fff; }
    kbd { font: 700 12px/1 'LockIn Sans', sans-serif; padding: 3px 6px; border-radius: 5px; background: rgba(0,0,0,.12); }
    .primary kbd { background: rgba(255,255,255,.2); }
    .brand { display: inline-flex; align-items: center; gap: 6px; }
    .count { margin-top: 16px; font-size: 15px; font-weight: 700; opacity: .9; }
    .toast { position: fixed; right: 18px; bottom: 18px; max-width: 340px; padding: 12px 16px; border-radius: 14px; background: #101820; color: #fff; box-shadow: 0 16px 40px rgba(0,0,0,.35); animation: up 0.35s cubic-bezier(.2,1.2,.3,1) both; pointer-events: auto; }
    .toast b { display: block; font-size: 20px; margin-bottom: 3px; color: #ffcf00; }
    .toast span { font-size: 14px; color: rgba(255,255,255,.85); }
    .leaving { animation: leave 0.25s ease-in both !important; }
    @keyframes slide { from { transform: translateX(120%); } }
    @keyframes up { from { transform: translateY(30px); opacity: 0; } }
    @keyframes fade { from { opacity: 0; } }
    @keyframes slam { 0% { transform: scale(1.35) rotate(-9deg); opacity: 0; } 70% { transform: scale(.97) rotate(-1.5deg); opacity: 1; } }
    @keyframes leave { to { opacity: 0; transform: translateY(-8px); } }
    @keyframes eq { 0%, 100% { height: 6px; } 50% { height: 26px; } }
    @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01s !important; } }`;

  let html = '';
  if (op.kind === 'nudge') {
    html = `<div class="ui corner out-able" role="alert"><div class="card"><div class="bar"></div><div class="in"><h2 class="display">${esc(op.title)}</h2><p>${esc(op.text)}</p><div class="row">${buttons(op.buttons)}</div></div></div><button class="x" data-id="close" aria-label="Close">×</button></div>`;
  } else if (op.kind === 'talk') {
    const bars = Array.from({ length: 12 }, (_, i) => `<i style="animation-delay:${(i * 0.07) % 0.6}s"></i>`).join('');
    html = `<div class="ui corner out-able" role="status"><div class="pill"><span class="lk">${lock}</span><span class="who display">Lock In<small>is talking to you</small></span><span class="bars">${bars}</span></div><div class="said">${esc(op.text)}</div></div>`;
  } else if (op.kind === 'yell') {
    html = `<div class="ui scrim out-able" role="alertdialog" aria-modal="true"><div class="big ${op.tone === 'red' ? 'red' : ''}"><div class="head"><span class="brand">${lock}${esc(op.name)}</span><span>${esc(op.meta)}</span></div><h1 class="display">${esc(op.line)}</h1><div class="opts">${buttons(op.options, true)}</div></div></div>`;
  } else if (op.kind === 'bomb') {
    html = `<div class="ui scrim out-able" role="alertdialog" aria-modal="true"><div class="big red"><div class="head"><span class="brand">${lock}Lock In bomb from ${esc(op.from)}</span><span>Every distraction is locked</span></div><h1 class="display">${esc(op.insult)}</h1><div class="count" id="count"></div></div></div>`;
  } else if (op.kind === 'toast') {
    html = `<div class="ui toast out-able" role="status"><b class="display">${esc(op.title)}</b><span>${esc(op.text)}</span></div>`;
  }
  root.innerHTML = `<style>${css}</style>${html}`;
  (document.body || document.documentElement).appendChild(host);

  root.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      answer(b.dataset.id!);
      close();
    }),
  );

  if (op.kind === 'yell' || op.kind === 'bomb') {
    // While it's up, the page doesn't get the keys (no sneaky space bar to keep the video going).
    document.querySelectorAll('video, audio').forEach((m) => {
      try {
        (m as HTMLMediaElement).pause();
      } catch {
        /* */
      }
    });
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    const opts = op.kind === 'yell' ? op.options : [];
    const swallow = (e: KeyboardEvent | WheelEvent) => {
      if (e instanceof KeyboardEvent && e.type === 'keydown') {
        const n = Number(e.key);
        if (n >= 1 && n <= opts.length) {
          answer(opts[n - 1].id);
          close();
        }
      }
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    const evs = ['keydown', 'keyup', 'keypress', 'wheel'] as const;
    evs.forEach((t) => window.addEventListener(t, swallow as EventListener, { capture: true, passive: false }));
    (window as unknown as { __lockinUnlock?: () => void }).__lockinUnlock = () => {
      evs.forEach((t) => window.removeEventListener(t, swallow as EventListener, { capture: true }));
      (window as unknown as { __lockinUnlock?: () => void }).__lockinUnlock = undefined;
    };
  }
  if (op.kind === 'bomb') {
    const count = root.getElementById('count');
    const end = Date.now() + 5000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((op.until - Date.now()) / 1000));
      if (count) count.textContent = `Locked for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (Date.now() >= end) close(300);
      else later(tick, 250);
    };
    tick();
  }
  if (op.kind === 'talk') later(() => close(), Math.max(4, op.seconds) * 1000);
  if (op.kind === 'toast') later(() => close(), Math.max(2, op.seconds) * 1000);
}
