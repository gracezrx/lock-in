// The opening moment, which is also the whole idea of Lock In in three seconds:
//   You drift.          distractions float in and crowd the open lock
//   It notices.         they go yellow, then red (the coach's yellow and red cards)
//   It drags you back.  the shackle snaps shut and flings them all away: "Lock in."
// Plays once per launch (and when you click the logo). A click or any key skips it.

const DISTRACTIONS = ['one more video', '37 tabs', 'just checking', 'reply later', 'quick scroll', 'new notification', 'rabbit hole', '5 more minutes'];

const LOCK = `<svg class="intro-lock" viewBox="0 0 1024 1024" aria-hidden="true">
  <rect width="1024" height="1024" rx="230" fill="#111"/>
  <g transform="translate(512 512) scale(0.82) translate(-512 -529)">
    <path class="intro-shackle" d="M375 526V430a137 137 0 0 1 274 0V526" fill="none" stroke="#d4ff3a" stroke-width="70"/>
    <rect x="292" y="486" width="440" height="314" rx="48" fill="#d4ff3a"/>
    <circle cx="512" cy="615" r="42" fill="#111"/>
    <rect x="491" y="622" width="42" height="94" rx="20" fill="#111"/>
  </g>
</svg>`;

const OPEN = 'translate(0px, -118px) rotate(-16deg)';

/** When things happen, in milliseconds from the start. */
export const INTRO_TIMES = { drift: 120, notice: 1150, alarm: 1500, snap: 1850, title: 1950, out: 3250, end: 3700 };

let playing: Promise<void> | null = null;

/** `hold` keeps the final "Lock in." up until a click or key (the README demo uses it). */
export function playIntro(opts: { reduced?: boolean; host?: HTMLElement; hold?: boolean } = {}): Promise<void> {
  if (playing) return playing;
  playing = run(opts).finally(() => {
    playing = null;
  });
  return playing;
}

async function run(opts: { reduced?: boolean; host?: HTMLElement; hold?: boolean }): Promise<void> {
  const reduced = opts.reduced ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const host = opts.host ?? document.body;
  const root = document.createElement('div');
  root.className = 'intro';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="intro-stage">
      ${LOCK}
      <div class="intro-title">Lock in.</div>
      <p class="intro-beats"><span>You drift.</span> <span>It notices.</span> <span>It drags you back.</span></p>
    </div>
    <div class="intro-ring"></div>`;
  const T = INTRO_TIMES;
  const lock = root.querySelector<SVGSVGElement>('.intro-lock')!;
  const shackle = root.querySelector<SVGPathElement>('.intro-shackle')!;
  const title = root.querySelector<HTMLElement>('.intro-title')!;
  const beats = [...root.querySelectorAll<HTMLElement>('.intro-beats span')];
  const ring = root.querySelector<HTMLElement>('.intro-ring')!;
  const stage = root.querySelector<HTMLElement>('.intro-stage')!;
  if (!reduced) {
    // The first frame is the open lock and nothing else (never a flash of the ending).
    shackle.style.transform = OPEN;
    title.style.opacity = '0';
    beats.forEach((b) => (b.style.opacity = '0'));
  }
  host.append(root);
  // Measure after the display font is in, so the distractions gather around the right spot.
  await document.fonts?.ready.catch(() => undefined);
  const timers: number[] = [];
  const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (fast: boolean) => {
      if (done) return;
      done = true;
      timers.forEach((t) => clearTimeout(t));
      root.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip, true);
      const out = root.animate(reduced ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }], {
        duration: fast ? 180 : reduced ? 220 : 430,
        easing: 'cubic-bezier(.7,0,.84,0)',
        fill: 'forwards',
      });
      out.onfinish = () => {
        root.remove();
        resolve();
      };
    };
    const skip = (e: Event) => {
      e.preventDefault();
      finish(true);
    };
    root.addEventListener('pointerdown', skip);
    window.addEventListener('keydown', skip, true);

    if (reduced) {
      // No motion: the finished lockup, briefly.
      root.classList.add('still');
      if (!opts.hold) at(1500, () => finish(false));
      return;
    }

    const show = (el: HTMLElement, ms: number) =>
      at(ms, () => el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out', fill: 'forwards' }));

    // You drift: the distractions float in and crowd the lock.
    const box = lock.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    // They gather around the whole lockup, not on top of it.
    const sb = stage.getBoundingClientRect();
    const gx = sb.left + sb.width / 2;
    const gy = sb.top + sb.height / 2;
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const pills = DISTRACTIONS.map((text, i) => {
      const p = document.createElement('span');
      p.className = 'intro-pill';
      p.textContent = text;
      p.style.left = `${gx}px`;
      p.style.top = `${gy}px`;
      root.append(p);
      const angle = (i / DISTRACTIONS.length) * Math.PI * 2 - Math.PI / 2 + (i % 2 ? 0.18 : -0.12);
      const rx = Math.min(w * 0.38, 360) + (i % 3) * 16;
      const ry = Math.min(hgt * 0.37, 255) + (i % 2) * 14;
      const end = { x: Math.cos(angle) * rx, y: Math.sin(angle) * ry, r: (i % 2 ? 1 : -1) * (4 + (i % 3) * 3) };
      const far = Math.max(w, hgt);
      const start = { x: Math.cos(angle) * far * 0.75, y: Math.sin(angle) * far * 0.6, r: end.r * 4 };
      const pos = (x: number, y: number, r: number) => `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px)) rotate(${r}deg)`;
      p.style.transform = pos(start.x, start.y, start.r);
      at(T.drift + i * 65, () =>
        p.animate([{ transform: pos(start.x, start.y, start.r) }, { transform: pos(end.x, end.y, end.r) }], { duration: 850, easing: 'cubic-bezier(.15,.85,.25,1)', fill: 'forwards' }),
      );
      // It notices: yellow card, then red card.
      at(T.notice + i * 35, () => {
        p.classList.add('yellow');
        p.animate([{ transform: pos(end.x, end.y, end.r) }, { transform: pos(end.x + 4, end.y, end.r - 3) }, { transform: pos(end.x - 4, end.y, end.r + 3) }, { transform: pos(end.x, end.y, end.r) }], { duration: 180, composite: 'replace' });
      });
      at(T.alarm + i * 25, () => {
        p.classList.add('red');
        p.animate([{ transform: pos(end.x, end.y, end.r) }, { transform: pos(end.x + 7, end.y - 2, end.r - 6) }, { transform: pos(end.x - 7, end.y + 2, end.r + 6) }, { transform: pos(end.x + 4, end.y, end.r - 2) }, { transform: pos(end.x, end.y, end.r) }], { duration: 260 });
      });
      // It drags you back: flung off the screen.
      at(T.snap + 40, () =>
        p.animate([{ transform: pos(end.x, end.y, end.r) }, { transform: pos(end.x * 4.2, end.y * 4.2, end.r * 9) }], { duration: 520, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' }),
      );
      return p;
    });
    void pills;
    show(beats[0], T.drift + 250);
    show(beats[1], T.notice + 100);

    // The lock leans in as it notices.
    at(T.notice, () => lock.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }], { duration: 650, easing: 'ease-in-out', fill: 'forwards' }));

    // Snap.
    at(T.snap, () => {
      shackle.animate(
        [
          { transform: OPEN },
          { transform: 'translate(0px, -118px) rotate(0deg)', offset: 0.4 },
          { transform: 'translate(0px, 10px) rotate(0deg)', offset: 0.82 },
          { transform: 'translate(0px, 0px) rotate(0deg)' },
        ],
        { duration: 240, easing: 'cubic-bezier(.6,0,.4,1)', fill: 'forwards' },
      );
      lock.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(0.9)', offset: 0.45 }, { transform: 'scale(1)' }], { duration: 320, delay: 150, fill: 'forwards' });
      ring.style.left = `${cx}px`;
      ring.style.top = `${cy}px`;
      ring.animate([{ transform: 'translate(-50%, -50%) scale(0.3)', opacity: 1 }, { transform: 'translate(-50%, -50%) scale(7)', opacity: 0 }], { duration: 560, delay: 170, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' }).onfinish = () => ring.remove();
      stage.animate(
        [{ transform: 'none' }, { transform: 'translate(-6px, 3px)' }, { transform: 'translate(5px, -3px)' }, { transform: 'translate(-3px, 2px)' }, { transform: 'none' }],
        { duration: 220, delay: 170 },
      );
    });
    at(T.title, () =>
      title.animate([{ opacity: 0, transform: 'scale(1.7)', letterSpacing: '0.08em' }, { opacity: 1, transform: 'scale(0.96)', letterSpacing: '-0.01em', offset: 0.7 }, { opacity: 1, transform: 'scale(1)', letterSpacing: '-0.01em' }], {
        duration: 300,
        easing: 'cubic-bezier(.2,.9,.3,1)',
        fill: 'forwards',
      }),
    );
    show(beats[2], T.title + 120);
    if (!opts.hold) at(T.out, () => finish(false));
  });
}
