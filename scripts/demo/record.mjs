// Records the README demo: plays scripts/demo/stage.html in Chromium and turns it into
// docs/demo.gif (for the README) and docs/demo.mp4 (for sharing).
//
//   npm run demo
//
// Needs Playwright's Chromium (npx playwright install chromium) and ffmpeg.
// The scene uses the real thing: the opening animation from src/renderer/intro.ts and the
// card from extension/background.js.
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is needed to record the demo: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg is needed to make the GIF (on a Mac: brew install ffmpeg).');
  process.exit(1);
}

if (!existsSync(join(root, 'dist/renderer/base.css'))) execSync('npm run build', { cwd: root, stdio: 'inherit' });

const intro = await build({ entryPoints: [join(root, 'src/renderer/intro.ts')], bundle: true, format: 'iife', globalName: 'LockInIntro', write: false });
const background = readFileSync(join(root, 'extension/background.js'), 'utf8');
const cardSource = background.slice(background.indexOf('function lockInCard('), background.indexOf('async function showCard'));
if (!cardSource.startsWith('function lockInCard(')) throw new Error('Could not find lockInCard in extension/background.js');

const work = mkdtempSync(join(tmpdir(), 'lockin-demo-'));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: work, size: { width: 1280, height: 800 } } });
const started = Date.now();
const page = await context.newPage();
await page.goto(pathToFileURL(join(root, 'scripts/demo/stage.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.addScriptTag({ content: intro.outputFiles[0].text });
await page.evaluate((src) => {
  window.lockInCardSource = src;
}, cardSource);
await page.waitForTimeout(800); // the two pages in the browser finish loading
const offset = (Date.now() - started) / 1000;
const length = await page.evaluate(() => {
  window.startDemo();
  return window.demoLength;
});
await page.waitForFunction(() => window.demoDone === true, null, { timeout: length + 20_000, polling: 100 });
await page.waitForTimeout(150);
const video = page.video();
await context.close();
const raw = await video.path();
await browser.close();

const out = join(root, 'docs');
mkdirSync(out, { recursive: true });
// Start a beat in, so the first frame (the README's still) is the scene, not a fade.
const cut = ['-ss', (offset + 0.35).toFixed(2), '-i', raw];
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...cut, '-vf', 'fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', join(out, 'demo.gif')]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...cut, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', '-an', join(out, 'demo.mp4')]);
rmSync(work, { recursive: true, force: true });

const mb = (f) => (statSync(join(out, f)).size / 1024 / 1024).toFixed(1);
console.log(`docs/demo.gif (${mb('demo.gif')} MB) and docs/demo.mp4 (${mb('demo.mp4')} MB)`);
