import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, type NotifyPayload } from '../src/main/notify';
import { Guardrails } from '../src/main/guardrails';
import { migrateSettings } from '../src/main/settings';
import { newerVersion } from '../src/main/sensors/bridge';
import { CHANNELS, DEFAULT_NOTIFY, TAB_CARD_KINDS, buildDefaultProfile } from '../src/shared/templates';
import type { Channel, NotifyKind, Settings } from '../src/shared/types';

function setup(opts: { distracting: boolean; inCall?: boolean }) {
  const settings = migrateSettings({});
  settings.quietStart = '00:00';
  settings.quietEnd = '00:00';
  const shown: NotifyPayload[] = [];
  const guard = new Guardrails();
  const n = new Notifier({
    settings: () => settings,
    profile: () => buildDefaultProfile('founder'),
    guard,
    inCall: () => !!opts.inCall,
    cardBusy: () => false,
    toast: () => undefined,
    card: () => undefined,
    tabReady: () => opts.distracting,
    tab: async (p) => {
      shown.push(p);
      return true;
    },
    speak: async () => undefined,
    sound: async () => undefined,
    system: () => undefined,
    menubar: () => undefined,
    dock: () => undefined,
    http: (async () => new Response('ok')) as typeof fetch,
    log: () => undefined,
  });
  return { n, shown, guard, settings };
}

test('the Chrome card is a channel, on by default for every "lock in" moment and nothing else', () => {
  assert.ok(CHANNELS.some((c) => c.id === 'tab'));
  for (const k of Object.keys(DEFAULT_NOTIFY) as NotifyKind[]) {
    assert.equal(DEFAULT_NOTIFY[k].includes('tab'), TAB_CARD_KINDS.includes(k), k);
  }
});

test('it shows only while a distracting tab is in front, and never in a call or while muted', async () => {
  const on = setup({ distracting: true });
  const p: NotifyPayload = { kind: 'todo_roast', title: 'To-do roast', body: 'Three hours, zero tasks. Babe.' };
  assert.ok(on.n.plan(p).includes('tab'));
  await on.n.notify(p);
  assert.equal(on.shown.length, 1);
  assert.equal(on.shown[0].body, 'Three hours, zero tasks. Babe.');

  const work = setup({ distracting: false });
  assert.ok(!work.n.plan(p).includes('tab'), 'on a work tab: no card');

  const call = setup({ distracting: true, inCall: true });
  assert.ok(!call.n.plan(p).includes('tab'), 'in a call: no card');

  const muted = setup({ distracting: true });
  muted.guard.mute(30);
  assert.ok(!muted.n.plan(p).includes('tab'), 'muted: no card');

  // A routine or a win never covers the page.
  assert.ok(!on.n.plan({ kind: 'routine', title: 'Lunch', body: 'Eat.' }).includes('tab'));
  assert.ok(!on.n.plan({ kind: 'todo_win', title: 'Done', body: 'Nice.' }).includes('tab'));
});

test('the coach\'s session nudges get it too (the coach handles its own corner card and voice)', () => {
  const on = setup({ distracting: true });
  for (const kind of ['nudge', 'speak', 'yellow', 'red'] as NotifyKind[]) {
    assert.ok(on.n.plan({ kind, title: 'x', body: 'Back to the deck.', exclude: ['toast', 'card', 'voice'] }).includes('tab'), kind);
  }
});

test('the Settings test button shows it on any tab', async () => {
  const off = setup({ distracting: false });
  assert.equal(await off.n.test('tab'), 'Shown in your browser.');
  assert.equal(off.shown[0].test, true);
});

test('saved settings from before get the card once; turning it off afterwards sticks', () => {
  const old: Partial<Settings> = {
    notify: { ...structuredClone(DEFAULT_NOTIFY), nudge: ['toast', 'sound'], speak: ['toast', 'voice', 'sound'], todo_roast: ['toast', 'voice', 'sound', 'system'], routine: ['toast'] } as Record<NotifyKind, Channel[]>,
  };
  const a = migrateSettings(old);
  assert.ok(a.notify.nudge.includes('tab'));
  assert.ok(a.notify.todo_roast.includes('tab'));
  assert.ok(!a.notify.routine.includes('tab'));
  assert.deepEqual(a.migrated, ['tab-card']);
  // You untick it for roasts; it stays off on the next start.
  const saved = { ...a, notify: { ...a.notify, todo_roast: a.notify.todo_roast.filter((c) => c !== 'tab') } };
  const b = migrateSettings(saved);
  assert.ok(!b.notify.todo_roast.includes('tab'));
  assert.ok(b.notify.nudge.includes('tab'));
  assert.deepEqual(b.migrated, ['tab-card']);
});

test('extension versions compare as numbers', () => {
  assert.equal(newerVersion('0.2.0', '0.1.0'), true);
  assert.equal(newerVersion('0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('0.2.0', '0.2.0'), false);
  assert.equal(newerVersion('0.2.0', '0.3'), false);
  assert.equal(newerVersion('0.2.0', '0'), true);
});

test('the menu bar panel is the default, and a saved choice of the classic window is kept', () => {
  assert.equal(migrateSettings({}).ui, 'panel');
  assert.equal(migrateSettings({ ui: 'window' }).ui, 'window');
  assert.equal(migrateSettings({ ui: 'panel' }).ui, 'panel');
});
