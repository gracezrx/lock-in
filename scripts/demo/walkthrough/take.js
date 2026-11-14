// ?take=1: the walkthrough cut to a real talking take. record.mjs --take <json> hands over the
// take's timings (window.applyTake(TAKE)) and the film plays on the take's clock:
//   anchors   [[output s, film s], ...]  where each beat of the film lands in the take (piecewise
//             linear, so the screen moves at the speaker's pace; the coach's line keeps 1:1)
//   intro     seconds of title card before the film
//   ext       when the Chrome extension shot happens (the toolbar icon, its panel)
//   captions  [[from, to, text], ...] what's said, on screen
//   speech    [[from, to], ...] when the speaker talks (the music ducks under it)
// The take itself (the face, the voice) is laid over the render afterwards.
(function () {
  if (new URLSearchParams(location.search).get('take') !== '1') return;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const outQuint = (k) => 1 - Math.pow(1 - k, 5);
  const backSoft = (k) => 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2);
  const inOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const $ = (id) => document.getElementById(id);
  const md = () => $('mac').contentDocument;

  window.applyTake = (TK) => {
    const F = window.FILM;
    const A = TK.anchors;
    const fOf = (o) => {
      if (o <= A[0][0]) return A[0][1];
      for (let i = 1; i < A.length; i++) if (o <= A[i][0]) return lerp(A[i - 1][1], A[i][1], (o - A[i - 1][0]) / (A[i][0] - A[i - 1][0]));
      return A[A.length - 1][1];
    };
    const oOf = (f) => {
      if (f <= A[0][1]) return A[0][0];
      for (let i = 1; i < A.length; i++) if (f <= A[i][1]) return lerp(A[i - 1][0], A[i][0], (f - A[i - 1][1]) / (A[i][1] - A[i - 1][1]));
      return A[A.length - 1][0];
    };
    const start = A[0][1];

    // Sound, on the take's clock: the film's cues that happen after the start, plus the take's own.
    const sfx = F.SFX.filter((c) => c.at >= start - 1e-6).map((c) => ({ ...c, at: oOf(c.at), ...(c.until !== undefined ? { until: oOf(c.until) } : {}) }));
    F.SFX = [...sfx, ...TK.sfx].sort((a, b) => a.at - b.at);
    F.VO = [
      ...F.VO.filter((v) => v.who === 'coach').map((v) => ({ ...v, at: oOf(v.at) })),
      ...TK.speech.map(([a, b], i) => ({ id: `take${i}`, who: 'you', at: a, dur: b - a, text: '' })),
    ];
    F.MUSIC = {
      start: TK.musicStart,
      end: TK.length,
      levels: F.MUSIC.levels.map(([t, g]) => [t <= start ? 0 : oOf(t), g]),
      busy: [],
      cuts: F.MUSIC.cuts.map(([a, b, back]) => [oOf(a), oOf(b), back]),
      duck: F.MUSIC.duck.map(([a, b, g]) => [oOf(a), oOf(b), g]),
    };
    Object.assign(F, { LENGTH: TK.length, PRE: 0, CUTS: TK.cuts, WARM: TK.warm, MIXES: [{ suffix: '', skip: ['you'] }], BOMB_AUDIO: [] });

    // The end card's question sits a little higher, clear of the speaker's frame (bottom right).
    const st = document.createElement('style');
    st.textContent = '#end .r { top: 110px; } #end .r svg { width: 160px; height: 160px; }';
    document.head.append(st);
    // The end card says it's on Chrome too now.
    const meta = document.querySelector('#end .meta');
    if (meta) meta.innerHTML = '<span class="y">Free for Mac + Chrome</span><span>Open source</span><span id="endUrl">gracezrx.com/lock-in</span>';

    const film = window.render;
    window.render = (o) => {
      const f = fOf(o);
      film(f);
      drawExt(o, TK.ext);
      drawIntro(o, TK.intro);
      drawCaps(o, TK.captions);
      $('fade').style.opacity = String(Math.max(Number($('fade').style.opacity) || 0, seg(o, TK.length - 0.6, TK.length)));
    };
    window.ready = ((r) => () => r() && !!md()?.querySelector('.toolbar'))(window.ready);
  };

  // ---- The title card ----
  function drawIntro(o, I) {
    const on = o < I;
    $('intro').style.display = on ? 'block' : 'none';
    if (!on) return;
    const out = inOut(seg(o, I - 0.3, I));
    $('intro').style.opacity = String(1 - out);
    $('intro').style.transform = `scale(${lerp(1, 1.06, out).toFixed(4)})`;
    const k = backSoft(seg(o, 0.04, 0.4));
    $('introIcon').style.transform = `scale(${lerp(2.4, 1, clamp(k, 0, 1.2)).toFixed(4)}) rotate(${lerp(-14, 0, clamp(k)).toFixed(2)}deg)`;
    $('introIcon').style.opacity = String(seg(o, 0.04, 0.12));
    const parts = [['introH', 0.28], ['introTag', 0.62], ['introChips', 1.05]];
    for (const [id, when] of parts) {
      const kk = backSoft(seg(o, when, when + 0.45));
      $(id).style.opacity = String(seg(o, when, when + 0.18));
      $(id).style.transform = `translateY(${((1 - kk) * 40).toFixed(2)}px)`;
    }
    $('introFlash').style.opacity = String(o < 0.04 ? 0 : 0.55 * (1 - outQuint(seg(o, 0.04, 0.3))));
  }

  // ---- "It lives in your Chrome extension": the toolbar icon, and its panel ----
  let extReady = false;
  function extButton() {
    const doc = md();
    if (!doc) return null;
    if (!extReady) {
      const bar = doc.querySelector('.toolbar');
      if (!bar) return null;
      const st = doc.createElement('style');
      st.textContent = '#extBtn{flex:none;width:30px;height:30px;border-radius:8px;display:grid;place-items:center} #extBtn img{width:22px;height:22px;border-radius:5px;display:block} #extBtn.on{background:#e1e5e8}';
      doc.head.append(st);
      const b = doc.createElement('span');
      b.id = 'extBtn';
      b.innerHTML = '<img src="/src/extension/static/icons/icon48.png" alt="">';
      bar.append(b);
      extReady = true;
    }
    return doc.getElementById('extBtn');
  }
  const ICON = { x: 1187, y: 112 };
  function drawExt(o, E) {
    const btn = extButton();
    const open = o >= E.click && o < E.close + 0.15;
    btn?.classList.toggle('on', open);
    // The popup, hanging under the icon like Chrome's.
    const pin = outQuint(seg(o, E.click + 0.05, E.click + 0.28));
    const pout = seg(o, E.close, E.close + 0.15);
    const pa = open ? pin * (1 - pout) : 0;
    $('extPop').style.display = pa > 0.01 ? 'block' : 'none';
    if (pa > 0.01) {
      $('extPop').style.opacity = String(clamp(pa * 1.3));
      $('extPop').style.transform = `translateY(${((1 - pin) * -8).toFixed(2)}px) scale(${lerp(0.97, 1, pin).toFixed(4)})`;
    }
    // The camera frames the popup while it's open, then hands back to the film's.
    const w = inOut(seg(o, E.click - 0.1, E.click + 0.45)) * (1 - inOut(seg(o, E.reopen - 0.1, E.reopen + 0.4)));
    if (w > 0) {
      const m0 = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\)/.exec($('cam').style.transform);
      if (m0) {
        const [x0, y0, s0] = m0.slice(1).map(Number);
        const s1 = 1.12;
        const P = { x: 192 + 1.2 * 1012, y: 60 + 1.2 * 436 };
        const x1 = 1080 - s1 * P.x;
        const y1 = 520 - s1 * P.y;
        $('cam').style.transform = `translate(${lerp(x0, x1, w).toFixed(2)}px, ${lerp(y0, y1, w).toFixed(2)}px) scale(${Math.exp(lerp(Math.log(s0), Math.log(s1), w)).toFixed(5)})`;
      }
    }
    // The menu bar panel closes when you click into Chrome, and opens again from the padlock.
    const panel = $('panel');
    if (o >= E.click && o < E.reopen) {
      const k = 1 - seg(o, E.click, E.click + 0.12);
      panel.style.display = k > 0.01 ? 'block' : 'none';
      panel.style.opacity = String(k);
    } else if (o >= E.reopen && o < E.reopen + 0.3) {
      const k = outQuint(seg(o, E.reopen, E.reopen + 0.3));
      panel.style.display = 'block';
      panel.style.opacity = String(clamp(k * 1.4));
      panel.style.transform = `translateY(${((1 - k) * -12).toFixed(2)}px) scale(${lerp(0.96, 1, k).toFixed(4)})`;
    }
    // The pointer: to the icon, click; over the list; back to the padlock, click.
    if (o < E.moveA || o > E.reopen + 0.35) return;
    const trayR = md()?.getElementById('tray')?.getBoundingClientRect();
    const tray = trayR ? { x: trayR.left + trayR.width / 2, y: trayR.top + trayR.height / 2 } : { x: 1110, y: 14 };
    const LIST = { x: 1000, y: 520 };
    const legs = [
      { a: E.moveA, b: E.click - 0.05, from: tray, to: ICON },
      { a: E.listA, b: E.listA + 0.6, from: ICON, to: LIST },
      { a: E.backA, b: E.reopen - 0.05, from: LIST, to: tray },
    ];
    let p = tray;
    for (const l of legs) {
      if (o < l.a) break;
      const k = inOut(seg(o, l.a, l.b));
      const arc = Math.sin(Math.PI * k) * Math.min(40, Math.hypot(l.to.x - l.from.x, l.to.y - l.from.y) * 0.08);
      p = { x: lerp(l.from.x, l.to.x, k), y: lerp(l.from.y, l.to.y, k) - arc };
    }
    const clicks = [E.click, E.reopen];
    const press = clicks.reduce((a, c) => Math.max(a, Math.sin(Math.PI * seg(o, c - 0.06, c + 0.1))), 0);
    $('cursor').style.opacity = '1';
    $('cursor').style.transform = `translate(${(p.x - 3).toFixed(2)}px, ${(p.y - 3).toFixed(2)}px) scale(${(1 - 0.16 * press).toFixed(3)})`;
    const c = clicks.find((x) => o >= x && o < x + 0.45);
    $('ring').style.opacity = c !== undefined ? String((1 - seg(o, c, c + 0.45)) * 0.9) : '0';
    if (c !== undefined) $('ring').style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) scale(${lerp(0.4, 1.3, 1 - Math.pow(1 - seg(o, c, c + 0.45), 3)).toFixed(3)})`;
  }

  // ---- Captions: what's said, a phrase at a time ----
  let capNow = -1;
  function drawCaps(o, C) {
    const i = C.findIndex(([a, b]) => o >= a - 0.04 && o < b + 0.2);
    const el = $('caps');
    if (i < 0) {
      el.style.opacity = '0';
      return;
    }
    const [a, , text] = C[i];
    if (i !== capNow) {
      el.firstElementChild.textContent = text;
      capNow = i;
    }
    const k = backSoft(seg(o, a - 0.04, a + 0.14));
    el.style.opacity = String(seg(o, a - 0.04, a + 0.04));
    el.style.transform = `translateX(-50%) scale(${lerp(0.94, 1, clamp(k, 0, 1.1)).toFixed(4)})`;
  }
})();
