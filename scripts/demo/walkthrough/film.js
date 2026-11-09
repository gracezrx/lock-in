// The walkthrough's timeline and render(t): a screen recording of Lock In, staged, for you to talk
// over with your camera on. Times are seconds; every frame is drawn from t alone.
// ?prompter=1 adds your lines across the top (near the camera) and a 3-second countdown first.
(function () {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const ease = {
    out: (k) => 1 - Math.pow(1 - k, 3),
    in: (k) => k * k * k,
    inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
    backSoft: (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2),
    back: (k) => 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2),
    outQuint: (k) => 1 - Math.pow(1 - k, 5),
    smooth: (k) => k * k * (3 - 2 * k),
  };
  const $ = (id) => document.getElementById(id);
  const PROMPTER = new URLSearchParams(location.search).get('prompter') === '1';

  // ---- What's said. "you" is you (the voice files are only stand-ins, for timing); the coach is the app. ----
  const VO = [
    { id: 'y1', who: 'you', at: 0.5, text: 'My friend just locked my laptop. From his phone.' },
    { id: 'y2', who: 'you', at: 4.1, text: 'Screen Time has a button that says ‘Ignore limit.’ So I built a focus app that fights back.' },
    { id: 'y3', who: 'you', at: 10.0, text: 'It’s called Lock In. It lives in my menu bar, and it knows what I’m supposed to be doing today.' },
    { id: 'y4', who: 'you', at: 16.3, text: 'I tell it what I’m working on, I lock in…' },
    { id: 'y5', who: 'you', at: 18.8, text: 'and then, obviously, I open the feed.' },
    { id: 'y6', who: 'you', at: 21.6, text: 'First, it nudges me.' },
    { id: 'y7', who: 'you', at: 23.3, text: 'I ignore that. So it talks.' },
    { id: 'c1', who: 'coach', at: 25.35, text: 'Grace. That’s your third raccoon video. The investor update is still blank.' },
    { id: 'y8', who: 'you', at: 30.5, text: 'Ignore that, and it gets personal.' },
    { id: 'y9', who: 'you', at: 33.6, text: 'But my favorite part: my friends can see when I’m drifting. And they get a button.' },
    { id: 'y10', who: 'you', at: 39.0, text: 'One tap, and every distraction on my Mac is locked for five minutes. No ignore button.' },
    { id: 'y11', who: 'you', at: 45.1, text: 'Setup takes a minute. Three questions, then it hooks into your menu bar, your browser and your calendar.' },
    { id: 'y12', who: 'you', at: 51.9, text: 'It’s free and open source. Link’s in the replies. So, who are you bombing first?' },
  ];
  const DUR = { y1: 2.64, y2: 4.86, y3: 5.26, y4: 2.02, y5: 2.15, y6: 1.28, y7: 1.49, c1: 4.88, y8: 1.8, y9: 4.15, y10: 4.99, y11: 5.54, y12: 4.49 };
  // A person talking to their camera runs a little slower than the stand-in voice.
  const PACE = 1.15;
  const dur = (v) => (window.VO_DUR?.[v.id] ?? DUR[v.id]) * (v.who === 'you' ? PACE : 1);

  // ---- The beats ----
  const T = {
    coldOut: 3.75, // the bomb card goes; back to how it started
    dialogIn: 4.6, ignore: 6.55, swipes1: [6.95, 7.5, 8.0],
    docClick: 9.75, // back to work
    trayClick: 11.8, // the padlock in the menu bar
    fieldClick: 16.65, typing: [16.75, 17.35],
    lockClick: 18.0, panelOut: [18.3, 18.55],
    feedClick: 20.05, swipes2: [20.45, 20.9, 21.35],
    drifting: 21.5,
    toast: 21.75, toastX: 23.75,
    talk: 24.35,
    slam: 31.75,
    phone: [33.7, 34.5], // a friend's phone slides in
    row: 35.5, // "my friends can see when I'm drifting"
    button: 37.3, // "and they get a button"
    tap: 38.5, // the phone's Bomb button (the bomb clip's 2.95 s)
    phoneOut: [41.15, 41.75],
    hunt: [43.25, 44.85], // looking for a way out
    setup: [44.95, 45.4], s2: 46.6, s3: 47.6,
    ticks: [48.55, 49.05, 49.6], count: 50.4,
    end: 51.6, ask: 54.9,
  };
  const PB = (bt) => T.tap + (bt - 2.95); // the bomb clip's clock, in film time
  T.impact = PB(5.2);
  const LENGTH = 58.5;
  const PRE = PROMPTER ? 3 : 0;

  // ---- The camera: zooms in like a screen recorder (z, and the point on the screen it centres on) ----
  const CAM = [
    { at: 0, d: 0.01, z: 1.5, f: [640, 380] },
    { at: T.coldOut, d: 0.7, z: 1, f: [640, 400] },
    { at: 10.9, d: 0.75, z: 1.9, f: 'tray' },
    { at: 12.15, d: 0.7, z: 1.22, f: 'panel' },
    { at: 16.2, d: 0.6, z: 1.75, f: 'field' },
    { at: 18.35, d: 0.7, z: 1, f: [640, 400] },
    { at: 21.65, d: 0.6, z: 1.6, f: [1072, 130] },
    { at: 24.1, d: 0.7, z: 1.28, f: [860, 320] },
    { at: 31.2, d: 0.5, z: 1, f: [640, 400] },
    { at: T.phone[0] - 0.1, d: 0.8, z: 0.6, f: [640, 400], q: [1310, 560] },
    { at: T.impact - 0.15, d: 0.3, z: 0.68, f: [640, 400], q: [1300, 560] },
    { at: T.phoneOut[0], d: 0.7, z: 1.35, f: [640, 400] },
    { at: T.setup[0], d: 0.6, z: 1, f: [640, 400] },
    { at: T.s3, d: 0.6, z: 1.12, f: [640, 430] },
    { at: 51.0, d: 0.5, z: 1, f: [640, 400] },
  ];

  // ---- Step chips (top left) ----
  const CHIPS = [[7.6, 10.4], [T.toast, T.talk - 0.05], [T.talk, T.slam - 0.05], [T.slam, T.phone[0]], [T.button + 0.1, T.setup[0]], [T.setup[0] + 0.25, T.end]];

  // ---- The pointer: where it goes, and when it clicks ----
  const MOVES = [
    { a: 5.6, b: 6.4, to: 'ignore' },
    { a: 9.0, b: 9.6, to: 'tabDoc' },
    { a: 10.75, b: 11.6, to: 'tray' },
    { a: 16.2, b: 16.55, to: 'field' },
    { a: 17.4, b: 17.9, to: 'lockBtn' },
    { a: 19.2, b: 19.9, to: 'tabFeed' },
    { a: 20.15, b: 20.6, to: [700, 520] },
    { a: 23.0, b: 23.6, to: [1232, 58] },
    { a: 24.0, b: 24.6, to: [760, 470] },
    { a: T.hunt[0], b: T.hunt[0] + 0.45, to: 'cardTR' },
    { a: T.hunt[0] + 0.5, b: T.hunt[0] + 0.95, to: 'cardTL' },
    { a: T.hunt[0] + 1.0, b: T.hunt[0] + 1.4, to: 'cardB' },
    { a: 45.9, b: 46.4, to: [1085, 727] },
    { a: 47.8, b: 48.4, to: [932, 293] },
    { a: 48.62, b: 48.95, to: [943, 476] },
    { a: 49.12, b: 49.5, to: [918, 577] },
  ];
  const CLICKS = [T.ignore, T.docClick, T.trayClick, T.fieldClick, T.lockClick, T.feedClick, T.toastX, 46.55, 47.55, ...T.ticks];
  const POINTER = [[4.9, T.phone[0] - 0.2], [T.hunt[0] - 0.3, T.hunt[1]], [45.6, T.end - 0.1]];

  // ---- The feed: where it's scrolled to ----
  const SWIPES = [...T.swipes1, ...T.swipes2];

  // ---- Sound cues (the coach's voice and the music are separate) ----
  const SFX = [
    { at: 0, kind: 'boom' }, { at: 0.02, kind: 'slam' },
    { at: T.coldOut - 0.05, kind: 'whoosh' },
    { at: T.dialogIn, kind: 'alert' },
    ...CLICKS.map((at) => ({ at, kind: 'click' })),
    ...SWIPES.map((at) => ({ at, kind: 'flick' })),
    { at: T.trayClick + 0.02, kind: 'blip' },
    { at: T.typing[0], kind: 'type', until: T.typing[1] },
    { at: T.lockClick + 0.03, kind: 'pluck', n: 2 },
    { at: T.toast, kind: 'toast' },
    { at: T.toastX + 0.05, kind: 'swish' },
    { at: T.talk, kind: 'blip' },
    { at: T.slam, kind: 'slam' },
    { at: T.phone[0] - 0.1, kind: 'whoosh' },
    { at: T.tap, kind: 'click' }, { at: PB(3.05), kind: 'swish' }, { at: PB(3.42), kind: 'click' }, { at: PB(3.78), kind: 'click' },
    { at: PB(3.95), kind: 'blip' },
    { at: PB(4.36), kind: 'whoosh' },
    { at: PB(4.36), kind: 'whistle', until: T.impact },
    { at: T.impact, kind: 'boom' }, { at: T.impact + 0.02, kind: 'slam' },
    { at: T.phoneOut[0], kind: 'whoosh' },
    { at: T.hunt[1] - 0.3, kind: 'denied' },
    { at: T.setup[0], kind: 'whoosh' },
    ...T.ticks.map((at) => ({ at: at + 0.04, kind: 'tick' })),
    { at: T.count, kind: 'chime' },
    { at: T.end, kind: 'whoosh' },
    { at: T.ask, kind: 'fuse', until: LENGTH },
  ].sort((a, b) => a.at - b.at);
  // Quiet: you're talking over it. It ducks under the coach and stops for the card slam.
  const MUSIC = {
    start: T.coldOut,
    end: LENGTH,
    levels: [[0, 0.42], [T.end, 0.6]],
    busy: [],
    cuts: [[T.slam, T.slam + 0.65, 0.4]],
    duck: [[25.2, 30.3, 0.5], [PB(4.2), T.impact + 0.6, 0.35]],
  };
  // For record.mjs: where to cut the render into chunks, what to show while warming up, and the
  // mixes (the stand-in voice for your lines is left out: that's yours to say).
  const CUTS = [0, 9.75, 18.35, 25.35, 33.6, 41.15, 48.55, LENGTH];
  const WARM = [0.5, 5, 9, 12, 17, 20, 22, 26, 32, 35, 39, 41, 44, 46, 48, 52, 56];
  const MIXES = [{ suffix: '', skip: ['you'] }];

  window.FILM = { VO, DUR, LENGTH: LENGTH + PRE, PRE, SFX, BOMB_AUDIO: [], MUSIC, CUTS: PRE ? [0, ...CUTS.slice(1).map((c) => c + PRE)] : CUTS, WARM, MIXES, T, PACE };
  window.ready = () => !!(window.render && macWin()?.render && phoneWin()?.render && coachWin()?.render && macWin().document.getElementById('cardFrame')?.contentWindow?.render);

  // ---- Drawing ----
  const macWin = () => $('mac').contentWindow;
  const phoneWin = () => $('phone').contentWindow;
  const coachWin = () => $('coach').contentWindow;
  $('coach').src = `/launch/coachcard.html?${new URLSearchParams({ name: 'Intervention', meta: '40 min drifting · 0 words written', line: 'Your investors think you’re heads down. You are. On a raccoon.', goal: 'Investor update' })}`;

  const toStage = (p) => ({ x: 192 + 1.2 * p.x, y: 60 + 1.2 * p.y });
  const apply = (m, p) => ({ x: m.x + m.s * p.x, y: m.y + m.s * p.y });
  const md = () => $('mac').contentDocument;
  const rectOf = (doc, id) => doc?.getElementById(id)?.getBoundingClientRect();
  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  // The panel hangs under the padlock.
  function panelBox() {
    const r = rectOf(md(), 'tray');
    const left = r ? clamp(r.left + r.width / 2 - 184, 8, 1280 - 368 - 8) : 880;
    return { x: left, y: 31 };
  }
  function cardRect() {
    const r = md()?.getElementById('cardFrame')?.contentDocument?.getElementById('card')?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 340, y: 230, w: 600, h: 340 };
  }
  /** Named places on the screen (in the screen's own pixels). */
  function spot(name) {
    if (Array.isArray(name)) return { x: name[0], y: name[1] };
    const doc = md();
    if (name === 'tray') { const r = rectOf(doc, 'tray'); return r ? center(r) : { x: 1110, y: 14 }; }
    if (name === 'tabDoc' || name === 'tabFeed') { const r = rectOf(doc, name); return r ? { x: r.left + 60, y: r.top + r.height / 2 } : { x: 200, y: 50 }; }
    if (name === 'ignore') return { x: 563, y: 392 };
    const p = panelBox();
    if (name === 'panel') return { x: p.x + 184, y: p.y + 330 };
    if (name === 'field') return { x: p.x + 150, y: p.y + 168 };
    if (name === 'lockBtn') return { x: p.x + 255, y: p.y + 224 };
    const c = cardRect();
    if (name === 'cardTR') return { x: c.x + c.w - 18, y: c.y + 20 };
    if (name === 'cardTL') return { x: c.x + 24, y: c.y + 22 };
    if (name === 'cardB') return { x: c.x + c.w * 0.62, y: c.y + c.h - 30 };
    return { x: 640, y: 400 };
  }

  function camera(t) {
    const state = (k) => {
      const f = typeof k.f === 'string' ? spot(k.f) : { x: k.f[0], y: k.f[1] };
      const P = toStage(f);
      const q = k.q ? { x: k.q[0], y: k.q[1] } : { x: lerp(P.x, 960, clamp((k.z - 1) / 0.4)), y: lerp(P.y, 540, clamp((k.z - 1) / 0.4)) };
      return { z: k.z, P, q };
    };
    let s = state(CAM[0]);
    for (const k of CAM.slice(1)) {
      if (t < k.at) break;
      const e = ease.inOut(seg(t, k.at, k.at + k.d));
      const n = state(k);
      s = { z: Math.exp(lerp(Math.log(s.z), Math.log(n.z), e)), P: { x: lerp(s.P.x, n.P.x, e), y: lerp(s.P.y, n.P.y, e) }, q: { x: lerp(s.q.x, n.q.x, e), y: lerp(s.q.y, n.q.y, e) } };
    }
    const m = { s: s.z, x: s.q.x - s.z * s.P.x, y: s.q.y - s.z * s.P.y };
    // Zoomed in, the screen's edges stay outside the picture.
    if (1536 * m.s > 1920) m.x = clamp(m.x, 1920 - 1728 * m.s, -192 * m.s);
    if (960 * m.s > 1080) m.y = clamp(m.y, 1080 - 1020 * m.s, -60 * m.s);
    // A jolt when a bomb lands.
    const jolt = [0, T.impact].reduce((a, h) => a + (t >= h ? Math.max(0, 1 - (t - h) / 0.45) : 0), 0);
    m.x += Math.sin(t * 110) * 14 * jolt;
    m.y += Math.cos(t * 87) * 9 * jolt;
    return m;
  }

  function pointer(t) {
    let p = { x: 700, y: 600 };
    for (const mv of MOVES) {
      if (t < mv.a) break;
      const to = spot(mv.to);
      const k = ease.inOut(seg(t, mv.a, mv.b));
      const arc = Math.sin(Math.PI * k) * Math.min(40, Math.hypot(to.x - p.x, to.y - p.y) * 0.08);
      p = { x: lerp(p.x, to.x, k), y: lerp(p.y, to.y, k) - arc };
    }
    return p;
  }

  // The feed: how far it's scrolled, how fast, and how long the current clip has played.
  function feedAt(t) {
    if (t < T.coldOut) return { pos: 6, speed: 0, age: 2 + t };
    let pos = 0;
    let last = T.coldOut - 1.5;
    for (const s of SWIPES) {
      pos += ease.inOut(seg(t, s, s + 0.3));
      if (t >= s + 0.3) last = s + 0.3;
    }
    const prev = SWIPES.reduce((a, s) => a + ease.inOut(seg(t - 1 / 60, s, s + 0.3)), 0);
    return { pos, speed: Math.abs(pos - prev) * 60, age: t - last };
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
  function loud(id, t) {
    const env = window.VO_ENV?.[id];
    const v = VO.find((x) => x.id === id);
    const k = t - v.at;
    if (k < 0 || k > dur(v)) return 0;
    if (!env) return 0.5 + 0.5 * Math.abs(Math.sin(k * 11));
    return env[Math.min(env.length - 1, Math.floor(k * 30))] ?? 0;
  }
  function bars(el, level, t) {
    if (!el.children.length) for (let i = 0; i < 18; i++) el.append(document.createElement('i'));
    [...el.children].forEach((b, i) => {
      const wob = 0.55 + 0.45 * Math.abs(Math.sin(t * (9 + (i % 5)) + i * 1.7));
      const shape = 1 - Math.abs(i - 8.5) / 11;
      b.style.height = `${Math.round(6 + 34 * clamp(0.15 + level * 1.5) * wob * shape)}px`;
    });
  }
  const at = (id) => VO.find((v) => v.id === id).at;
  const shown = (el, on, display = 'block') => (el.style.display = on ? display : 'none');
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;

  // ---- Sam's... no: your Mac ----
  function drawMac(t) {
    const doc = md();
    const win = macWin();
    if (!doc || !win?.render) return;
    if (!doc.getElementById('wtCss')) {
      const st = doc.createElement('style');
      st.id = 'wtCss';
      st.textContent = '#cursor{display:none!important} #toast{display:none!important}';
      doc.head.append(st);
    }
    // The bomb card's clock: the cold open, then the real bomb.
    let bt = 0;
    if (t < T.coldOut) bt = 5.2 + Math.min(t, 0.9);
    else if (t < T.coldOut + 0.16) bt = 7.96 + (t - T.coldOut);
    else if (t >= T.impact && t < T.setup[0]) bt = 5.2 + Math.min(t - T.impact, 0.9);
    else if (t >= T.setup[0] && t < T.setup[0] + 0.16) bt = 7.96 + (t - T.setup[0]);
    win.render(bt);
    const cd = doc.getElementById('cardFrame')?.contentDocument;
    if (cd) {
      const meta = cd.querySelector('.card-meta');
      if (meta) meta.textContent = 'Every distraction is locked for 5 minutes';
      const left = t < T.coldOut + 0.2 ? 299 - t : 299 - (t - T.impact);
      const st = cd.getElementById('status');
      if (st && bt < 7.45) st.textContent = `Locked for ${mmss(left)}`;
    }
    // Which page is up: the feed, or the doc you should be writing.
    const docView = (t >= T.docClick && t < T.feedClick) || t >= T.setup[0];
    doc.getElementById('feed').style.display = docView ? 'none' : 'flex';
    doc.getElementById('doc').style.display = docView ? 'flex' : 'none';
    doc.getElementById('tabFeed').style.display = 'flex';
    doc.getElementById('tabDoc').classList.toggle('on', docView);
    doc.getElementById('tabFeed').classList.toggle('on', !docView);
    doc.getElementById('url').textContent = docView ? 'docs.example.com/investor-update' : 'doomscroll.app/reels';
    const TYPE = 'MRR up 18% this month, and our first enterprise pilot starts';
    const n = t >= T.setup[0] ? TYPE.length : Math.round(lerp(14, 27, seg(t, T.docClick + 0.2, T.trayClick - 0.4)));
    doc.getElementById('typed').textContent = TYPE.slice(0, n);
    doc.getElementById('caret').style.opacity = Math.floor(t * 2) % 2 ? '0' : '1';
    // The feed, scrolled by hand.
    const f = feedAt(t);
    const reels = doc.getElementById('reels');
    reels.style.transform = `translateY(${(-f.pos * 614).toFixed(2)}px)`;
    reels.style.filter = f.speed > 1 ? `blur(${Math.min(7, f.speed * 0.4).toFixed(1)}px)` : 'none';
    const cur = Math.round(f.pos);
    doc.querySelectorAll('.reel').forEach((el, i) => {
      const age = i === cur ? f.age : 0;
      el.querySelectorAll('.kb').forEach((img) => (img.style.transform = `translate(${(Math.sin(age * 2.1 + i) * 4).toFixed(2)}px, ${(Math.cos(age * 1.7 + i * 2) * 3).toFixed(2)}px) scale(${(1.04 + age * 0.05).toFixed(4)})`));
      const bar = el.querySelector('.bar');
      if (bar) bar.style.width = `${Math.min(100, age * 9 + 10)}%`;
    });
    // The padlock in the menu bar: locked in from the click (green, then red when you drift).
    const tray = doc.getElementById('tray');
    const bombed = t < T.coldOut || (t >= T.impact && t < T.setup[0]);
    const session = t >= T.lockClick;
    tray.classList.toggle('idle', !(session || bombed));
    const dot = tray.querySelector('.dot');
    if (dot) dot.style.background = bombed || (t >= T.drifting && t < T.setup[0]) ? '#e5202e' : '#2bb24c';
    const clock = doc.getElementById('clock');
    if (bombed) clock.textContent = mmss(t < T.coldOut ? 299 - t : 299 - (t - T.impact));
    else if (session) clock.textContent = mmss(50 * 60 - (t - T.lockClick));
  }

  function drawScreenParts(t) {
    // The time-limit alert, and its "Ignore Limit".
    const dA = t >= T.dialogIn && t < T.ignore + 0.25 ? ease.backSoft(seg(t, T.dialogIn, T.dialogIn + 0.3)) * (1 - seg(t, T.ignore + 0.05, T.ignore + 0.22)) : 0;
    shown($('dialog'), dA > 0.01);
    if (dA > 0.01) {
      $('dialog').style.opacity = String(clamp(dA * 1.5));
      $('dialog').style.transform = `scale(${lerp(0.85, 1, clamp(dA, 0, 1.1)).toFixed(4)})`;
      $('ignoreBtn').classList.toggle('down', t >= T.ignore - 0.04 && t < T.ignore + 0.1);
    }

    // The menu bar panel (the app's own), with what you type into it.
    const pIn = ease.outQuint(seg(t, T.trayClick, T.trayClick + 0.3));
    const pOut = ease.inOut(seg(t, T.panelOut[0], T.panelOut[1]));
    const pA = t >= T.trayClick && t < T.panelOut[1] ? pIn * (1 - pOut) : 0;
    shown($('panel'), pA > 0.01);
    if (pA > 0.01) {
      const p = panelBox();
      Object.assign($('panel').style, { left: `${p.x}px`, top: `${p.y}px`, opacity: String(clamp(pA * 1.4)), transform: `translateY(${((1 - pA) * -12).toFixed(2)}px) scale(${lerp(0.96, 1, pA).toFixed(4)})` });
      const typed = 'investor update'.slice(0, Math.round(15 * seg(t, T.typing[0], T.typing[1])));
      const caret = t >= T.fieldClick && Math.floor(t * 3) % 2 === 0 ? '<i></i>' : '';
      $('field').innerHTML = typed ? `${typed}${caret}` : `${caret}<span class="ph">What are you working on?</span>`;
      $('lockBtn').style.opacity = t >= T.lockClick - 0.04 && t < T.lockClick + 0.12 ? '1' : '0';
    }

    // The corner card (it nudges), closed with its ×.
    const tIn = ease.outQuint(seg(t, T.toast, T.toast + 0.5));
    const tOut = ease.inOut(seg(t, T.toastX + 0.05, T.toastX + 0.4));
    $('toast').style.opacity = t >= T.toast && t < T.toastX + 0.4 ? String(seg(t, T.toast, T.toast + 0.2) * (1 - seg(t, T.toastX + 0.1, T.toastX + 0.35))) : '0';
    $('toast').style.transform = `translateX(${((1 - tIn) * 440 + tOut * 440).toFixed(2)}px)`;

    // It talks: the pill, its bars following the voice.
    const ta = ease.outQuint(seg(t, T.talk, T.talk + 0.4)) * (1 - seg(t, T.slam - 0.05, T.slam + 0.2));
    $('talk').style.opacity = String(ta);
    $('talk').style.transform = `translateY(${((1 - ta) * -14).toFixed(2)}px)`;
    if (ta > 0) bars($('bars'), loud('c1', t), t);

    // It gets personal: the card slams down, and goes when the phone comes in.
    const ck = t >= T.slam && t < T.phone[0] + 0.35 ? t - T.slam : -1;
    $('coach').style.visibility = ck >= 0 ? 'visible' : 'hidden';
    $('coach').style.opacity = String(1 - seg(t, T.phone[0], T.phone[0] + 0.3));
    coachWin()?.render?.(ck);

    // The setup window: the app's own three screens.
    const sA = t >= T.setup[0] && t < T.end + 0.4 ? ease.outQuint(seg(t, T.setup[0], T.setup[1])) : 0;
    shown($('setup'), sA > 0.01);
    if (sA > 0.01) {
      $('setup').style.opacity = String(clamp(sA * 1.3));
      $('setup').style.transform = `translateY(${((1 - sA) * 40).toFixed(2)}px) scale(${lerp(0.94, 1, sA).toFixed(4)})`;
      const k2 = ease.inOut(seg(t, T.s2, T.s2 + 0.35));
      const k3 = ease.inOut(seg(t, T.s3, T.s3 + 0.35));
      $('s1').style.transform = `translateX(${(-k2 * 1040).toFixed(1)}px)`;
      $('s2').style.transform = `translateX(${((1 - k2) * 1040 - k3 * 1040).toFixed(1)}px)`;
      $('s3').style.transform = `translateX(${((1 - k3) * 1040).toFixed(1)}px)`;
      T.ticks.forEach((h, i) => {
        const k = ease.back(seg(t, h + 0.04, h + 0.3));
        const el = $(`k${i + 1}`);
        el.style.opacity = String(seg(t, h + 0.04, h + 0.12));
        el.style.transform = `scale(${lerp(0.3, 1, k).toFixed(3)})`;
      });
      $('count').style.opacity = String(seg(t, T.count, T.count + 0.25));
    }

    // The pointer.
    const vis = POINTER.find(([a, b]) => t >= a - 0.25 && t < b + 0.25);
    const pa = vis ? seg(t, vis[0] - 0.25, vis[0]) * (1 - seg(t, vis[1], vis[1] + 0.25)) : 0;
    $('cursor').style.opacity = String(pa);
    if (pa > 0) {
      const p = pointer(t);
      const press = CLICKS.reduce((a, c) => Math.max(a, Math.sin(Math.PI * seg(t, c - 0.06, c + 0.1))), 0);
      $('cursor').style.transform = `translate(${(p.x - 3).toFixed(2)}px, ${(p.y - 3).toFixed(2)}px) scale(${(1 - 0.16 * press).toFixed(3)})`;
      const c = CLICKS.find((x) => t >= x && t < x + 0.45);
      $('ring').style.opacity = c !== undefined ? String((1 - seg(t, c, c + 0.45)) * 0.9) : '0';
      if (c !== undefined) $('ring').style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${lerp(0.4, 1.3, ease.out(seg(t, c, c + 0.45))).toFixed(3)})`;
    } else $('ring').style.opacity = '0';
  }

  // ---- A friend's phone, and the bomb ----
  function drawPhone(t, m) {
    const on = t >= T.phone[0] && t < T.phoneOut[1];
    shown($('phoneBox'), on);
    $('phl').style.opacity = '0';
    $('pring').style.opacity = '0';
    if (!on) return null;
    const x = lerp(-480, 310, ease.outQuint(seg(t, T.phone[0], T.phone[1]))) - 820 * ease.in(seg(t, T.phoneOut[0], T.phoneOut[1]));
    const y = 150;
    $('phoneBox').style.transform = `translate(${x.toFixed(1)}px, ${y}px) rotate(${(-4 + 4 * ease.out(seg(t, T.phone[0], T.phone[1] + 0.3))).toFixed(3)}deg)`;
    const pw = phoneWin();
    pw?.render?.(Math.max(1.0, 2.95 + (t - T.tap)));
    const toStagePhone = (p) => ({ x: x + 12 + p.x * 0.974359, y: y + 12 + p.y * 0.974359 });
    const pd = $('phone').contentDocument;
    // "My friends can see when I'm drifting": your row, highlighted.
    const row = pd?.getElementById('themPill')?.closest('li')?.getBoundingClientRect();
    const rA = seg(t, T.row, T.row + 0.25) * (1 - seg(t, T.button, T.button + 0.25));
    if (row && rA > 0) {
      const a = toStagePhone({ x: row.left - 6, y: row.top - 6 });
      Object.assign($('phl').style, { opacity: String(rA), transform: `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px)`, width: `${((row.width + 12) * 0.974).toFixed(1)}px`, height: `${((row.height + 12) * 0.974).toFixed(1)}px` });
    }
    // "And they get a button": a pulse on Bomb.
    const b = pw?.spot?.('bomb');
    const bA = seg(t, T.button, T.button + 0.2) * (1 - seg(t, T.tap - 0.05, T.tap + 0.1));
    if (b && bA > 0) {
      const c = toStagePhone(b);
      const pulse = 1 + 0.12 * Math.sin((t - T.button) * 9);
      Object.assign($('pring').style, { opacity: String(bA), transform: `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) scale(${pulse.toFixed(3)})` });
    }
    return { toStagePhone, throwAt: pw?.spot?.('throw') ?? { x: 290, y: 780 } };
  }

  function drawBomb(t, m, ph) {
    const pop = PB(3.95);
    const wind = [PB(4.22), PB(4.36)];
    const on = ph && t >= pop && t < T.impact;
    shown($('fly'), on);
    if (!on) return;
    const from = ph.toStagePhone(ph.throwAt);
    const hover = { x: from.x + 40, y: from.y - 300 };
    const target = apply(m, toStage({ x: 640, y: 400 }));
    let p;
    let s = 1;
    let r = 0;
    if (t < wind[0]) {
      const k = ease.out(seg(t, pop, pop + 0.24));
      p = { x: lerp(from.x, hover.x, k), y: lerp(from.y, hover.y, k) };
      s = ease.back(seg(t, pop, pop + 0.18));
      r = Math.sin(t * 26) * 9;
    } else if (t < wind[1]) {
      const k = ease.out(seg(t, wind[0], wind[1]));
      p = { x: hover.x, y: hover.y + 40 * k };
      r = -14 * k;
    } else {
      const k0 = seg(t, wind[1], T.impact);
      const k = k0 * 0.8 + ease.in(k0) * 0.2;
      const a = { x: hover.x, y: hover.y + 40 };
      const c = { x: (a.x + target.x) / 2, y: Math.min(a.y, target.y) - 330 };
      p = { x: (1 - k) * (1 - k) * a.x + 2 * (1 - k) * k * c.x + k * k * target.x, y: (1 - k) * (1 - k) * a.y + 2 * (1 - k) * k * c.y + k * k * target.y };
      s = lerp(1, 1.9, k * k);
      r = -14 + k * 720;
    }
    $('fly').style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${s.toFixed(3)}) rotate(${r.toFixed(1)}deg)`;
    $('flySpark').setAttribute('transform', `translate(133 18) scale(${(0.8 + 0.3 * (0.5 - 0.5 * Math.cos(t * 30))).toFixed(3)})`);
  }

  function drawChips(t) {
    CHIPS.forEach(([a, b], i) => {
      const el = $(`chip${i}`);
      const k = ease.backSoft(seg(t, a, a + 0.35));
      const o = seg(t, a, a + 0.15) * (1 - seg(t, b - 0.2, b));
      el.style.opacity = t >= a && t < b ? o.toFixed(3) : '0';
      el.style.transform = `translateX(${((1 - clamp(k)) * -30).toFixed(1)}px) scale(${lerp(0.9, 1, k).toFixed(3)})`;
    });
  }

  function drawEnd(t) {
    const on = t >= T.end;
    shown($('end'), on);
    if (!on) return;
    const k = ease.outQuint(seg(t, T.end, T.end + 0.45));
    $('end').style.opacity = String(k);
    $('end').style.transform = `scale(${lerp(1.04, 1, k).toFixed(4)})`;
    const parts = [['#end .icon', T.end + 0.2], ['#end h1', T.end + 0.35], ['#end .tag', T.end + 0.6], ['#end .meta', T.end + 0.9], ['#endR', T.ask]];
    for (const [sel, when] of parts) {
      const el = document.querySelector(sel);
      const kk = ease.backSoft(seg(t, when, when + 0.5));
      el.style.opacity = String(ease.smooth(seg(t, when, when + 0.25)));
      el.style.transform = `translateY(${((1 - kk) * 34).toFixed(2)}px) scale(${lerp(0.94, 1, kk).toFixed(4)})`;
    }
    // "Link's in the replies": the address lights up.
    const lk = seg(t, 53.5, 53.8) * (1 - seg(t, 55.2, 55.5));
    $('endUrl').style.background = `rgba(255, 207, 0, ${(0.1 + 0.9 * lk).toFixed(3)})`;
    $('endUrl').style.color = lk > 0.5 ? '#101820' : '#fff';
    $('endSpark').setAttribute('transform', `translate(133 18) scale(${(0.8 + 0.3 * (0.5 - 0.5 * Math.cos(t * 30))).toFixed(3)}) rotate(${((t * 400) % 360).toFixed(1)})`);
    $('endBomb').style.transform = `rotate(${(Math.sin(t * 3) * 5).toFixed(3)}deg)`;
  }

  // ---- Your lines, for recording ----
  const lines = VO.filter((v) => v.who === 'you');
  function drawPrompter(t, T0) {
    shown($('prompter'), PROMPTER);
    shown($('bubble'), PROMPTER, 'grid');
    shown($('countdown'), PROMPTER && T0 < 0, 'grid');
    if (!PROMPTER) return;
    if (T0 < 0) {
      $('cdN').textContent = String(Math.ceil(-T0));
      $('cdLine').textContent = `First line: “${lines[0].text}”`;
    }
    const now = lines.find((v) => t >= v.at - 0.15 && t < v.at + dur(v) + 0.15);
    const next = lines.find((v) => v.at > t + 0.15 && v !== now);
    const coach = VO.find((v) => v.who === 'coach' && t >= v.at - 0.3 && t < v.at + dur(v));
    const el = $('pNow');
    if (now) {
      const k = seg(t, now.at, now.at + dur(now));
      const words = now.text.split(' ');
      let count = 0;
      const total = now.text.length;
      el.innerHTML = words.map((w) => {
        const said = count / total < k;
        count += w.length + 1;
        return said ? `<em>${w}</em>` : w;
      }).join(' ');
      el.className = '';
      $('pBar').firstElementChild.style.width = `${(k * 100).toFixed(1)}%`;
    } else {
      el.className = 'wait';
      el.textContent = coach ? `(Lock In talks: “${coach.text}”)` : next ? next.text : '';
      $('pBar').firstElementChild.style.width = '0%';
    }
    $('pNext').textContent = T0 < 0 ? '' : now && next ? `Next: ${next.text}` : next && !coach ? `In ${Math.max(0, next.at - t).toFixed(0)}…` : '';
  }

  window.render = (T0) => {
    star();
    const t = Math.max(0, T0 - PRE);
    const m = camera(t);
    $('cam').style.transform = `translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px) scale(${m.s.toFixed(5)})`;
    drawMac(t);
    drawScreenParts(t);
    const ph = drawPhone(t, m);
    drawBomb(t, m, ph);
    // KABOOM where it lands.
    const kb = t >= T.impact && t < T.impact + 0.7 ? 1 - ease.inOut(seg(t, T.impact + 0.42, T.impact + 0.65)) : 0;
    $('kaboom').style.visibility = kb > 0 ? 'visible' : 'hidden';
    if (kb > 0) {
      const c = apply(m, toStage({ x: 640, y: 400 }));
      const k = ease.backSoft(seg(t, T.impact, T.impact + 0.28));
      $('kaboom').style.opacity = String(kb);
      $('kaboom').style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px) scale(${lerp(0.2, 0.9, k).toFixed(4)}) rotate(${lerp(-20, -4, k).toFixed(3)}deg)`;
    }
    const flash = (when, peak, len) => (t >= when ? peak * (1 - ease.out(seg(t, when, when + len))) : 0);
    $('flash').style.opacity = String(Math.max(flash(0, 0.6, 0.25), flash(T.impact, 0.6, 0.25), flash(T.slam, 0.35, 0.25)));
    $('fade').style.opacity = String(PROMPTER ? 0 : 1 - seg(t, 0, 0.08));
    drawChips(t);
    drawEnd(t);
    drawPrompter(t, T0 - PRE);
  };
})();
