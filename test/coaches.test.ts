import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Coaches, buildMaterial, checkLines, countWords, parseDistilled, planClips, readiness, speakerStats, turnsFromWords, type ScribeWord, type Turn,
} from '../src/main/coach/custom';
import { activeStyle, languageCode, setActiveStyle, toActiveStyle } from '../src/main/coach/style';
import { confirmLine, exampleLine, levelLine, roastLine, routineLine, winLine } from '../src/main/coach/lines';
import { coachSystem } from '../src/main/coach/llm';
import { opener, personaVoice } from '../src/main/talk/prompt';
import { ElevenAgent } from '../src/main/talk/agent';
import { collect } from '../src/main/backup';
import { lineProblem } from '../src/shared/coachlines';
import { DEFAULT_SETTINGS } from '../src/main/settings';
import type { CoachSource, CustomCoach } from '../src/shared/types';

const words = (speaker: string, start: number, text: string, perWord = 0.4): ScribeWord[] => {
  const out: ScribeWord[] = [];
  text.split(' ').forEach((w, i) => {
    if (i) out.push({ text: ' ', type: 'spacing', speaker_id: speaker });
    out.push({ text: w, type: 'word', start: start + i * perWord, end: start + (i + 1) * perWord, speaker_id: speaker });
  });
  return out;
};

test('words are counted in any language', () => {
  assert.equal(countWords('Did you eat yet? Go to bed.'), 7);
  assert.equal(countWords('宝贝你吃饭了没有'), 5);
  assert.equal(countWords('宝贝, finish the deck 先'), 5);
  assert.equal(countWords(''), 0);
});

test('a recording becomes turns: a new one when the voice changes or after a long pause', () => {
  const turns = turnsFromWords([
    ...words('speaker_0', 0, 'Did you eat yet?'),
    ...words('speaker_1', 2, 'Yes Mum.'),
    { text: '(laughs)', type: 'audio_event', speaker_id: 'speaker_1' },
    ...words('speaker_0', 3, 'Good. Go to bed.'),
    ...words('speaker_0', 9, 'Seriously.'),
    // No spacing entries at all, and Chinese with none needed.
    { text: 'no', type: 'word', start: 10, end: 10.2, speaker_id: 'speaker_1' },
    { text: 'spaces', type: 'word', start: 10.2, end: 10.5, speaker_id: 'speaker_1' },
    { text: '早点', type: 'word', start: 11, end: 11.3, speaker_id: 'speaker_0' },
    { text: '睡觉', type: 'word', start: 11.3, end: 11.6, speaker_id: 'speaker_0' },
  ]);
  assert.deepEqual(turns.map((t) => [t.speaker, t.text]), [
    ['speaker_0', 'Did you eat yet?'],
    ['speaker_1', 'Yes Mum.'],
    ['speaker_0', 'Good. Go to bed.'],
    ['speaker_0', 'Seriously.'],
    ['speaker_1', 'no spaces'],
    ['speaker_0', '早点睡觉'],
  ]);
  const stats = speakerStats(turns);
  assert.equal(stats[0].id, 'speaker_0', 'the most talkative voice first');
  assert.ok(stats[0].quotes.length >= 1 && stats[0].quotes.every((q) => q.length <= 140));
});

const coach = (o: Partial<CustomCoach> = {}): CustomCoach => ({
  id: 'aaaaaaaaaaaa', name: 'Mum', relation: 'my mum', base: 'firm', language: '', notes: '', createdAt: 0, updatedAt: 0, sources: [], lines: {}, edited: [], useVoice: true, ...o,
});
const src = (o: Partial<CoachSource>): CoachSource => ({ id: 'bbbbbbbbbbbb', kind: 'recording', title: 'Call', addedAt: 0, status: 'ready', words: 0, ...o });

test('how ready a coach is: words for the style, a minute of voice for a copy', () => {
  const r0 = readiness(coach());
  assert.equal(r0.style, 'empty');
  assert.equal(r0.canDistill, false);
  assert.equal(readiness(coach({ notes: 'She calls me baobei, always asks if I ate, hates when I stay up late, says circle back, and tells me she is proud of me but only after nagging for a while about my sleep and my phone.' })).canDistill, true, 'notes alone are enough to start');
  const r = readiness(coach({
    sources: [src({ words: 900, theirSec: 75 }), src({ id: 'c', status: 'pick-speaker', words: 0 }), src({ id: 'd', status: 'transcribing', words: 0 }), src({ id: 'e', kind: 'text', words: 2500 })],
    distilledAt: 1,
    distilledWords: 900,
  }));
  assert.deepEqual([r.words, r.style, r.theirSec, r.canClone, r.pickSpeaker, r.pending, r.newWords], [3400, 'great', 75, true, 1, 1, 2500]);
});

test("Claude reads only their side: their turns, plus what you wrote about them", () => {
  const c = coach({ notes: 'Calls me 宝贝.', sources: [src({ speaker: 'speaker_0', words: 10 }), src({ id: 'cccccccccccc', kind: 'text', title: 'WeChat', words: 5 })] });
  const m = buildMaterial(c, (s) =>
    s.kind === 'recording'
      ? { turns: [{ speaker: 'speaker_0', start: 0, end: 2, text: 'Go to bed.' }, { speaker: 'speaker_1', start: 2, end: 3, text: 'GRACE SAID THIS' }] }
      : { text: 'Mum: 吃饭了吗\nMe: yes' },
  );
  assert.match(m, /Calls me 宝贝/);
  assert.match(m, /Go to bed\./);
  assert.doesNotMatch(m, /GRACE SAID THIS/);
  assert.match(m, /WeChat \(messages or writing; use only what they wrote\)\nMum: 吃饭了吗/);
  // A long recording is sampled from its start, middle and end to stay under budget.
  const turns: Turn[] = Array.from({ length: 3000 }, (_x, i) => ({ speaker: 'speaker_0', start: i, end: i + 1, text: `line number ${i} of the call` }));
  const big = buildMaterial(coach({ sources: [src({ speaker: 'speaker_0', words: 9000 })] }), () => ({ turns }), 6000);
  assert.ok(big.length < 6500, String(big.length));
  assert.match(big, /line number 0 /);
  assert.match(big, /line number 1\d{3} /);
  assert.match(big, /line number 2\d{3} /);
});

test("Claude's answer becomes their style and lines; lines that don't fit are dropped, your own edits stay", () => {
  const answer = '```json\n' + JSON.stringify({
    summary: 'Warm and worried.',
    persona: 'A warm, worried mum who mixes Mandarin and English.',
    callsYou: ['宝贝', '宝贝', 'Grace'],
    catchphrases: ['吃饭了没有'],
    language: 'Mandarin with some English',
    languageCode: 'zh',
    lines: {
      level1: ['“宝贝，{site}？”', '{site} again 🙄', 'Wrong {placeholder} here', '{goal} 还没做完'],
      starter: ['Just do a little bit.', '先做这个：{step}'],
      back: ['Claude would overwrite this'],
      notAMoment: ['x'],
    },
  }) + '\n```';
  const out = parseDistilled(answer, { lines: { back: ['My own line'] }, edited: ['back'] })!;
  assert.equal(out.style.languageCode, 'zh');
  assert.deepEqual(out.style.callsYou, ['宝贝', 'Grace']);
  assert.deepEqual(out.lines.level1, ['宝贝，{site}？', '{site} again', '{goal} 还没做完']);
  assert.deepEqual(out.lines.starter, ['先做这个：{step}'], 'a starter line must contain the step');
  assert.deepEqual(out.lines.back, ['My own line']);
  assert.equal(parseDistilled('Sorry, I cannot do that.', { lines: {}, edited: [] }), null);
});

test('your own lines are checked too', () => {
  assert.match(lineProblem('win', '{site} done') ?? '', /doesn't fit/);
  assert.equal(lineProblem('win', '{task} 做完了！还剩 {open} 个。'), null);
  assert.match(lineProblem('overdue', 'Some are late.') ?? '', /Needs \{overdue\}/);
  const r = checkLines('level2', ['  - {min} minutes on {site}.  ', '{min} minutes on {site}.', '{task}?', '']);
  assert.deepEqual(r.ok, ['{min} minutes on {site}.']);
  assert.equal(r.problems.length, 1);
});

test('clips for copying their voice: their longer turns where nobody talks over them, up to a limit', () => {
  const turns: Turn[] = [
    { speaker: 'mum', start: 0, end: 20, text: 'a' },
    { speaker: 'me', start: 19, end: 22, text: 'b' },
    { speaker: 'mum', start: 22, end: 23, text: 'too short' },
    { speaker: 'mum', start: 30, end: 70, text: 'long' },
    { speaker: 'mum', start: 80, end: 90, text: 'c' },
  ];
  const segs = planClips(turns, 'mum', 35);
  assert.deepEqual(segs.map((s) => [Math.round(s.start), Math.round(s.end)]), [[30, 60], [80, 90]], 'overlapping and tiny turns are skipped, long ones capped at 30s');
});

test('while they are the coach, every moment speaks in their words (and the built-in coach fills gaps)', () => {
  const c = coach({
    base: 'firm',
    style: { summary: '', persona: 'A warm, worried Chinese mum.', callsYou: ['宝贝'], catchphrases: ['吃饭了没有'], language: 'Mandarin with some English', languageCode: 'zh' },
    lines: {
      level2: ['{min} 分钟了还在 {site}。先把 {goal} 做完。'],
      win: ['{task} 做完了？还剩 {open} 个。'],
      roast1: ['你在电脑前 {active} 了。'],
      kickoff: ['早上好。先做 {top}。'],
      back: ['乖。{work} 打开了。'],
      talkOpen: ['宝贝，今天忙什么呢？'],
    },
  });
  const ctx = { site: 'YouTube', goal: 'Finish the deck', min: 12, work: 'the deck' };
  setActiveStyle(toActiveStyle(c));
  try {
    assert.equal(levelLine(2, 'firm', ctx), '12 分钟了还在 YouTube。先把 finish the deck 做完。');
    assert.equal(confirmLine('back', 'firm', ctx), '乖。the deck 打开了。');
    assert.equal(winLine('firm', { active: '', done: 1, open: 3, overdue: 0, task: 'Pitch deck' }), '“Pitch deck” 做完了？还剩 3 个。');
    assert.equal(roastLine(1, 'firm', { active: '3 hours', done: 0, open: 4, overdue: 2 }), '你在电脑前 3 hours 了。', 'no built-in English tail tacked on');
    assert.match(levelLine(1, 'firm', ctx), /YouTube/, 'a moment without their lines uses the built-in one');
    assert.notEqual(routineLine('kickoff', 'firm', { active: '', done: 0, open: 0, overdue: 0, time: '9:00' }), '早上好。先做 the first thing on your list。', 'without a to-do, a line naming one is skipped');
    assert.match(levelLine(2, 'gentle', ctx), /YouTube/, "when the coach goes gentle (you're not okay) it isn't their nagging");
    assert.doesNotMatch(levelLine(2, 'gentle', ctx), /分钟/);
    const sys = coachSystem('firm', false, false);
    assert.match(sys, /you talk like Mum, the user's mum\. A warm, worried Chinese mum\./);
    assert.match(sys, /They call the user 宝贝/);
    assert.match(sys, /Speak the way they do: Mandarin with some English/);
    assert.match(sys, /Plain spoken words only/);
    assert.match(coachSystem('firm', false, true), /at their kindest/);
    assert.match(personaVoice('firm'), /^exactly like Mum, the user's mum/);
    assert.equal(opener('checkin', 'firm'), '宝贝，今天忙什么呢？');
    assert.equal(exampleLine('win', '{task}! {open} left.'), '“Pitch deck”! 6 left.');
    assert.equal(activeStyle()?.languageCode, 'zh');
  } finally {
    setActiveStyle(null);
  }
  assert.doesNotMatch(levelLine(2, 'firm', ctx), /分钟/);
  assert.match(coachSystem('firm', false, false), /Persona: a direct coach/);
  assert.equal(opener('checkin', 'firm'), 'Status update. What have you done so far?');
});

test('language names become codes for the voice agent', () => {
  assert.equal(languageCode('Mandarin with some English'), 'zh');
  assert.equal(languageCode('English, a little Spanish'), 'en');
  assert.equal(languageCode('zho'), 'zh');
  assert.equal(languageCode('es-MX'), 'es');
  assert.equal(languageCode('粤语'), 'zh');
  assert.equal(languageCode('Klingon'), null);
});

test('the voice agent talks in the coach’s language (and English agents are left alone)', async () => {
  const bodies: Record<string, unknown>[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (u.endsWith('/v1/convai/tools')) return new Response(JSON.stringify({ id: `t${bodies.length}` }));
    if (u.endsWith('/v1/convai/agents/create')) return new Response(JSON.stringify({ agent_id: 'agent1' }));
    return new Response('{}');
  }) as typeof fetch;
  let lang = 'en';
  const a = new ElevenAgent({ key: () => 'k', voiceId: () => 'v1', language: () => lang, load: () => null, save: () => undefined, http, log: () => undefined });
  const en = a.hash();
  assert.equal(en, new ElevenAgent({ key: () => 'k', voiceId: () => 'v1', load: () => null, save: () => undefined, http, log: () => undefined }).hash(), 'no change for English');
  lang = 'zh';
  assert.notEqual(a.hash(), en);
  await a.ensure();
  const agentBody = bodies.find((b) => 'conversation_config' in b) as { conversation_config: { agent: { language: string }; tts: { model_id?: string } } };
  assert.equal(agentBody.conversation_config.agent.language, 'zh');
  assert.equal(agentBody.conversation_config.tts.model_id, 'eleven_flash_v2_5');
});

// ---- the whole thing, with a stand-in ElevenLabs and Claude ------------------------------------

function fakes() {
  const calls: { url: string; form?: FormData }[] = [];
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, form: init?.body instanceof FormData ? init.body : undefined });
    if (u.endsWith('/v1/speech-to-text')) {
      const name = await ((init?.body as FormData).get('file') as Blob).text();
      if (name.includes('broken')) return new Response('{"detail":"could not decode audio"}', { status: 400 });
      const w = name.includes('memo')
        ? words('speaker_0', 0, 'Grace go to bed it is late and you have work tomorrow', 1)
        : [...words('speaker_0', 0, 'Did you eat yet? Do not stay up again.', 1.5), ...words('speaker_1', 13, 'Yes Mum I ate.', 1), ...words('speaker_0', 18, 'Good girl. Finish the deck then sleep.', 1.5)];
      return new Response(JSON.stringify({ language_code: 'eng', words: w }));
    }
    if (u.endsWith('/v1/voices/add')) return new Response(JSON.stringify({ voice_id: 'clone1' }));
    if (u.includes('/v1/voices/clone1')) return new Response('{}');
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  let distills = 0;
  const claude = {
    available: true,
    messages: async () => {
      distills++;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ summary: 'Worried, warm.', persona: 'A warm mum.', callsYou: ['Grace'], catchphrases: ['Did you eat yet?'], language: 'English', languageCode: 'en', lines: { level2: [`Did you eat yet? {site} again. (${distills})`], back: ['Good girl.'] } }) }],
        stop_reason: 'end_turn',
      };
    },
  };
  return { http, calls, claude, distills: () => distills };
}

test('making a coach from someone: recordings, picking their voice, distilling, editing, and copying the voice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-coach-'));
  const files = mkdtempSync(join(tmpdir(), 'lockin-coach-files-'));
  writeFileSync(join(files, 'call.m4a'), 'call audio');
  writeFileSync(join(files, 'memo.m4a'), 'memo audio');
  writeFileSync(join(files, 'broken.m4a'), 'broken audio');
  writeFileSync(join(files, 'chat.srt'), '1\n00:00:01,000 --> 00:00:02,000\nMum: Eat something!\n\n2\n00:00:03,000 --> 00:00:04,000\nMum: Bed. Now.\n');
  writeFileSync(join(files, 'scan.pdf'), '%PDF');
  const f = fakes();
  const changes: string[] = [];
  const coaches = new Coaches({ dir, elevenKey: () => 'key', claude: f.claude, settings: () => DEFAULT_SETTINGS, userName: () => 'Grace', http: f.http, onChange: (id) => changes.push(id), log: () => undefined });
  const c = coaches.create({ name: ' Mum ', relation: 'my mum' });
  assert.equal(c.name, 'Mum');

  const added = coaches.addFiles(c.id, [join(files, 'call.m4a'), join(files, 'memo.m4a'), join(files, 'broken.m4a'), join(files, 'chat.srt'), join(files, 'scan.pdf'), join(files, 'gone.mp3')]);
  assert.equal(added.added, 4);
  assert.deepEqual(added.skipped.map((s) => s.name), ['scan.pdf', 'gone.mp3']);
  await coaches.idle();
  let v = coaches.view(c.id)!;
  const by = Object.fromEntries(v.sources.map((s) => [s.title, s]));
  assert.equal(by['call.m4a'].status, 'pick-speaker');
  assert.equal(by['call.m4a'].speakers?.length, 2);
  assert.equal(by['memo.m4a'].status, 'ready', 'one voice: that is them');
  assert.equal(by['memo.m4a'].words, 12);
  assert.equal(by['broken.m4a'].status, 'error');
  assert.match(by['broken.m4a'].error ?? '', /couldn't read that file/);
  assert.equal(by['chat.srt'].kind, 'text');
  assert.equal(by['chat.srt'].words, 6, 'subtitle numbers and timestamps are dropped');
  const form = f.calls.find((x) => x.url.endsWith('/v1/speech-to-text'))!.form!;
  assert.equal(form.get('diarize'), 'true');
  assert.equal(v.readiness.pickSpeaker, 1);
  assert.equal(f.distills(), 0, 'not enough words to distill by itself');

  // Which voice is Mum.
  const mum = by['call.m4a'].speakers![0];
  assert.match(mum.quotes.join(' '), /Did you eat yet/);
  coaches.pickSpeaker(c.id, by['call.m4a'].id, mum.id);
  v = coaches.view(c.id)!;
  assert.equal(v.sources.find((s) => s.title === 'call.m4a')!.words, 16);
  assert.ok(v.readiness.theirSec > 20);

  // Distilling (a few sentences of notes make up for few words), then writing a moment yourself, then distilling again.
  assert.match((await coaches.distill(c.id)).error ?? '', /Add a bit more/);
  coaches.update(c.id, { notes: 'She always asks if I ate before anything else. She hates it when I stay up late on my laptop, and she says she is proud of me right after she finishes nagging me about sleep.' });
  assert.deepEqual(await coaches.distill(c.id), { ok: true });
  v = coaches.view(c.id)!;
  assert.equal(v.style?.persona, 'A warm mum.');
  assert.deepEqual(v.lines.level2, ['Did you eat yet? {site} again. (1)']);
  const edit = coaches.setLines(c.id, 'back', ['That is my girl. {work} is open.', '{site} is not a placeholder here']);
  assert.equal(edit.ok.length, 1);
  assert.equal(edit.problems.length, 1);
  await coaches.distill(c.id);
  v = coaches.view(c.id)!;
  assert.deepEqual(v.lines.back, ['That is my girl. {work} is open.'], 'your own lines survive');
  assert.deepEqual(v.lines.level2, ['Did you eat yet? {site} again. (2)']);
  assert.deepEqual(v.edited, ['back']);
  coaches.setLines(c.id, 'back', []);
  assert.deepEqual(coaches.view(c.id)!.edited, [], 'clearing a moment hands it back');

  // Their voice: only with consent, from the clips the page cut.
  const plan = coaches.clipPlan(c.id);
  assert.ok(plan.sources.length >= 1 && plan.seconds > 0);
  assert.ok(coaches.audio(c.id, plan.sources[0].sid)!.data.byteLength > 0);
  assert.deepEqual(await coaches.cloneVoice(c.id, { files: [], consent: false }), { ok: false, error: 'Tick the box once Mum has said yes.' });
  const tooShort = await coaches.cloneVoice(c.id, { files: [{ name: 'a.wav', data: new Uint8Array(10), mime: 'audio/wav', seconds: 5 }], consent: true });
  assert.match(tooShort.error ?? '', /Couldn't cut enough/);
  const made = await coaches.cloneVoice(c.id, { files: [{ name: 'a.wav', data: new Uint8Array(100), mime: 'audio/wav', seconds: 70 }], consent: true });
  assert.deepEqual(made, { ok: true });
  v = coaches.view(c.id)!;
  assert.equal(v.voice?.id, 'clone1');
  const cloneForm = f.calls.find((x) => x.url.endsWith('/v1/voices/add'))!.form!;
  assert.equal(cloneForm.getAll('files').length, 1);
  assert.equal(cloneForm.get('remove_background_noise'), 'true');
  await coaches.deleteVoice(c.id);
  assert.equal(coaches.view(c.id)!.voice, undefined);
  assert.ok(f.calls.some((x) => x.url.endsWith('/v1/voices/clone1')));

  // Backups keep the coach and transcripts, not the recordings.
  const names = collect(dir).map((x) => x.name);
  assert.ok(names.includes(`coaches/${c.id}/coach.json`));
  assert.ok(names.some((n) => n.startsWith(`coaches/${c.id}/`) && n !== `coaches/${c.id}/coach.json`));
  assert.ok(!names.some((n) => n.includes('audio')));
  assert.ok(changes.includes(c.id));

  coaches.remove(c.id);
  assert.equal(coaches.get(c.id), null);
  assert.equal(existsSync(join(dir, 'coaches', c.id)), false);
});

test('enough words: the first distill happens by itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-coach-auto-'));
  const f = fakes();
  const coaches = new Coaches({ dir, elevenKey: () => 'key', claude: f.claude, settings: () => DEFAULT_SETTINGS, userName: () => 'Grace', http: f.http, onChange: () => undefined, log: () => undefined });
  const c = coaches.create({ name: 'Sam', relation: 'my boss', base: 'drill' });
  coaches.addText(c.id, 'Slack', Array.from({ length: 120 }, (_x, i) => `Let's circle back on item ${i} before standup, okay?`).join('\n'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.distills(), 1);
  assert.ok(coaches.view(c.id)!.distilledAt);
  coaches.addText(c.id, 'More', 'Ship it today please.');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.distills(), 1, 'later material waits for you to press the button');
  assert.equal(coaches.view(c.id)!.readiness.newWords, 4);
});

test('recordings half-transcribed when Lock In quit start again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lockin-coach-restart-'));
  const audio = join(mkdtempSync(join(tmpdir(), 'lockin-coach-a-')), 'memo.m4a');
  writeFileSync(audio, 'memo audio');
  const f = fakes();
  const deps = { dir, elevenKey: () => 'key', claude: { ...f.claude, available: false }, settings: () => DEFAULT_SETTINGS, userName: () => '', http: f.http, onChange: () => undefined, log: () => undefined };
  const first = new Coaches({ ...deps, elevenKey: () => undefined });
  const c = first.create({ name: 'Dad' });
  first.addFiles(c.id, [audio]);
  await first.idle();
  assert.match(first.view(c.id)!.sources[0].error ?? '', /ElevenLabs key/);
  // Pretend it was cut off mid-way.
  const raw = first.get(c.id)!;
  raw.sources[0].status = 'transcribing';
  writeFileSync(join(dir, 'coaches', c.id, 'coach.json'), JSON.stringify(raw));
  const second = new Coaches(deps);
  await second.idle();
  assert.equal(second.view(c.id)!.sources[0].status, 'ready');
});
