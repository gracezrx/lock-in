import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HoldSpace, holdSpaceAllowed } from '../src/main/sensors/holdspace';

const on = { on: true, self: false };

test('a hold opens Lock In in ordinary apps and sites', () => {
  assert.equal(holdSpaceAllowed({ app: 'Notion' }, on), true);
  assert.equal(holdSpaceAllowed({ app: 'Google Chrome', domain: 'youtube.com' }, on), true);
  assert.equal(holdSpaceAllowed({ app: 'Google Chrome', domain: 'docs.google.com' }, on), true);
  assert.equal(holdSpaceAllowed(null, on), true);
});

test('it stays out of apps and sites where holding space already does something', () => {
  for (const app of ['Figma', 'Adobe Photoshop 2026', 'Sketch', 'Miro', 'zoom.us', 'Discord', 'Microsoft Teams', 'Logic Pro', 'Lock In']) {
    assert.equal(holdSpaceAllowed({ app }, on), false, app);
  }
  for (const domain of ['figma.com', 'www.figma.com', 'meet.google.com', 'excalidraw.com', 'app.zoom.us']) {
    assert.equal(holdSpaceAllowed({ app: 'Google Chrome', domain }, on), false, domain);
  }
  assert.equal(holdSpaceAllowed({ app: 'Notion', inCall: true }, on), false, 'on a call');
  assert.equal(holdSpaceAllowed({ app: 'Notion' }, { on: true, self: true }), false, 'Lock In in front');
  assert.equal(holdSpaceAllowed({ app: 'Notion' }, { on: false, self: false }), false, 'setting off');
  assert.equal(holdSpaceAllowed({ app: 'Figmaster Pro' }, on), true, 'only whole names');
});

function fakeWatcher() {
  const procs: { stdin: PassThrough; stdout: PassThrough; written: string[]; proc: EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => void } }[] = [];
  const spawn = (() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: string[] = [];
    stdin.on('data', (b) => written.push(...String(b).split('\n').filter(Boolean)));
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, kill: () => proc.emit('exit', 0) });
    procs.push({ stdin, stdout, written, proc });
    return proc;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawn, procs };
}

const tick = () => new Promise((r) => setTimeout(r, 60));

test('the watcher is told when to listen, and a hold opens a conversation', async () => {
  const { spawn, procs } = fakeWatcher();
  let holds = 0;
  const hs = new HoldSpace({ bin: () => '/x/lockin-keys', spawn, onHold: () => holds++, log: () => undefined });
  hs.setIntercept(true);
  hs.setActive(true);
  assert.equal(hs.status, 'starting');
  procs[0].stdout.write('{"event":"ready"}\n');
  await tick();
  assert.equal(hs.status, 'ready');
  hs.setIntercept(true);
  hs.setIntercept(false);
  hs.setIntercept(false);
  hs.setIntercept(true);
  await tick();
  assert.deepEqual(procs[0].written, ['on', 'off', 'on'], 'only changes are sent');
  procs[0].stdout.write('{"event":"hold"}\nnot json\n{"event":"release"}\n');
  await tick();
  assert.equal(holds, 1);
  hs.stop();
  assert.equal(hs.status, 'off');
});

test('no Accessibility yet, and a missing watcher, are reported', async () => {
  const { spawn, procs } = fakeWatcher();
  const hs = new HoldSpace({ bin: () => '/x/lockin-keys', spawn, onHold: () => undefined, log: () => undefined });
  hs.setActive(true);
  procs[0].stdout.write('{"event":"error","reason":"permission"}\n');
  await tick();
  assert.equal(hs.status, 'permission');
  procs[0].stdout.write('{"event":"ready"}\n');
  await tick();
  assert.equal(hs.status, 'ready', 'allowed later: it starts listening');
  hs.stop();

  const missing = new HoldSpace({ bin: () => null, onHold: () => undefined, log: () => undefined });
  missing.setActive(true);
  assert.equal(missing.status, 'missing');
});
