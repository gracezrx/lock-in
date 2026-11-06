import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agendaText, findLink, inMeeting, nextMeeting, normalizeIcsUrl, ownerFromUrl, parseIcs, CalendarManager } from '../src/main/calendar';
import { buildExport, csv } from '../src/main/export';
import { ElevenAgent, friendlyError } from '../src/main/talk/agent';
import { AGENT_PROMPT, TALK_TOOLS, dynamicVariables, elevenTool, filledPrompt, opener } from '../src/main/talk/prompt';
import { DoneLog, type DoneEntry } from '../src/main/todos/donelog';
import { bestMatch, matchScore, splitDone, tokens } from '../src/main/todos/match';
import type { CalEvent, SessionRecord, Task } from '../src/shared/types';
import { DEFAULT_CALENDAR } from '../src/shared/templates';

// ---------------------------------------------------------------------------
// "I was doing X and Y" → done items, matched to the list

test('splits what you say into done items', () => {
  assert.deepEqual(splitDone('I was doing the pitch deck and then sent Sam the invoice'), ['The pitch deck', 'Sent Sam the invoice']);
  assert.deepEqual(splitDone("so um I've been working on the landing page, fixed the login bug. Also called the bank"), ['Worked on the landing page', 'Fixed the login bug', 'Called the bank']);
  assert.deepEqual(splitDone('nothing'), []);
  assert.deepEqual(splitDone("I finished the memo and I'm going to start the deck tomorrow"), ['Finished the memo'], 'plans are not done items');
  assert.deepEqual(splitDone('salt and pepper shaker design'), ['Salt and pepper shaker design'], '"and" inside a phrase does not split');
});

test('matches what you said to your open tasks', () => {
  const open: Task[] = [
    { id: '1', title: 'Finish the pitch deck', completed: false },
    { id: '2', title: 'Reply to Sam about pricing', completed: false },
    { id: '3', title: 'bug fixing', completed: false },
    { id: '4', title: '奇绩 presentation', completed: false },
    { id: '5', title: 'speedrun video', completed: false },
  ];
  assert.equal(bestMatch('the pitch deck', open)?.id, '1');
  assert.equal(bestMatch('replied to Sam about the pricing', open)?.id, '2');
  assert.equal(bestMatch('fixed some bugs', open)?.id, '3');
  assert.equal(bestMatch('did the 奇绩 presentation', open)?.id, '4');
  assert.equal(bestMatch('recorded the speedrun video', open)?.id, '5');
  assert.equal(bestMatch('called the bank', open), null);
  assert.equal(bestMatch('video', open), null, 'one shared word out of two is not enough');
  assert.equal(bestMatch('the pitch deck', open, new Set(['1'])), null, 'a task already matched is not matched twice');
  assert.ok(matchScore('fixing', 'fixed') === 1 && tokens('The Running').includes('run'));
});

test('the done log keeps entries, removes them, and knows list tasks per day', () => {
  const lines: DoneEntry[] = [];
  const log = new DoneLog({ append: (e) => lines.push(e), read: () => lines });
  const a = log.add({ at: new Date('2026-10-24T10:00:00').getTime(), title: 'Called the bank', source: 'said' });
  log.add({ at: new Date('2026-10-24T11:00:00').getTime(), title: 'Deck', source: 'list', taskId: 't1' });
  assert.equal(a.day, '2026-10-24');
  assert.ok(log.hasTask('2026-10-24', 't1'));
  assert.equal(log.remove(a.id), true);
  assert.deepEqual(log.all().map((e) => e.title), ['Deck']);
  // A fresh log reading the same lines agrees (tombstones are honored).
  assert.deepEqual(new DoneLog({ append: () => undefined, read: () => lines }).all().map((e) => e.title), ['Deck']);
  log.removeTask('2026-10-24', 't1');
  assert.equal(log.all().length, 0);
});

// ---------------------------------------------------------------------------
// The voice agent

test('the agent prompt only uses variables Lock In always fills in', () => {
  const vars = dynamicVariables({ userName: 'Grace', persona: 'sassy', profanityOk: false, situation: 'roast', now: new Date('2026-10-24T15:00:00'), status: 'x', openTasks: ['A', 'B'], doneToday: [], agenda: '' });
  const used = new Set([...`${AGENT_PROMPT} {{opener}}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  for (const k of used) assert.ok(typeof vars[k] === 'string' && vars[k].length > 0, `missing ${k}`);
  assert.equal(vars.opener, opener('roast', 'sassy'));
  assert.match(vars.open_tasks, /"A", "B"/);
  assert.match(filledPrompt(vars), /Grace's Mac/);
  assert.doesNotMatch(filledPrompt(vars), /\{\{/);
});

test('tools are valid ElevenLabs client tools', () => {
  for (const t of TALK_TOOLS) {
    const x = elevenTool(t) as { type: string; name: string; parameters?: { type: string; properties: Record<string, { type: string }> } };
    assert.equal(x.type, 'client');
    assert.match(x.name, /^[a-z_]+$/);
    if (x.parameters) assert.equal(x.parameters.type, 'object');
  }
  const log = elevenTool(TALK_TOOLS.find((t) => t.name === 'log_done')!) as { parameters: { properties: { items: { type: string; items: { type: string } } } } };
  assert.equal(log.parameters.properties.items.type, 'array');
  assert.equal(log.parameters.properties.items.items.type, 'string');
});

function fakeEleven(over: Partial<Record<string, (body: unknown) => { status: number; json: unknown }>> = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let n = 0;
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname + u.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body });
    const key = `${method} ${u.pathname}`;
    const custom = over[key];
    let r: { status: number; json: unknown };
    if (custom) r = custom(body);
    else if (key === 'POST /v1/convai/tools') r = { status: 200, json: { id: `tool_${++n}` } };
    else if (key === 'POST /v1/convai/agents/create') r = { status: 200, json: { agent_id: `agent_${++n}` } };
    else if (key === 'GET /v1/convai/conversation/get-signed-url') r = { status: 200, json: { signed_url: `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${u.searchParams.get('agent_id')}&conversation_signature=x` } };
    else r = { status: 200, json: {} };
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { http, calls };
}

test('creates the agent once, then just signs conversation links', async () => {
  const { http, calls } = fakeEleven();
  let saved: unknown = null;
  const a = new ElevenAgent({ key: () => 'k', voiceId: () => 'voice1', load: () => saved as never, save: (r) => (saved = r), http, log: () => undefined });
  const url = await a.signedUrl();
  assert.match(url, /^wss:\/\/api\.elevenlabs\.io\/.*agent_id=agent_\d+/);
  assert.equal(calls.filter((c) => c.path === '/v1/convai/tools').length, TALK_TOOLS.length);
  const create = calls.find((c) => c.path === '/v1/convai/agents/create')!.body as { conversation_config: { agent: { first_message: string; prompt: { tool_ids: string[] } }; tts: { voice_id: string } } };
  assert.equal(create.conversation_config.agent.first_message, '{{opener}}');
  assert.equal(create.conversation_config.agent.prompt.tool_ids.length, TALK_TOOLS.length);
  assert.equal(create.conversation_config.tts.voice_id, 'voice1');
  calls.length = 0;
  await a.signedUrl();
  assert.deepEqual(calls.map((c) => c.method), ['GET'], 'second time: no new agent');
});

test('a changed voice replaces the agent and cleans up the old one', async () => {
  const { http, calls } = fakeEleven();
  let saved: { agentId: string } | null = null;
  let voice = 'v1';
  const a = new ElevenAgent({ key: () => 'k', voiceId: () => voice, load: () => saved as never, save: (r) => (saved = r), http, log: () => undefined });
  await a.ensure();
  const first = saved!.agentId;
  voice = 'v2';
  await a.ensure();
  assert.notEqual(saved!.agentId, first);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path === `/v1/convai/agents/${first}`));
});

test('falls back to a basic agent config, and to inline tools on older accounts', async () => {
  let creates = 0;
  const { http, calls } = fakeEleven({
    'POST /v1/convai/tools': () => ({ status: 404, json: {} }),
    'POST /v1/convai/agents/create': () => (++creates === 1 ? { status: 422, json: { detail: 'bad llm' } } : { status: 200, json: { agent_id: 'agent_ok' } }),
  });
  let saved: unknown = null;
  const a = new ElevenAgent({ key: () => 'k', voiceId: () => 'v', load: () => saved as never, save: (r) => (saved = r), http, log: () => undefined });
  assert.equal(await a.ensure(), 'agent_ok');
  const second = calls.filter((c) => c.path === '/v1/convai/agents/create')[1].body as { conversation_config: { agent: { prompt: { tools: unknown[]; llm?: string } } } };
  assert.equal(second.conversation_config.agent.prompt.tools.length, TALK_TOOLS.length);
  assert.equal(second.conversation_config.agent.prompt.llm, undefined);
});

test('explains key problems in plain words', async () => {
  const { http } = fakeEleven({ 'POST /v1/convai/tools': () => ({ status: 401, json: { detail: { status: 'missing_permissions', message: 'The API key you used is missing the permission convai_write' } } }) });
  const a = new ElevenAgent({ key: () => 'k', voiceId: () => 'v', load: () => null, save: () => undefined, http, log: () => undefined });
  await assert.rejects(a.ensure(), /ElevenAgents set to Write/);
  assert.match(friendlyError(401, '{"detail":"invalid_api_key"}'), /rejected your key/);
  assert.match(friendlyError(402, 'quota_exceeded'), /out of credits/);
});

test('a deleted agent is recreated when signing a link', async () => {
  let gets = 0;
  const { http } = fakeEleven({ 'GET /v1/convai/conversation/get-signed-url': () => (++gets === 1 ? { status: 404, json: {} } : { status: 200, json: { signed_url: 'wss://api.elevenlabs.io/x' } }) });
  let saved: unknown = { agentId: 'gone', toolIds: [], hash: 'whatever' };
  const a = new ElevenAgent({ key: () => 'k', voiceId: () => 'v', load: () => saved as never, save: (r) => (saved = r), http, log: () => undefined });
  (saved as { hash: string }).hash = a.hash();
  assert.equal(await a.signedUrl(), 'wss://api.elevenlabs.io/x');
  assert.notEqual((saved as { agentId: string }).agentId, 'gone');
});

// ---------------------------------------------------------------------------
// Calendar

const ICS = readFileSync(join(import.meta.dirname, 'fixtures', 'google.ics'), 'utf8');
const FROM = Date.parse('2026-10-21T07:00:00Z');
const TO = Date.parse('2026-10-24T07:00:00Z');

test('reads a Google calendar: repeats, moved and skipped days, declined and cancelled events, all-day, links', () => {
  const ev = parseIcs(ICS, FROM, TO, { calendar: 'g', owner: 'you@startup.com' });
  const brief = ev.map((e) => [new Date(e.start).toISOString(), e.title, e.allDay, e.busy]);
  assert.deepEqual(brief, [
    ['2026-10-21T17:00:00.000Z', 'Standup', false, true],
    ['2026-10-22T07:00:00.000Z', 'LA Tech Week', true, false],
    ['2026-10-22T18:00:00.000Z', 'Standup (moved)', false, true],
    ['2026-10-22T21:00:00.000Z', 'Product sync', false, true],
  ]);
  assert.equal(ev[0].link, 'https://meet.google.com/abc-defg-hij');
  assert.equal(ev[3].link, 'https://us02web.zoom.us/j/123456?pwd=abc');
  const at = Date.parse('2026-10-22T21:30:00Z');
  assert.equal(inMeeting(ev, at)?.title, 'Product sync');
  assert.equal(nextMeeting(ev, Date.parse('2026-10-22T17:30:00Z'))?.title, 'Standup (moved)');
});

test('calendar helpers', () => {
  assert.equal(normalizeIcsUrl(' webcal://p01-caldav.icloud.com/published/2/abc '), 'https://p01-caldav.icloud.com/published/2/abc');
  assert.equal(ownerFromUrl('https://calendar.google.com/calendar/ical/you%40startup.com/private-abc/basic.ics'), 'you@startup.com');
  assert.equal(findLink('Join: https://teams.microsoft.com/l/meetup-join/xyz now'), 'https://teams.microsoft.com/l/meetup-join/xyz');
  const now = Date.parse('2026-10-22T17:05:00Z');
  const ev = parseIcs(ICS, FROM, TO, { calendar: 'g' });
  assert.match(agendaText(ev, now), /Next: "Standup \(moved\)" at .* \(in 55 min\)\./);
});

test('heads-up once per meeting; a lock-in offer only after a meeting with a real gap', () => {
  const m = new CalendarManager({ settings: () => ({ ...DEFAULT_CALENDAR, urls: ['x'] }), log: () => undefined, saveDay: () => undefined });
  const t0 = Date.parse('2026-10-22T16:00:00Z');
  const ev = (id: string, startMin: number, endMin: number): CalEvent => ({ id, title: id, start: t0 + startMin * 60_000, end: t0 + endMin * 60_000, allDay: false, busy: true, calendar: 'g' });
  m.events = [ev('standup', 10, 25), ev('sync', 100, 130)];
  assert.equal(m.headsUp(t0, 5), undefined);
  assert.equal(m.headsUp(t0 + 6 * 60_000, 5)?.id, 'standup');
  assert.equal(m.headsUp(t0 + 7 * 60_000, 5), undefined, 'only once');
  const gap = m.gapAfter(t0 + 26 * 60_000);
  assert.equal(gap?.ended.id, 'standup');
  assert.equal(gap?.freeMin, 74);
  assert.equal(m.gapAfter(t0 + 27 * 60_000), undefined, 'offered once');
  m.events = [ev('a', 0, 30), ev('b', 40, 60)];
  assert.equal(m.gapAfter(t0 + 31 * 60_000), undefined, 'a 9-minute gap is not worth it');
});

// ---------------------------------------------------------------------------
// Export

test('CSV escaping, with a BOM so Excel reads Chinese', () => {
  const out = csv([['a', 'b,c', 'say "hi"', '奇绩', null]]);
  assert.equal(out, '﻿a,"b,c","say ""hi""",奇绩,\r\n');
});

test('builds the done log, daily summary, sessions and day files', () => {
  const at = (s: string) => new Date(s).getTime();
  const done: DoneEntry[] = [
    { id: '1', at: at('2026-10-23T10:00:00'), day: '2026-10-23', title: 'Speedrun video', source: 'list', project: 'Captain', list: 'Google Sheets: Grace' },
    { id: '2', at: at('2026-10-24T09:30:00'), day: '2026-10-24', title: 'Called the bank', source: 'said', list: 'Told Lock In' },
    { id: '3', at: at('2026-10-24T11:00:00'), day: '2026-10-24', title: '奇绩 presentation', source: 'lockin', project: 'Captain' },
  ];
  const session: SessionRecord = {
    id: 's', goal: 'Deck', plannedMin: 50, startedAt: at('2026-10-24T10:00:00'), endedAt: at('2026-10-24T10:50:00'), endedBy: 'timer',
    focusSec: 2700, driftSec: 300, neutralSec: 0, awaySec: 0, breakSec: 0, maxLevel: 2, interventions: 1, topDistractions: { 'youtube.com': 300 },
  };
  const files = buildExport(
    { done, sessions: [session], days: { '2026-10-24': { activeSec: 4 * 3600 } }, meetings: { '2026-10-24': [{ title: 'Standup', start: at('2026-10-24T09:00:00'), end: at('2026-10-24T09:15:00') }] } },
    { now: at('2026-10-24T18:00:00') },
  );
  const byName = Object.fromEntries(files.map((f) => [f.name, f.content.replace(/^﻿/, '').split('\r\n').filter(Boolean)]));
  assert.deepEqual(byName['Lock In - done log.csv'][0], 'Date,Day,Time,Task,Project,List,How');
  assert.deepEqual(byName['Lock In - done log.csv'][2], '2026-10-24,Saturday,09:30,Called the bank,,Told Lock In,Told the coach');
  assert.deepEqual(byName['Lock In - daily summary.csv'][2], '2026-10-24,Saturday,2,45,5,1,240,1,15,youtube.com (5 min),Called the bank; 奇绩 presentation');
  assert.deepEqual(byName['Lock In - sessions.csv'][1], '2026-10-24,10:00,10:50,Deck,50,45,5,1,youtube.com (5 min),Timer');
  const day = byName[join('Days', '2026-10-24.csv')];
  assert.deepEqual(day.map((r) => r.split(',')[1]), ['Type', 'Meeting', 'Done', 'Focus session', 'Done']);
  assert.ok(byName[join('Days', '2026-10-23.csv')], 'yesterday has its own file too');
});
