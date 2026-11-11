// Zips dist/extension for the Chrome Web Store: release/Lock-In-Extended-<version>.zip.
// Run with `npm run extension:zip` (it builds first).
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const root = new URL('..', import.meta.url).pathname;
const dir = join(root, 'dist/extension');
const { version, name } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

const files = {};
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (!f.startsWith('.') && !f.endsWith('.map')) files[relative(dir, p)] = [readFileSync(p), { mtime: new Date('2026-01-01T00:00:00Z') }];
  }
};
walk(dir);

mkdirSync(join(root, 'release'), { recursive: true });
const out = join(root, 'release', `${name.replace(/\s+/g, '-')}-${version}.zip`);
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`${relative(root, out)}: ${Object.keys(files).length} files, ${(statSync(out).size / 1024).toFixed(0)} KB`);
