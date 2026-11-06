#!/usr/bin/env node
// Builds the app people download: release/Lock-In-mac-arm64.zip, a self-contained
// "Lock In.app" for Apple silicon Macs.
//
//   npm run build            (the app's code)
//   npm run helper           (on a Mac: the Swift helpers; elsewhere copy them into
//                            native/mac-helper/build first, or the app runs without them)
//   node scripts/package-mac.mjs
//
// The app is Electron with Lock In's code in Contents/Resources/app. It is signed ad hoc
// (with codesign on a Mac, or rcodesign anywhere else), not with an Apple Developer ID, so
// the first time someone opens it macOS asks them to allow it in Privacy & Security.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROJ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PROJ, 'package.json'), 'utf8'));
const electronVersion = require('electron/package.json').version;
const ARCH = 'arm64';
const OUT = join(PROJ, 'release');
const WORK = join(OUT, 'work');
const APP = join(WORK, 'Lock In.app');
const ZIP = join(OUT, `Lock-In-mac-${ARCH}.zip`);
const BUNDLE_ID = 'app.lockin.desktop';
const mac = process.platform === 'darwin';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const say = (s) => console.log(`[package] ${s}`);

if (!existsSync(join(PROJ, 'dist/main/index.js'))) throw new Error('Build first: npm run build');

// 1. Electron for macOS.
const { downloadArtifact } = require('@electron/get');
const electronZip = await downloadArtifact({ version: electronVersion, platform: 'darwin', arch: ARCH, artifactName: 'electron' });
say(`Electron ${electronVersion} (${ARCH})`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
// Both keep the frameworks' symlinks.
if (mac) run('ditto', ['-x', '-k', electronZip, WORK]);
else run('unzip', ['-q', electronZip, '-d', WORK]);
renameSync(join(WORK, 'Electron.app'), APP);

// 2. Its Info.plist: name, id, version and why it asks for each permission.
const plistPath = join(APP, 'Contents/Info.plist');
let plist = readFileSync(plistPath, 'utf8');
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const setKey = (key, value) => {
  const re = new RegExp(`(<key>${key}</key>\\s*)<string>[^<]*</string>`);
  plist = re.test(plist) ? plist.replace(re, `$1<string>${xml(value)}</string>`) : plist.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t<string>${xml(value)}</string>\n</dict>\n</plist>\n`);
};
/** Removes a key and its value, a string or a (nested) dict. */
const dropKey = (key) => {
  const m = new RegExp(`\\s*<key>${key}</key>\\s*`).exec(plist);
  if (!m) return;
  let end = m.index + m[0].length;
  if (plist.startsWith('<string>', end)) end = plist.indexOf('</string>', end) + '</string>'.length;
  else if (plist.startsWith('<dict>', end)) {
    const tag = /<\/?dict>/g;
    tag.lastIndex = end;
    for (let depth = 0, t; (t = tag.exec(plist)); ) {
      depth += t[0] === '<dict>' ? 1 : -1;
      if (depth === 0) { end = tag.lastIndex; break; }
    }
  }
  plist = plist.slice(0, m.index) + plist.slice(end);
};
setKey('CFBundleName', 'Lock In');
setKey('CFBundleDisplayName', 'Lock In');
setKey('CFBundleIdentifier', BUNDLE_ID);
setKey('CFBundleShortVersionString', pkg.version);
setKey('CFBundleVersion', pkg.version);
setKey('LSApplicationCategoryType', 'public.app-category.productivity');
setKey('NSHumanReadableCopyright', 'Lock In, MIT License');
setKey('NSMicrophoneUsageDescription', 'Lock In listens only when you answer your coach.');
setKey('NSCalendarsUsageDescription', 'Lock In reads your calendar to stay quiet in meetings and plan around them. It never changes it.');
setKey('NSCalendarsFullAccessUsageDescription', 'Lock In reads your calendar to stay quiet in meetings and plan around them. It never changes it.');
setKey('NSAppleEventsUsageDescription', 'Lock In reads the open browser tab and your to-do list, and can hide a distracting app when you ask.');
dropKey('ElectronAsarIntegrity');
writeFileSync(plistPath, plist);
// Electron's helper apps leave out CFBundleExecutable (macOS guesses it); signing tools want it.
const frameworks = join(APP, 'Contents/Frameworks');
for (const helper of readdirSync(frameworks).filter((f) => f.endsWith('.app'))) {
  const p = join(frameworks, helper, 'Contents/Info.plist');
  const text = readFileSync(p, 'utf8');
  if (!text.includes('<key>CFBundleExecutable</key>')) writeFileSync(p, text.replace('<dict>', `<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>${xml(helper.replace(/\.app$/, ''))}</string>`));
}

// 3. Icon, and Lock In's code where Electron looks for it.
const res = join(APP, 'Contents/Resources');
cpSync(join(PROJ, 'assets/icon.icns'), join(res, 'electron.icns'));
rmSync(join(res, 'default_app.asar'), { force: true });
const code = join(res, 'app');
mkdirSync(code, { recursive: true });
const { name, productName, version, description, main, type, license } = pkg;
writeFileSync(join(code, 'package.json'), JSON.stringify({ name, productName, version, description, main, type, license }, null, 2));
for (const dir of ['dist', 'assets', 'extension']) cpSync(join(PROJ, dir), join(code, dir), { recursive: true });
cpSync(join(PROJ, 'node_modules/ws'), join(code, 'node_modules/ws'), { recursive: true });
const helpers = join(PROJ, 'native/mac-helper/build');
const found = existsSync(helpers) ? readdirSync(helpers).filter((f) => f.startsWith('lockin-')) : [];
if (found.length) {
  cpSync(helpers, join(code, 'native/mac-helper/build'), { recursive: true });
  for (const f of found) chmodSync(join(code, 'native/mac-helper/build', f), 0o755);
}
say(found.length ? `Helpers: ${found.join(', ')}` : 'No Swift helpers found: the app falls back to basic sensing.');
// Source maps stay out of the download.
for (const f of readdirSync(join(code, 'dist'), { recursive: true })) if (String(f).endsWith('.map')) rmSync(join(code, 'dist', String(f)));

// 4. Sign it ad hoc (Apple silicon won't run unsigned code).
if (mac) {
  run('xattr', ['-cr', APP]);
  run('codesign', ['--force', '--deep', '--sign', '-', APP]);
  run('codesign', ['--force', '--sign', '-', `-r=designated => identifier "${BUNDLE_ID}"`, APP]);
  run('codesign', ['--verify', '--deep', '--strict', APP]);
} else {
  // The same designated requirement, compiled by hand: macOS then recognizes the app by its
  // bundle id, so permissions (Accessibility, Microphone) carry over to the next version.
  const id = Buffer.from(BUNDLE_ID);
  const pad = (4 - (id.length % 4)) % 4;
  const req = Buffer.alloc(20 + id.length + pad);
  req.writeUInt32BE(0xfade0c00, 0); // a requirement
  req.writeUInt32BE(req.length, 4);
  req.writeUInt32BE(1, 8); // expression form
  req.writeUInt32BE(2, 12); // opIdent
  req.writeUInt32BE(id.length, 16);
  id.copy(req, 20);
  const reqPath = join(OUT, 'designated.req');
  writeFileSync(reqPath, req);
  const rcodesign = process.env.RCODESIGN || 'rcodesign';
  run(rcodesign, ['sign', '--code-requirements-file', `Contents/MacOS/Electron:${reqPath}`, APP], { stdio: ['ignore', 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore'] });
  rmSync(reqPath);
}
say('Signed (ad hoc)');

// 5. Zip it, keeping symlinks and permissions.
rmSync(ZIP, { force: true });
if (mac) run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', APP, ZIP]);
else run('zip', ['-qry', ZIP, 'Lock In.app'], { cwd: WORK });
say(`Done: ${ZIP}`);
