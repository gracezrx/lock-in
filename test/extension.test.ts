import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mac from '../src/main/crew/code';
import * as web from '../src/extension/lib/code';

test('extension crew codes: the same topic and key as the Mac, and messages open both ways', () => {
  const code = mac.newCode();
  const a = mac.crewKeys(code)!;
  const b = web.crewKeys(code)!;
  assert.equal(b.topic, a.topic);
  assert.deepEqual(Array.from(b.key), Array.from(a.key));
  const msg = { v: 1, t: 'status', from: 'x', name: 'Sam ✨', at: 1, state: 'locked' };
  assert.deepEqual(web.open(b.key, mac.seal(a.key, msg)), msg);
  assert.deepEqual(mac.open(a.key, web.seal(b.key, msg)), msg);
  assert.equal(web.open(b.key, web.seal(b.key, msg).slice(0, -3) + 'AAA'), null);
  const wcode = web.newCode();
  assert.equal(web.formatCode(wcode), mac.formatCode(wcode));
  assert.ok(mac.codeSecret(wcode));
});
