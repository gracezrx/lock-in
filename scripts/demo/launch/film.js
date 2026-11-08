// The launch film's timeline and render(t). Times are seconds; every frame is drawn from t alone.
(function () {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const ease = {
    out: (k) => 1 - Math.pow(1 - k, 3),
    in: (k) => k * k * k,
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    back: (k) => 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2),
    // A softer overshoot, and the long gentle tails that make moves feel smooth.
    backSoft: (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2),
    outQuint: (k) => 1 - Math.pow(1 - k, 5),
    smooth: (k) => k * k * (3 - 2 * k),
  };
  const $ = (id) => document.getElementById(id);

  // ---- What's said, and when (durations come from the voice files; record.mjs fills them in) ----
  const VO = [
    { id: 'n1', who: 'narrator', at: 1.5, text: 'Yep. That’s Sam. You’re probably wondering how he got here.' },
    { id: 'n2', who: 'narrator', at: 5.85, text: 'Sam has an investor update due in three hours.' },
    { id: 's1', who: 'sam', at: 8.55, text: 'Just one video.' },
    { id: 'n3', who: 'narrator', at: 9.7, text: 'Two hundred and thirteen videos later, Sam is an expert on raccoons.' },
    { id: 'n4', who: 'narrator', at: 14.15, text: 'Luckily, Sam has Lock In. It lives in his menu bar. It sees everything.' },
    { id: 'c1', who: 'coach', at: 21.2, text: 'Sam. You’ve watched a raccoon steal snacks four times. It’s the same raccoon. Your investor update is still blank.' },
    { id: 's2', who: 'sam', at: 28.85, text: 'It’s research.' },
    { id: 'c2', who: 'coach', at: 30.0, text: 'Right. Intervention.' },
    { id: 'n5', who: 'narrator', at: 32.9, text: 'And if Sam still won’t lock in, his friends get a button.' },
    { id: 'n6', who: 'narrator', at: 36.85, text: 'One bomb. Every distraction on his Mac. Locked for five minutes.' },
    { id: 's3', who: 'sam', at: 45.7, text: 'This is a hostage situation.' },
    { id: 'n7', who: 'narrator', at: 47.75, text: 'It is.' },
    { id: 'n8', who: 'narrator', at: 50.7, text: 'It also knows your goals, your to-dos and your calendar, so it never roasts you on a Zoom.' },
    { id: 'n9', who: 'narrator', at: 57.35, text: 'Lock In. Free for Mac. Go bomb a friend.' },
    { id: 'c3', who: 'coach', at: 63.6, text: 'Sam.' },
    { id: 's4', who: 'sam', at: 64.45, text: 'I was just closing it.' },
  ];
  const DUR = { n1: 3.06, n2: 2.56, s1: 1.0, n3: 3.86, n4: 4.48, c1: 7.54, s2: 0.88, c2: 1.48, n5: 2.9, n6: 3.93, s3: 1.57, n7: 0.66, n8: 4.71, n9: 2.39, c3: 0.75, s4: 1.17 };
  const at = (id) => VO.find((v) => v.id === id).at;
  // The subtitles: each line in pieces, with when each piece starts (from the pauses in the voice files).
  const SUBS = {
    n1: [[0, 'Yep. That’s Sam.'], [1.24, 'You’re probably wondering how he got here.']],
    n3: [[0, 'Two hundred and thirteen videos later,'], [1.95, 'Sam is an expert on raccoons.']],
    n4: [[0, 'Luckily, Sam has Lock In.'], [1.88, 'It lives in his menu bar.'], [3.41, 'It sees everything.']],
    c1: [[0, 'Sam. You’ve watched a raccoon steal snacks four times.'], [3.77, 'It’s the same raccoon.'], [5.4, 'Your investor update is still blank.']],
    n5: [[0, 'And if Sam still won’t lock in,'], [1.79, 'his friends get a button.']],
    n6: [[0, 'One bomb. Every distraction on his Mac.'], [2.54, 'Locked for five minutes.']],
    n8: [[0, 'It also knows your goals,'], [1.49, 'your to-dos and your calendar,'], [3.16, 'so it never roasts you on a Zoom.']],
    n9: [[0, 'Lock In. Free for Mac.'], [1.43, 'Go bomb a friend.']],
  };

  // ---- The beats ----
  const T = {
    freeze: 1.3, // record scratch: "Yep. That's Sam."
    rew: [4.55, 5.35], // ◀◀ back to 47 minutes earlier
    play: 5.35,
    scroll: [9.6, 11.75], // "just one video", then 213
    push1: [11.6, 12.2], // into his laptop
    back: [12.45, 12.95], // he scrolls all the way back up to the raccoon
    loop: 4.0, // the raccoon video, on repeat
    glow: 15.0, // the padlock in the menu bar lights up
    drift: 16.1,
    sting: [17.6, 17.85, 18.1], // dun, dun, DUN: "It sees everything."
    stingOut: [18.9, 19.3],
    toast: 19.1, // it nudges…
    flick: [19.7, 20.4],
    click: 20.45, // …he closes it
    research: [28.8, 29.95], // "It's research."
    slam: 30.5, // "Intervention."
    out1: [32.45, 32.95],
    whip: 35.75, // to Grace's phone (the bomb clip's 2.45 s)
    push2: [39.65, 40.25],
    free: 48.45, // the red card goes, the doc is back
    pull: [48.7, 49.3],
    feats: [50.35, 57.15],
    end: [56.85, 62.1],
    later: 61.9, // five minutes later…
    boom: 65.65,
    outro: 66.0,
  };
  const LENGTH = 67.8;

  // ---- The big words on top ----
  const CAPS = [
    [1.45, 4.5, 'Yep. That’s <y>Sam.</y>'],
    [5.4, 7.05, '<y>47 minutes</y> earlier'],
    [7.05, 8.5, 'Investor update due in <y>3 hours</y>'],
    [8.5, 9.65, '“Just <y>one</y> video.”'],
    [9.7, 11.6, '<y>213 videos</y> later'],
    [12.9, 14.15, 'Certified <y>raccoon expert</y>'],
    [17.6, 19.05, 'It sees <y>everything.</y>'],
    [19.15, 20.45, 'First it <y>nudges.</y>'],
    [20.5, 21.25, 'Sam <y>ignores it.</y>'],
    [21.3, 24.9, 'So it <y>talks.</y>'],
    [24.95, 26.55, 'It’s the <y>same raccoon.</y>'],
    [26.6, 28.75, 'Investor update: <y>blank.</y>'],
    [28.8, 29.95, '“It’s <y>research.</y>”'],
    [30.5, 32.45, 'Then it <y>yells.</y>'],
    [32.5, 34.6, '<y>Still</y> scrolling?'],
    [34.65, 36.05, 'Friends get <y>a button.</y>'],
    [36.1, 38.45, 'Grace throws a <y>Lock In bomb</y>'],
    [38.5, 40.05, 'Screen locked. <y>No escape.</y>'],
    [40.1, 42.6, 'Every distraction. <y>5 minutes.</y>'],
    [44.45, 45.65, 'He tried to <y>google it.</y>'],
    [45.7, 47.55, '“A <y>hostage situation.</y>”'],
    [47.7, 48.6, '<y>It is.</y>'],
    [48.8, 50.4, '…and he’s <y>locked in.</y>'],
    [50.5, 53.85, 'Your <y>goals</y> & <y>to-dos</y>'],
    [53.85, 55.65, 'Never roasts you <y>on a Zoom</y>'],
    [55.65, 56.95, 'Set up in <y>a minute</y>'],
    [62.1, 63.1, '<y>Five minutes</y> later…'],
  ];

  // ---- Scenes (each layer's time on screen; the edges overlap so one shot flows into the next) ----
  const ON = {
    wide: [[0, T.push1[1]], [T.out1[0], T.push2[1]], [T.pull[0], 50.85]],
    close: [[T.push1[0], T.out1[1]], [T.push2[0], T.pull[1]], [T.later, 65.8]],
    feats: [T.feats],
    end: [T.end],
    outro: [[T.outro, LENGTH]],
  };
  const S = ON;
  // The camera pushes into Sam's laptop screen (1) and pulls back out of it (-1).
  const PUSH = [{ a: T.push1[0], b: T.push1[1], dir: 1 }, { a: T.push2[0], b: T.push2[1], dir: 1 }, { a: T.pull[0], b: T.pull[1], dir: -1 }];
  const CLOSE = { x: 243, y: 150, w: 1433.6, h: 896 };

  // The bomb clip's own clock, for each moment it's on screen.
  function bombTime(t) {
    if (t < T.freeze) return 1.0 + t; // the feed flying by
    if (t < T.rew[0]) return 2.3; // frozen
    if (t < T.rew[1]) return 2.3 - 2.28 * ease.inOut(seg(t, T.rew[0], T.rew[1])); // rewinding
    if (t < T.scroll[0]) return 0.02 + 0.27 * seg(t, T.play, T.scroll[0]); // the first video
    if (t < T.scroll[1]) return 0.3 + 1.98 * Math.pow(seg(t, T.scroll[0], T.scroll[1]), 1.25); // and the rest
    if (t < 20) return 2.28 + 0.1 * seg(t, T.scroll[1], T.push1[1]);
    if (t < T.whip) return 1.7 + 0.75 * seg(t, T.out1[0], T.whip); // still scrolling
    if (t < 45) return 2.45 + (t - T.whip); // the bomb
    return Math.min(9.85, 8.12 + Math.max(0, t - T.pull[0])); // typing
  }
  // Sam's Mac, up close.
  function macTime(t) {
    if (t < 35) return 2.3; // the feed (the film scrolls it from here)
    if (t < T.free) return 1.04; // under the red card
    if (t < 60) return Math.max(8.12, 8.12 + (t - T.pull[0])); // the doc, typing
    return 9.85;
  }

  // The lockout: he tries everything, then tries to google his way out.
  const TRIES = [
    { at: 40.35, url: 'youtube.com', hit: 40.8, left: '4:52' },
    { at: 41.2, url: 'x.com', hit: 41.48, left: '4:51' },
    { at: 41.85, url: 'reddit.com', hit: 42.17, left: '4:50' },
    { at: 42.75, url: 'how to get around lock in', hit: 44.4, left: '4:47', pause: [0.62, 1.0], h1: 'Nice try.', msg: 'Googling how to get around Lock In is also a distraction. 4:47 left.' },
  ];
  /** How much of a try's address he has typed (0..1); the sneaky one stops halfway to think. */
  function typed(x, t) {
    const end = x.hit - 0.08;
    if (!x.pause) return seg(t, x.at, end);
    const [p0, p1] = x.pause.map((o) => x.at + o);
    return t < p0 ? 0.5 * seg(t, x.at, p0) : 0.5 + 0.5 * seg(t, p1, end);
  }

  // Each swipe of the feed, in film time (for a little flick of sound).
  function swipeTimes() {
    const B = window.LOCKIN_BOMB_B ?? [0.3, 0.72, 1.06, 1.34, 1.56, 1.74, 1.89, 2.02, 2.14];
    const out = [];
    let prev = bombTime(0);
    for (let t = 1 / 240; t < T.whip; t += 1 / 240) {
      const visible = t < T.push1[0] || (t >= T.out1[0] && t < T.whip);
      const bt = bombTime(t);
      if (visible && bt > prev) for (const s of B) if (prev < s && bt >= s) out.push({ at: +t.toFixed(3), kind: 'flick' });
      prev = bt;
    }
    return out;
  }

  // Sound cues for record.mjs (the voice, the bomb clip's own sound and the music are separate).
  const SFX = [
    ...swipeTimes(),
    { at: T.freeze, kind: 'scratch' },
    { at: T.rew[0], kind: 'rewind', until: T.rew[1] },
    { at: T.play, kind: 'clunk' },
    { at: 8.95, kind: 'tick' },
    { at: T.push1[0] - 0.05, kind: 'whoosh' },
    { at: T.back[0], kind: 'zip', until: T.back[1] },
    { at: T.glow, kind: 'blip' },
    { at: T.drift, kind: 'pluck', n: 0 },
    { at: T.sting[0], kind: 'sting' },
    { at: T.toast, kind: 'toast' },
    { at: T.click, kind: 'click' },
    { at: T.click + 0.05, kind: 'swish' },
    { at: T.back[1] + 2 * T.loop, kind: 'tick' },
    { at: T.back[1] + 3 * T.loop, kind: 'tick' },
    { at: T.research[0], kind: 'swish' },
    { at: T.slam, kind: 'slam' },
    { at: T.out1[0] - 0.02, kind: 'whoosh' },
    { at: T.push2[0] - 0.05, kind: 'whoosh' },
    ...TRIES.flatMap((x) => {
      const type = x.pause
        ? [{ at: x.at, kind: 'type', until: x.at + x.pause[0] }, { at: x.at + x.pause[1], kind: 'type', until: x.hit - 0.08 }]
        : [{ at: x.at, kind: 'type', until: x.hit - 0.08 }];
      return [...type, { at: x.hit, kind: 'denied' }, ...(x.h1 ? [{ at: x.hit + 0.12, kind: 'womp' }] : [])];
    }),
    { at: T.pull[0] - 0.02, kind: 'whoosh' },
    { at: T.feats[0] - 0.02, kind: 'whoosh' },
    { at: 53.78, kind: 'whoosh' },
    { at: 55.58, kind: 'whoosh' },
    { at: T.end[0], kind: 'chime' },
    { at: 59.2, kind: 'fuse', until: T.later + 0.2 },
    { at: T.later + 0.05, kind: 'whoosh' },
    { at: 65.2, kind: 'whistle', until: T.boom },
    { at: T.boom, kind: 'boom' },
  ].sort((a, b) => a.at - b.at);
  // The bomb clip's soundtrack: [film time, clip time, length].
  const BOMB_AUDIO = [[T.whip, 2.45, 4.55], [T.pull[0], 8.12, 1.7]];
  // Music: loud for the opening scroll, dead at the record scratch, back on PLAY; it stops for the
  // card slam and for "It is.", ducks under the dramatic sting, the bomb and the sad trombone.
  const MUSIC = {
    start: 0,
    end: T.boom,
    levels: [[0, 0.95], [T.play, 0.5], [T.scroll[0], 1], [T.push1[1], 0.55], [T.slam, 0.85], [T.pull[0], 1], [T.later, 0.45]],
    busy: [[0, T.freeze], [T.scroll[0], T.later]],
    cuts: [[T.freeze, T.play, 0.6], [T.slam, T.slam + 0.7, 0.45], [47.2, 48.45, 0.35]],
    duck: [[T.sting[0] - 0.05, T.stingOut[1], 0.25], [T.whip, T.push2[1], 0.3], [44.4, 45.9, 0.3]],
  };

  window.FILM = { VO, DUR, CAPS, S, LENGTH, SFX, BOMB_AUDIO, MUSIC, TRIES, T };

  // ---- Drawing ----
  const bombWin = () => $('bomb').contentWindow;
  const macWin = () => $('mac').contentWindow;
  const coachWin = () => $('coach').contentWindow;
  const SHOWN = { end: 'flex', outro: 'grid' };
  const show = (id, on) => {
    $(id).style.display = on ? SHOWN[id] ?? 'block' : 'none';
    $(id).style.visibility = 'visible';
  };

  // Voice loudness per frame (record.mjs fills window.VO_ENV with 30 values a second per line).
  function loud(id, t) {
    const env = window.VO_ENV?.[id];
    const v = VO.find((x) => x.id === id);
    if (!v) return 0;
    const k = t - v.at;
    if (k < 0 || k > (window.VO_DUR?.[id] ?? DUR[id])) return 0;
    if (!env) return 0.5 + 0.5 * Math.abs(Math.sin(k * 11));
    return env[Math.min(env.length - 1, Math.floor(k * 30))] ?? 0;
  }
  function bars(el, level, t, seed) {
    if (!el.children.length) for (let i = 0; i < 18; i++) el.append(document.createElement('i'));
    [...el.children].forEach((b, i) => {
      const wob = 0.55 + 0.45 * Math.abs(Math.sin(t * (9 + (i % 5)) + i * 1.7 + seed));
      const shape = 1 - Math.abs(i - 8.5) / 11;
      b.style.height = `${Math.round(6 + 34 * clamp(0.15 + level * 1.5) * wob * shape)}px`;
    });
  }

  let kStar = false;
  function star() {
    if (kStar) return;
    kStar = true;
    const pts = (r1, r2, n) => Array.from({ length: n * 2 }, (_, i) => {
      const r = i % 2 ? r2 : r1 * (0.86 + 0.14 * ((i * 37) % 7) / 6);
      const a = (i / (n * 2)) * Math.PI * 2;
      return `${(Math.cos(a) * r * 1.25).toFixed(0)},${(Math.sin(a) * r).toFixed(0)}`;
    }).join(' ');
    $('kOut').setAttribute('points', pts(500, 300, 14));
    $('kIn').setAttribute('points', pts(380, 230, 14));
  }

  const within = (name, t) => ON[name].find(([a, b]) => t >= a && t < b);
  const zoom = (s, cx = 960, cy = 540) => ({ s, x: cx * (1 - s), y: cy * (1 - s) });
  /** The transform that puts point P at point Q, scaled by s. */
  const aim = (P, Q, s) => ({ s, x: Q.x - s * P.x, y: Q.y - s * P.y });
  const apply = (m, p) => (m ? { x: m.x + m.s * p.x, y: m.y + m.s * p.y } : p);
  /** Shows a layer at an opacity, a transform ({s, x, y}, origin top left), a blur and other filters. */
  function place(id, alpha, m, blur = 0, more = '') {
    const el = $(id);
    const on = alpha > 0.002;
    show(id, on);
    if (!on) return;
    el.style.opacity = alpha >= 0.999 ? '1' : alpha.toFixed(3);
    el.style.transform = m ? `translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px) scale(${m.s.toFixed(5)})` : 'none';
    const f = `${blur > 0.05 ? `blur(${blur.toFixed(2)}px) ` : ''}${more}`.trim();
    el.style.filter = f || 'none';
  }
  /** Where the wide shot's laptop screen is (after the bomb clip has drawn this frame). */
  function laptopRect() {
    const r = $('bomb').contentDocument?.querySelector('.laptop .screen')?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 60, y: 402, w: 960, h: 600 };
  }
  /** The transform that puts a screen drawn at rect `from` where rect `to` is. */
  const fit = (from, to) => {
    const s = to.w / from.w;
    return { s, x: to.x - s * from.x, y: to.y - s * from.y };
  };
  /** A point on Sam's screen (the mac page's own pixels) in the film's pixels. */
  const onScreen = (x, y) => ({ x: CLOSE.x + 1.12 * x, y: CLOSE.y + 1.12 * y });

  // Every phrase of every line, with its own start and end (subtitles cross-fade between them).
  function phraseTimes() {
    const out = [];
    for (const v of VO) {
      const dur = window.VO_DUR?.[v.id] ?? DUR[v.id];
      const parts = SUBS[v.id] ?? [[0, v.text]];
      parts.forEach(([o, text], i) => {
        const last = i === parts.length - 1;
        const b = last ? v.at + dur + 0.25 : v.at + parts[i + 1][0] - 0.02;
        out.push({ key: `${v.id}:${i}`, who: v.who, text, a: v.at + o, b, first: i === 0, last });
      });
    }
    return out;
  }

  // ---- The reel counter on Sam's laptop (in the wide shot) ----
  function sticker(d, t) {
    const st = d.getElementById('sticker');
    if (!st) return;
    let n = null;
    let pop = 1;
    if (t >= T.rew[0] && t < T.play) n = Math.round(213 * (1 - ease.inOut(seg(t, T.rew[0], T.rew[1] - 0.08))));
    else if (t >= T.play && t < T.scroll[0]) {
      n = t < 8.95 ? 0 : 1; // "Just one video."
      pop = 1 + 0.25 * Math.max(0, 1 - Math.abs(t - 9.0) / 0.15);
    } else if (t >= T.scroll[0] && t < T.push1[1]) {
      n = Math.round(1 + 212 * Math.pow(seg(t, T.scroll[0], T.scroll[1] - 0.15), 1.6));
      pop = n < 213 ? 1 + 0.05 * Math.abs(Math.sin(t * 40)) : 1;
    } else if (t >= T.out1[0] && t < T.whip) n = 213 + Math.floor(seg(t, T.out1[0], T.whip) * 9); // still going
    if (n === null) return;
    d.getElementById('stNum').textContent = String(n);
    st.style.opacity = '1';
    st.style.transform = `rotate(6deg) scale(${pop.toFixed(3)})`;
  }

  // ---- On Sam's screen up close: the feed, scrolled back up to the raccoon, which plays on repeat ----
  function rewatch(md, t) {
    const reels = md.getElementById('reels');
    const first = md.querySelector('.reel');
    if (!reels || !first) return;
    const pos = (x) => 9 * (1 - ease.inOut(seg(x, T.back[0], T.back[1])));
    const p = pos(t);
    const speed = Math.abs(p - pos(t - 1 / 60)) * 60;
    reels.style.transform = `translateY(${(-p * 614).toFixed(2)}px)`;
    reels.style.filter = speed > 1 ? `blur(${Math.min(10, speed * 0.35).toFixed(1)}px)` : 'none';
    const age = Math.max(0, t - T.back[1]) % T.loop;
    for (const img of first.querySelectorAll('.kb')) img.style.transform = `translate(${(Math.sin(age * 2.1) * 4).toFixed(2)}px, ${(Math.cos(age * 1.7) * 3).toFixed(2)}px) scale(${(1.04 + age * 0.05).toFixed(4)})`;
    const bar = first.querySelector('.bar');
    if (bar) bar.style.width = `${t < T.back[1] ? 30 : ((age / T.loop) * 100).toFixed(2)}%`;
    // How many times he's watched it.
    let badge = md.getElementById('replays');
    if (!badge) {
      badge = md.createElement('div');
      badge.id = 'replays';
      badge.style.cssText = 'position:absolute;left:18px;top:18px;z-index:5;padding:8px 16px 9px;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;font:800 22px/1 "Public Sans",system-ui,sans-serif;white-space:nowrap;transform-origin:0 50%;box-shadow:0 4px 14px rgba(0,0,0,.35)';
      first.querySelector('.video')?.append(badge);
    }
    const since = t - T.back[1];
    const n = 2 + Math.floor(Math.max(0, since) / T.loop);
    const k = since < 0 ? 0 : seg(since % T.loop, 0, 0.3);
    badge.textContent = `↻ Watched ${n}×`;
    badge.style.opacity = String(seg(t, T.back[1] + 0.1, T.back[1] + 0.3));
    badge.style.transform = `scale(${lerp(1.35, 1, ease.backSoft(k)).toFixed(3)})`;
    badge.style.background = n === 5 && k < 1 ? `rgba(255, 207, 0, ${(1 - k).toFixed(3)})` : 'rgba(0,0,0,.62)';
    badge.style.color = n === 5 && k < 0.6 ? '#101820' : '#fff';
  }

  window.render = (t) => {
    star();
    $('fade').style.opacity = String(1 - ease.inOut(seg(t, 0, 0.25)));

    // ---- 1. The wide shot (the bomb clip) ----
    const wide = within('wide', t);
    const push = PUSH.find((p) => t >= p.a && t < p.b);
    const d = $('bomb').contentDocument;
    let wideRect = null;
    if (wide) {
      // Laid out before it's drawn and measured (inside a hidden layer, the clip has no size).
      show('wide', true);
      bombWin().render?.(bombTime(t));
      if (d && !d.getElementById('launchCss')) {
        const st = d.createElement('style');
        st.id = 'launchCss';
        st.textContent = '.cap{display:none!important}';
        d.head.append(st);
        const tag = d.getElementById('tagPhone');
        if (tag) tag.textContent = 'Grace’s phone';
      }
      if (d) sticker(d, t);
      wideRect = laptopRect();
    }
    let wideA = wide ? 1 : 0;
    let wideM = null;
    let wideBlur = 0;
    let wideMore = '';
    // The freeze frame: grey, a slow push in on Sam; then the tape rewinds, jittering.
    let head = null;
    if (wide && t >= T.freeze && t < T.play + 0.35) {
      const r = d?.getElementById('samHead')?.getBoundingClientRect();
      head = r ? { x: r.left + r.width * 0.5, y: r.top + r.height * 0.45, r } : { x: 1100, y: 600 };
      const kz = ease.inOut(seg(t, T.freeze, T.rew[0])) * (1 - ease.inOut(seg(t, T.rew[0], T.rew[0] + 0.35)));
      wideM = zoom(1 + 0.12 * kz + 0.03 * (1 - ease.outQuint(seg(t, T.freeze, T.freeze + 0.25))), head.x, head.y);
      const g = 1 - seg(t, T.play, T.play + 0.3);
      wideMore = `grayscale(${g.toFixed(3)}) contrast(${(1 + 0.15 * g).toFixed(3)}) brightness(${(1 - 0.06 * g).toFixed(3)})`;
      if (t >= T.rew[0] && t < T.play) {
        wideM.x += Math.sin(t * 97) * 7 + (Math.sin(t * 13) > 0.7 ? 14 : 0);
        wideM.y += Math.cos(t * 71) * 3;
      }
    }
    if (wide === ON.wide[1] && t < T.out1[1]) {
      // In from the card: settles back from a slight zoom (he's scrolling again).
      const k = ease.outQuint(seg(t, T.out1[0], T.out1[1]));
      wideA = k;
      wideM = zoom(lerp(1.08, 1, k));
    }
    if (wide === ON.wide[2] && t >= T.feats[0]) {
      // Out to the feature tour: pushes forward and dissolves.
      const k = ease.inOut(seg(t, T.feats[0], T.feats[0] + 0.5));
      wideA = 1 - k;
      wideM = zoom(lerp(1, 1.12, k));
      wideBlur = 7 * k;
    }

    // "That's Sam": a label on the frozen frame.
    const tagA = head ? ease.backSoft(seg(t, at('n1') + 0.42, at('n1') + 0.72)) * (1 - seg(t, T.rew[0], T.rew[0] + 0.15)) : 0;
    $('samTag').style.display = tagA > 0.01 ? 'block' : 'none';
    if (tagA > 0.01) {
      const p = apply(wideM, { x: head.r ? head.r.right : head.x + 120, y: head.r ? head.r.top + head.r.height * 0.2 : head.y - 80 });
      $('samTag').style.transform = `translate(${(p.x - 10).toFixed(1)}px, ${(p.y - 150).toFixed(1)}px) scale(${clamp(tagA, 0, 1.2).toFixed(3)}) rotate(-4deg)`;
      $('samTag').style.opacity = String(clamp(tagA * 2));
    }

    // VHS: ◀◀ while it rewinds, ▶ PLAY after.
    const vhsA = t >= T.rew[0] && t < T.play + 0.8 ? 1 - seg(t, T.play + 0.5, T.play + 0.8) : 0;
    $('vhs').style.display = vhsA > 0 ? 'block' : 'none';
    if (vhsA > 0) {
      $('vhs').style.opacity = vhsA.toFixed(3);
      $('vhsLines').style.opacity = String(1 - seg(t, T.play, T.play + 0.3));
      $('vhsBand').style.transform = `translateY(${(((t * 1.7) % 1) * 1300 - 200).toFixed(1)}px)`;
      $('vhsOsd').innerHTML = t < T.play ? '◀◀&nbsp;REWIND' : '▶&nbsp;PLAY';
    }

    // ---- 2. Sam's screen, up close ----
    const close = within('close', t);
    const md = $('mac').contentDocument;
    if (close) {
      show('close', true);
      macWin().render?.(macTime(t));
      if (close === ON.close[0] && md) rewatch(md, t);
    }
    let closeA = close ? 1 : 0;
    let closeM = null;
    let closeBlur = 0;
    if (push && wideRect) {
      // The push: both shots put the laptop screen at the same place, so the cut can't be seen.
      const k = ease.inOut(seg(t, push.a, push.b));
      const kk = push.dir > 0 ? k : 1 - k;
      const R = { x: lerp(wideRect.x, CLOSE.x, kk), y: lerp(wideRect.y, CLOSE.y, kk), w: lerp(wideRect.w, CLOSE.w, kk), h: lerp(wideRect.h, CLOSE.h, kk) };
      wideM = fit(wideRect, R);
      closeM = fit(CLOSE, R);
      closeA = ease.smooth(seg(kk, 0.25, 0.7));
    } else if (close === ON.close[0] && t >= T.out1[0]) {
      // Out after the card: pulls back and softens.
      const k = ease.inOut(seg(t, T.out1[0], T.out1[1]));
      closeA = 1 - k;
      closeM = zoom(lerp(1, 0.86, k));
      closeBlur = 8 * k;
    } else if (close === ON.close[2]) {
      // Back in after the end card (five minutes later).
      const k = ease.outQuint(seg(t, T.later + 0.15, T.later + 0.6));
      closeA = k;
      closeM = zoom(lerp(1.05, 1, k));
    } else if (close === ON.close[0] && md && t >= T.sting[0] - 0.01 && t < T.stingOut[1]) {
      // Dun, dun, DUN: three snap zooms onto the padlock in the menu bar.
      const r = md.getElementById('tray').getBoundingClientRect();
      const P = onScreen(r.left + r.width / 2, r.top + r.height / 2);
      const lvl = T.sting.reduce((a, h) => a + ease.outQuint(seg(t, h, h + 0.09)), 0) / T.sting.length;
      const k = lvl * (1 - ease.inOut(seg(t, T.stingOut[0], T.stingOut[1])));
      closeM = aim(P, { x: lerp(P.x, 960, k), y: lerp(P.y, 430, k) }, 1 + 2.3 * k);
      const jolt = T.sting.reduce((a, h) => a + (t >= h ? Math.max(0, 1 - (t - h) / 0.2) : 0), 0);
      closeM.x += Math.sin(t * 120) * 12 * jolt;
      closeM.y += Math.cos(t * 97) * 8 * jolt;
    } else if (close === ON.close[0] && md && t >= T.research[0] && t < T.research[1] + 0.3) {
      // "It's research": a punch in on the raccoon.
      const r = md.querySelector('.reel .video')?.getBoundingClientRect();
      if (r) {
        const P = onScreen(r.left + r.width / 2, r.top + r.height * 0.45);
        const k = ease.outQuint(seg(t, T.research[0], T.research[0] + 0.14)) * (1 - ease.inOut(seg(t, T.research[1], T.research[1] + 0.25)));
        closeM = aim(P, { x: lerp(P.x, 960, k), y: lerp(P.y, 600, k) }, 1 + 0.7 * k);
      }
    }
    place('wide', wideA, wideM, wideBlur, wideMore);
    place('close', closeA, closeM, closeBlur);

    if (close) {
      // The padlock in the menu bar lights up: he's drifting.
      const tray = md?.getElementById('tray')?.getBoundingClientRect();
      const first = close === ON.close[0];
      const glowA = first ? seg(t, T.glow, T.glow + 0.3) * (1 - seg(t, T.click, T.click + 0.35)) : 0;
      $('glow').style.opacity = String(glowA * (0.6 + 0.4 * (0.5 - 0.5 * Math.cos((t - T.glow) * 7))));
      const driftA = first ? ease.outQuint(seg(t, T.drift, T.drift + 0.35)) * (1 - seg(t, T.click, T.click + 0.35)) : 0;
      const tIn = ease.outQuint(seg(t, T.toast, T.toast + 0.5));
      const tOut = ease.inOut(seg(t, T.click + 0.05, T.click + 0.4));
      $('drift').style.opacity = String(driftA);
      if (tray) {
        Object.assign($('glow').style, { left: `${tray.left - 14}px`, top: `${tray.top - 6}px`, width: `${tray.width + 28}px`, height: `${tray.height + 12}px` });
        Object.assign($('drift').style, { left: `${tray.left - 40}px`, top: `${tray.bottom + 10 + 180 * ease.inOut(seg(t, T.toast, T.toast + 0.45)) * (1 - tOut)}px` });
      }

      // The corner card slides in (it nudges), he closes it.
      $('toast').style.opacity = first ? String(seg(t, T.toast, T.toast + 0.2) * (1 - seg(t, T.click + 0.1, T.click + 0.35))) : '0';
      $('toast').style.transform = `translateX(${((1 - tIn) * 440 + tOut * 440).toFixed(2)}px)`;

      // Lock In talks (the bars follow the voice).
      const talkLine = !first ? 'c3' : t < at('c2') - 0.05 ? 'c1' : 'c2';
      const from = first ? at('c1') - 0.3 : at('c3') - 0.25;
      const until = first ? T.slam : at('c3') + 0.95;
      const ta = ease.outQuint(seg(t, from, from + 0.4)) * (1 - seg(t, until - 0.05, until + 0.2));
      $('talk').style.opacity = String(ta);
      $('talk').style.transform = `translateY(${((1 - ta) * -14).toFixed(2)}px)`;
      if (ta > 0) bars($('bars'), loud(talkLine, t), t, 0);

      // The card slams down (on purpose, not smooth).
      const ck = first && t >= T.slam ? t - T.slam : -1;
      $('coach').style.visibility = ck >= 0 ? 'visible' : 'hidden';
      coachWin().render?.(ck);

      // The cursor: to the corner card's ×; then (five minutes later) creeping toward the feed's tab,
      // freezing when Lock In says his name, and creeping on.
      const cur = $('cursor');
      let cx = null;
      let cy = null;
      let ca = 0;
      let press = 0;
      if (first && t > T.flick[0] - 0.2 && t < T.click + 0.6) {
        const k2 = ease.inOut(seg(t, T.flick[0], T.flick[1]));
        cx = lerp(640, 1232, k2);
        cy = lerp(520, 58, k2);
        ca = seg(t, T.flick[0] - 0.2, T.flick[0] + 0.05) * (1 - seg(t, T.click + 0.25, T.click + 0.6));
        press = Math.sin(Math.PI * seg(t, T.click - 0.05, T.click + 0.11));
      }
      const tab = md?.getElementById('tabFeed');
      if (close === ON.close[2]) {
        if (tab) {
          tab.style.display = 'flex';
          tab.classList.remove('on');
        }
        const r = tab?.getBoundingClientRect();
        const k3 = 0.7 * ease.inOut(seg(t, T.later + 0.4, at('c3') - 0.05)) + 0.2 * ease.inOut(seg(t, at('s4'), T.boom - 0.15));
        cx = lerp(700, r ? r.left + r.width / 2 : 400, k3);
        cy = lerp(560, r ? r.top + r.height / 2 + 4 : 70, k3);
        ca = seg(t, T.later + 0.3, T.later + 0.55);
      }
      cur.style.opacity = String(ca);
      if (cx !== null) cur.style.transform = `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px) scale(${(1 - 0.14 * press).toFixed(3)})`;

      // The lockout: every site he tries is locked, and so is googling his way out.
      const gag = close === ON.close[1];
      const bl = $('blocked');
      const blA = gag && t >= TRIES[0].hit ? 1 - ease.inOut(seg(t, T.free, T.free + 0.3)) : 0;
      bl.style.display = blA > 0 ? 'grid' : 'none';
      bl.style.opacity = String(blA);
      const feed = md?.getElementById('feed')?.getBoundingClientRect();
      if (feed) Object.assign(bl.style, { left: `${feed.left}px`, top: `${feed.top}px`, width: `${feed.width}px`, height: `${feed.height}px` });
      if (gag && md && t < T.free) {
        const x = [...TRIES].reverse().find((y) => t >= y.at);
        const url = md.getElementById('url');
        if (x && url) {
          const n = Math.round(x.url.length * typed(x, t));
          url.textContent = t < x.hit ? x.url.slice(0, n) + (Math.floor(t * 6) % 2 ? '|' : '') : x.url;
        }
        // The sneaky one gets a search box, big enough to read.
        const sb = $('search');
        const sA = x?.pause ? ease.outQuint(seg(t, x.at - 0.05, x.at + 0.2)) * (1 - seg(t, x.hit + 0.05, x.hit + 0.3)) : 0;
        sb.style.display = sA > 0.01 ? 'flex' : 'none';
        if (sA > 0.01) {
          sb.style.opacity = sA.toFixed(3);
          sb.style.transform = `translateY(-50%) scale(${lerp(0.92, 1, sA).toFixed(4)})`;
          $('sq').textContent = x.url.slice(0, Math.round(x.url.length * typed(x, t)));
          $('sqCaret').style.opacity = t < x.hit && Math.floor(t * 4) % 2 === 0 ? '1' : t < x.hit ? '0' : '0';
        }
        const card = bl.querySelector('.bc');
        const hit = x && t >= x.hit;
        card.style.visibility = hit ? 'visible' : 'hidden';
        if (hit) {
          const big = x.h1 ? 1.4 : 1.25;
          const k4 = ease.backSoft(seg(t, x.hit, x.hit + (x.h1 ? 0.4 : 0.3)));
          card.style.transform = `scale(${lerp(big, 1, k4).toFixed(4)}) rotate(${lerp(x.h1 ? 8 : -6, x.h1 ? -2 : 2, k4).toFixed(3)}deg)`;
          card.style.opacity = String(seg(t, x.hit, x.hit + 0.06));
          $('bH1').textContent = x.h1 ?? 'Locked.';
          $('bMsg').textContent = x.msg ?? `${x.url} is locked for ${x.left}. Every distraction is. Back to work.`;
        }
      }
      const badge = md?.getElementById('replays');
      if (badge && !first) badge.style.opacity = '0';
    }

    // ---- 3. What else it does: a carousel ----
    const feats = within('feats', t);
    if (feats) {
      const [a0, b0] = T.feats;
      const kin = ease.outQuint(seg(t, a0, a0 + 0.4));
      const kout = ease.inOut(seg(t, b0 - 0.4, b0));
      place('feats', kin * (1 - kout), zoom(lerp(1, 0.94, kout)), 6 * kout);
      [[50.45, 53.9], [53.8, 55.7], [55.6, b0]].forEach(([a, b], i) => {
        const el = $(`f${i + 1}`);
        const k = ease.outQuint(seg(t, a, a + 0.5));
        const k2 = ease.inOut(seg(t, b - 0.3, b));
        const on = t >= a && t < b;
        el.style.visibility = on ? 'visible' : 'hidden';
        if (!on) return;
        el.style.transform = `translateX(${((1 - k) * 200 - k2 * 200).toFixed(2)}px)`;
        el.style.opacity = String(ease.smooth(seg(t, a, a + 0.25)) * (1 - k2));
        [...el.querySelectorAll('img')].forEach((img, j) => (img.style.transform = `rotate(${((j % 2 ? 2 : -2) * (1 - 0.3 * k)).toFixed(3)}deg) scale(${(lerp(0.95, 1, k) + (t - a) * 0.006).toFixed(4)})`));
      });
    } else place('feats', 0);

    // ---- 4. The end card ----
    const end = within('end', t);
    if (end) {
      const [a0, b0] = T.end;
      const kin = ease.outQuint(seg(t, a0 + 0.1, a0 + 0.6));
      const kout = ease.inOut(seg(t, b0 - 0.4, b0 - 0.05));
      place('end', kin * (1 - kout), zoom(lerp(1.05, 1, kin) + 0.012 * seg(t, a0 + 0.45, b0)));
      const parts = [['#end .icon', a0 + 0.35], ['#end h1', a0 + 0.6], ['#end .tag', a0 + 1.25], ['#end .meta', a0 + 1.7], ['#endR', a0 + 2.35]];
      for (const [sel, when] of parts) {
        const el = document.querySelector(sel);
        const k = ease.backSoft(seg(t, when, when + 0.5));
        el.style.opacity = String(ease.smooth(seg(t, when, when + 0.25)));
        el.style.transform = `translateY(${((1 - k) * 34).toFixed(2)}px) scale(${lerp(0.94, 1, k).toFixed(4)})`;
      }
      $('endSpark').setAttribute('transform', `translate(133 18) scale(${(0.8 + 0.3 * (0.5 - 0.5 * Math.cos(t * 30))).toFixed(3)}) rotate(${((t * 400) % 360).toFixed(1)})`);
      $('endBomb').style.transform = `rotate(${(Math.sin(t * 3) * 4).toFixed(3)}deg)`;
    } else place('end', 0);

    // ---- 5. The stinger: KABOOM, then the outro ----
    const kbA = t >= T.boom ? 1 - ease.inOut(seg(t, T.boom + 0.42, T.boom + 0.65)) : 0;
    $('kaboom').style.visibility = kbA > 0 ? 'visible' : 'hidden';
    if (kbA > 0) {
      const k = ease.backSoft(seg(t, T.boom, T.boom + 0.28));
      $('kaboom').style.opacity = String(kbA);
      $('kaboom').style.transform = `scale(${lerp(0.2, 1.1, k).toFixed(4)}) rotate(${lerp(-20, -4, k).toFixed(3)}deg)`;
    }
    place('outro', within('outro', t) ? ease.inOut(seg(t, T.outro, T.outro + 0.35)) : 0);

    // Flashes: the freeze frame, the card slam and the boom.
    const flash = (when, peak, len) => (t >= when ? peak * (1 - ease.out(seg(t, when, when + len))) : 0);
    $('flash').style.opacity = String(Math.max(flash(T.freeze, 0.55, 0.22), flash(T.slam, 0.5, 0.3), flash(T.boom, 0.65, 0.22)));

    // ---- The big words: glide up out of a soft blur, and cross-fade into the next ----
    const caps = [$('cap'), $('cap2')];
    let shade = 0;
    const shown = new Set();
    CAPS.forEach((c, i) => {
      const [a, b, html] = c;
      if (t < a - 0.01 || t >= b + 0.25) return;
      const el = caps[i % 2];
      shown.add(el);
      if (el.dataset.at !== String(a)) {
        el.innerHTML = html;
        el.dataset.at = String(a);
      }
      const kin = ease.outQuint(seg(t, a, a + 0.42));
      const kout = ease.inOut(seg(t, b - 0.05, b + 0.22));
      const alpha = ease.smooth(seg(t, a, a + 0.2)) * (1 - kout);
      el.style.opacity = alpha.toFixed(3);
      el.style.transform = `translateY(${((1 - kin) * 30 - kout * 16).toFixed(2)}px) scale(${lerp(1.05, 1, kin).toFixed(4)})`;
      const blur = (1 - seg(t, a, a + 0.28)) * 10 + kout * 6;
      el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
      shade = Math.max(shade, ease.smooth(seg(t, a, a + 0.3)) * (1 - seg(t, b, b + 0.3)));
    });
    for (const el of caps) if (!shown.has(el)) el.style.opacity = '0';
    $('shade').style.opacity = shade.toFixed(3);

    // ---- Subtitles: a phrase at a time, cross-fading ----
    const subs = [$('sub'), $('sub2')];
    const used = new Set();
    phraseTimes().forEach((p, i) => {
      if (t < p.a - 0.12 || t >= p.b + 0.12) return;
      const el = subs[i % 2];
      used.add(el);
      if (el.dataset.id !== p.key) {
        el.innerHTML = (p.who === 'coach' ? '<span class="who coach">Lock In</span>' : p.who === 'sam' ? '<span class="who sam">Sam</span>' : '') + p.text;
        el.dataset.id = p.key;
      }
      const fin = p.first ? 0.18 : 0.1;
      const fout = p.last ? 0.22 : 0.1;
      const kin = ease.smooth(seg(t, p.a - fin * 0.6, p.a + fin * 0.4));
      const kout = ease.smooth(seg(t, p.b - fout * 0.4, p.b + fout * 0.6));
      el.style.opacity = (kin * (1 - kout)).toFixed(3);
      const rise = p.first ? (1 - ease.outQuint(seg(t, p.a - 0.1, p.a + 0.25))) * 14 : 0;
      el.style.transform = `translateX(-50%) translateY(${rise.toFixed(2)}px)`;
    });
    for (const el of subs) if (!used.has(el)) el.style.opacity = '0';
  };
})();
