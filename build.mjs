// Builds Lock In into dist/:
//   node build.mjs            the Mac app: main process (ESM), preload (CJS), renderer pages, phone page
//   node build.mjs extension  Lock In Extended, the Chrome extension, on its own (dist/extension)
//   node build.mjs app extension   both
// The two ship separately: the Mac app never includes the extension.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const out = join(root, 'dist');
const targets = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['app']);
for (const t of targets) if (t !== 'app' && t !== 'extension') throw new Error(`Unknown build target: ${t} (app or extension)`);

const common = { bundle: true, sourcemap: 'linked', logLevel: 'info', legalComments: 'none' };

if (targets.has('app')) {
for (const d of ['main', 'preload', 'renderer', 'phone']) rmSync(join(out, d), { recursive: true, force: true });
mkdirSync(join(out, 'renderer'), { recursive: true });

await build({
  ...common,
  entryPoints: [join(root, 'src/main/index.ts')],
  outfile: join(out, 'main/index.js'),
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron', 'ws'],
  // Some bundled libraries (tweetnacl) call require('crypto'): give the ES module a real require.
  banner: { js: "import { createRequire as __lockinRequire } from 'node:module'; const require = __lockinRequire(import.meta.url);" },
});

await build({
  ...common,
  entryPoints: [join(root, 'src/preload/index.ts')],
  outfile: join(out, 'preload/index.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
});

const pages = ['app', 'panel', 'toast', 'overlay', 'voice', 'talk'];
await build({
  ...common,
  entryPoints: pages.map((p) => join(root, `src/renderer/${p}.ts`)),
  outdir: join(out, 'renderer'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome130',
});

// The phone page, served by the Mac to your phone over Wi-Fi (Safari and Chrome on phones).
mkdirSync(join(out, 'phone'), { recursive: true });
await build({
  ...common,
  entryPoints: [join(root, 'src/phone/phone.ts')],
  outfile: join(out, 'phone/phone.js'),
  platform: 'browser',
  format: 'iife',
  target: ['safari15', 'chrome100'],
  minify: true,
});
for (const f of ['phone.html', 'phone.css']) cpSync(join(root, 'src/phone', f), join(out, 'phone', f));

// Bundle the two typefaces locally so the UI works offline.
mkdirSync(join(out, 'renderer/fonts'), { recursive: true });
const fonts = [
  ['big-shoulders-display', ['600', '800', '900']],
  ['public-sans', ['400', '500', '600', '700']],
  ['big-shoulders-stencil-display', ['700', '900']],
];
for (const [family, weights] of fonts) {
  for (const w of weights) {
    const file = `${family}-latin-${w}-normal.woff2`;
    cpSync(join(root, `node_modules/@fontsource/${family}/files/${file}`), join(out, 'renderer/fonts', file));
  }
}

// ElevenLabs audio worklets, served from the app itself (the pages' CSP allows only 'self').
mkdirSync(join(out, 'renderer/vendor'), { recursive: true });
for (const f of ['rawAudioProcessor.js', 'audioConcatProcessor.js']) {
  cpSync(join(root, 'node_modules/@elevenlabs/client/worklets', f), join(out, 'renderer/vendor', f));
}

for (const f of readdirSync(join(root, 'src/renderer'))) {
  if (f.endsWith('.html') || f.endsWith('.css')) {
    cpSync(join(root, 'src/renderer', f), join(out, 'renderer', f));
  }
}

}

// Lock In Extended, the Chrome extension: on its own it runs the same engine as the Mac app on
// Chrome's tabs; linked to the Mac app it reports tabs and drives it. Built to dist/extension
// (load it unpacked from there, or zip it with `npm run extension:zip` for the release page and
// the Chrome Web Store).
if (targets.has('extension')) {
const ext = join(out, 'extension');
rmSync(ext, { recursive: true, force: true });
mkdirSync(join(ext, 'fonts'), { recursive: true });
/** The Mac-only bits the shared engine imports, swapped for their web versions. */
const webShims = {
  name: 'lockin-web-shims',
  setup(b) {
    b.onResolve({ filter: /^(node:)?crypto$/ }, () => ({ path: join(root, 'src/extension/lib/node-crypto.ts') }));
    b.onResolve({ filter: /^\.\/code$/ }, (a) => (a.importer.endsWith(join('src/main/crew/crew.ts')) ? { path: join(root, 'src/extension/lib/code.ts') } : undefined));
  },
};
await build({
  ...common,
  sourcemap: false,
  entryPoints: ['background', 'popup', 'content', 'blocked'].map((p) => join(root, `src/extension/${p}.ts`)),
  outdir: ext,
  platform: 'browser',
  format: 'iife',
  target: 'chrome116',
  plugins: [webShims],
});
cpSync(join(root, 'src/extension/static'), ext, { recursive: true });
cpSync(join(root, 'src/extension/manifest.json'), join(ext, 'manifest.json'));
for (const [family, weights] of [['big-shoulders-display', ['800', '900']], ['public-sans', ['400', '600', '700']]]) {
  for (const w of weights) {
    const file = `${family}-latin-${w}-normal.woff2`;
    cpSync(join(root, `node_modules/@fontsource/${family}/files/${file}`), join(ext, 'fonts', file));
  }
}
}
console.log(`Build complete (${[...targets].join(' + ')}) → dist/`);
