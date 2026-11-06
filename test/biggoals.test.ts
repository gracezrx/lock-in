import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeft, daysLeftText, guessGoal, matches, movedItems, parseLinks, parseTerms, questionFor, recurringThings, seedTerms, termsOf, themeTerms, thingsIn, type DayItem } from '../src/main/biggoals';

test('the words of a title that say what it is about', () => {
  assert.deepEqual(seedTerms('Fundraise well'), ['fundraise']);
  assert.deepEqual(seedTerms('Launch cool side products'), [], 'too generic: the products themselves come from your answers');
  assert.deepEqual(seedTerms('Ship the Captain launch'), ['captain']);
  assert.deepEqual(seedTerms('Get 1,000 users on Captain'), ['000', 'users', 'captain']);
});

test('matching: word forms for words, whole names for names', () => {
  assert.ok(matches('Fundraising deck v3', ['fundraise']));
  assert.ok(matches('Talk to a fundraiser', ['fundraise']));
  assert.ok(matches('Email investors', ['investor']));
  assert.ok(matches('Reply to the investor', ['investors']));
  assert.ok(matches('Fix Lock In onboarding', ['Lock In']));
  assert.ok(!matches('Lockin', ['Lock In']));
  assert.ok(!matches('Productivity tips', ['products']));
  assert.ok(!matches('Ideck', ['deck']));
  assert.ok(matches('Call with Sequoia', ['sequoia']));
  assert.ok(matches('给投资人发邮件', ['投资人']));
  assert.ok(!matches('anything', ['', ' ']));
});

test('what counts: its list, or the words of its title, and always the title itself', () => {
  assert.deepEqual(termsOf({ title: 'Fundraise well' }), ['Fundraise well', 'fundraise']);
  assert.deepEqual(termsOf({ title: 'Fundraise well', counts: ['investors', 'deck'] }), ['Fundraise well', 'investors', 'deck']);
  const items: DayItem[] = [{ kind: 'todo', text: 'Book flights' }, { kind: 'session', text: 'Fundraise well' }, { kind: 'todo', text: 'Investor update' }];
  assert.deepEqual(movedItems({ title: 'Fundraise well', counts: ['investors'] }, items).map((i) => i.text), ['Fundraise well', 'Investor update']);
  assert.deepEqual(movedItems({ title: 'x' }, undefined), []);
});

test('days left', () => {
  assert.equal(daysLeft('2026-10-27', '2026-12-31'), 65);
  assert.equal(daysLeft('2026-10-27', '2026-10-27'), 0);
  assert.equal(daysLeft('2026-10-27', '2026-10-20'), -7);
  assert.equal(daysLeft('2026-10-27', undefined), undefined);
  assert.equal(daysLeft('2026-10-27', 'soon'), undefined);
  assert.deepEqual([daysLeftText(0), daysLeftText(1), daysLeftText(65), daysLeftText(100), daysLeftText(-1), daysLeftText(undefined)], ['Last day', '1 day left', '65 days left', '14 weeks left', 'Past its end date', '']);
});

test('names and projects in a line, without the verbs in front', () => {
  assert.deepEqual(thingsIn('Fix Lock In'), ['Lock In']);
  assert.deepEqual(thingsIn('Use the Acme product'), ['Acme']);
  assert.deepEqual(thingsIn('Call with Sequoia'), ['Sequoia']);
  assert.deepEqual(thingsIn('Brown alumni: send out messages'), ['Brown']);
  assert.deepEqual(thingsIn('Send Quorum demo to Sam'), ['Quorum', 'Sam']);
  assert.deepEqual(thingsIn('call the bank'), []);
  assert.deepEqual(thingsIn('Weekly team sync'), []);
});

const days = (...lines: string[][]): DayItem[][] => lines.map((l) => l.map((text) => ({ kind: 'todo' as const, text })));

test('things you keep coming back to that are not part of any goal yet', () => {
  const byDay = days(['Fix Lock In', 'Call with Sequoia'], ['Lock In onboarding', 'Book flights'], [], ['Ship Lock In 1.2', 'Sequoia follow-up', 'Quorum demo']);
  const goals = [{ title: 'Fundraise well', counts: ['investors', 'Sequoia'] }];
  const t = recurringThings(byDay, goals, []);
  assert.deepEqual(t.map((x) => [x.term, x.days]), [['Lock In', 3]], 'Sequoia already counts; Quorum came up once');
  assert.deepEqual(t[0].examples, ['Fix Lock In', 'Lock In onboarding', 'Ship Lock In 1.2']);
  assert.deepEqual(recurringThings(byDay, goals, ['lock in']), [], 'you said it is part of nothing');
  assert.deepEqual(recurringThings(byDay, [{ ...goals[0], notCounts: ['Lock In'] }], []), [], 'the only goal said no');
});

test('the question: yes/no for one goal or a good guess, "which one" otherwise', () => {
  const t = { term: 'Lock In', days: 3, examples: ['Fix Lock In', 'Lock In onboarding'] };
  const side = { id: 'g1', title: 'Launch cool side products' };
  const fund = { id: 'g2', title: 'Fundraise well' };
  const one = questionFor(t, [side])!;
  assert.equal(one.text, 'Is “Lock In” part of “Launch cool side products”?');
  assert.deepEqual(one.goalIds, ['g1']);
  assert.equal(one.evidence, 'You came back to “Lock In” on 3 days this week: “Fix Lock In”, “Lock In onboarding”.');
  assert.equal(one.id, 'q:lock in');
  const guessed = questionFor(t, [fund, side], { goalId: 'g1', text: 'Is Lock In one of your cool side products?' })!;
  assert.equal(guessed.text, 'Is Lock In one of your cool side products?');
  assert.deepEqual(guessed.goalIds, ['g1']);
  const which = questionFor(t, [fund, side])!;
  assert.deepEqual(which.goalIds, ['g2', 'g1']);
  assert.equal(which.text, 'Is “Lock In” part of one of your goals?');
  assert.equal(questionFor(t, [{ ...side, notCounts: ['lock in'] }]), null);
});

test('the coach’s lists are checked', () => {
  assert.deepEqual(parseTerms('Sure: ["investors", "pitch deck", "Investors", "", "a very long phrase that goes on and on and on", 7]'), ['investors', 'pitch deck']);
  assert.deepEqual(parseTerms('nothing'), []);
  const links = parseLinks('[{"term":"Lock In","goal":"g1","question":"Is Lock In one of your cool side products?"},{"term":"Sam","goal":null},{"term":"Brown","goal":"nope","question":"x?"}]', ['g1', 'g2']);
  assert.deepEqual(links, { 'lock in': { goalId: 'g1', text: 'Is Lock In one of your cool side products?' }, sam: { goalId: null, text: undefined }, brown: { goalId: null, text: undefined } });
});

test('common goals come with words that usually count, even without the coach', () => {
  const fund = themeTerms('Fundraise well');
  assert.ok(fund.includes('investors') && fund.includes('pitch') && fund.includes('deck'));
  assert.ok(themeTerms('Launch cool side products').includes('landing page'));
  assert.ok(themeTerms('Land a summer internship').includes('interview'));
  assert.deepEqual(themeTerms('Be kinder'), []);
  assert.deepEqual(themeTerms('Fundraise well', 'Runway through next year'), themeTerms('Fundraise well'), '"Runway" is not about running');
});

test('without the coach, Lock In guesses from the words around a thing', () => {
  const goals = [{ id: 'fund', title: 'Fundraise well' }, { id: 'side', title: 'Launch cool side products' }];
  assert.equal(guessGoal({ term: 'Lock In', days: 3, examples: ['Fix Lock In onboarding', 'Ship Lock In 1.2'] }, goals), 'side');
  assert.equal(guessGoal({ term: 'Sequoia', days: 2, examples: ['Sequoia pitch', 'Call with Sequoia'] }, goals), 'fund');
  assert.equal(guessGoal({ term: 'Sam', days: 2, examples: ['Lunch with Sam', 'Sam'] }, goals), undefined, 'nothing to go on');
  assert.equal(guessGoal({ term: 'Captain', days: 2, examples: ['Captain demo for investors'] }, goals), undefined, 'could be either: ask which');
});
