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
    { id: 'n1', who: 'narrator', at: 0.4, text: 'This is Sam. Sam has an investor update due in three hours.' },
    { id: 's1', who: 'sam', at: 4.25, text: 'Just one video.' },
    { id: 'n2', who: 'narrator', at: 6.7, text: 'That was a hundred and eighty videos ago.' },
    { id: 'n3', who: 'narrator', at: 10.4, text: 'Luckily, Sam has Lock In. It lives in his menu bar, and it notices when he drifts.' },
    { id: 'c1', who: 'coach', at: 15.9, text: 'Sam. It’s been twenty-two minutes. The investor update is not going to write itself.' },
    { id: 'c2', who: 'coach', at: 21.7, text: 'Right. This is an intervention.' },
    { id: 'n4', who: 'narrator', at: 24.35, text: 'First it nudges. Then it talks. Then it yells.' },
    { id: 'n5', who: 'narrator', at: 27.15, text: 'And if Sam still won’t lock in, his friends can help.' },
    { id: 'n6', who: 'narrator', at: 32.75, text: 'One bomb locks every distraction on his Mac. For five whole minutes.' },
    { id: 's2', who: 'sam', at: 38.6, text: 'Ugh. Fine.' },
    { id: 'n7', who: 'narrator', at: 41.7, text: 'Lock In knows your goals and today’s to-dos, stays quiet in your meetings, and sets up in a minute.' },
    { id: 'n8', who: 'narrator', at: 50.0, text: 'Lock In. Free for Mac. Go bomb a friend.' },
    { id: 'c3', who: 'coach', at: 57.0, text: 'Don’t even think about it.' },
  ];
  const DUR = { n1: 3.58, s1: 1.0, n2: 1.72, n3: 5.02, c1: 5.43, c2: 2.26, n4: 2.65, n5: 2.68, n6: 3.93, s2: 0.76, n7: 5.4, n8: 2.39, c3: 1.6 };

  // ---- The big words on top ----
  const CAPS = [
    [0.3, 1.95, 'This is <y>Sam.</y>'],
    [1.95, 4.15, 'Investor update due in <y>3 hours</y>'],
    [4.15, 5.6, '“Just <y>one</y> video.”'],
    [6.55, 10.0, '<y>180 videos</y> later'],
    [10.45, 15.1, 'Lock In <y>notices.</y>'],
    [15.12, 15.9, 'Sam <y>ignores it.</y>'],
    [15.92, 22.55, 'So it <y>talks.</y>'],
    [22.6, 24.3, 'Then it <y>yells.</y>'],
    [27.05, 28.75, '<y>Still</y> scrolling?'],
    [28.75, 29.45, 'Call <y>a friend.</y>'],
    [29.45, 32.15, 'Grace throws a <y>Lock In bomb</y>'],
    [32.2, 34.4, 'Screen locked. <y>No escape.</y>'],
    [34.45, 38.55, 'Every distraction. <y>5 minutes.</y>'],
    [38.55, 39.6, '“Ugh. <y>Fine.</y>”'],
    [39.65, 41.4, '…and he’s <y>locked in.</y>'],
    [41.45, 43.9, 'Your <y>goals</y> & <y>to-dos</y>'],
    [43.9, 45.7, '<y>Quiet</y> in meetings'],
    [45.7, 47.3, 'Set up in <y>a minute</y>'],
    [47.3, 49.6, 'Friends can <y>bomb you</y>'],
    [56.05, 57.0, '<y>Five minutes</y> later…'],
  ];

  // ---- Scenes ----
  const S = {
    wide: [[0, 10.0], [27.0, 34.4], [39.6, 41.4]],
    close: [[10.0, 24.3], [34.4, 39.6], [56.0, 59.25]],
    recap: [[24.3, 27.0]],
    feats: [[41.4, 49.6]],
    end: [[49.6, 56.0]],
    outro: [[59.6, 60.6]],
  };
  const LENGTH = 60.6;
  const inScene = (name, t) => S[name].find(([a, b]) => t >= a && t < b);

  // The bomb clip's own clock, for each moment it's on screen.
  function bombTime(t) {
    if (t < 5.5) return 0.28 * (t / 5.5);
    if (t < 12) return 0.3 + 1.95 * Math.pow(Math.min(1, (t - 5.5) / 4.5), 1.6);
    if (t < 29.4) return 1.7 + (t - 27) * 0.27;
    if (t < 37) return 2.45 + (t - 29.4);
    return 8.05 + (t - 39.6);
  }
  // Sam's Mac, up close.
  function macTime(t) {
    if (t < 22.6) return 0.3 + (t - 10) * 0.09;
    if (t < 24.3) return 0.3 + 12.6 * 0.09;
    if (t < 39.3) return 1.0;
    if (t < 55) return 8.45 + (t - 39.3);
    return 9.85;
  }

  // The lockout: he tries everything.
  const TRIES = [
    { at: 34.5, url: 'youtube.com', hit: 35.0, left: '4:52' },
    { at: 35.55, url: 'x.com', hit: 35.85, left: '4:51' },
    { at: 36.45, url: 'reddit.com', hit: 36.8, left: '4:50' },
    { at: 37.3, url: 'instagram.com', hit: 37.58, left: '4:49' },
  ];

  // Sound cues for record.mjs (the voice, the bomb clip's own sound and the music are separate).
  const SFX = [
    { at: 4.85, kind: 'click' },
    { at: 9.95, kind: 'whoosh' },
    { at: 11.85, kind: 'blip' },
    { at: 12.8, kind: 'toast' },
    { at: 15.05, kind: 'click' },
    { at: 15.12, kind: 'swish' },
    { at: 22.6, kind: 'slam' },
    { at: 24.28, kind: 'whoosh' },
    { at: 24.75, kind: 'pluck', n: 0 },
    { at: 25.6, kind: 'pluck', n: 1 },
    { at: 26.45, kind: 'pluck', n: 2 },
    { at: 26.98, kind: 'whoosh' },
    { at: 34.38, kind: 'whoosh' },
    ...TRIES.flatMap((x) => [{ at: x.at, kind: 'type', until: x.hit - 0.08 }, { at: x.hit, kind: 'denied' }]),
    { at: 39.58, kind: 'whoosh' },
    { at: 41.38, kind: 'whoosh' },
    { at: 43.88, kind: 'whoosh' },
    { at: 45.68, kind: 'whoosh' },
    { at: 47.28, kind: 'whoosh' },
    { at: 49.6, kind: 'chime' },
    { at: 51.7, kind: 'fuse', until: 56.0 },
    { at: 55.95, kind: 'whoosh' },
    { at: 58.65, kind: 'whistle', until: 59.2 },
    { at: 59.2, kind: 'boom' },
  ];
  // The bomb clip's soundtrack: [film time, clip time, length].
  const BOMB_AUDIO = [[29.4, 2.45, 5.0], [39.6, 8.05, 1.8]];
  // Music: in at 0.3, out under the bomb (its own sound plays), back for the lockout, off at the
  // card slam and the stinger's boom.
  const MUSIC = { start: 0.3, end: 59.2, duck: [[22.55, 24.3, 0.35], [29.4, 34.4, 0.25], [59.2, 61, 0]] };

  window.FILM = { VO, DUR, CAPS, S, LENGTH, SFX, BOMB_AUDIO, MUSIC, TRIES };

  /** A line in subtitle-sized pieces: split after sentences and commas, joined up to ~46 characters. */
  function phrases(text) {
    const bits = text.split(/(?<=[.,!?…])\s+/);
    const out = [];
    for (const b of bits) {
      if (out.length && out[out.length - 1].length + b.length + 1 <= 46) out[out.length - 1] += ` ${b}`;
      else out.push(b);
    }
    return out;
  }

  // ---- Drawing ----
  const bombWin = () => $('bomb').contentWindow;
  const macWin = () => $('mac').contentWindow;
  const coachWin = () => $('coach').contentWindow;
  const SHOWN = { recap: 'flex', end: 'flex', outro: 'grid' };
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

  // ---- Layers, and the camera moves between them ----
  // Each layer's time on screen; the edges overlap so one shot flows into the next.
  const ON = {
    wide: [[0, 10.35], [26.75, 34.7], [39.55, 41.7]],
    close: [[9.75, 24.55], [34.1, 40.15], [55.8, 59.4]],
    recap: [[24.05, 27.2]],
    feats: [[41.2, 49.9]],
    end: [[49.35, 56.1]],
    outro: [[59.5, 60.6]],
  };
  // The camera pushes into Sam's laptop screen (1) and pulls back out of it (-1).
  const PUSH = [{ a: 9.75, b: 10.35, dir: 1 }, { a: 34.1, b: 34.7, dir: 1 }, { a: 39.55, b: 40.15, dir: -1 }];
  const CLOSE = { x: 243, y: 150, w: 1433.6, h: 896 };
  const within = (name, t) => ON[name].find(([a, b]) => t >= a && t < b);
  const zoom = (s, cx = 960, cy = 540) => ({ s, x: cx * (1 - s), y: cy * (1 - s) });
  /** Shows a layer at an opacity, a transform ({s, x, y}, origin top left) and a blur. */
  function place(id, alpha, m, blur = 0) {
    const el = $(id);
    const on = alpha > 0.002;
    show(id, on);
    if (!on) return;
    el.style.opacity = alpha >= 0.999 ? '1' : alpha.toFixed(3);
    el.style.transform = m ? `translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px) scale(${m.s.toFixed(5)})` : 'none';
    el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
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

  // Every phrase of every line, with its own start and end (subtitles cross-fade between them).
  function phraseTimes() {
    const out = [];
    for (const v of VO) {
      const parts = phrases(v.text);
      const total = parts.reduce((n, p) => n + p.length, 0);
      const dur = window.VO_DUR?.[v.id] ?? DUR[v.id];
      let acc = 0;
      parts.forEach((p, i) => {
        const a = v.at + (acc / total) * dur;
        acc += p.length;
        const b = i === parts.length - 1 ? v.at + dur + 0.25 : v.at + (acc / total) * dur;
        out.push({ key: `${v.id}:${i}`, who: v.who, text: p, a, b, first: i === 0, last: i === parts.length - 1 });
      });
    }
    return out;
  }

  window.render = (t) => {
    star();
    $('fade').style.opacity = String(1 - ease.inOut(seg(t, 0, 0.6)));

    // ---- 1. The wide shot (the bomb clip) ----
    const wide = within('wide', t);
    const push = PUSH.find((p) => t >= p.a && t < p.b);
    let wideRect = null;
    if (wide) {
      bombWin().render?.(bombTime(t));
      const d = $('bomb').contentDocument;
      if (d && !d.getElementById('launchCss')) {
        const st = d.createElement('style');
        st.id = 'launchCss';
        st.textContent = '.cap{display:none!important}';
        d.head.append(st);
        const tag = d.getElementById('tagPhone');
        if (tag) tag.textContent = 'Grace’s phone';
      }
      wideRect = laptopRect();
    }
    let wideA = wide ? 1 : 0;
    let wideM = null;
    let wideBlur = 0;
    if (wide && wide[0] === 26.75) {
      // In from the recap: settles back from a slight zoom.
      const k = ease.outQuint(seg(t, 26.75, 27.25));
      wideA = k;
      wideM = zoom(lerp(1.08, 1, k));
    }
    if (wide && wide[0] === 39.55 && t >= 41.2) {
      // Out to the feature tour: pushes forward and dissolves.
      const k = ease.inOut(seg(t, 41.2, 41.7));
      wideA = 1 - k;
      wideM = zoom(lerp(1, 1.12, k));
      wideBlur = 7 * k;
    }

    // ---- 2. Sam's screen, up close ----
    const close = within('close', t);
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
    } else if (close && close[0] === 9.75 && t >= 24.05) {
      // Out to the recap: pulls back and softens.
      const k = ease.inOut(seg(t, 24.05, 24.55));
      closeA = 1 - k;
      closeM = zoom(lerp(1, 0.86, k));
      closeBlur = 8 * k;
    } else if (close && close[0] === 55.8) {
      // Back in after the end card (five minutes later).
      const k = ease.outQuint(seg(t, 55.95, 56.4));
      closeA = k;
      closeM = zoom(lerp(1.05, 1, k));
    }
    place('wide', wideA, wideM, wideBlur);
    place('close', closeA, closeM, closeBlur);

    if (close) {
      macWin().render?.(macTime(t));
      const md = $('mac').contentDocument;

      // The padlock in the menu bar lights up: he's drifting.
      const tray = md?.getElementById('tray')?.getBoundingClientRect();
      const glowA = seg(t, 11.8, 12.1) * (1 - seg(t, 15.35, 15.7));
      $('glow').style.opacity = String(glowA * (0.6 + 0.4 * (0.5 - 0.5 * Math.cos((t - 11.8) * 7))));
      const driftA = ease.outQuint(seg(t, 12.0, 12.35)) * (1 - seg(t, 15.35, 15.7));
      const tIn = ease.outQuint(seg(t, 12.8, 13.3));
      const tOut = ease.inOut(seg(t, 15.1, 15.45));
      $('drift').style.opacity = String(driftA);
      if (tray) {
        Object.assign($('glow').style, { left: `${tray.left - 14}px`, top: `${tray.top - 6}px`, width: `${tray.width + 28}px`, height: `${tray.height + 12}px` });
        Object.assign($('drift').style, { left: `${tray.left - 40}px`, top: `${tray.bottom + 10 + 180 * ease.inOut(seg(t, 12.8, 13.25)) * (1 - tOut)}px` });
      }

      // The corner card slides in, he closes it.
      $('toast').style.opacity = String(seg(t, 12.8, 13.0) * (1 - seg(t, 15.2, 15.45)));
      $('toast').style.transform = `translateX(${((1 - tIn) * 440 + tOut * 440).toFixed(2)}px)`;

      // Lock In talks (the bars follow the voice).
      const talkLine = t < 22.6 ? (t < 21.6 ? 'c1' : 'c2') : 'c3';
      const from = t < 40 ? 15.8 : 56.9;
      const until = t < 40 ? 22.6 : 58.8;
      const ta = ease.outQuint(seg(t, from, from + 0.4)) * (1 - seg(t, until - 0.05, until + 0.2));
      $('talk').style.opacity = String(ta);
      $('talk').style.transform = `translateY(${((1 - ta) * -14).toFixed(2)}px)`;
      if (ta > 0) bars($('bars'), loud(talkLine, t), t, 0);

      // The card slams down (on purpose, not smooth).
      const ck = t >= 22.6 && t < 24.6 ? t - 22.6 : -1;
      $('coach').style.visibility = ck >= 0 ? 'visible' : 'hidden';
      coachWin().render?.(ck);

      // The cursor: to the corner card's ×, then (five minutes later) creeping toward the feed's tab.
      const cur = $('cursor');
      let cx = null;
      let cy = null;
      let ca = 0;
      let press = 0;
      if (t > 13.9 && t < 15.8) {
        const k2 = ease.inOut(seg(t, 14.1, 15.0));
        cx = lerp(640, 1232, k2);
        cy = lerp(520, 58, k2);
        ca = seg(t, 13.9, 14.15) * (1 - seg(t, 15.45, 15.8));
        press = Math.sin(Math.PI * seg(t, 15.0, 15.16));
      }
      if (t >= 56.0 && t < 59.3) {
        const tab = md?.getElementById('tabFeed');
        if (tab) {
          tab.style.display = 'flex';
          tab.classList.remove('on');
        }
        const r = tab?.getBoundingClientRect();
        const k3 = ease.inOut(seg(t, 56.3, 58.7));
        cx = lerp(700, r ? r.left + r.width / 2 : 400, k3);
        cy = lerp(560, r ? r.top + r.height / 2 + 4 : 70, k3);
        ca = seg(t, 56.1, 56.4);
      }
      cur.style.opacity = String(ca);
      if (cx !== null) cur.style.transform = `translate(${cx.toFixed(2)}px, ${cy.toFixed(2)}px) scale(${(1 - 0.14 * press).toFixed(3)})`;

      // The lockout: every site he tries is locked; then he gives up and the doc comes back.
      const gag = t >= 34.1 && t < 39.55;
      const feed = md?.getElementById('feed')?.getBoundingClientRect();
      const bl = $('blocked');
      const blA = t >= TRIES[0].hit ? 1 - ease.inOut(seg(t, 39.25, 39.55)) : 0;
      bl.style.display = gag && blA > 0 ? 'grid' : 'none';
      bl.style.opacity = String(blA);
      if (feed) Object.assign(bl.style, { left: `${feed.left}px`, top: `${feed.top}px`, width: `${feed.width}px`, height: `${feed.height}px` });
      if (gag && md && t < 39.3) {
        const cur2 = [...TRIES].reverse().find((x) => t >= x.at);
        const url = md.getElementById('url');
        if (cur2 && url) {
          const n = Math.round(cur2.url.length * seg(t, cur2.at, cur2.hit - 0.08));
          url.textContent = t < cur2.hit ? cur2.url.slice(0, n) + (Math.floor(t * 6) % 2 ? '|' : '') : `${cur2.url}`;
        }
        const card = bl.querySelector('.bc');
        const hit = cur2 && t >= cur2.hit;
        card.style.visibility = hit ? 'visible' : 'hidden';
        if (hit) {
          const k4 = ease.backSoft(seg(t, cur2.hit, cur2.hit + 0.3));
          card.style.transform = `scale(${lerp(1.25, 1, k4).toFixed(4)}) rotate(${lerp(-6, 2, k4).toFixed(3)}deg)`;
          card.style.opacity = String(seg(t, cur2.hit, cur2.hit + 0.06));
          $('bMsg').textContent = `${cur2.url} is locked for ${cur2.left}. Every distraction is. Back to work.`;
        }
      }
      $('poof').style.display = 'none';
    }

    // ---- 3. The recap: nudge, talk, yell ----
    const recap = within('recap', t);
    if (recap) {
      const kin = ease.outQuint(seg(t, 24.05, 24.6));
      const kout = ease.inOut(seg(t, 26.75, 27.2));
      place('recap', kin * (1 - kout), zoom(lerp(1.06, 1, kin) * lerp(1, 0.92, kout) + 0.01 * seg(t, 24.3, 27)), 6 * kout);
      [24.75, 25.6, 26.45].forEach((at, i) => {
        const k = ease.backSoft(seg(t, at, at + 0.5));
        const el = $(`t${i + 1}`);
        el.style.opacity = String(ease.smooth(seg(t, at, at + 0.22)));
        el.style.transform = `translateY(${((1 - k) * 46).toFixed(2)}px) scale(${lerp(0.9, 1, k).toFixed(4)})`;
        el.style.filter = seg(t, at, at + 0.3) < 1 ? `blur(${((1 - seg(t, at, at + 0.3)) * 6).toFixed(2)}px)` : 'none';
      });
      bars($('bars2'), 0.55 + 0.35 * (0.5 - 0.5 * Math.cos(t * 10)), t, 2);
    } else place('recap', 0);

    // ---- 4. What else it does: a carousel ----
    const feats = within('feats', t);
    if (feats) {
      const kin = ease.outQuint(seg(t, 41.2, 41.6));
      const kout = ease.inOut(seg(t, 49.45, 49.85));
      place('feats', kin * (1 - kout), zoom(lerp(1, 0.94, kout)), 6 * kout);
      [[41.3, 43.95], [43.85, 45.75], [45.65, 47.35], [47.25, 49.9]].forEach(([a, b], i) => {
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

    // ---- 5. The end card ----
    const end = within('end', t);
    if (end) {
      const kin = ease.outQuint(seg(t, 49.45, 49.95));
      const kout = ease.inOut(seg(t, 55.7, 56.05));
      place('end', kin * (1 - kout), zoom(lerp(1.05, 1, kin) + 0.012 * seg(t, 49.8, 56)));
      const parts = [['#end .icon', 49.7], ['#end h1', 49.95], ['#end .tag', 50.6], ['#end .meta', 51.05], ['#endR', 51.7]];
      for (const [sel, at] of parts) {
        const el = document.querySelector(sel);
        const k = ease.backSoft(seg(t, at, at + 0.5));
        el.style.opacity = String(ease.smooth(seg(t, at, at + 0.25)));
        el.style.transform = `translateY(${((1 - k) * 34).toFixed(2)}px) scale(${lerp(0.94, 1, k).toFixed(4)})`;
      }
      $('endSpark').setAttribute('transform', `translate(133 18) scale(${(0.8 + 0.3 * (0.5 - 0.5 * Math.cos(t * 30))).toFixed(3)}) rotate(${((t * 400) % 360).toFixed(1)})`);
      $('endBomb').style.transform = `rotate(${(Math.sin(t * 3) * 4).toFixed(3)}deg)`;
    } else place('end', 0);

    // ---- 6. The stinger: KABOOM, then the outro ----
    const kbA = t >= 59.2 ? 1 - ease.inOut(seg(t, 59.62, 59.85)) : 0;
    $('kaboom').style.visibility = kbA > 0 ? 'visible' : 'hidden';
    if (kbA > 0) {
      const k = ease.backSoft(seg(t, 59.2, 59.48));
      $('kaboom').style.opacity = String(kbA);
      $('kaboom').style.transform = `scale(${lerp(0.2, 1.1, k).toFixed(4)}) rotate(${lerp(-20, -4, k).toFixed(3)}deg)`;
    }
    place('outro', within('outro', t) ? ease.inOut(seg(t, 59.55, 59.9)) : 0);

    // Flashes: the card slam and the boom.
    $('flash').style.opacity = String(Math.max(0.5 * (1 - ease.out(seg(t, 22.6, 22.9))) * (t >= 22.6 ? 1 : 0), 0.65 * (1 - ease.out(seg(t, 59.2, 59.42))) * (t >= 59.2 ? 1 : 0)));

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
