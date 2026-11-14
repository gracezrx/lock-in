import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coach, type CoachDeps } from '../src/main/coach/coach';
import { parseReply, fill } from '../src/main/coach/lines';
import { Classifier } from '../src/main/engine/classifier';
import { Session } from '../src/main/engine/session';
import { Guardrails, inQuietHours } from '../src/main/guardrails';
import { DEFAULT_CALENDAR, DEFAULT_CREW, DEFAULT_EXPORT, DEFAULT_NOTIFY, DEFAULT_SOUNDS, DEFAULT_TALK, DEFAULT_TODO, buildDefaultProfile } from '../src/shared/templates';
import type { NotifyPayload } from '../src/main/notify';
import type { InterventionRecord, LabeledSample, OverlayPayload, Settings, ToastPayload } from '../src/shared/types';

const SETTINGS: Settings = {
  notify: DEFAULT_NOTIFY, sounds: DEFAULT_SOUNDS, ntfyServer: 'https://ntfy.sh', ntfyTopic: '', webhookUrl: '', todo: DEFAULT_TODO,
  voiceId: 'v', ttsModelLive: 'flash', ttsModelShout: 'v3', sttModel: 'scribe_v2', sayVoice: '', coachModel: 'c', classifierModel: 'h',
  volumeCap: 0.8, quietStart: '00:00', quietEnd: '00:00', profanityOk: false, titlesStayLocal: false, maxSpokenPerHour: 6,
  commitmentMode: false, sensitiveDomains: [], sensitiveApps: [], breakMinutes: 7, talk: DEFAULT_TALK, calendar: DEFAULT_CALENDAR, exportCsv: DEFAULT_EXPORT, crew: DEFAULT_CREW, phone: { enabled: false }, look: { theme: 'jail', keyCursor: true }, goals: { enabled: true, suggest: true, nudges: true }, attention: { pauses: true, maxPerDay: 12, minGapMin: 20 }, ui: 'panel', telemetry: { features: false, apps: false, asked: true },
};

function yt(over: Partial<LabeledSample> = {}): LabeledSample {
  return {
    t: Date.now(), app: 'Google Chrome', bundleId: 'com.google.Chrome', domain: 'youtube.com', url: 'https://youtube.com/watch', title: 'Cats', tabId: 7,
    browser: true, idleSec: 0, mediaPlaying: true, inCall: false, isPrivate: false, label: 'distraction', weight: 1.5, itemKey: 'site:youtube.com', source: 'rule', ...over,
  };
}

function setup(settings: Partial<Settings> = {}) {
  const profile = buildDefaultProfile('founder');
  const st = { ...SETTINGS, ...settings };
  const calls: string[] = [];
  const spoken: string[] = [];
  const toasts: ToastPayload[] = [];
  const overlays: OverlayPayload[] = [];
  let overlayOpen = false;
  const interventions: InterventionRecord[] = [];
  const notes: NotifyPayload[] = [];
  let todoState: { open: number; overdue: number; done: number; top?: { id: string; title: string; completed: boolean } } | null = null;
  const sess = new Session('Finish the deck', 50, 5, () => {}, { app: 'Keynote', bundleId: 'com.apple.iWork.Keynote', documentPath: '/tmp/deck.key', updatedAt: 0 });
  let ended = false;
  const classifier = new Classifier(() => profile, {}, () => {}, { titlesStayLocal: () => false });
  const deps: CoachDeps = {
    store: {
      logIntervention: (i: InterventionRecord) => interventions.push({ ...i }),
      logTurn: () => {},
      interventions: () => interventions,
    } as unknown as CoachDeps['store'],
    profile: () => profile,
    settings: () => st,
    classifier,
    claude: { available: false } as unknown as CoachDeps['claude'],
    voice: {
      speaking: false,
      recording: false,
      canListen: false,
      speak: async (t: string) => void spoken.push(t),
      stop: () => {},
      stopListening: () => {},
      listen: async () => null,
    } as unknown as CoachDeps['voice'],
    router: {
      pauseMedia: async () => (calls.push('pause'), true),
      closeTab: async (id: number) => (calls.push(`close:${id}`), true),
      blockDomain: async (d: string) => (calls.push(`block:${d}`), true),
      unblockAll: async () => (calls.push('unblock'), true),
      hideApp: async (a: string) => (calls.push(`hide:${a}`), true),
      openWork: async () => (calls.push('openWork'), true),
    } as unknown as CoachDeps['router'],
    guard: new Guardrails(),
    ui: {
      showToast: (p) => toasts.push(p),
      hideToast: () => {},
      showOverlay: (p) => {
        overlayOpen = true;
        overlays.push(p);
      },
      updateOverlay: () => {},
      hideOverlay: () => (overlayOpen = false),
      refresh: () => {},
    },
    session: () => (ended ? null : sess),
    endSession: () => {
      ended = true;
      calls.push('endSession');
    },
    current: () => yt(),
    log: () => {},
    notify: async (p) => void notes.push(p),
    channels: (k) => st.notify[k],
    todos: () => todoState,
  };
  const coach = new Coach(deps);
  return { coach, calls, spoken, toasts, overlays, sess, interventions, profile, isOverlayOpen: () => overlayOpen, classifier, notes, st, setTodos: (t: typeof todoState) => (todoState = t) };
}

test('level 1 is a silent toast plus a whistle; level 2 speaks', async () => {
  const t = setup();
  t.profile.persona = 'firm';
  await t.coach.onLevel(1, 'score', yt());
  assert.equal(t.toasts.at(-1)?.kind, 'nudge');
  assert.equal(t.notes.at(-1)?.kind, 'nudge', 'sound and other extras go through the notifier');
  assert.deepEqual(t.notes.at(-1)?.exclude, ['toast', 'card', 'voice']);
  assert.equal(t.spoken.length, 0);
  await t.coach.onLevel(2, 'score', yt());
  assert.equal(t.toasts.at(-1)?.kind, 'speak');
  assert.equal(t.spoken.length, 1);
  assert.equal(t.interventions.at(-1)?.level, 2, 'same intervention escalates');
  assert.equal(new Set(t.interventions.map((i) => i.id)).size, 1);
});

test('level 3 pauses media and raises the overlay; level 4 blocks the site', async () => {
  const t = setup();
  await t.coach.onLevel(3, 'score', yt());
  assert.ok(t.calls.includes('pause'));
  assert.ok(t.isOverlayOpen());
  assert.equal(t.overlays.at(-1)?.level, 3);
  await t.coach.onLevel(4, 'score', yt());
  assert.ok(t.calls.includes('block:youtube.com'));
  t.coach.silence();
});

test('a distracting desktop app gets hidden at level 4', async () => {
  const t = setup();
  await t.coach.onLevel(4, 'score', yt({ app: 'Steam', browser: false, domain: undefined, url: undefined }));
  assert.ok(t.calls.includes('hide:Steam'));
  t.coach.silence();
});

test('"Back to it" closes the tab at level 3+, reopens work, and resets the ladder', async () => {
  const t = setup();
  t.sess.engine.force(3);
  await t.coach.onLevel(3, 'score', yt());
  await t.coach.choose('back', 'button');
  assert.ok(t.calls.includes('close:7'));
  assert.ok(t.calls.includes('openWork'));
  assert.equal(t.sess.engine.level, 0);
  assert.equal(t.coach.active, null);
  assert.equal(t.isOverlayOpen(), false);
  assert.equal(t.interventions.at(-1)?.option, 'back');
});

test('spoken "I need a break" starts a break without a Claude key', async () => {
  const t = setup();
  await t.coach.onLevel(2, 'score', yt());
  await t.coach.reply('ugh fine, I need a break', 'voice');
  assert.ok(t.sess.onBreakUntil && t.sess.onBreakUntil > Date.now());
  assert.equal(t.sess.engine.paused, true);
  assert.ok(t.calls.includes('unblock'));
});

test('"this is research" relabels the site as work', async () => {
  const t = setup();
  await t.coach.onLevel(2, 'score', yt({ domain: 'reddit.com', itemKey: 'site:reddit.com' }));
  await t.coach.reply("it's for work, research", 'typed');
  const c = t.classifier.classify(yt({ domain: 'reddit.com' }));
  assert.equal(c.label, 'work');
});

test('saying you are overwhelmed drops the persona and caps the ladder', async () => {
  const t = setup();
  t.profile.persona = 'drill';
  await t.coach.onLevel(3, 'score', yt());
  await t.coach.reply("honestly I'm overwhelmed", 'voice');
  assert.equal(t.coach.wellbeing, true);
  assert.match(t.spoken.at(-1) ?? '', /matters more than/);
  const last = t.overlays.at(-1)!;
  assert.deepEqual(last.options.map((o) => o.id), ['break', 'end', 'back']);
  assert.equal(last.level, 2);
  t.coach.silence();
});

test('commitment mode keeps "End session" off the overlay and refuses ending by voice', async () => {
  const t = setup({ commitmentMode: true });
  await t.coach.onLevel(3, 'score', yt());
  assert.ok(!t.overlays.at(-1)!.options.some((o) => o.id === 'end'));
  await t.coach.choose('end', 'voice');
  assert.ok(!t.calls.includes('endSession'));
  assert.ok(t.coach.active, 'intervention stays open');
  t.coach.silence();
});

test('muting clears the open intervention and the ladder', async () => {
  const t = setup();
  t.sess.engine.force(3);
  await t.coach.onLevel(3, 'score', yt());
  t.coach.silence();
  assert.equal(t.coach.active, null);
  assert.equal(t.sess.engine.level, 0);
  assert.equal(t.isOverlayOpen(), false);
});

test('no interventions during a call', async () => {
  const t = setup();
  await t.coach.onLevel(3, 'score', yt({ inCall: true }));
  assert.equal(t.coach.active, null);
  assert.equal(t.overlays.length, 0);
});

test('reply parsing and copy helpers', () => {
  assert.equal(parseReply('okay okay going back'), 'back');
  assert.equal(parseReply('give me a break'), 'break');
  assert.equal(parseReply('this is work actually'), 'is_work');
  assert.equal(parseReply("I don't know where to start"), 'starter');
  assert.equal(parseReply("I'm stuck on the intro"), 'talk');
  assert.equal(parseReply('end the session'), 'end');
  assert.equal(parseReply('I feel sick'), 'wellbeing');
  assert.equal(parseReply('banana'), null);
  assert.equal(fill('{min} minutes on {site}.', { site: 'x.com', goal: '', min: 1, work: '' }), 'A minute on x.com.');
  assert.equal(fill('Okay, {min} minutes on {site}.', { site: 'x.com', goal: '', min: 1, work: '' }), 'Okay, a minute on x.com.');
  assert.equal(fill('{min} minutes on {site}.', { site: 'x.com', goal: '', min: 7.4, work: '' }), '7 minutes on x.com.');
});

test('quiet hours wrap around midnight', () => {
  const s = { ...SETTINGS, quietStart: '22:00', quietEnd: '08:00' };
  assert.equal(inQuietHours(s, new Date('2026-10-17T23:30:00')), true);
  assert.equal(inQuietHours(s, new Date('2026-10-17T07:59:00')), true);
  assert.equal(inQuietHours(s, new Date('2026-10-17T12:00:00')), false);
});

test('goals read naturally mid-sentence', () => {
  const c = { site: 'x.com', goal: 'Finish the deck', min: 3, work: 'deck' };
  assert.equal(fill('Back to {goal}.', c), 'Back to finish the deck.');
  assert.equal(fill('{goal}. Go.', c), 'Finish the deck. Go.');
  assert.equal(fill('Back to {goal}.', { ...c, goal: 'Captain launch plan' }), 'Back to Captain launch plan.');
  assert.equal(fill('Stop. {goal}. Go.', { ...c, goal: 'write the memo' }), 'Stop. Write the memo. Go.');
});

test('the routing table decides the surface: yellow card as a corner card when "Full screen" is off', async () => {
  const t = setup();
  t.st.notify = { ...t.st.notify, yellow: ['toast', 'voice'] };
  await t.coach.onLevel(3, 'score', yt());
  assert.equal(t.overlays.length, 0);
  assert.equal(t.toasts.at(-1)?.title, 'Yellow card');
  assert.ok(t.spoken.length >= 1);
  t.coach.silence();
});

test('turning voice off for a level keeps the coach quiet', async () => {
  const t = setup();
  t.st.notify = { ...t.st.notify, speak: ['toast'] };
  await t.coach.onLevel(2, 'score', yt());
  assert.equal(t.spoken.length, 0);
});

test('sassy lines mention the to-do list when one is connected', async () => {
  const t = setup();
  t.profile.persona = 'sassy';
  t.setTodos({ open: 5, overdue: 1, done: 0, top: { id: '1', title: 'Send the investor update', completed: false } });
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    await t.coach.onLevel(2, 'score', yt());
    seen.add(t.coach.active!.line);
    t.coach.silence();
  }
  assert.ok([...seen].some((l) => /5 (things|to-dos)/.test(l)), 'some lines count the to-dos');
});
