import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Every channel a page invokes has to be on the preload's allow-list, or the call is refused.
test('every channel the pages use is allowed by the preload', () => {
  const preload = readFileSync('src/preload/index.ts', 'utf8');
  const allowed = new Set([...preload.slice(preload.indexOf('const INVOKE'), preload.indexOf(']);')).matchAll(/'([a-z]+:[A-Za-z]+)'/g)].map((m) => m[1]));
  const dir = 'src/renderer';
  const used = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z]+:[A-Za-z]+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 20);
  const missing = [...used].filter((c) => !allowed.has(c));
  assert.deepEqual(missing, []);
});
