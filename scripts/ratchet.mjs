#!/usr/bin/env node
// Ratchet: known debt that may shrink but never grow.
//
// Counters live in scripts/ratchet.json:
//   { "counters": { "<name>": { "paths": ["src"], "ext": ["ts","tsx"], "pattern": "\\buseEffect\\(", "why": "..." } },
//     "baseline": { "<name>": 12 } }
// CI fails when a count exceeds its baseline. When a count drops, lower the
// baseline in the same PR: node scripts/ratchet.mjs --update
// When a counter reaches 0, make it a hard rule (lint / boundary check) and delete it.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'scripts', 'ratchet.json');
const UPDATE = process.argv.includes('--update');
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.next', 'target', 'Pods', 'DerivedData', 'vendor', '.venv', '__pycache__']);

function walk(dir, exts, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, exts, out);
        else if (exts.includes(e.name.split('.').pop())) out.push(full);
    }
    return out;
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const baseline = cfg.baseline ?? {};
const current = {};
let failed = false;
let shrank = false;

for (const [name, c] of Object.entries(cfg.counters ?? {})) {
    const re = new RegExp(c.pattern, 'gm');
    let n = 0;
    const where = [];
    for (const p of c.paths) {
        for (const f of walk(path.join(ROOT, p), c.ext)) {
            const hits = (fs.readFileSync(f, 'utf8').match(re) ?? []).length;
            if (hits) { n += hits; where.push(`${path.relative(ROOT, f)} (${hits})`); }
        }
    }
    current[name] = n;
    const base = baseline[name];
    if (base === undefined) console.log(`• ${name}: ${n} (no baseline yet)`);
    else if (n > base) { failed = true; console.error(`✗ ${name}: ${n}, baseline is ${base}. ${c.why}\n    ${where.join('\n    ')}`); }
    else if (n < base) { shrank = true; console.log(`↓ ${name}: ${n}, down from ${base}. Lower the baseline: node scripts/ratchet.mjs --update`); }
    else console.log(`• ${name}: ${n} (at baseline)`);
}

if (UPDATE) {
    cfg.baseline = current;
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`wrote ${path.relative(ROOT, CONFIG)}`);
    process.exit(0);
}
if (failed) process.exit(1);
if (shrank && process.env.CI) {
    console.error('A ratchet count went down but the baseline was not lowered. Run: node scripts/ratchet.mjs --update');
    process.exit(1);
}
console.log('✓ ratchet holds');
