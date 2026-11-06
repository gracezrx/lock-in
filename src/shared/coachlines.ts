// Every moment the coach says something, for coaches made from someone you know: what the
// moment is, which {placeholders} the line may use, and how the editor groups them.
import type { CoachLineKind } from './types';

export interface LineSpec {
  label: string;
  /** What is happening, for you and for Claude. */
  when: string;
  vars: string[];
  /** Placeholders a line must contain to make sense. */
  needs?: string[];
  group: 'drift' | 'answers' | 'session' | 'todos' | 'routines' | 'talk';
}

const DRIFT = ['site', 'goal', 'min', 'work', 'top', 'tasks'];
const ROAST = ['active', 'done', 'open', 'top'];

export const LINE_SPECS: Record<CoachLineKind, LineSpec> = {
  level1: { group: 'drift', label: 'First nudge', when: 'They drifted to a distracting site or app a few minutes ago. A light first nudge.', vars: DRIFT },
  level2: { group: 'drift', label: 'Speaking up', when: 'Still on the distraction. Call it out.', vars: DRIFT },
  level3: { group: 'drift', label: 'Yellow card', when: 'A long drift. Lock In just paused the video. Get firm.', vars: DRIFT },
  level4: { group: 'drift', label: 'Red card', when: 'The site is now blocked for the rest of the session. The strongest line.', vars: ['site', 'goal', 'work', 'top'] },
  repeat: { group: 'drift', label: 'Still waiting', when: "They're ignoring you and haven't picked an option yet.", vars: ['site', 'goal', 'work'] },
  back: { group: 'answers', label: 'They went back', when: 'They agreed to go back to work.', vars: ['work', 'goal'] },
  self: { group: 'answers', label: 'Came back on their own', when: 'They went back to work by themselves before you said more.', vars: ['work', 'goal'] },
  starter: { group: 'answers', label: 'Tiny first step', when: 'Giving them one small step they can do in five minutes.', vars: ['step'], needs: ['step'] },
  break: { group: 'answers', label: 'Break allowed', when: 'They asked for a break, and you allow {n} minutes.', vars: ['n', 'goal'] },
  is_work: { group: 'answers', label: '"It\'s for work"', when: 'They said the site is actually part of their work.', vars: ['site'] },
  talk: { group: 'answers', label: '"Can we talk?"', when: "They want to talk about what's in the way. Ask what's going on.", vars: [] },
  end: { group: 'answers', label: 'Session ended', when: 'They ended the focus session.', vars: [] },
  breakOver: { group: 'session', label: "Break's over", when: 'Their break just ended.', vars: ['goal'] },
  away: { group: 'session', label: 'Are you there?', when: 'They went quiet or left the computer during a session.', vars: ['goal'] },
  halfway: { group: 'session', label: 'Halfway', when: 'Halfway through a session, with {focus} focused minutes so far.', vars: ['focus', 'goal'] },
  streak: { group: 'session', label: '25 minutes straight', when: 'Twenty-five focused minutes in a row.', vars: ['goal'] },
  pomodoroBreak: { group: 'session', label: 'Short break', when: 'Time for a five-minute break: stand up, get water.', vars: [] },
  roast1: { group: 'todos', label: 'To-do roast, mild', when: "They've been on the computer for {active} and their to-do list has barely moved.", vars: ROAST },
  roast2: { group: 'todos', label: 'To-do roast, medium', when: 'Still nothing ticked off. Push a bit harder.', vars: ROAST },
  roast3: { group: 'todos', label: 'To-do roast, intervention', when: 'The day is slipping away. The strongest to-do line.', vars: ROAST },
  overdue: { group: 'todos', label: 'Overdue add-on', when: 'One short extra sentence: {overdue} of their to-dos are overdue.', vars: ['overdue'], needs: ['overdue'] },
  win: { group: 'todos', label: 'Ticked one off', when: 'They just finished {task}; {open} are left.', vars: ['task', 'open'] },
  allDone: { group: 'todos', label: 'List cleared', when: 'They finished everything on today\'s list.', vars: ['done'] },
  kickoff: { group: 'routines', label: 'Morning kickoff', when: 'Start of the day: {open} to-dos, the first is {top}.', vars: ['open', 'top'] },
  deepwork: { group: 'routines', label: 'Deep work time', when: 'Time for a deep work block of {minutes} minutes on {top}.', vars: ['top', 'minutes'] },
  hydrate: { group: 'routines', label: 'Drink water', when: 'A reminder to drink some water.', vars: ['time'] },
  stretch: { group: 'routines', label: 'Stretch', when: 'A reminder to stand up and stretch.', vars: ['time'] },
  eyes: { group: 'routines', label: 'Rest your eyes', when: 'Look at something far away for 20 seconds.', vars: [] },
  lunch: { group: 'routines', label: 'Lunch', when: "It's lunchtime. Go eat.", vars: ['time'] },
  midday: { group: 'routines', label: 'Midday check', when: 'Midday: {done} done, {open} to go.', vars: ['time', 'done', 'open'] },
  shutdown: { group: 'routines', label: 'End of the workday', when: 'Time to wrap up: {done} done, {open} left.', vars: ['done', 'open'] },
  bedtime: { group: 'routines', label: 'Go to bed', when: "It's {time} and they're still on the computer.", vars: ['time'] },
  weekly: { group: 'routines', label: 'Weekly review', when: '{hours} focused hours this week. Plan next week.', vars: ['hours', 'done'] },
  talkOpen: { group: 'talk', label: 'Starting a conversation', when: 'The first thing you say when they start a voice chat with you. Ask what they have been up to.', vars: [] },
};

export const LINE_KINDS = Object.keys(LINE_SPECS) as CoachLineKind[];

export const LINE_GROUPS: { id: LineSpec['group']; title: string }[] = [
  { id: 'drift', title: 'When you drift' },
  { id: 'answers', title: 'When you answer' },
  { id: 'session', title: 'During a session' },
  { id: 'todos', title: 'Your to-do list' },
  { id: 'routines', title: 'Routines' },
  { id: 'talk', title: 'Conversations' },
];

/** What each {placeholder} becomes, with an example. */
export const PLACEHOLDERS: Record<string, string> = {
  site: 'the distracting site or app (YouTube)',
  goal: 'what they set out to do this session (finish the pitch deck)',
  min: 'minutes on the distraction (12)',
  work: 'the last work thing they had open (the deck in Keynote)',
  top: 'their most urgent to-do ("Email Sam")',
  tasks: 'how many to-dos are open today (5)',
  step: 'the tiny first step (Open the deck and write one slide title.)',
  n: 'break minutes (5)',
  focus: 'focused minutes so far (25)',
  active: 'time on the computer today (3 hours 10 minutes)',
  done: 'to-dos done today (2)',
  open: 'to-dos still open (6)',
  overdue: 'overdue to-dos (2)',
  task: 'the to-do just finished ("Pitch deck")',
  time: 'the time now (11:40 PM)',
  minutes: 'length of the deep work block (50)',
  hours: 'focused hours this week (14)',
};

/** The {placeholders} a line uses. */
export function placeholdersIn(line: string): string[] {
  return [...new Set([...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

/** Why a line can't be used for this moment, or null when it's fine. */
export function lineProblem(kind: CoachLineKind, line: string): string | null {
  const spec = LINE_SPECS[kind];
  const used = placeholdersIn(line);
  const bad = used.filter((v) => !spec.vars.includes(v));
  if (bad.length) return `{${bad[0]}} doesn't fit here. This one can use ${spec.vars.length ? spec.vars.map((v) => `{${v}}`).join(' ') : 'no placeholders'}.`;
  const missing = (spec.needs ?? []).filter((v) => !used.includes(v));
  if (missing.length) return `Needs {${missing[0]}} somewhere in the line.`;
  if (line.length > 240) return 'Too long to say out loud. Keep it to a sentence or two.';
  return null;
}

/** Example values, for hearing a line before it is used. */
export const EXAMPLE_VALUES = {
  line: { site: 'YouTube', goal: 'Finish the pitch deck', min: 12, work: 'the deck in Keynote', top: 'Email Sam', tasks: 5, step: 'Open the deck and write one slide title.', n: 5, focus: 25, overdue: 2 },
  todo: { active: '3 hours 10 minutes', done: 2, open: 6, overdue: 2, top: 'Email Sam', task: 'Pitch deck', time: '11:40 PM', hours: 14, minutes: 50 },
} as const;
