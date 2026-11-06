// Records the bomb clip (about 11 seconds, 30 fps, with sound): vertical 1080x1920 to
// docs/bomb-demo.mp4, or with --wide, landscape 1920x1080 (for X/Twitter) to docs/bomb-demo-wide.mp4.
//
//   node scripts/demo/bomb/record.mjs
//   node scripts/demo/bomb/record.mjs --wide
//   node scripts/demo/bomb/record.mjs --me Grace --them Sam --line "Close it. Whatever it is. Close it."
//
// Options: --me (who throws), --them (who gets bombed), --pronoun he|she, --line, --where
// (the distraction), --goal (what they lock in on), --mygoal, --crew, --out (an .mp4 path).
// --stills 1,4.5,9.5 saves just those moments as PNGs next to --out, to check a change quickly.
// Needs Playwright's Chromium and ffmpeg. Every frame is drawn from a time t (index.html's
// render), so the clip comes out the same every time; the sound is made here, in code.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const require = createRequire(import.meta.url);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = /^--(\w+)$/.exec(process.argv[i]);
  if (!m) continue;
  const next = process.argv[i + 1];
  args[m[1]] = next === undefined || next.startsWith('--') ? '1' : process.argv[++i];
}
const wide = !!args.wide;
const SIZE = wide ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
const out = resolve(args.out ?? join(root, wide ? 'docs/bomb-demo-wide.mp4' : 'docs/bomb-demo.mp4'));
const query = new URLSearchParams(Object.entries(args).filter(([k]) => ['me', 'them', 'pronoun', 'line', 'where', 'goal', 'mygoal', 'crew', 'wide'].includes(k))).toString();

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is needed: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg is needed (on a Mac: brew install ffmpeg).');
  process.exit(1);
}
if (!existsSync(join(root, 'dist/renderer/overlay.css'))) execSync('npm run build', { cwd: root, stdio: 'inherit' });

// ---- a tiny server: the scene, plus the app's own CSS, fonts and icons ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
function fileFor(path) {
  if (path.startsWith('/scene/')) return join(here, path.slice(7));
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

// ---- frames ----
const FPS = 30;
const work = mkdtempSync(join(tmpdir(), 'lockin-bomb-'));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/scene/index.html${query ? `?${query}` : ''}`, { waitUntil: 'load' });
// Every frame (and the card inside her Mac) loaded, fonts in, each part drawn once.
await page.waitForFunction(() => {
  const mac = document.getElementById('macFrame').contentWindow;
  return !!(mac?.render && document.getElementById('phoneFrame').contentWindow?.render && mac.document.getElementById('cardFrame')?.contentWindow?.render);
}, null, { timeout: 20_000 });
await page.evaluate(async () => {
  const docs = [document, document.getElementById('macFrame').contentDocument, document.getElementById('phoneFrame').contentDocument];
  docs.push(docs[1].getElementById('cardFrame').contentDocument);
  for (const t of [1, 3, 5, 7, 9.5]) window.render(t);
  for (const d of docs) {
    await Promise.all(['900 40px "Big Shoulders Display"', '800 40px "Big Shoulders Display"', '400 16px "Public Sans"', '600 16px "Public Sans"', '700 16px "Public Sans"'].map((f) => d.fonts.load(f).catch(() => null)));
    await d.fonts.ready;
    await Promise.all([...d.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
  }
});
if (args.stills) {
  mkdirSync(dirname(out), { recursive: true });
  for (const t of args.stills.split(',').map(Number)) {
    await page.evaluate((x) => window.render(x), t);
    await page.screenshot({ path: out.replace(/\.mp4$/, '') + `-${t.toFixed(2)}.png` });
  }
  await browser.close();
  server.close();
  if (errors.length) console.warn('page errors:', errors);
  console.log('stills saved');
  process.exit(0);
}
const length = await page.evaluate(() => window.LOCKIN_BOMB.B.length);
const frames = Math.round(length * FPS);
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => window.render(t), f / FPS);
  await page.screenshot({ path: join(work, `f${String(f).padStart(4, '0')}.png`) });
  if (f % 30 === 0) process.stdout.write(`\rframes ${f}/${frames}`);
}
process.stdout.write(`\rframes ${frames}/${frames}\n`);
const B = await page.evaluate(() => window.LOCKIN_BOMB.B);
await browser.close();
server.close();
if (errors.length) console.warn('page errors:', errors);

// ---- sound ----
writeFileSync(join(work, 'sfx.wav'), wav(sfx(B, length)));

mkdirSync(dirname(out), { recursive: true });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(work, 'f%04d.png'), '-i', join(work, 'sfx.wav'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
if (process.env.LOCKIN_KEEP_FRAMES) console.log(`frames kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
console.log(`${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);

// -----------------------------------------------------------------------------
// The sound, synthesized: swipes, taps, the whistle, the boom, Lock In's buzzer and chime.

function sfx(B, seconds) {
  const SR = 48_000;
  const buf = new Float32Array(Math.ceil(seconds * SR));
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const add = (at, dur, fn) => {
    const s0 = Math.floor(at * SR);
    const n = Math.floor(dur * SR);
    for (let i = 0; i < n && s0 + i < buf.length; i++) if (s0 + i >= 0) buf[s0 + i] += fn(i / SR, i / n);
  };
  // Noise through a swept band-pass (state-variable filter).
  const sweep = (at, dur, f0, f1, gain, q = 0.7) => {
    let lp = 0;
    let bp = 0;
    add(at, dur, (_t, k) => {
      const f = 2 * Math.sin((Math.PI * (f0 + (f1 - f0) * k)) / SR);
      const hp = rand() - lp - q * bp;
      bp += f * hp;
      lp += f * bp;
      return bp * gain * Math.sin(Math.PI * k) ** 1.5;
    });
  };
  const tone = (at, dur, freq, gain, { type = 'sine', attack = 0.005, decay = 6 } = {}) => {
    let ph = 0;
    add(at, dur, (t) => {
      ph += (2 * Math.PI * (typeof freq === 'function' ? freq(t) : freq)) / SR;
      const w = type === 'square' ? Math.sign(Math.sin(ph)) : type === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(ph)) : Math.sin(ph);
      const env = Math.min(1, t / attack) * Math.exp(-decay * t);
      return w * env * gain;
    });
  };
  const tap = (at) => {
    tone(at, 0.05, 1900, 0.32, { decay: 90 });
    add(at, 0.006, () => rand() * 0.35);
  };

  // Each reel's own tinny soundtrack, cut off by the next swipe (a different loop per reel,
  // low-passed like laptop speakers). The feed goes silent when the bomb lands.
  const SCALE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2];
  const starts = [0, ...B.swipes.map((x) => x + 0.06)];
  starts.forEach((st, i) => {
    const end = Math.min(B.swipes[i] ?? B.impact, B.impact) + 0.02;
    if (end <= st) return;
    const root = [220, 262, 196, 247, 174, 294, 233, 208, 277, 185][i % 10];
    const step = [0.12, 0.1, 0.15, 0.09, 0.13, 0.11, 0.1, 0.14, 0.12, 0.1][i % 10];
    const local = new Float32Array(Math.ceil((end - st) * SR));
    for (let n = 0; n * step < end - st; n++) {
      const f = root * SCALE[(n * (i + 2) + i) % SCALE.length] * (n % 4 === 3 ? 2 : 1);
      const s0 = Math.floor(n * step * SR);
      let ph = 0;
      for (let j = 0; j < step * 0.9 * SR && s0 + j < local.length; j++) {
        ph += (2 * Math.PI * f) / SR;
        const w = i % 2 ? Math.sign(Math.sin(ph)) * 0.6 : (2 / Math.PI) * Math.asin(Math.sin(ph));
        local[s0 + j] += w * Math.exp((-j / SR) * 18) * 0.5;
      }
      if (i % 3 !== 1 && n % 2 === 0) {
        let kp = 0;
        for (let j = 0; j < 0.12 * SR && s0 + j < local.length; j++) {
          kp += (2 * Math.PI * (55 + 90 * Math.exp((-j / SR) * 30))) / SR;
          local[s0 + j] += Math.sin(kp) * Math.exp((-j / SR) * 22) * 0.9;
        }
      }
    }
    let lp = 0;
    const s0 = Math.floor(st * SR);
    for (let j = 0; j < local.length && s0 + j < buf.length; j++) {
      lp += 0.18 * (local[j] - lp);
      const fade = Math.min(1, j / (0.01 * SR), (local.length - j) / (0.01 * SR));
      buf[s0 + j] += lp * 0.16 * fade;
    }
  });
  B.swipes.forEach((x, i) => sweep(x - 0.03, B.swipeDur[i] + 0.1, 600, 3400, 0.75));

  // Whip pan to your phone, then the taps
  sweep(B.toPhone[0] - 0.05, 0.42, 200, 2600, 1.0);
  tap(B.tapBomb);
  sweep(B.sheetUp[0], 0.22, 900, 2400, 0.4);
  tap(B.tapChip);
  tap(B.tapThrow);

  // The bomb: pops out (bloop), fuse fizzing, wind-up, WHOOSH, a falling whistle
  tone(B.pop, 0.16, (t) => 280 + 5200 * t, 0.4, { attack: 0.003, decay: 14 });
  add(B.pop, B.impact - B.pop, () => {
    const crackle = rand() > 0.985 ? rand() * 0.5 : 0;
    return rand() * 0.035 + crackle * 0.25;
  });
  tone(B.windup[0], B.windup[1] - B.windup[0], (t) => 520 - 900 * t, 0.16, { attack: 0.01, decay: 4 });
  sweep(B.launch - 0.02, 0.45, 150, 3200, 1.3, 0.5);
  const [f0, f1] = B.flight;
  const fl = f1 - f0 - 0.12;
  tone(f0 + 0.12, fl, (t) => 2200 - 1500 * (t / fl), 0.06, { attack: 0.08, decay: -1.6 });
  // "!": he spots it
  tone(B.notice, 0.18, 1760, 0.14, { decay: 18 });
  tone(B.notice + 0.07, 0.2, 2637, 0.12, { decay: 16 });

  // KABOOM: a boom, a noise blast, debris, then the app's buzzer (two square waves, low-passed)
  const hit = B.impact;
  tone(hit, 1.5, (t) => 30 + 70 * Math.exp(-t * 6), 1.1, { attack: 0.002, decay: 2.8 });
  {
    let lp = 0;
    add(hit, 1.0, (t) => {
      lp += 0.1 * (rand() - lp);
      return lp * 3.8 * Math.exp(-t * 4.5);
    });
  }
  for (let i = 0; i < 26; i++) {
    const at = hit + 0.08 + ((i * 0.037) % 0.7) + (i % 5) * 0.011;
    add(at, 0.012, (_t, k) => rand() * 0.22 * (1 - k));
  }
  {
    let lp = 0;
    add(hit + 0.05, 0.8, (t) => {
      const a = Math.sign(Math.sin(2 * Math.PI * 110 * t)) + Math.sign(Math.sin(2 * Math.PI * 116 * t));
      lp += 0.21 * (a - lp); // about 1.8 kHz
      const env = Math.min(1, t / 0.01) * Math.min(1, (0.8 - t) / 0.06);
      return lp * 0.11 * env;
    });
  }
  // The countdown
  for (const c of B.countdown.slice(1)) tone(c, 0.08, 1250, 0.18, { decay: 40 });
  tone(B.unlock, 0.12, 880, 0.12, { decay: 25 });
  // The click, then Lock In's chime (C6, E6, G6)
  add(B.click, 0.012, (_t, k) => rand() * 0.3 * (1 - k));
  [[0, 1047], [0.18, 1319], [0.36, 1568]].forEach(([d, f]) => tone(B.sessionToast - 0.06 + d, 0.9, f, 0.16, { attack: 0.01, decay: 5 }));
  // Typing
  for (let at = B.typing[0]; at < B.typing[1]; at += 0.055 + ((at * 1000) % 7) * 0.006) {
    add(at, 0.005, (_t, k) => rand() * 0.16 * (1 - k));
    tone(at, 0.02, 2900 + ((at * 997) % 400), 0.05, { decay: 160 });
  }
  // Into the end card
  sweep(B.endCard[0] - 0.2, 0.4, 200, 1400, 0.4);
  tone(B.endCard[0] + 0.12, 0.8, (t) => 50 + 30 * Math.exp(-t * 9), 0.5, { attack: 0.003, decay: 6 });

  // Soft clip and normalise to -1 dB.
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.tanh(buf[i] * 1.2);
    peak = Math.max(peak, Math.abs(buf[i]));
  }
  const g = peak ? 0.89 / peak : 1;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return { SR, buf };
}

function wav({ SR, buf }) {
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, buf[i])) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
