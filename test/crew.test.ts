import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeSecret, crewKeys, formatCode, newCode, normalizeCode, open, seal } from '../src/main/crew/code';
import { BOMB_FRESH_MS, BOMBS_PER_DAY, Crew, ONLINE_MS, clean, parseMsg, type BombOutcome, type CrewData, type LocalStatus } from '../src/main/crew/crew';
import { relayUrls, type Relay, type RelayMessage } from '../src/main/crew/relay';
import { DEFAULT_CREW } from '../src/shared/templates';
import type { CrewSettings, CrewStats } from '../src/shared/types';

test('invite codes: 26 characters, forgiving to type, and the only secret', () => {
  const code = newCode();
  assert.match(code, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}-[0-9A-Z]$/);
  assert.equal(normalizeCode(code).length, 26);
  assert.ok(codeSecret(code));
  assert.ok(codeSecret(code.toLowerCase().replace(/-/g, ' ')), 'lower case with spaces');
  assert.equal(codeSecret(normalizeCode(code).replace(/0/g, 'O')) !== null, true, 'O for zero');
  assert.equal(codeSecret('hello'), null);
  assert.equal(formatCode('abcde fghjk'), 'ABCDE-FGHJK');
  const a = crewKeys(code)!;
  const b = crewKeys(code.toLowerCase())!;
  assert.equal(a.topic, b.topic);
  assert.match(a.topic, /^lockin-[0-9a-f]{32}$/);
  assert.notEqual(crewKeys(newCode())!.topic, a.topic);
});

test('messages are sealed: only the crew can read them, and tampering is caught', () => {
  const k = crewKeys(newCode())!;
  const other = crewKeys(newCode())!;
  const sealed = seal(k.key, { hi: 'there' });
  assert.ok(!sealed.includes('there'));
  assert.deepEqual(open(k.key, sealed), { hi: 'there' });
  assert.equal(open(other.key, sealed), null);
  const flipped = sealed.slice(0, -3) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-2);
  assert.equal(open(k.key, flipped), null);
  assert.equal(open(k.key, 'not ours'), null);
});

test('incoming messages are checked field by field', () => {
  assert.equal(parseMsg({ v: 2, t: 'status' }), null);
  assert.equal(parseMsg({ v: 1, t: 'status', from: 'x', at: 1, state: 'hacking' }), null);
  const b = parseMsg({ v: 1, t: 'bomb', from: 'x', name: 'Sam\u0000‮', at: 1, id: 'i', to: 'y', insult: 'x'.repeat(500) });
  assert.ok(b && b.t === 'bomb');
  assert.equal(b && 'insult' in b ? b.insult.length : 0, 140);
  assert.equal(b?.name, 'Sam');
  assert.equal(clean('  a\n\tb  ', 10), 'a b');
  const s = parseMsg({ v: 1, t: 'status', from: 'x', at: 1, state: 'free', stats: { todayMin: 1e9, weekMin: -5, streak: 'lots' } });
  assert.ok(s && s.t === 'status');
  assert.deepEqual(s && 'stats' in s ? s.stats : null, { todayMin: 1440, weekMin: 0, streak: 0, roastedWeek: 0, bombsThrownWeek: 0, achievements: 0 });
});

test('relay addresses for ntfy.sh and your own server', () => {
  assert.deepEqual(relayUrls('https://ntfy.sh/', 'lockin-abc', '12h'), { post: 'https://ntfy.sh/lockin-abc', ws: 'wss://ntfy.sh/lockin-abc/ws?since=12h' });
  assert.equal(relayUrls('http://192.168.1.5:8080', 't', 'x').ws, 'ws://192.168.1.5:8080/t/ws?since=x');
});

// ---- a crew of friends on an in-memory relay ---------------------------------------------

class Hub {
  subs = new Map<string, Set<(m: RelayMessage) => void>>();
  seq = 0;
  delay = 0;
  published = 0;
  constructor(public clock: { now: number }) {}
  relay(): Relay & { bind: (fn: (m: RelayMessage) => void, state: (on: boolean) => void) => void } {
    let topic = '';
    let deliver: (m: RelayMessage) => void = () => undefined;
    let onState: (on: boolean) => void = () => undefined;
    const hub = this;
    return {
      connected: false,
      bind(fn, state) {
        deliver = fn;
        onState = state;
      },
      start(t) {
        topic = t;
        if (!hub.subs.has(t)) hub.subs.set(t, new Set());
        hub.subs.get(t)!.add((m) => deliver(m));
        this.connected = true;
        onState(true);
      },
      stop() {
        this.connected = false;
      },
      async publish(t, text) {
        hub.published++;
        const m = { id: `m${++hub.seq}`, time: hub.clock.now, text };
        for (const fn of hub.subs.get(t) ?? []) {
          if (hub.delay) {
            // The message sits in transit while time passes.
            hub.clock.now += hub.delay;
          }
          fn(m);
        }
        void topic;
        return true;
      },
    };
  }
}

const STATS: CrewStats = { todayMin: 30, weekMin: 200, streak: 2, roastedWeek: 1, bombsThrownWeek: 0, achievements: 3 };

function friend(hub: Hub, name: string) {
  const settings: CrewSettings = { ...DEFAULT_CREW, name };
  let data: CrewData | null = null;
  const local: LocalStatus = { state: 'free', since: hub.clock.now, stats: { ...STATS } };
  const bombs: { name: string; insult: string }[] = [];
  let answer: BombOutcome = 'hit';
  const relay = hub.relay();
  const crew = new Crew({
    settings: () => settings,
    saveSettings: (p) => Object.assign(settings, p),
    relay,
    load: () => data,
    save: (d) => (data = structuredClone(d)),
    local: () => local,
    onBomb: (b) => {
      bombs.push({ name: b.name, insult: b.insult });
      return answer;
    },
    onChange: () => undefined,
    log: () => undefined,
    now: () => hub.clock.now,
  });
  relay.bind((m) => crew.receive(m), (on) => crew.setConnection(on));
  return {
    crew,
    settings,
    local,
    bombs,
    set answer(a: BombOutcome) {
      answer = a;
    },
    member: (id: string) => crew.view().members.find((m) => m.id === id)!,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

function crewOf(...names: string[]) {
  const clock = { now: new Date('2026-10-26T10:00:00').getTime() };
  const hub = new Hub(clock);
  const people = names.map((n) => friend(hub, n));
  const code = people[0].crew.create('Library gremlins', names[0]);
  for (const p of people.slice(1)) assert.deepEqual(p.crew.join(code.toLowerCase(), p.settings.name), { ok: true });
  return { clock, hub, people, code };
}

async function everyoneTicks(people: ReturnType<typeof friend>[]) {
  for (const p of people) p.crew.tick();
  await flush();
}

test('friends see each other, and the crew name travels with the invite', async () => {
  const { people } = crewOf('Grace', 'Sam', 'Lee');
  const [grace, sam, lee] = people;
  sam.local.state = 'locked';
  sam.local.goal = 'Problem set 4';
  sam.local.sessionMin = 12;
  lee.local.state = 'drifting';
  await everyoneTicks(people);
  const v = grace.crew.view();
  assert.equal(v.joined, true);
  assert.equal(v.members[0].me, true);
  assert.deepEqual(v.members.slice(1).map((m) => [m.name, m.state, m.bombable]), [
    ['Sam', 'locked', false],
    ['Lee', 'drifting', true],
  ]);
  assert.equal(v.members[1].goal, 'Problem set 4');
  assert.equal(sam.settings.crewName, 'Library gremlins');
  assert.ok(grace.crew.view().feed.some((f) => f.text === 'Sam locked in on Problem set 4.'));
});

test('a bomb lands on a friend who is not locked in, with your insult, and uses one of your 3', async () => {
  const { people } = crewOf('Grace', 'Sam');
  const [grace, sam] = people;
  await everyoneTicks(people);
  assert.equal(grace.crew.bombsLeft(), BOMBS_PER_DAY);
  const r = await grace.crew.throwBomb(sam.crew.me, 'Your deck called. It misses you.');
  await flush();
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(sam.bombs, [{ name: 'Grace', insult: 'Your deck called. It misses you.' }]);
  assert.equal(grace.crew.bombsLeft(), 2);
  assert.ok(sam.crew.view().feed.some((f) => f.text === 'Grace bombed you: “Your deck called. It misses you.”'));
  assert.deepEqual(grace.crew.events().map((e) => [e.type, e.outcome]), [['thrown', 'hit']]);
  assert.deepEqual(sam.crew.events().map((e) => [e.type, e.outcome]), [['received', 'hit']]);
});

test('no bombs on friends who are locked in, away, or offline; none past 3 a day', async () => {
  const { clock, people } = crewOf('Grace', 'Sam', 'Lee');
  const [grace, sam, lee] = people;
  sam.local.state = 'locked';
  lee.local.state = 'away';
  await everyoneTicks(people);
  assert.match((await grace.crew.throwBomb(sam.crew.me, 'hi')).error ?? '', /locked in/);
  assert.match((await grace.crew.throwBomb(lee.crew.me, 'hi')).error ?? '', /isn't at their computer/);
  lee.local.state = 'free';
  clock.now += 21_000;
  await everyoneTicks(people);
  clock.now += 21_000;
  await everyoneTicks(people);
  for (let i = 0; i < 3; i++) assert.equal((await grace.crew.throwBomb(lee.crew.me, `bomb ${i}`)).ok, true);
  assert.match((await grace.crew.throwBomb(lee.crew.me, 'one more')).error ?? '', /No bombs left today/);
  // A friend who goes quiet for 25 minutes is offline.
  clock.now += ONLINE_MS + 1000;
  const lv = grace.member(lee.crew.me);
  assert.equal(lv.state, 'offline');
  assert.equal(lv.bombable, false);
});

test('a bomb that arrives after they locked in bounces, and the thrower gets it back', async () => {
  const { people } = crewOf('Grace', 'Sam');
  const [grace, sam] = people;
  await everyoneTicks(people);
  sam.answer = 'bounced';
  assert.equal((await grace.crew.throwBomb(sam.crew.me, 'gotcha')).ok, true);
  await flush();
  assert.equal(grace.crew.bombsLeft(), 3);
  assert.ok(grace.crew.view().feed.some((f) => f.text.startsWith('Your bomb bounced off Sam')));
});

test('the person bombed enforces the limit, so a tampered app cannot spam them', async () => {
  const { clock, people } = crewOf('Grace', 'Sam');
  const [grace, sam] = people;
  await everyoneTicks(people);
  for (let i = 0; i < 3; i++) await grace.crew.throwBomb(sam.crew.me, `bomb ${i}`);
  await flush();
  assert.equal(sam.bombs.length, 3);
  // Grace's app "thinks" it's tomorrow; Sam's day hasn't changed.
  const realNow = clock.now;
  clock.now = realNow + 86_400_000;
  assert.equal(grace.crew.bombsLeft(), 3);
  clock.now = realNow;
  (grace.crew as unknown as { data: CrewData }).data.thrown = { day: '2026-10-26', ids: [], refunded: [] };
  assert.equal((await grace.crew.throwBomb(sam.crew.me, 'fourth')).ok, true);
  await flush();
  assert.equal(sam.bombs.length, 3, 'Sam ignores the fourth');
});

test("bombs sent while you were offline don't go off when you come back", async () => {
  const { hub, people } = crewOf('Grace', 'Sam');
  const [grace, sam] = people;
  await everyoneTicks(people);
  hub.delay = BOMB_FRESH_MS + 1000;
  await grace.crew.throwBomb(sam.crew.me, 'late');
  hub.delay = 0;
  await flush();
  assert.equal(sam.bombs.length, 0);
  assert.ok(sam.crew.view().feed.some((f) => f.text.includes('while you were away')));
});

test('drifting settles for 20 seconds before friends hear about it; locking in is instant', async () => {
  const { clock, hub, people } = crewOf('Grace', 'Sam');
  const [grace, sam] = people;
  await everyoneTicks(people);
  const before = hub.published;
  sam.local.state = 'drifting';
  sam.crew.tick();
  clock.now += 5000;
  sam.crew.tick();
  await flush();
  assert.equal(hub.published, before, 'not yet');
  assert.equal(grace.member(sam.crew.me).state, 'free');
  clock.now += 16_000;
  sam.crew.tick();
  await flush();
  assert.equal(grace.member(sam.crew.me).state, 'drifting');
  sam.local.state = 'locked';
  sam.crew.tick();
  await flush();
  assert.equal(grace.member(sam.crew.me).state, 'locked');
});

test('leaving tells the crew and forgets the code', async () => {
  const { people } = crewOf('Grace', 'Sam');
  const [grace, sam] = people;
  await everyoneTicks(people);
  await sam.crew.leave();
  await flush();
  assert.equal(sam.crew.joined, false);
  assert.equal(sam.settings.code, '');
  assert.equal(grace.crew.view().members.length, 1);
  assert.ok(grace.crew.view().feed.some((f) => f.text === 'Sam left the crew.'));
  assert.deepEqual(grace.crew.join('nope', 'x').ok, false);
});
