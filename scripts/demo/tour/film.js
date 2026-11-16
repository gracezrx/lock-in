// The feature tour: everything Lock In does, chapter by chapter, on the app's own screens.
// Times are seconds; every frame is drawn from t alone (render(t)), so record.mjs captures it exactly.
//   python3 scripts/demo/launch/tts.py tour            (once: speaks the lines into vo/)
//   node scripts/demo/launch/record.mjs --film tour    (docs/tour.mp4)
// The screens in ui/ are captured from the app itself (the smoke test, at 2x).
(function () {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const outQuint = (k) => 1 - Math.pow(1 - k, 5);
  const outCubic = (k) => 1 - Math.pow(1 - k, 3);
  const inOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const backSoft = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);
  const $ = (id) => document.getElementById(id);
  // ?nosubs=1 is the pass the README's GIF is cut from: no subtitles, and a flat backdrop (GIFs band on gradients).
  const NOSUBS = new URLSearchParams(location.search).get('nosubs') === '1';
  if (NOSUBS) {
    $('bg').style.background = '#2a1f45';
    $('grain').style.display = 'none';
  }

  // ---- What's said (durations come from the voice files; record.mjs fills them in) ----
  const VO = [
    { id: 'n1', who: 'narrator', at: 0.9, text: 'This is Lock In. A focus coach for your Mac, with a mouth on it.' },
    { id: 'n2', who: 'narrator', at: 5.2, text: 'Setup takes a minute. What you’re going after, what’s on today, what pulls you off track, and who gets to yell at you.' },
    { id: 'n3', who: 'narrator', at: 12.6, text: 'Pick what you’re working on, and lock in.' },
    { id: 'n4', who: 'narrator', at: 16.4, text: 'It knows which app and which site you’re on. Window titles, never screenshots.' },
    { id: 'n5', who: 'narrator', at: 22.0, text: 'Drift, and it nudges.' },
    { id: 'c1', who: 'coach', at: 23.75, text: 'I’m not mad. I’m just watching you scroll YouTube instead of finishing the pitch deck.' },
    { id: 'n6', who: 'narrator', at: 29.5, text: 'Ignore it, and it gets louder.' },
    { id: 'n7', who: 'narrator', at: 33.3, text: 'Then it puts you right back where you were.' },
    { id: 'n8', who: 'narrator', at: 37.3, text: 'Hit command, shift, space, and argue back.' },
    { id: 'y1', who: 'me', at: 40.4, text: 'I’m just checking one thing.' },
    { id: 'c2', who: 'coach', at: 41.95, text: 'You said that forty minutes ago.' },
    { id: 'n9', who: 'narrator', at: 45.4, text: 'Make the coach sound like someone you can’t ignore. A few voice notes, with their OK, and it’s your mom.' },
    { id: 'n10', who: 'narrator', at: 52.4, text: 'It reads your to-do list, and calls you out when you’ve been on for hours and finished nothing.' },
    { id: 'n11', who: 'narrator', at: 58.4, text: 'It runs your routines, keeps your goals in front of you, and notices your patterns.' },
    { id: 'n12', who: 'narrator', at: 64.0, text: 'It reads your calendar, so it never roasts you on a call.' },
    { id: 'n13', who: 'narrator', at: 67.8, text: 'And your friends get a button. One bomb locks every distraction on your Mac for five minutes.' },
    { id: 'n14', who: 'narrator', at: 75.0, text: 'Corner card, full screen, your phone, your browser. It finds you.' },
    { id: 'n15', who: 'narrator', at: 79.8, text: 'Free, open source, and everything stays on your Mac.' },
    { id: 'n16', who: 'narrator', at: 83.5, text: 'Lock In. Go bomb a friend.' },
  ];
  const DUR = { n1: 3.5, n2: 6.21, n3: 1.97, n4: 4.2, n5: 1.27, c1: 5.29, n6: 1.67, n7: 1.71, n8: 2.6, y1: 1.27, c2: 2.12, n9: 5.57, n10: 4.36, n11: 4.22, n12: 2.81, n13: 5.17, n14: 3.42, n15: 3.03, n16: 1.55 };
  const dur = (v) => window.VO_DUR?.[v.id] ?? DUR[v.id];
  const LENGTH = 87.5;

  // ---- The chapters ----
  // Pages are the app's windows (1040x693 at 2x), shown 1060 wide in a window frame.
  const PAGE = (src, x, y, at, o = {}) => ({ kind: 'win', src, x, y, w: o.w ?? 1060, at, anim: o.anim ?? 'slide', out: o.out, z: o.z ?? 1, title: o.title ?? 'Lock In' });
  const IMG = (src, x, y, w, at, o = {}) => ({ kind: o.frame ?? 'card', src, x, y, w, at, anim: o.anim ?? 'pop', out: o.out, z: o.z ?? 5, rot: o.rot ?? 0 });
  const SCENES = [
    { id: 'open', a: 0, b: 4.75, html: 'open' },
    {
      id: 'setup', a: 4.75, b: 12.3, n: '01', kicker: 'Setup', title: 'A one-minute <em>setup</em>',
      sub: 'Your goals, today’s to-dos, what pulls you off track, and who gets to yell at you.',
      layers: [PAGE('setup-goals', 770, 150, 4.95), PAGE('setup-coach', 800, 180, 7.85, { z: 2 }), PAGE('setup-connect', 830, 210, 10.25, { z: 3 })],
    },
    {
      id: 'lockin', a: 12.3, b: 16.1, n: '02', kicker: 'Sessions', title: 'Pick a goal. <em>Lock in.</em>',
      sub: 'From the menu bar, or ⌘⇧L. 25, 50, 90 minutes, or Pomodoros.',
      layers: [PAGE('home-live', 760, 190, 12.45, { w: 960 }), IMG('panel.png', 1460, 110, 360, 12.85, { frame: 'bare', anim: 'drop', z: 4 })],
    },
    {
      id: 'knows', a: 16.1, b: 21.7, n: '03', kicker: 'Awareness', title: 'It knows <em>where you are</em>',
      sub: 'The app and site in front of you. Window titles, never screenshots.',
      layers: [{ kind: 'html', html: 'front', x: 760, y: 300, at: 16.3, anim: 'slide', z: 1 }, IMG('ext-popup.png', 1490, 200, 350, 19.1, { frame: 'bare', z: 3 })],
    },
    {
      id: 'escalate', a: 21.7, b: 37.0, n: '04', kicker: 'The coach', title: 'Drift, and it <em>escalates</em>',
      chips: [['Nudge', 22.05, [22.05, 23.6]], ['Talk', 23.6, [23.6, 29.9]], ['Yell', 29.9, [29.9, 33.1]], ['Back to work', 33.1, [33.1, 37.0]]],
      layers: [
        IMG('toast-nudge', 900, 230, 780, 22.15, { out: 23.5 }),
        IMG('toast-speak', 900, 230, 780, 23.55, { out: 29.8 }),
        { kind: 'html', html: 'talking:c1', x: 900, y: 700, at: 23.7, anim: 'pop', out: 29.3, z: 6, scale: 1.3 },
        IMG('card-yellow', 960, 150, 620, 29.95, { anim: 'slam', out: 31.38, rot: -2 }),
        IMG('card-red', 950, 140, 650, 31.4, { anim: 'slam', out: 32.9, rot: 2.5 }),
        { kind: 'html', html: 'doc', x: 800, y: 210, at: 33.15, anim: 'rise', z: 2 },
        { kind: 'html', html: 'back', x: 1180, y: 152, at: 33.55, anim: 'pop', z: 7 },
      ],
    },
    {
      id: 'talk', a: 37.0, b: 45.1, n: '05', kicker: 'Talk back', title: '<em>Argue</em> with it',
      sub: 'Hold Space, or ⌘⇧Space from anywhere. Make your case out loud.',
      layers: [
        { kind: 'html', html: 'keys', x: 790, y: 300, at: 37.45, anim: 'rise', z: 2 },
        IMG('talk', 1370, 110, 470, 39.0, { z: 3 }),
        { kind: 'html', html: 'talking:c2', x: 790, y: 560, at: 41.8, anim: 'pop', z: 4, scale: 1.3 },
      ],
    },
    {
      id: 'mum', a: 45.1, b: 52.1, n: '06', kicker: 'Your coach', title: 'Any voice. <em>Even your mom’s.</em>',
      sub: 'A few voice notes, with their OK. It even talks the way they talk, language and all.',
      layers: [PAGE('coach-mum', 770, 150, 45.25), IMG('toast-mum', 1250, 560, 560, 47.9, { z: 4 })],
    },
    {
      id: 'todos', a: 52.1, b: 58.1, n: '07', kicker: 'To-dos', title: 'It reads your <em>to-do list</em>',
      chips: [['Reminders', 52.7], ['Things', 52.85], ['Todoist', 53.0], ['Google Sheets', 53.15], ['Excel', 53.3]],
      layers: [PAGE('todos', 770, 150, 52.25), IMG('card-roast', 900, 330, 760, 54.7, { anim: 'slam', rot: -1.5, z: 4 })],
    },
    {
      id: 'routines', a: 58.1, b: 63.7, n: '08', kicker: 'Your day', title: 'Routines, goals, <em>patterns</em>',
      sub: 'Morning kickoff, breaks, water, bedtime. Goals it checks in on. Habits it spots for you.',
      layers: [
        PAGE('routines', 770, 140, 58.25),
        IMG('toast-kickoff', 1290, 540, 540, 59.25, { out: 60.4, z: 4 }),
        PAGE('goals', 810, 180, 60.45, { z: 2 }),
        IMG('toast-noticed', 1290, 560, 540, 61.6, { z: 4 }),
      ],
    },
    {
      id: 'calendar', a: 63.7, b: 67.5, n: '09', kicker: 'Calendar', title: 'Quiet on <em>calls</em>',
      sub: 'A heads-up before a meeting. Never a roast during one.',
      layers: [PAGE('home-meeting', 770, 150, 63.85), IMG('toast-meeting', 1270, 560, 560, 64.7, { z: 4 })],
    },
    {
      id: 'friends', a: 67.5, b: 74.7, n: '10', kicker: 'Friends', title: 'Your friends get <em>a button</em>',
      sub: 'Three bombs a day. One locks every distraction on your Mac for five minutes.',
      layers: [PAGE('friends', 770, 150, 67.65), IMG('card-bomb', 830, 320, 920, 70.8, { anim: 'slam', rot: -2, z: 4 })],
    },
    {
      id: 'everywhere', a: 74.7, b: 79.5, n: '11', kicker: 'Everywhere', title: 'It <em>finds</em> you',
      chips: [['Corner card', 75.1], ['Full screen', 75.8], ['Your phone', 76.5], ['Chrome', 77.2]],
      layers: [
        IMG('toast-win', 770, 200, 580, 75.1, { z: 2 }),
        IMG('card-red', 850, 410, 460, 75.8, { anim: 'slam', rot: -3, z: 3 }),
        IMG('phone-live', 1380, 100, 290, 76.5, { frame: 'phone', z: 4 }),
        IMG('ext-popup.png', 1560, 590, 240, 77.2, { frame: 'bare', z: 5 }),
      ],
    },
    { id: 'end', a: 79.5, b: LENGTH, html: 'end' },
  ];

  // ---- Sound cues for record.mjs ----
  const SLAMS = [];
  for (const s of SCENES) for (const l of s.layers ?? []) if (l.anim === 'slam') SLAMS.push(l.at);
  const SFX = [
    { at: 0.12, kind: 'boom' }, { at: 0.14, kind: 'slam' },
    { at: 1.0, kind: 'tick' }, { at: 1.75, kind: 'tick' }, { at: 2.6, kind: 'tick' },
    ...SCENES.slice(1).map((s) => ({ at: s.a - 0.02, kind: 'whoosh' })),
    ...SCENES.flatMap((s) => (s.layers ?? []).filter((l) => l.anim === 'pop' && /toast|talk$/.test(l.src ?? '')).map((l) => ({ at: l.at, kind: 'toast' }))),
    { at: 29.95, kind: 'alert' },
    { at: 31.4, kind: 'slam' },
    { at: 33.55, kind: 'chime' },
    { at: 37.75, kind: 'click' }, { at: 38.15, kind: 'click' }, { at: 38.55, kind: 'click' },
    { at: 39.0, kind: 'blip' },
    { at: 54.7, kind: 'slam' },
    { at: 69.95, kind: 'whistle', until: 70.8 },
    { at: 70.8, kind: 'boom' }, { at: 70.82, kind: 'slam' },
    { at: 75.8, kind: 'slam' },
    ...SCENES.flatMap((s) => (s.chips ?? []).map(([, at]) => ({ at, kind: 'tick' }))),
    { at: 80.2, kind: 'chime' },
  ].sort((a, b) => a.at - b.at);
  // The groove under it all: busier while the coach escalates and the bomb drops, cut dead at
  // the red card and the bomb, a little louder for the end card.
  const MUSIC = {
    start: 0.1,
    end: LENGTH,
    levels: [[0, 0.55], [79.5, 0.75]],
    busy: [[21.7, 37.0], [67.5, 74.7]],
    cuts: [[31.4, 31.75, 0.5], [70.8, 71.2, 0.6]],
    duck: [[86.6, LENGTH, 0.3]],
  };
  const CUTS = [0, 12.3, 21.7, 37.0, 52.1, 63.7, 74.7, LENGTH];
  const WARM = SCENES.map((s) => (s.a + s.b) / 2).concat([1, 3, 23, 30, 32, 34, 38, 40, 42, 48, 55, 60, 62, 65, 71, 76, 78, 84]);
  const MIXES = [{ suffix: '', skip: [] }];
  window.FILM = { VO, DUR, LENGTH, PRE: 0, SFX, BOMB_AUDIO: [], MUSIC, CUTS, WARM, MIXES };

  // ---- Building the page ----
  const root = $('scenes');
  const ui = (src) => `/film/ui/${/\.\w+$/.test(src) ? src : `${src}.jpg`}`;
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const WIN_BAR = (title) => `<div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>${title}</span></div>`;

  function htmlBlock(name) {
    if (name === 'front') {
      const e = el('div', 'front');
      e.style.width = '700px';
      e.innerHTML = `<h4>In front right now</h4>
        <div class="row"><div class="ic" style="background:#a259ff">F</div><div class="what"><b>Figma</b><small>Pitch deck v3</small></div><span class="tag work">Work</span></div>
        <div class="row"><div class="ic" style="background:#4285f4">G</div><div class="what"><b>Google Chrome</b><small>youtube.com · Raccoon steals snacks (4K)</small></div><span class="tag drift">Drift</span></div>
        <div class="row"><div class="ic" style="background:#4a154b">S</div><div class="what"><b>Slack</b><small>#general</small></div><span class="tag meh">Neutral</span></div>`;
      return e;
    }
    if (name.startsWith('talking:')) {
      const e = el('div', 'talking', `<div class="lk"><img src="/icon.png" width="30" height="30" style="border-radius:7px" alt=""></div><div class="who">Lock In<small>is talking</small></div><div class="bars">${'<i></i>'.repeat(9)}</div>`);
      e.dataset.vo = name.slice(8);
      return e;
    }
    if (name === 'doc') {
      return el('div', 'doc', `${WIN_BAR('Pitch deck')}<div class="side"><div></div><div></div><div></div><div class="cur"></div><div></div></div><div class="slide"><h2>Why now<span class="caret"></span></h2><p style="width:92%"></p><p style="width:84%"></p><p style="width:88%"></p><p style="width:60%"></p></div>`);
    }
    if (name === 'back') return el('div', 'back', '✓ Back to the pitch deck, slide 4');
    if (name === 'keys') return el('div', 'keys', '<div class="key">⌘</div><div class="key">⇧</div><div class="key wide">Space</div>');
    return el('div');
  }

  for (const s of SCENES) {
    const sc = el('div', 'scene');
    sc.id = `s-${s.id}`;
    const stage = el('div', 'stage');
    sc.append(stage);
    s.dom = { sc, stage, layers: [], chips: [] };
    if (s.html === 'open') {
      stage.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:56px">
        <div class="logo" id="openLogo"><img src="/icon.png" alt=""><b>Lock In</b></div>
        <div class="tagline" id="openTag"><span>You drift.</span><span>It notices.</span><span class="y">It drags you back.</span></div></div>`;
    } else if (s.html === 'end') {
      stage.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:44px">
        <div class="logo" id="endLogo"><img src="/icon.png" alt=""><b>Lock In</b></div>
        <div class="facts" id="endFacts"><span class="y">Free</span><span>Open source</span><span>Mac + Chrome</span><span>Stays on your Mac</span></div>
        <div class="url" id="endUrl">github.com/gracezrx/lock-in</div></div>`;
    } else {
      const words = el('div', 'words');
      words.append(el('div', 'kicker', `<b>${s.n}</b>${s.kicker}`), el('div', 'title', s.title));
      if (s.sub) words.append(el('div', 'sub', s.sub));
      if (s.chips) {
        const chips = el('div', 'chips');
        for (const [text, at, on] of s.chips) {
          const c = el('span', 'chip', text);
          chips.append(c);
          s.dom.chips.push({ e: c, at, on });
        }
        words.append(chips);
      }
      stage.append(words);
      for (const l of s.layers) {
        let e;
        if (l.kind === 'html') e = htmlBlock(l.html);
        else if (l.kind === 'win') {
          e = el('div', 'win', WIN_BAR(l.title));
          const img = el('img');
          img.src = ui(l.src);
          e.append(img);
        } else {
          e = el('div', l.kind === 'phone' ? 'phone' : l.kind === 'bare' ? 'bare' : 'card');
          const img = el('img');
          img.src = ui(l.src);
          e.append(img);
        }
        const wrap = el('div', 'layer');
        wrap.append(e);
        Object.assign(wrap.style, { left: `${l.x}px`, top: `${l.y}px`, zIndex: String(l.z ?? 1) });
        if (l.w) wrap.style.width = `${l.w}px`;
        if (l.scale) Object.assign(e.style, { transform: `scale(${l.scale})`, transformOrigin: '0 0' });
        stage.append(wrap);
        s.dom.layers.push({ l, wrap, inner: e });
      }
    }
    root.append(sc);
  }

  // ---- Drawing ----
  function layerState(l, t) {
    const d = l.anim === 'slam' ? 0.3 : l.anim === 'pop' ? 0.42 : 0.6;
    const k = seg(t, l.at, l.at + d);
    if (t < l.at) return null;
    let op = 1;
    let x = 0;
    let y = 0;
    let s = 1;
    let r = l.rot ?? 0;
    if (l.anim === 'slide') {
      const e = outQuint(k);
      x = (1 - e) * 120;
      op = clamp(k * 2.2);
    } else if (l.anim === 'rise') {
      const e = outQuint(k);
      y = (1 - e) * 80;
      op = clamp(k * 2.2);
    } else if (l.anim === 'drop') {
      const e = outQuint(k);
      y = (1 - e) * -50;
      op = clamp(k * 2.5);
    } else if (l.anim === 'pop') {
      const e = backSoft(k);
      s = lerp(0.86, 1, clamp(e, 0, 1.08));
      y = (1 - outCubic(k)) * 26;
      op = clamp(k * 3);
    } else if (l.anim === 'slam') {
      const e = outQuint(k);
      s = lerp(1.7, 1, e);
      r = lerp((l.rot ?? 0) - 9, l.rot ?? 0, e);
      op = clamp(k * 4);
    }
    if (l.out !== undefined) {
      const o = seg(t, l.out, l.out + 0.25);
      if (o >= 1) return null;
      op *= 1 - o;
      s *= lerp(1, 0.96, o);
      y -= o * 14;
    }
    return { op, x, y, s, r };
  }

  function shake(t) {
    let a = 0;
    for (const at of [0.14, ...SLAMS]) {
      const k = (t - at - 0.22) / 0.32;
      if (k >= 0 && k < 1) a = Math.max(a, (1 - k) * 12);
    }
    return a ? { x: Math.sin(t * 91) * a, y: Math.cos(t * 77) * a * 0.7 } : { x: 0, y: 0 };
  }

  function bars(e, id, t) {
    const v = VO.find((x) => x.id === id);
    const env = window.VO_ENV?.[id];
    const i = Math.floor((t - v.at) * 30);
    const live = t >= v.at && t < v.at + dur(v);
    [...e.querySelectorAll('.bars i')].forEach((b, j) => {
      const lv = live ? (env ? env[clamp(i, 0, env.length - 1)] ?? 0 : 0.5 + 0.5 * Math.sin(t * 13 + j)) : 0;
      const wob = 0.55 + 0.45 * Math.abs(Math.sin(t * 9.3 + j * 1.7));
      b.style.height = `${(6 + 34 * lv * wob).toFixed(1)}px`;
    });
  }

  function drawOpen(s, t) {
    const k = seg(t, 0.12, 0.42);
    const logo = $('openLogo');
    logo.style.opacity = String(clamp(k * 4));
    logo.style.transform = `scale(${lerp(2.1, 1, outQuint(k)).toFixed(4)})`;
    [...$('openTag').children].forEach((sp, i) => {
      const at = [1.0, 1.75, 2.6][i];
      const kk = seg(t, at, at + 0.35);
      sp.style.opacity = String(clamp(kk * 2.5));
      sp.style.transform = `translateY(${((1 - outQuint(kk)) * 30).toFixed(1)}px)`;
    });
  }

  function drawEnd(s, t) {
    const k = seg(t, s.a + 0.2, s.a + 0.6);
    $('endLogo').style.opacity = String(clamp(k * 2));
    $('endLogo').style.transform = `scale(${lerp(1.25, 1, outQuint(k)).toFixed(4)})`;
    [...$('endFacts').children].forEach((sp, i) => {
      const at = s.a + 0.7 + i * 0.25;
      const kk = seg(t, at, at + 0.35);
      sp.style.opacity = String(clamp(kk * 2.5));
      sp.style.transform = `translateY(${((1 - outQuint(kk)) * 20).toFixed(1)}px) scale(${lerp(0.9, 1, backSoft(kk)).toFixed(3)})`;
    });
    const ku = seg(t, s.a + 2.0, s.a + 2.5);
    $('endUrl').style.opacity = String(ku);
    $('endUrl').style.transform = `translateY(${((1 - outQuint(ku)) * 16).toFixed(1)}px)`;
  }

  window.render = (t) => {
    const sh = shake(t);
    for (const [i, s] of SCENES.entries()) {
      const first = i === 0;
      const last = i === SCENES.length - 1;
      const inK = first ? 1 : outQuint(seg(t, s.a, s.a + 0.45));
      const outK = last ? 0 : inOut(seg(t, s.b - 0.35, s.b + 0.05));
      const on = t >= s.a - 0.01 && (last || t < s.b + 0.05);
      const { sc, stage } = s.dom;
      sc.style.display = on ? 'block' : 'none';
      if (!on) continue;
      sc.style.opacity = String(inK * (1 - outK));
      const kb = 1 + 0.025 * seg(t, s.a, s.b);
      stage.style.transform = `translate(${((1 - inK) * 70 - outK * 70 + sh.x).toFixed(2)}px, ${sh.y.toFixed(2)}px) scale(${kb.toFixed(4)})`;
      if (s.html === 'open') drawOpen(s, t);
      else if (s.html === 'end') drawEnd(s, t);
      for (const { l, wrap, inner } of s.dom.layers) {
        const st = layerState(l, t);
        if (!st) {
          wrap.style.opacity = '0';
          continue;
        }
        wrap.style.opacity = String(st.op);
        wrap.style.transform = `translate(${st.x.toFixed(2)}px, ${st.y.toFixed(2)}px) scale(${st.s.toFixed(4)}) rotate(${st.r.toFixed(2)}deg)`;
        if (l.html?.startsWith('talking:')) bars(inner, l.html.slice(8), t);
        if (l.html === 'front') {
          [...inner.querySelectorAll('.row')].forEach((row, j) => {
            const at = 16.75 + j * 0.85;
            const kk = seg(t, at, at + 0.35);
            row.style.opacity = String(clamp(kk * 2.5));
            row.style.transform = `translateX(${((1 - outQuint(kk)) * 40).toFixed(1)}px)`;
          });
        }
        if (l.html === 'keys') {
          [...inner.children].forEach((key, j) => {
            const at = [37.75, 38.15, 38.55][j];
            const p = Math.sin(Math.PI * seg(t, at - 0.05, at + 0.18));
            key.style.transform = `translateY(${(p * 9).toFixed(1)}px)`;
            key.style.boxShadow = `0 ${(10 - p * 8).toFixed(1)}px 0 #b9bcc4, 0 ${(22 - p * 12).toFixed(1)}px 40px rgba(0,0,0,0.4)`;
            key.style.background = p > 0.3 ? 'linear-gradient(#fff4c2, #ffe066)' : '';
          });
        }
        if (l.html === 'doc') {
          const caret = inner.querySelector('.caret');
          caret.style.opacity = Math.floor(t * 2.2) % 2 ? '0' : '1';
        }
      }
      for (const { e, at, on: range } of s.dom.chips) {
        const kk = seg(t, at, at + 0.3);
        e.style.opacity = String(clamp(kk * 2.5) * (range && t > range[1] ? 0.55 : 1));
        e.style.transform = `scale(${lerp(0.85, 1, clamp(backSoft(kk), 0, 1.06)).toFixed(3)})`;
        e.classList.toggle('on', !!range && t >= range[0] && t < range[1]);
      }
    }
    // Subtitles: the line being said.
    const v = VO.find((x) => t >= x.at - 0.06 && t < x.at + dur(x) + 0.3);
    const subs = $('subs');
    if (v) {
      if (subs.dataset.id !== v.id) {
        subs.textContent = v.text;
        subs.dataset.id = v.id;
        subs.className = v.who === 'coach' ? 'coach' : v.who === 'me' ? 'me' : '';
      }
      subs.style.opacity = String(Math.min(seg(t, v.at - 0.06, v.at + 0.08), 1 - seg(t, v.at + dur(v) + 0.15, v.at + dur(v) + 0.3)));
    } else subs.style.opacity = '0';
    if (NOSUBS) subs.style.opacity = '0';
    $('fade').style.opacity = String(seg(t, LENGTH - 0.6, LENGTH));
  };

  window.ready = () => !!window.render && [...document.images].every((i) => i.complete && i.naturalWidth > 0);
  window.render(0);
})();
