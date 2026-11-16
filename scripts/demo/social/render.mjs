// The repository's social preview: scripts/demo/social/index.html at 1280x640 -> docs/social-preview.png.
// (Upload it in the repository's Settings → General → Social preview.)
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../docs/social-preview.png');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'index.html')).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
await page.screenshot({ path: out });
await browser.close();
console.log(out);
