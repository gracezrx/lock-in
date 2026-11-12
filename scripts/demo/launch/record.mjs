// Records a film (1920x1080, 60 fps) with its sound. The launch film (this folder):
//   docs/launch.mp4             the AI voices (narrator, the coach, Sam)
//   docs/launch-your-voice.mp4  the same film without the narrator, to record your own voice over
// and, with --film walkthrough (../walkthrough), the walkthrough to talk over with your camera on:
//   docs/walkthrough.mp4           the screen recording, with the app's own sounds
//   docs/walkthrough-prompter.mp4  (--prompter) the same with your lines on top and a countdown
//
//   python3 scripts/demo/launch/tts.py [walkthrough]   (once: speaks the lines into <film>/vo/)
//   node scripts/demo/launch/record.mjs [--film walkthrough] [--prompter]
//   node scripts/demo/launch/record.mjs --stills 3,12,23   (just those moments, as JPEGs)
//   node scripts/demo/launch/record.mjs --only 4          (render one chunk again, then join)
//   node scripts/demo/launch/record.mjs --film walkthrough --take take.json --out screen.mp4
//       ... --music off|only --wav stem.wav   (a sound stem on its own, for re-cutting)
//       the walkthrough on a real take's clock (../walkthrough/take.js): a title card, the
//       screen moving at the speaker's pace, captions; the face and voice go on afterwards
//
// Every frame is drawn from a time t (film.js), so the film comes out the same every time. The
// bomb scenes play the bomb clip (../bomb) inside the film, with its own sound
// (docs/bomb-demo-wide.mp4); the music and the sound effects are made here, in code.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bombDir = resolve(here, '../bomb');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = /^--(\w+)$/.exec(process.argv[i]);
  if (!m) continue;
  const next = process.argv[i + 1];
  args[m[1]] = next === undefined || next.startsWith('--') ? '1' : process.argv[++i];
}
// 60 frames a second, each the blend of 2 moments 1/240 s apart: a light motion blur (a
// quarter-frame shutter), so fast moves read as smooth rather than as steps or double images.
const FILM_NAME = args.film ?? 'launch';
const filmDir = resolve(here, '..', FILM_NAME);
const PROMPTER = args.prompter !== undefined;
const TAKE = args.take ? JSON.parse(readFileSync(resolve(args.take), 'utf8')) : null;
// The prompter version is only for you to read from: 30 fps is plenty.
const FPS = Number(args.fps ?? (PROMPTER ? 30 : 60));
const SUB = Number(args.sub ?? (PROMPTER ? 1 : 2));
const ENV_RATE = 30;
const W = 1920;
const H = 1080;
const out = resolve(args.out ?? join(root, `docs/${FILM_NAME}${PROMPTER ? '-prompter' : ''}.mp4`));
const work = resolve(args.work ?? join(root, `release/${FILM_NAME}${PROMPTER ? '-prompter' : TAKE ? '-take' : ''}-work`));
mkdirSync(work, { recursive: true });

// ---- the voices ----
function readWav(file) {
  const b = readFileSync(file);
  let p = 12;
  let fmt = null;
  let data = null;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  const n = data.length / (fmt.bits / 8) / fmt.channels;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * fmt.channels * (fmt.bits / 8);
    s[i] = fmt.format === 3 ? data.readFloatLE(o) : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : data.readInt32LE(o) / 2147483648;
  }
  return { rate: fmt.rate, s };
}
const SR = 48_000;
function resample({ rate, s }) {
  if (rate === SR) return s;
  const n = Math.floor((s.length * SR) / rate);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * rate) / SR;
    const a = Math.floor(x);
    o[i] = (s[a] ?? 0) + ((s[a + 1] ?? 0) - (s[a] ?? 0)) * (x - a);
  }
  return o;
}
const VO_DIR = join(filmDir, 'vo');
const voices = {};
const VO_DUR = {};
const VO_ENV = {};
const LINE_IDS = [...readFileSync(join(filmDir, 'film.js'), 'utf8').matchAll(/\{ id: '(\w+)', who: '\w+', at: [\d.]+, text: '/g)].map((m) => m[1]);
for (const f of LINE_IDS) {
  const file = join(VO_DIR, `${f}.wav`);
  if (!existsSync(file)) throw new Error(`Missing ${file}: run python3 scripts/demo/launch/tts.py ${FILM_NAME === 'launch' ? '' : FILM_NAME} first`);
  const s = resample(readWav(file));
  voices[f] = s;
  VO_DUR[f] = s.length / SR;
  // Loudness, 30 times a second (the coach's bars move with it).
  const step = SR / ENV_RATE;
  const env = [];
  for (let i = 0; i < s.length; i += step) {
    let sum = 0;
    for (let j = i; j < Math.min(s.length, i + step); j++) sum += s[j] * s[j];
    env.push(Math.sqrt(sum / step));
  }
  const peak = Math.max(...env) || 1;
  VO_ENV[f] = env.map((x) => +(x / peak).toFixed(3));
}

// ---- a tiny server: the film, the bomb clip, and the app's own CSS, fonts and icon ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
function fileFor(path) {
  if (path.startsWith('/launch/')) return join(here, path.slice(8));
  if (path.startsWith('/film/')) return join(filmDir, path.slice(6));
  if (path.startsWith('/scene/')) return join(bombDir, path.slice(7));
  if (path.startsWith('/fonts/')) return join(root, 'dist/renderer/fonts', path.slice(7));
  if (path === '/icon.png') return join(root, 'assets/icon.png');
  if (path === '/phone.css') return join(root, 'src/phone/phone.css');
  if (path.startsWith('/dist/') || path.startsWith('/assets/')) return join(root, path);
  return null;
}
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.includes('..') ? null : fileFor(path);
  if (!file || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// Who's who in the bomb scenes: the launch film bombs Sam; in the walkthrough, Sam bombs you.
const QUERY = {
  launch: { wide: '1', me: 'Grace', them: 'Sam', line: 'Your investors can hear you scrolling.', goal: 'Investor update', mygoal: 'Pitch deck' },
  walkthrough: { me: 'Sam', them: 'Grace', pronoun: 'she', crew: 'Friends', line: 'Your investors can hear you scrolling.', goal: 'Investor update', mygoal: 'Pitch deck' },
}[FILM_NAME] ?? {};
const q = new URLSearchParams({ ...QUERY, ...(PROMPTER ? { prompter: '1' } : {}), ...(TAKE ? { take: '1' } : {}) });
await page.goto(`http://127.0.0.1:${port}/film/index.html?${q}`, { waitUntil: 'load' });
await page.waitForFunction(() => {
  if (window.ready) return window.ready();
  const b = document.getElementById('bomb').contentWindow;
  const bm = b?.document.getElementById('macFrame')?.contentWindow;
  return !!(window.render && b?.render && bm?.render && b.document.getElementById('phoneFrame')?.contentWindow?.render && document.getElementById('mac').contentWindow?.render && document.getElementById('coach').contentWindow?.render);
}, null, { timeout: 30_000 });
if (TAKE) {
  await page.evaluate((tk) => window.applyTake(tk), TAKE);
  await page.waitForFunction(() => window.ready(), null, { timeout: 30_000 });
}
const WARM = await page.evaluate(() => window.FILM.WARM ?? [1, 3, 5, 8, 12, 14, 18, 23, 30, 31, 34, 38, 42, 45, 49, 52, 58, 63, 66]);
await page.evaluate(async ({ dur, env, warm }) => {
  window.VO_DUR = dur;
  window.VO_ENV = env;
  const docs = [];
  const walk = (d) => {
    docs.push(d);
    for (const f of d.querySelectorAll('iframe')) if (f.contentDocument) walk(f.contentDocument);
  };
  walk(document);
  for (const t of warm) window.render(t);
  for (const d of docs) {
    await Promise.all(['900 40px "Big Shoulders Display"', '800 40px "Big Shoulders Display"', '400 16px "Public Sans"', '600 16px "Public Sans"', '700 16px "Public Sans"'].map((f) => d.fonts.load(f).catch(() => null)));
    await d.fonts.ready;
    await Promise.all([...d.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
  }
}, { dur: VO_DUR, env: VO_ENV, warm: WARM });
const FILM = await page.evaluate(() => window.FILM);

if (args.stills) {
  for (const t of args.stills.split(',').map(Number)) {
    await page.evaluate((x) => window.render(x), t);
    await page.screenshot({ path: join(work, `still-${t.toFixed(2)}.jpg`), type: 'jpeg', quality: 92 });
  }
  await browser.close();
  server.close();
  if (errors.length) console.warn('page errors:', errors);
  console.log(`stills in ${work}`);
  process.exit(0);
}

// ---- frames, one encoded file per chunk ----
const cuts = FILM.CUTS ?? [0, 5.35, 12.2, 21.2, 30.5, 39.65, 48.7, 56.85, 61.9, FILM.LENGTH];
// Frame numbers here count the moments drawn (FPS x SUB a second).
const chunks = cuts.slice(0, -1).map((a, i) => [Math.round(a * FPS * SUB), Math.round(cuts[i + 1] * FPS * SUB)]);
const only = args.only !== undefined ? Number(args.only) : null;
for (const [i, [f0, f1]] of chunks.entries()) {
  const file = join(work, `chunk-${String(i).padStart(2, '0')}.mp4`);
  if (only !== null ? i !== only : existsSync(file) && args.fresh === undefined) continue;
  const tmp = join(work, `chunk-${String(i).padStart(2, '0')}.part.mp4`);
  const blend = SUB > 1 ? ['-vf', `tmix=frames=${SUB},fps=${FPS}`] : [];
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS * SUB), '-c:v', 'mjpeg', '-i', '-', ...blend, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((r) => ff.on('exit', r));
  for (let f = f0; f < f1; f++) {
    // ffmpeg's tmix blends drawn moments SUB*k-SUB+1 .. SUB*k into output frame k (the fps filter
    // keeps every SUB-th), so moment f belongs to frame ceil(f / SUB), spread over the quarter
    // frame before it.
    const k = Math.ceil(f / SUB);
    const j = SUB * k - f;
    const shutter = SUB > 1 ? ((0.25 / FPS) * j) / (SUB - 1) : 0;
    await page.evaluate((t) => window.render(t), Math.max(0, k / FPS - shutter));
    const jpg = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  const code = await done;
  if (code !== 0) throw new Error(`ffmpeg failed on chunk ${i}`);
  renameSync(tmp, file);
  console.log(`chunk ${i}: ${((f1 - f0) / (FPS * SUB)).toFixed(2)}s`);
}
await browser.close();
server.close();
if (errors.length) console.warn('page errors:', [...new Set(errors)].slice(0, 5));

writeFileSync(join(work, 'chunks.txt'), chunks.map((_, i) => `file 'chunk-${String(i).padStart(2, '0')}.mp4'`).join('\n') + '\n');
const video = join(work, 'video.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(work, 'chunks.txt'), '-c', 'copy', video]);

// ---- sound (in film time; the prompter's countdown goes in front at the end) ----
const PRE = FILM.PRE ?? 0;
const PACE = FILM.PACE ?? 1;
const N = Math.ceil((FILM.LENGTH - PRE) * SR);
const bombWav = join(work, 'bomb.wav');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(root, 'docs/bomb-demo-wide.mp4'), '-vn', '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', bombWav]);
const bombAudio = readWav(bombWav).s;

function voTrack(skip) {
  const buf = new Float32Array(N);
  for (const v of FILM.VO) {
    if (skip.includes(v.who)) continue;
    const s = voices[v.id];
    const g = v.who === 'coach' ? 1.0 : v.who === 'sam' ? 0.85 : 0.95;
    const o = Math.round(v.at * SR);
    for (let i = 0; i < s.length && o + i < N; i++) buf[o + i] += s[i] * g;
  }
  return buf;
}
const sfx = sfxTrack(FILM, N);
const music = musicTrack(FILM, N);
const bomb = new Float32Array(N);
for (const [at, from, len] of FILM.BOMB_AUDIO) {
  const o = Math.round(at * SR);
  const s0 = Math.round(from * SR);
  const n = Math.round(len * SR);
  for (let i = 0; i < n && o + i < N; i++) {
    const fade = Math.min(1, i / (0.03 * SR), (n - i) / (0.06 * SR));
    bomb[o + i] += (bombAudio[s0 + i] ?? 0) * fade;
  }
}

function mix(skip) {
  const vo = voTrack(skip);
  const buf = new Float32Array(N);
  // The music ducks under the voices (all of them, so both cuts have the same music).
  let duck = 1;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const speaking = FILM.VO.some((v) => t >= v.at - 0.08 && t < v.at + (v.dur ?? VO_DUR[v.id] * (v.who === 'you' ? PACE : 1)) + 0.12);
    const target = speaking ? 0.42 : 1;
    duck += (target - duck) * (target < duck ? 0.0009 : 0.00012);
    let g = args.music === 'only' ? 1 : duck;
    if (args.music !== 'only') for (const [a, b, gg] of FILM.MUSIC.duck) if (t >= a && t < b) g *= gg;
    const mus = args.music === 'off' ? 0 : 1;
    const rest = args.music === 'only' ? 0 : 1;
    buf[i] = (vo[i] * 1.0 + sfx[i] * 0.5 + bomb[i] * 0.65) * rest + music[i] * 0.3 * g * mus;
  }
  let peak = 0;
  for (let i = 0; i < N; i++) {
    buf[i] = Math.tanh(buf[i] * 1.1);
    peak = Math.max(peak, Math.abs(buf[i]));
  }
  const gn = peak ? 0.89 / peak : 1;
  for (let i = 0; i < N; i++) buf[i] *= gn;
  if (!PRE) return buf;
  // The countdown: a beep a second, the last one higher.
  const pre = Math.round(PRE * SR);
  const all = new Float32Array(pre + N);
  for (let b = 0; b < Math.round(PRE); b++) {
    const f = b === Math.round(PRE) - 1 ? 1320 : 880;
    for (let i = 0; i < 0.12 * SR; i++) all[b * SR + i] = Math.sin((2 * Math.PI * f * i) / SR) * 0.35 * Math.min(1, i / 200, (0.12 * SR - i) / 400);
  }
  all.set(buf, pre);
  return all;
}

const MIXES = FILM.MIXES ?? [{ suffix: '', skip: [] }, { suffix: '-your-voice', skip: ['narrator'] }];
for (const { suffix, skip } of PROMPTER ? MIXES.slice(0, 1) : MIXES) {
  const file = out.replace(/\.mp4$/, `${PROMPTER ? '' : suffix}.mp4`);
  const wav = args.wav ? resolve(args.wav) : join(work, `mix${suffix}.wav`);
  writeFileSync(wav, toWav(mix(skip)));
  if (args.wav) {
    console.log(wav);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file.replace(/\.mp4$/, '.part.mp4');
  // Tame the booms, then bring it up to social-video loudness (-14 LUFS).
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', 'acompressor=threshold=-20dB:ratio=4:attack=5:release=150,loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp]);
  renameSync(tmp, file);
  console.log(`${file} (${(statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
}
if (!process.env.LOCKIN_KEEP_WORK) rmSync(join(work, 'bomb.wav'), { force: true });

// -----------------------------------------------------------------------------
// Sound effects and music, synthesized.

function synth(n) {
  const buf = new Float32Array(n);
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const add = (at, dur, fn) => {
    const s0 = Math.floor(at * SR);
    const len = Math.floor(dur * SR);
    for (let i = 0; i < len && s0 + i < n; i++) if (s0 + i >= 0) buf[s0 + i] += fn(i / SR, i / len);
  };
  const tone = (at, dur, freq, gain, { type = 'sine', attack = 0.005, decay = 6, lp = 0 } = {}) => {
    let ph = 0;
    let y = 0;
    add(at, dur, (t) => {
      ph += (2 * Math.PI * (typeof freq === 'function' ? freq(t) : freq)) / SR;
      let w = type === 'square' ? Math.sign(Math.sin(ph)) : type === 'saw' ? ((ph / Math.PI) % 2) - 1 : type === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph);
      if (lp) w = y += lp * (w - y);
      return w * Math.min(1, t / attack) * Math.exp(-decay * t) * gain;
    });
  };
  const sweep = (at, dur, f0, f1, gain, q = 0.7) => {
    let low = 0;
    let band = 0;
    add(at, dur, (_t, k) => {
      const f = 2 * Math.sin((Math.PI * (f0 + (f1 - f0) * k)) / SR);
      const high = rand() - low - q * band;
      band += f * high;
      low += f * band;
      return band * gain * Math.sin(Math.PI * k) ** 1.5;
    });
  };
  const noise = (at, dur, gain, decay, lpk = 0.3) => {
    let y = 0;
    add(at, dur, (t) => (y += lpk * (rand() - y)) * gain * Math.exp(-decay * t));
  };
  return { buf, rand, add, tone, sweep, noise };
}

function sfxTrack(F, n) {
  const x = synth(n);
  for (const e of F.SFX) {
    const at = e.at;
    switch (e.kind) {
      case 'whoosh': x.sweep(at - 0.12, 0.38, 300, 3800, 0.7); break;
      case 'swish': x.sweep(at, 0.25, 2600, 900, 0.45); break;
      case 'click': x.add(at, 0.01, (_t, k) => x.rand() * 0.5 * (1 - k)); x.tone(at, 0.03, 2400, 0.15, { decay: 120 }); break;
      case 'blip': x.tone(at, 0.12, 1568, 0.18, { decay: 22 }); x.tone(at + 0.08, 0.16, 2093, 0.14, { decay: 18 }); break;
      case 'toast': x.tone(at, 0.4, 1319, 0.16, { decay: 9 }); x.tone(at + 0.07, 0.45, 1760, 0.13, { decay: 8 }); break;
      case 'slam':
        // The referee's buzzer and a thud.
        x.tone(at, 0.9, (t) => 40 + 60 * Math.exp(-t * 8), 0.9, { attack: 0.002, decay: 4 });
        x.noise(at, 0.4, 0.9, 9, 0.15);
        x.tone(at + 0.02, 0.7, 220, 0.12, { type: 'square', decay: 1.5, lp: 0.08 });
        x.tone(at + 0.02, 0.7, 233, 0.12, { type: 'square', decay: 1.5, lp: 0.08 });
        break;
      case 'pluck': {
        const f = [523, 659, 784][e.n ?? 0];
        x.tone(at, 0.5, f, 0.2, { type: 'triangle', decay: 7 });
        x.tone(at, 0.4, f * 2, 0.06, { decay: 10 });
        x.add(at, 0.02, (_t, k) => x.rand() * 0.15 * (1 - k));
        break;
      }
      case 'type':
        for (let t = at; t < e.until; t += 0.07 + ((t * 1000) % 5) * 0.008) {
          x.add(t, 0.005, (_t, k) => x.rand() * 0.22 * (1 - k));
          x.tone(t, 0.02, 3100 + ((t * 997) % 400), 0.05, { decay: 160 });
        }
        break;
      case 'denied':
        // A cartoon "nope": two low square bonks.
        x.tone(at, 0.16, 196, 0.22, { type: 'square', decay: 9, lp: 0.12 });
        x.tone(at + 0.14, 0.22, 147, 0.22, { type: 'square', decay: 7, lp: 0.12 });
        x.tone(at, 0.25, (t) => 70 + 40 * Math.exp(-t * 20), 0.5, { decay: 10 });
        break;
      case 'chime': [[0, 1047], [0.16, 1319], [0.32, 1568], [0.48, 2093]].forEach(([d, f]) => x.tone(at + d, 1.0, f, 0.15, { attack: 0.01, decay: 4 })); break;
      case 'fuse':
        x.add(at, e.until - at, (t) => {
          const crackle = x.rand() > 0.992 ? x.rand() * 0.6 : 0;
          return (x.rand() * 0.025 + crackle * 0.2) * Math.min(1, t / 0.2);
        });
        break;
      case 'whistle': {
        const d = e.until - at;
        x.tone(at, d, (t) => 2600 - 1900 * (t / d), 0.1, { attack: 0.05, decay: -1.2 });
        break;
      }
      case 'boom':
        x.tone(at, 1.6, (t) => 30 + 70 * Math.exp(-t * 6), 1.2, { attack: 0.002, decay: 2.6 });
        x.noise(at, 1.2, 4.2, 4, 0.1);
        for (let i = 0; i < 22; i++) x.add(at + 0.08 + ((i * 0.041) % 0.8), 0.012, (_t, k) => x.rand() * 0.25 * (1 - k));
        break;
      case 'flick': x.sweep(at - 0.02, 0.13, 3600, 1500, 0.28); break;
      case 'alert': x.tone(at, 0.3, 740, 0.16, { decay: 9 }); x.tone(at + 0.09, 0.4, 554, 0.14, { decay: 7 }); break;
      case 'tick': x.tone(at, 0.09, 2637, 0.14, { decay: 30 }); x.tone(at + 0.05, 0.09, 3520, 0.08, { decay: 34 }); break;
      case 'scratch':
        // The needle dragged back and forth across the record.
        x.sweep(at, 0.11, 3000, 500, 1.4, 0.3);
        x.sweep(at + 0.1, 0.2, 450, 3200, 1.2, 0.3);
        x.noise(at, 0.32, 0.3, 10, 0.7);
        x.tone(at, 0.25, (t) => 160 - 100 * t, 0.3, { type: 'saw', decay: 9, lp: 0.1 });
        break;
      case 'rewind': {
        // Tape whirring backwards: a rising whine, chipmunk chatter and hiss.
        const d = e.until - at;
        x.tone(at, d, (t) => 300 + 1500 * (t / d), 0.1, { type: 'saw', attack: 0.04, decay: -0.6, lp: 0.06 });
        for (let t = 0; t < d - 0.03; t += 0.038 + ((t * 1000) % 7) * 0.003) {
          const f = 700 + ((t * 7919) % 1500);
          x.tone(at + t, 0.035, f * (1 + t / d), 0.07 + ((t * 313) % 5) * 0.012, { type: 'square', attack: 0.004, decay: 25, lp: 0.2 });
        }
        x.add(at, d, (_t, k) => x.rand() * 0.035 * Math.sin(Math.PI * k));
        break;
      }
      case 'clunk':
        x.add(at, 0.012, (_t, k) => x.rand() * 0.6 * (1 - k));
        x.tone(at, 0.14, 95, 0.45, { decay: 28 });
        x.tone(at + 0.06, 0.05, 1900, 0.06, { decay: 80 });
        break;
      case 'zip':
        x.sweep(at - 0.05, e.until - at + 0.1, 500, 4200, 0.6);
        for (let t = at; t < e.until; t += 0.055) x.sweep(t, 0.07, 3800, 1800, 0.15);
        break;
      case 'sting':
        // Dun, dun, DUN: brass (two detuned saws an octave over a sine) and a timpani on the last.
        [[0, 147, 0.22], [0.25, 147, 0.22], [0.5, 139, 1.3]].forEach(([d, f, len]) => {
          const vib = (t) => f * (1 + (len > 1 ? 0.012 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3) : 0));
          for (const det of [1, 1.006, 2.003]) x.tone(at + d, len + 0.25, (t) => vib(t) * det, det > 2 ? 0.07 : 0.16, { type: 'saw', attack: 0.012, decay: len > 1 ? 1.4 : 5, lp: 0.07 });
          x.tone(at + d, len + 0.25, (t) => vib(t) / 2, 0.22, { attack: 0.01, decay: len > 1 ? 1.6 : 5 });
        });
        x.tone(at + 0.5, 1.2, (t) => 62 + 30 * Math.exp(-t * 7), 0.75, { attack: 0.003, decay: 3 });
        x.noise(at + 0.5, 0.3, 0.35, 12, 0.12);
        break;
      case 'womp':
        // The sad trombone: four notes down, the last one wobbling.
        [[0, 233, 0.3], [0.32, 220, 0.3], [0.64, 208, 0.3], [0.96, 196, 1.0]].forEach(([d, f, len]) => {
          let ph = 0;
          let y = 0;
          x.add(at + d, len, (t) => {
            const fr = f * (1 + (len > 0.5 ? 0.035 * Math.sin(2 * Math.PI * 6 * t) * Math.min(1, t / 0.15) : 0)) * (1 - 0.03 * (t / len));
            ph += (2 * Math.PI * fr) / SR;
            const w = ((ph / Math.PI) % 2) - 1;
            const open = 0.025 + 0.11 * Math.sin(Math.PI * Math.min(1, t / Math.min(len, 0.35)));
            y += open * (w - y);
            return y * 0.5 * Math.min(1, t / 0.025) * Math.min(1, (len - t) / 0.08);
          });
        });
        break;
      default: break;
    }
  }
  return x.buf;
}

// A cheeky little groove (112 BPM, C minor): kick, clap, hats, a plucky bass and chord stabs.
function musicTrack(F, n) {
  const x = synth(n);
  const beat = 60 / 112;
  const bar = beat * 4;
  const start = F.MUSIC.start;
  const end = F.MUSIC.end;
  const BASS = [[48, 0, 0.5], [48, 1.5, 0.25], [51, 2, 0.5], [53, 3, 0.25], [55, 3.5, 0.25], [43, 4, 0.5], [43, 5.5, 0.25], [46, 6, 0.5], [48, 7, 0.5]];
  const CHORDS = [[60, 63, 67, 70], [60, 63, 67, 70], [56, 60, 63, 67], [58, 62, 65, 70]];
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  // How loud, section by section (film.js says), and where the claps and stabs come in.
  const level = (t) => F.MUSIC.levels.filter(([a]) => t >= a).pop()?.[1] ?? 1;
  const busy = (t) => F.MUSIC.busy.some(([a, b]) => t >= a && t < b);
  for (let b = 0; start + b * bar < end; b++) {
    const t0 = start + b * bar;
    for (let k = 0; k < 8; k++) {
      const t = t0 + k * (beat / 2);
      if (t >= end) break;
      const L = level(t);
      // Kick on 1 and 3, and the "and" of 3 every other bar; clap on 2 and 4.
      if (k === 0 || k === 4 || (k === 5 && b % 2)) x.tone(t, 0.35, (s) => 45 + 120 * Math.exp(-s * 28), 0.9 * L, { attack: 0.002, decay: 9 });
      if (busy(t) && (k === 2 || k === 6)) {
        x.noise(t, 0.18, 0.55 * L, 22, 0.5);
        x.noise(t + 0.012, 0.15, 0.35 * L, 26, 0.6);
      }
      // Hats on every eighth, open on the last.
      x.add(t, k === 7 ? 0.12 : 0.04, (s) => {
        const r = x.rand();
        return (r - (x._h = 0.6 * (x._h ?? 0) + 0.4 * r)) * 0.22 * L * Math.exp(-s * (k === 7 ? 20 : 70));
      });
    }
    // Bass, two-bar phrase.
    for (const [note, at, len] of BASS) {
      const t = t0 + (at % 4) * beat;
      if (Math.floor(at / 4) !== b % 2 || t >= end) continue;
      x.tone(t, len * beat * 1.8, hz(note - 12), 0.3 * level(t), { type: 'saw', decay: 3.2, lp: 0.03 });
      x.tone(t, len * beat * 1.8, hz(note - 24), 0.25 * level(t), { decay: 3 });
    }
    // Stabs on the off-beats.
    if (busy(t0)) {
      const ch = CHORDS[b % 4];
      for (const at of [0.5, 1.75, 2.5, 3.5]) {
        const t = t0 + at * beat;
        if (t >= end) continue;
        for (const m of ch) x.tone(t, 0.22, hz(m), 0.045 * level(t), { type: 'square', decay: 16, lp: 0.12 });
      }
    }
  }
  // Cut dead at each of film.js's cuts (the record scratch, the card slam, "It is."), then
  // softly back in; dead at the boom.
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let g = Math.min(1, Math.max(0, (t - start) / 0.05));
    for (const [a, b, back] of F.MUSIC.cuts) if (t >= a && t < b + back) g *= t < b ? Math.max(0, 1 - (t - a) / 0.012) : (t - b) / back;
    if (t >= end) g *= Math.max(0, 1 - (t - end) / 0.012);
    x.buf[i] *= g;
  }
  return x.buf;
}

function toWav(buf) {
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
