// The README demo: a 20-second scene, played in real time and recorded by record.mjs.
//   Locked in on the deck -> "just one video" -> 12 minutes later -> Lock In notices
//   (menu bar, corner card, then the extension's card over the page, out loud) -> back to the deck
//   -> the opening animation as the end card.
// record.mjs provides window.LockInIntro (src/renderer/intro.ts) and window.lockInCardSource
// (the card function from extension/background.js), then calls window.startDemo().
/* global LockInIntro, lockInCardSource */

const $ = (id) => document.getElementById(id);
const at = (ms, fn) => setTimeout(fn, ms);

const ROAST = "Twelve minutes of cats knocking things off tables. The pitch deck isn't going to finish itself, babe.";

const DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../../dist/renderer/base.css"><style>
  body { background: #f1f3f4; color: var(--ink); font-family: var(--body); }
  .bar { height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 18px; background: #fff; border-bottom: 1px solid #e3e5e0; }
  .bar i { width: 26px; height: 10px; border-radius: 3px; background: #dfe2e5; }
  .page { width: 700px; min-height: 620px; margin: 26px auto; padding: 56px 68px; background: #fff; box-shadow: 0 1px 3px rgba(16,24,32,.14); }
  h1 { font-family: var(--display); font-weight: 900; font-size: 46px; line-height: 1; margin-bottom: 22px; }
  p { margin-bottom: 14px; font-size: 16.5px; line-height: 1.55; }
  #t::after { content: ''; display: inline-block; width: 2px; height: 19px; margin-left: 1px; vertical-align: -4px; background: var(--ink); animation: b 1s steps(1) infinite; }
  @keyframes b { 50% { opacity: 0; } }
</style></head><body>
  <div class="bar"><i></i><i></i><i style="width:64px"></i><i></i><i></i><i style="width:90px"></i><i></i></div>
  <div class="page">
    <h1>Pitch deck draft</h1>
    <p><b>Problem.</b> People open their laptop to work and end up on video number nine.</p>
    <p><b>Why now.</b> Everything on a screen is built to pull you away from what you meant to do.</p>
    <p><b>Solution.</b> <span id="t"></span></p>
  </div>
</body></html>`;

const VIDEO = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../../dist/renderer/base.css"><style>
  body { background: #0f0f12; color: #f2f2f5; font-family: var(--body); }
  .top { height: 56px; display: flex; align-items: center; padding: 0 22px; }
  .logo { display: flex; align-items: center; gap: 8px; font-family: var(--display); font-weight: 900; font-size: 25px; }
  .logo i { width: 28px; height: 28px; border-radius: 8px; background: #7c5cff; }
  .search { width: 440px; height: 36px; margin-left: 150px; border-radius: 18px; background: #1d1d22; border: 1px solid #2d2d35; }
  .main { display: flex; gap: 24px; padding: 6px 22px; }
  .player { position: relative; flex: 0 0 760px; height: 428px; border-radius: 12px; overflow: hidden; }
  .player svg { display: block; width: 100%; height: 100%; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; background: rgba(255,255,255,.28); }
  .bar i { display: block; height: 100%; width: 6%; background: #7c5cff; transition: width .4s; }
  h2 { margin: 14px 0 4px; font-size: 20px; font-weight: 700; }
  .meta { color: #9a9aa5; font-size: 14px; }
  .side { flex: 1; min-width: 0; }
  .side h3 { font-size: 15px; margin-bottom: 12px; }
  .item { display: flex; gap: 10px; margin-bottom: 12px; }
  .thumb { flex: 0 0 150px; height: 84px; border-radius: 8px; }
  .item b { display: block; font-size: 14px; line-height: 1.3; margin-bottom: 4px; }
  .item span { font-size: 12px; color: #9a9aa5; }
  .paw { animation: swipe 2.6s ease-in-out infinite; transform-box: fill-box; transform-origin: 0 50%; }
  .mug { animation: shove 2.6s ease-in infinite; transform-box: fill-box; transform-origin: 50% 100%; }
  .tail { animation: wag 1.3s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 100% 100%; }
  .paused .paw, .paused .mug, .paused .tail { animation-play-state: paused; }
  @keyframes swipe { 0%, 22% { transform: translateX(0); } 32% { transform: translateX(26px); } 44%, 100% { transform: translateX(0); } }
  @keyframes shove { 0%, 26% { transform: translate(0, 0) rotate(0); opacity: 1; } 42% { transform: translate(84px, 0) rotate(0); } 70% { transform: translate(150px, 170px) rotate(120deg); opacity: 1; } 71%, 88% { opacity: 0; transform: translate(0, 0); } 100% { opacity: 1; transform: translate(0, 0); } }
  @keyframes wag { from { transform: rotate(-6deg); } to { transform: rotate(10deg); } }
</style></head><body>
  <div class="top"><div class="logo"><i></i>vidz</div><div class="search"></div></div>
  <div class="main">
    <div>
      <div class="player">
        <svg viewBox="0 0 760 428" aria-hidden="true">
          <rect width="760" height="428" fill="#f4d6ad"/>
          <rect x="560" y="60" width="130" height="150" rx="6" fill="#bfe0f0" stroke="#e9c597" stroke-width="10"/>
          <rect x="110" y="292" width="500" height="18" rx="4" fill="#7a4b2a"/>
          <rect x="140" y="310" width="16" height="118" fill="#6a3f22"/>
          <rect x="566" y="310" width="16" height="118" fill="#6a3f22"/>
          <path class="tail" d="M268 262 C214 252 214 196 246 182" stroke="#2b2b33" stroke-width="15" fill="none" stroke-linecap="round"/>
          <ellipse cx="330" cy="250" rx="72" ry="44" fill="#2b2b33"/>
          <circle cx="398" cy="204" r="42" fill="#2b2b33"/>
          <path d="M366 178 L372 134 L398 164 Z" fill="#2b2b33"/>
          <path d="M408 164 L432 134 L436 182 Z" fill="#2b2b33"/>
          <circle cx="386" cy="200" r="7" fill="#d4ff3a"/><circle cx="414" cy="200" r="7" fill="#d4ff3a"/>
          <rect class="paw" x="414" y="256" width="58" height="16" rx="8" fill="#2b2b33"/>
          <g class="mug"><rect x="480" y="244" width="42" height="48" rx="6" fill="#fff"/><path d="M522 254 h10 a11 11 0 0 1 0 22 h-10" stroke="#fff" stroke-width="7" fill="none"/></g>
        </svg>
        <div class="bar"><i id="progress"></i></div>
      </div>
      <h2>10 hours of cats knocking things off tables</h2>
      <div class="meta">4.2M views</div>
    </div>
    <div class="side">
      <h3>Up next</h3>
      <div class="item"><div class="thumb" style="background:#3a2f4d"></div><div><b>Cats vs. cucumbers, part 4</b><span>2.1M views</span></div></div>
      <div class="item"><div class="thumb" style="background:#24414a"></div><div><b>Dog learns to open the fridge</b><span>880K views</span></div></div>
      <div class="item"><div class="thumb" style="background:#4a3324"></div><div><b>Top 50 cat fails of the year</b><span>6.7M views</span></div></div>
      <div class="item"><div class="thumb" style="background:#2c3a28"></div><div><b>Just one more: the cat compilation</b><span>12M views</span></div></div>
    </div>
  </div>
</body></html>`;

const docFrame = $('docFrame');
const vidFrame = $('vidFrame');
docFrame.srcdoc = DOC;
vidFrame.srcdoc = VIDEO;

// ---- little helpers ----------------------------------------------------------

function caption(text) {
  const c = $('caption');
  if (!text) return c.classList.add('off');
  c.textContent = text;
  c.classList.remove('off');
}

const cursor = $('cursor');
let pos = { x: 760, y: 520 };
cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
function moveTo(x, y, ms) {
  cursor.animate([{ transform: `translate(${pos.x}px, ${pos.y}px)` }, { transform: `translate(${x}px, ${y}px)` }], { duration: ms, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' });
  pos = { x, y };
}
function clickAnim() {
  cursor.animate([{ transform: `translate(${pos.x}px, ${pos.y}px) scale(1)` }, { transform: `translate(${pos.x}px, ${pos.y}px) scale(.82)` }, { transform: `translate(${pos.x}px, ${pos.y}px) scale(1)` }], { duration: 160 });
}
function typeText(write, text, startMs, perChar) {
  [...text].forEach((ch, i) => at(startMs + i * perChar, () => write(ch)));
  return startMs + text.length * perChar;
}

let clockSec = 41 * 60 + 12;
let clockTimer = 0;
function tickClock() {
  clockSec -= 1;
  $('clock').textContent = `${Math.floor(clockSec / 60)}:${String(clockSec % 60).padStart(2, '0')}`;
}

function docType(ch) {
  docFrame.contentDocument.getElementById('t').textContent += ch;
}

let videoTab = null;

// ---- the scene -------------------------------------------------------------------

window.startDemo = function startDemo() {
  clockTimer = setInterval(tickClock, 1000);

  // Locked in on the deck.
  caption('Locked in on the pitch deck.');
  typeText(docType, 'A coach that notices when you dri', 300, 42);

  // ...just one video.
  const plus = $('newTab').getBoundingClientRect();
  at(1600, () => moveTo(plus.left + 8, plus.top + 8, 650));
  at(2350, () => {
    clickAnim();
    caption('Just one video…');
    $('tabDoc').classList.remove('on');
    videoTab = document.createElement('div');
    videoTab.className = 'tab on';
    videoTab.innerHTML = '<span class="fav" style="background:#dfe2e5"></span><span class="label">New Tab</span>';
    $('tabs').insertBefore(videoTab, $('newTab'));
    $('url').textContent = '';
    $('omnibox').classList.add('typing');
    docFrame.classList.remove('on');
  });
  typeText((ch) => ($('url').textContent += ch), 'vidz.tv', 2650, 90);
  at(3400, () => {
    $('omnibox').classList.remove('typing');
    $('url').textContent = 'vidz.tv/watch?v=cats-10-hours';
    videoTab.innerHTML = '<span class="fav" style="background:#7c5cff"></span><span class="label">10 hours of cats knocking things off…</span>';
    vidFrame.classList.add('on');
    moveTo(980, 640, 700);
  });
  at(3500, () => (vidFrame.contentDocument.getElementById('progress').style.width = '8%'));

  // 12 minutes later.
  at(5100, () => {
    caption('12 minutes later');
    clockSec = 29 * 60 + 5;
    tickClock();
    vidFrame.contentDocument.getElementById('progress').style.width = '41%';
  });

  // Lock In notices: the menu bar, then the corner card...
  at(5900, () => {
    caption('Lock In notices.');
    $('lockinItem').classList.add('alert');
  });
  at(6200, () => $('toast').classList.add('on'));

  // ...then the card over the page, out loud.
  at(8200, () => {
    $('toast').classList.remove('on');
    const win = vidFrame.contentWindow;
    win.document.body.classList.add('paused');
    win.eval(`${lockInCardSource}\nlockInCard(${JSON.stringify({ title: 'Lock in.', text: ROAST, goal: 'Pitch deck', seconds: 5, tone: 'yellow' })});`);
  });
  at(8450, () => $('voice').classList.add('on'));
  ROAST.split(' ').forEach((word, i) => at(8450 + i * 190, () => ($('voiceText').textContent += (i ? ' ' : '') + word)));

  // ...and drags you back.
  at(13450, () => {
    $('voice').classList.remove('on');
    caption('…and drags you back.');
    $('lockinItem').classList.remove('alert');
    videoTab.classList.remove('on');
    $('tabDoc').classList.add('on');
    $('url').textContent = 'docs.example.com/pitch-deck';
    vidFrame.classList.remove('on');
    docFrame.classList.add('on');
  });
  typeText(docType, 'ft and drags you back to work.', 13900, 45);

  // The end card: the opening animation, held on "Lock in."
  at(15700, () => {
    caption('');
    clearInterval(clockTimer);
    void LockInIntro.playIntro({ hold: true });
  });
  at(17900, () => $('outro').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'forwards' }));
  // Hold on the end card, then tell the recorder it's over (timers can run late while recording).
  at(17900, () => setTimeout(() => (window.demoDone = true), 2300));
};

/** Roughly how long the scene runs. */
window.demoLength = 20200;
