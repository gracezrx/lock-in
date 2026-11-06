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
    if (t < 10) return 0.3 + 1.95 * Math.pow((t - 5.5) / 4.5, 1.6);
    if (t < 29.4) return 1.7 + (t - 27) * 0.27;
    if (t < 34.4) return 2.45 + (t - 29.4);
    return 8.05 + (t - 39.6);
  }
  // Sam's Mac, up close.
  function macTime(t) {
    if (t < 22.6) return 0.3 + (t - 10) * 0.09;
    if (t < 24.3) return 0.3 + 12.6 * 0.09;
    if (t < 39.6) return 1.0;
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

  window.render = (t) => {
    star();
    // Fade in from black.
    $('fade').style.opacity = String(1 - seg(t, 0, 0.35));

    // 1. The wide shot (the bomb clip)
    const wide = inScene('wide', t);
    show('wide', !!wide);
    if (wide) {
      const bt = bombTime(t);
      bombWin().render?.(bt);
      const d = $('bomb').contentDocument;
      if (d && !d.getElementById('launchCss')) {
        const st = d.createElement('style');
        st.id = 'launchCss';
        st.textContent = '.cap{display:none!important}';
        d.head.append(st);
        const tag = d.getElementById('tagPhone');
        if (tag) tag.textContent = 'Grace’s phone';
      }
      const k = ease.out(seg(t, wide[0], wide[0] + 0.3));
      $('wide').style.transform = wide[0] > 0 ? `scale(${lerp(1.06, 1, k)})` : 'none';
    }

    // 2. Sam's screen, up close
    const close = inScene('close', t);
    show('close', !!close);
    if (close) {
      const mt = macTime(t);
      macWin().render?.(mt);
      const md = $('mac').contentDocument;
      const k = ease.out(seg(t, close[0], close[0] + 0.32));
      $('close').style.transform = `scale(${lerp(0.9, 1, k)})`;
      $('close').style.opacity = String(seg(t, close[0], close[0] + 0.12));

      // The padlock in the menu bar lights up: he's drifting.
      const tray = md?.getElementById('tray')?.getBoundingClientRect();
      const glowOn = t > 11.8 && t < 15.6;
      $('glow').style.opacity = glowOn ? String(0.55 + 0.45 * Math.abs(Math.sin((t - 11.8) * 4))) : '0';
      $('drift').style.opacity = String(t > 12.0 && t < 15.6 ? ease.out(seg(t, 12.0, 12.2)) : 0);
      if (tray) {
        Object.assign($('glow').style, { left: `${tray.left - 14}px`, top: `${tray.top - 6}px`, width: `${tray.width + 28}px`, height: `${tray.height + 12}px` });
        Object.assign($('drift').style, { left: `${tray.left - 40}px`, top: `${tray.bottom + 10}px` });
      }

      // The corner card slides in, he closes it.
      const tin = ease.out(seg(t, 12.8, 13.15));
      const tout = ease.in(seg(t, 15.1, 15.35));
      $('toast').style.opacity = String(t < 12.8 || t > 15.4 ? 0 : 1);
      $('toast').style.transform = `translateX(${(1 - tin) * 440 + tout * 440}px)`;
      $('drift').style.top = tray ? `${tray.bottom + 10 + (t > 12.8 && t < 15.4 ? 180 : 0)}px` : '';

      // Lock In talks (the bars follow the voice).
      const talkLine = t < 22.6 ? (t < 21.6 ? 'c1' : 'c2') : 'c3';
      const talking = (t > 15.8 && t < 22.6) || (t > 56.9 && t < 58.75);
      const ta = talking ? ease.out(seg(t, t < 22.6 ? 15.8 : 56.9, (t < 22.6 ? 15.8 : 56.9) + 0.25)) : 0;
      $('talk').style.opacity = String(ta);
      $('talk').style.transform = `translateY(${(1 - ta) * -16}px)`;
      if (talking) bars($('bars'), loud(talkLine, t), t, 0);

      // The card slams down.
      const ck = t >= 22.6 && t < 24.3 ? t - 22.6 : -1;
      $('coach').style.visibility = ck >= 0 ? 'visible' : 'hidden';
      coachWin().render?.(ck);

      // The cursor: to the corner card's ×, then (much later) toward the feed's tab.
      const cur = $('cursor');
      let cx = null;
      let cy = null;
      let press = false;
      if (t > 14.1 && t < 15.6) {
        const k2 = ease.inOut(seg(t, 14.15, 15.0));
        cx = lerp(640, 1232, k2);
        cy = lerp(520, 58, k2);
        press = t > 15.02 && t < 15.12;
      }
      if (t >= 56.0 && t < 59.2) {
        const tab = md?.getElementById('tabFeed');
        if (tab) {
          tab.style.display = 'flex';
          tab.classList.remove('on');
        }
        const r = tab?.getBoundingClientRect();
        const k3 = ease.inOut(seg(t, 56.3, 58.6));
        cx = lerp(700, r ? r.left + r.width / 2 : 400, k3);
        cy = lerp(560, r ? r.top + r.height / 2 + 4 : 70, k3);
      }
      cur.style.opacity = cx === null ? '0' : '1';
      if (cx !== null) cur.style.transform = `translate(${cx}px, ${cy}px) scale(${press ? 0.86 : 1})`;

      // The lockout: every site he tries is locked.
      const gag = t >= 34.4 && t < 39.6;
      const feed = md?.getElementById('feed')?.getBoundingClientRect();
      const bl = $('blocked');
      bl.style.display = gag && t >= TRIES[0].hit ? 'grid' : 'none';
      if (feed) Object.assign(bl.style, { left: `${feed.left}px`, top: `${feed.top}px`, width: `${feed.width}px`, height: `${feed.height}px` });
      if (gag && md) {
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
          const k4 = ease.back(seg(t, cur2.hit, cur2.hit + 0.22));
          card.style.transform = `scale(${lerp(1.3, 1, k4)}) rotate(${lerp(-6, 2, k4)}deg)`;
          $('bMsg').textContent = `${cur2.url} is locked for ${cur2.left}. Every distraction is. Back to work.`;
        }
      }
      $('poof').style.display = 'none';
    }

    // 3. The recap: nudge, talk, yell
    const recap = inScene('recap', t);
    show('recap', !!recap);
    if (recap) {
      [24.75, 25.6, 26.45].forEach((at, i) => {
        const k = ease.back(seg(t, at, at + 0.28));
        const el = $(`t${i + 1}`);
        el.style.opacity = String(seg(t, at, at + 0.1));
        el.style.transform = `translateY(${(1 - k) * 60}px) scale(${lerp(0.86, 1, k)})`;
      });
      bars($('bars2'), 0.55 + 0.35 * Math.abs(Math.sin(t * 5)), t, 2);
    }

    // 4. What else it does
    const feats = inScene('feats', t);
    show('feats', !!feats);
    if (feats) {
      [[41.4, 43.9], [43.9, 45.7], [45.7, 47.3], [47.3, 49.6]].forEach(([a, b], i) => {
        const el = $(`f${i + 1}`);
        const on = t >= a && t < b;
        el.style.visibility = on ? 'visible' : 'hidden';
        if (!on) return;
        const k = ease.out(seg(t, a, a + 0.38));
        el.style.transform = `translateX(${(1 - k) * 260}px)`;
        el.style.opacity = String(seg(t, a, a + 0.15));
        [...el.querySelectorAll('img')].forEach((img, j) => (img.style.transform = `rotate(${(j % 2 ? 2 : -2) * (1 - 0.3 * k)}deg) scale(${lerp(0.94, 1, k) + (t - a) * 0.006})`));
      });
    }

    // 5. The end card
    const end = inScene('end', t);
    show('end', !!end);
    if (end) {
      const parts = [['#end .icon', 49.7], ['#end h1', 49.95], ['#end .tag', 50.6], ['#end .meta', 51.05], ['#endR', 51.7]];
      for (const [sel, at] of parts) {
        const el = document.querySelector(sel);
        const k = ease.back(seg(t, at, at + 0.3));
        el.style.opacity = String(seg(t, at, at + 0.12));
        el.style.transform = `translateY(${(1 - k) * 40}px) scale(${lerp(0.9, 1, k)})`;
      }
      $('endSpark').setAttribute('transform', `translate(133 18) scale(${(0.75 + 0.35 * Math.abs(Math.sin(t * 23))).toFixed(2)}) rotate(${(t * 400) % 360})`);
      $('endBomb').style.transform = `rotate(${Math.sin(t * 3) * 4}deg)`;
    }

    // 6. The stinger: KABOOM, then the outro
    const kb = t >= 59.2 && t < 59.75;
    $('kaboom').style.visibility = kb ? 'visible' : 'hidden';
    if (kb) {
      const k = ease.back(seg(t, 59.2, 59.45));
      $('kaboom').style.transform = `scale(${lerp(0.2, 1.1, k)}) rotate(${lerp(-20, -4, k)}deg)`;
    }
    show('outro', !!inScene('outro', t));
    $('outro').style.opacity = String(seg(t, 59.6, 59.85));

    // Flashes: the card slam and the boom.
    $('flash').style.opacity = String(Math.max(0.55 * (1 - seg(t, 22.6, 22.82)) * (t >= 22.6 ? 1 : 0), 0.7 * (1 - seg(t, 59.2, 59.35)) * (t >= 59.2 ? 1 : 0)));

    // The big words
    const c = CAPS.find(([a, b]) => t >= a && t < b);
    const cap = $('cap');
    $('shade').style.opacity = c ? '1' : '0';
    if (c) {
      if (cap.dataset.at !== String(c[0])) {
        cap.innerHTML = c[2];
        cap.dataset.at = String(c[0]);
      }
      const k = ease.back(seg(t, c[0], c[0] + 0.2));
      cap.style.opacity = String(seg(t, c[0], c[0] + 0.08) * (1 - seg(t, c[1] - 0.08, c[1])));
      cap.style.transform = `scale(${lerp(1.2, 1, k)})`;
    } else cap.style.opacity = '0';

    // Subtitles: every line that's said, a phrase at a time (timed by length).
    const sub = $('sub');
    const v = VO.find((x) => t >= x.at - 0.05 && t < x.at + (window.VO_DUR?.[x.id] ?? DUR[x.id]) + 0.2);
    if (v) {
      const parts = phrases(v.text);
      const total = parts.reduce((n, p) => n + p.length, 0);
      const dur = window.VO_DUR?.[v.id] ?? DUR[v.id];
      let acc = 0;
      let i = 0;
      for (; i < parts.length - 1; i++) {
        acc += parts[i].length;
        if (t - v.at < (acc / total) * dur) break;
      }
      const key = `${v.id}:${i}`;
      if (sub.dataset.id !== key) {
        sub.innerHTML = (v.who === 'coach' ? '<span class="who coach">Lock In</span>' : v.who === 'sam' ? '<span class="who sam">Sam</span>' : '') + parts[i];
        sub.dataset.id = key;
      }
      sub.style.opacity = String(seg(t, v.at - 0.05, v.at + 0.05));
    } else sub.style.opacity = '0';
  };
})();
