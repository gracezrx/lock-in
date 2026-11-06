// Pre-written lines for every persona. Used instantly for levels 1-2, and as the
// fallback for everything else when there is no Claude key or a call fails.
// The sassy persona roasts the habit, never the person.
// A coach made from someone you know brings its own lines (see style.ts); any moment it has
// no line for falls back to the built-in ones.
import type { CoachLineKind, Persona, RouteOption, RoutineKind } from '../../shared/types';
import { styleLines } from './style';
import { EXAMPLE_VALUES, LINE_SPECS } from '../../shared/coachlines';

export interface LineCtx {
  site: string;
  goal: string;
  min: number;
  work: string;
  step?: string;
  n?: number;
  focus?: number;
  /** Open to-dos for today (0 or undefined when no list is connected). */
  tasks?: number;
  /** Title of the top open to-do. */
  top?: string;
  overdue?: number;
}

type Bank = Record<Persona, string[]>;

const LEVEL: Record<1 | 2 | 3 | 4, Bank> = {
  1: {
    sassy: [
      'Why are we so locked out again? {site}? Really?',
      'Oh, {site}. Bold choice. {goal} misses you.',
      'Hi. Hello. {site} is not {goal}.',
      'Psst. Your goal called. It said {goal}, not {site}.',
    ],
    gentle: ['Hey, {site} has had you for {min} minutes. Back to {goal}?', 'Small detour to {site}. Ready to head back?'],
    firm: ['{min} minutes on {site}. Back to {goal}.', '{site} again. {goal} is waiting.'],
    drill: ['{site}? Already? Back to {goal}.', 'I see you on {site}. Wrap it up.'],
  },
  2: {
    sassy: [
      'Why are you so locked out again? {min} minutes on {site}. {goal} is literally waiting.',
      'Babe. {site}? For {min} minutes? We said {goal}.',
      "I'm not mad. I'm just watching you scroll {site} instead of doing {goal}.",
      'Respectfully, what is going on? {min} minutes on {site}.',
      'Oh, so {site} is the plan now? Interesting. {work} disagrees.',
    ],
    gentle: [
      'Hey. We drifted onto {site} for a bit. Want to pick {goal} back up?',
      'Little detour to {site}. {work} is right where you left it.',
      "No judgment, but it's been {min} minutes on {site}. Shall we go back?",
    ],
    firm: [
      "{site}, {min} minutes. {goal} isn't going to finish itself. Back to it.",
      "You said {goal}. You're on {site}. Pick one.",
      '{min} minutes gone to {site}. Close it and open {work}.',
    ],
    drill: [
      'Hey! {min} minutes on {site}. Close it. {goal}. Move.',
      'What are we doing on {site}? {goal}. Now.',
      'Nope. {site} is not the assignment. {work} is. Go.',
    ],
  },
  3: {
    sassy: [
      'Okay, no. {min} minutes on {site}. I paused it. Go open {work} before I get dramatic.',
      'Why are you like this? {site} again. Video paused. {goal}. Now.',
      "I've seen you do hard things. This is not one of them. Close {site}.",
      'Yellow card, bestie. {min} minutes on {site}. I paused it for both of us.',
    ],
    gentle: [
      "Okay, {min} minutes on {site}. I paused it. Let's get back to {goal} together.",
      'I paused {site} for you. {work} is one click away. Want to go back?',
    ],
    firm: ["{min} minutes on {site}. That's enough. I paused it. Back to {work}.", 'Stop. {site} is done for now. {goal}. Go.'],
    drill: [
      "Hey. {min} minutes on {site}. Video's paused. Get back to {work}. Now.",
      'Absolutely not. {site} again. Close it and go. Now!',
      "{min} minutes! On {site}! {goal} called. It's not happy. Move!",
    ],
  },
  4: {
    sassy: [
      "That's it. {site} is blocked. I did it for us. Back to {work}.",
      'Red card, bestie. {site} is gone until the session ends. Go do {goal}.',
      "I blocked {site}. You're welcome. I'll be right here, judging, until you open {work}.",
    ],
    gentle: ["I've closed {site} for the rest of the session. {work} is waiting, and so am I.", "{site} is off for now. Let's do just five minutes of {goal}."],
    firm: ['{site} is blocked until the session ends. Back to {work}. Now.', "That's the limit. {site} is closed. Pick an option and get back to {goal}."],
    drill: ["That's it. {site} is blocked. You're going back to {work}. I'll keep talking until you do.", 'Locked. Blocked. Done. {site} is gone. {goal}. Right now!'],
  },
};

/** Extra lines mixed in when a to-do list is connected and has open items. */
const TASK_LEVEL: Record<2 | 3 | 4, Bank> = {
  2: {
    sassy: ['You have {tasks} things left today and you chose {site}. Interesting.', '{tasks} to-dos, and we are on {site}? Make it make sense.'],
    gentle: ['{tasks} things are still on today’s list. Maybe start with {top}?'],
    firm: ['{tasks} tasks left today. {site} is not one of them.'],
    drill: ['{tasks} tasks left! None of them are on {site}! Move!'],
  },
  3: {
    sassy: ['{tasks} things on your list. Zero of them are on {site}. Start with {top}.', 'Your to-do list is screaming. {top}. Now. I paused {site}.'],
    gentle: ['{top} is still waiting. I paused {site} so you can get to it.'],
    firm: ['{site} is paused. {top} is next. Go.'],
    drill: ['{site} paused! {top}! Now!'],
  },
  4: {
    sassy: ['{site} is blocked and {top} is still undone. Coincidence? No. Go.'],
    gentle: ['{site} is closed for now. {top} is a good place to start.'],
    firm: ['{site} is blocked. {top}. Now.'],
    drill: ['{site} is gone! {top}! Go!'],
  },
};

const REPEAT: Bank = {
  sassy: [
    'Still waiting. I have all day. You do not.',
    "Hello? {work} isn't going to open itself. Pick an option.",
    "I'm going to keep talking until you pick one. I'm very annoying. You know this.",
    'The longer you stare at me, the longer {goal} waits.',
  ],
  gentle: ["Still here whenever you're ready. {work} is waiting.", 'Whenever you are ready, just pick one.'],
  firm: ['Still waiting. {work}. Go.', 'Pick an option. {goal} is not getting done from here.'],
  drill: ['Still waiting! {work}! Go!', 'I can do this all day. Back to {goal}!', 'Every second on {site} is a second off {goal}. Move!'],
};

const CONFIRM: Record<RouteOption | 'self', Bank> = {
  back: {
    sassy: ['Look at you, being responsible. {work} is open.', 'Thank you. Was that so hard?', 'There you are. {work} is open.'],
    gentle: ['There you go. {work} is open.', 'Nice. Back to {goal}.'],
    firm: ['Good. {work} is open.', "That's it. Back to work."],
    drill: ["That's what I like. {work}. Go.", 'Good. Now stay there.'],
  },
  starter: {
    sassy: ['Tiny step, no excuses: {step} Five minutes. Go.'],
    gentle: ['Here is your starter: {step} Just five minutes.'],
    firm: ['Starter: {step} Five minutes. Go.'],
    drill: ['Your mission: {step} Five minutes. Go!'],
  },
  break: {
    sassy: ["Fine. {n} minutes. I'm counting.", '{n} minutes of freedom. Use them wisely. You won’t, but still.'],
    gentle: ["Enjoy the break. I'll check in after {n} minutes."],
    firm: ['Break for {n} minutes. Then back to {goal}.'],
    drill: ['Fine. {n} minutes. Then you are mine.'],
  },
  is_work: {
    sassy: ["Oh, it's work? My bad. {site} counts now. Don't make me regret it."],
    gentle: ['Got it. I will count {site} as work from now on.'],
    firm: ['Noted. {site} counts as work.'],
    drill: ['Fine. {site} is work. It better be.'],
  },
  talk: {
    sassy: ["Okay, spill. What's actually going on?"],
    gentle: ["Okay. What's getting in the way right now?"],
    firm: ["What's actually blocking you?"],
    drill: ['Talk to me. What is actually blocking you?'],
  },
  end: {
    sassy: ["Session over. Let's look at the damage."],
    gentle: ['Ending the session. Here is how it went.'],
    firm: ['Session ended.'],
    drill: ['Session over. Here is the damage.'],
  },
  self: {
    sassy: ['Oh, you came back on your own? Proud of you. Weirdly.'],
    gentle: ['Welcome back.'],
    firm: ['Good. Back on track.'],
    drill: ['There it is. Stay there.'],
  },
};

const MISC = {
  breakOver: {
    sassy: ["Break's over. Don't make me come get you.", "Time's up. {goal} isn't going to do itself, sadly."],
    gentle: ["Break's over. Ready to get back to {goal}?"],
    firm: ["Break's over. Back to {goal}."],
    drill: ["Break's over! Back to {goal}! Let's go!"],
  } as Bank,
  away: {
    sassy: ['Hello? Did you leave me? The session is still running.'],
    gentle: ['Still there? No rush, just checking in.'],
    firm: ['Still there? Your session is still running.'],
    drill: ['Hello? Session is still running. Come back.'],
  } as Bank,
  halfway: {
    sassy: ['Halfway there with {focus} focused minutes. Who are you?'],
    gentle: ['Halfway there. {focus} focused minutes so far. Nice work.'],
    firm: ['Halfway. {focus} focused minutes. Keep going.'],
    drill: ['Halfway! {focus} focused minutes. Do not slow down now!'],
  } as Bank,
  streak: {
    sassy: ['Twenty-five minutes straight? Okay, main character.'],
    gentle: ['Twenty-five minutes straight. That is a real streak.'],
    firm: ['Twenty-five straight minutes. Good.'],
    drill: ['Twenty-five minutes, no breaks in focus. Respect. Keep it rolling.'],
  } as Bank,
  pomodoroBreak: {
    sassy: ['Pomodoro break. Water, stretch, and no, not TikTok.'],
    gentle: ['Time for a short break. Stretch and get some water.'],
    firm: ['Break. Five minutes. Stand up.'],
    drill: ['Break! Five minutes! On your feet!'],
  } as Bank,
  wellbeing: ['Okay. That matters more than {goal}. Take a real break, or we can end the session. Your call.'],
  unclear: ['Say back to it, starter, break, or this is work.'],
};

// ---- to-do roasts and wins ----------------------------------------------------

export interface TodoCtx {
  active: string;
  done: number;
  open: number;
  overdue: number;
  top?: string;
  task?: string;
}

const ROAST: Record<1 | 2 | 3, Bank> = {
  1: {
    sassy: [
      "You've been on this computer for {active} and finished {done} things. {open} left. Want to talk about it?",
      '{active} of screen time. {done} tasks done. The math is not mathing.',
      'Quick check: {active} on here, and your to-do list has not moved. {top} is right there.',
    ],
    gentle: ["You've been on for {active}. {open} things are still on today's list. Maybe start with {top}?"],
    firm: ['{active} on the computer. {done} done, {open} to go. Start {top}.'],
    drill: ['{active} on the computer and {done} tasks done! {top}! Now!'],
  },
  2: {
    sassy: [
      "Okay, real talk. {active} on here and the to-do list hasn't moved. Start with {top}. Just that one.",
      'Your to-do list called. It feels ignored. {open} things, and the top one is {top}.',
      "I'm starting to think the to-do list is decorative. {open} open. {top}. Go.",
    ],
    gentle: ['It has been a while without ticking anything off. {top} could be a nice small win.'],
    firm: ['{active} and nothing finished. {top}. Lock in on it.'],
    drill: ['Nothing done in {active}! Unacceptable! {top}! Go!'],
  },
  3: {
    sassy: [
      'No. {active} on this computer, {done} things done, {open} still waiting. Lock in on {top} right now.',
      "This is an intervention. {active}. {open} to-dos. I'm not leaving until you start {top}.",
    ],
    gentle: ["I'm worried the day is slipping. Let's do {top} together, starting now."],
    firm: ['Enough. {active}, {open} open tasks. Start {top} now.'],
    drill: ['This is a red alert! {active}! {open} tasks! {top}! Move!'],
  },
};

const OVERDUE_TAIL: Bank = {
  sassy: ['{overdue} of them are overdue, by the way.', 'Also, {overdue} are overdue. Just saying.'],
  gentle: ['{overdue} are a little overdue.'],
  firm: ['{overdue} are overdue.'],
  drill: ['{overdue} overdue!'],
};

const WIN: Bank = {
  sassy: ['Wait, you finished {task}? Who are you?', '{task}: done. Look at you go. {open} left.', "One down, {open} to go. I'm almost impressed."],
  gentle: ['Nice, {task} is done. {open} left.'],
  firm: ['{task}: done. Next.'],
  drill: ['{task}: done! Next target!'],
};

const ALL_DONE: Bank = {
  sassy: ['You finished everything? Close the laptop before I find more.'],
  gentle: ['Everything on the list is done. Well done.'],
  firm: ['List cleared. Good work.'],
  drill: ['List cleared! Outstanding!'],
};

// ---- routines -----------------------------------------------------------------

export interface RoutineCtx extends TodoCtx {
  time: string;
  hours?: number;
  minutes?: number;
  message?: string;
  followUp?: number;
}

type RoutineBank = { sassy: string[]; other: string[] };

const ROUTINE: Record<Exclude<RoutineKind, 'custom'>, RoutineBank> = {
  kickoff: {
    sassy: [
      'Morning. {open} things on the list today. Top one: {top}. Are we pretending to be productive, or actually being productive?',
      'Rise and grind, but like, actually. {open} to-dos. Start with {top}.',
    ],
    other: ['Good morning. {open} things on the list today. The first one is {top}. Want to lock in on it?'],
  },
  deepwork: {
    sassy: ["It's deep work o'clock. {top} isn't going to do itself.", 'Deep work time. Phone face down. {top}. Go.'],
    other: ['Deep work block. Lock in on {top} for {minutes} minutes?'],
  },
  hydrate: {
    sassy: ["Drink some water. You're basically a houseplant with opinions.", 'Hydrate. Coffee does not count, I checked.'],
    other: ['Time for some water.'],
  },
  stretch: {
    sassy: ['Stand up. Stretch. Your spine is filing a complaint.', 'Get up and move for a minute. Your posture is giving shrimp.'],
    other: ['Stand up and stretch for a minute.'],
  },
  eyes: {
    sassy: ['Look at something 20 feet away for 20 seconds. No, not your phone.'],
    other: ['Eye break: look at something 20 feet away for 20 seconds.'],
  },
  lunch: {
    sassy: ["It's lunch. Go eat real food, not snacks over the keyboard."],
    other: ["It's lunchtime. Step away and eat something."],
  },
  midday: {
    sassy: ["It's {time}. {done} done, {open} to go. The afternoon is not going to be more motivated than you are."],
    other: ['Midday check: {done} done, {open} to go.'],
  },
  shutdown: {
    sassy: ["That's a wrap. You finished {done} and left {open}. Write down tomorrow's top three and close the laptop."],
    other: ['Time to wrap up. {done} done today, {open} left. Pick tomorrow’s top three, then log off.'],
  },
  bedtime: {
    sassy: [
      "It's {time}. Why are you still on your computer? Go to bed.",
      "It's {time}. Whatever this is can wait until tomorrow. Bed.",
      'I said bed. Laptop. Closed. Now.',
    ],
    other: ["It's {time}. Time to log off and get some sleep."],
  },
  weekly: {
    sassy: ['Weekly review. {hours} focused hours, {done} tasks done. Plan next week before it plans you.'],
    other: ['Weekly review: {hours} focused hours this week. Take a few minutes to plan next week.'],
  },
};

const lastUsed = new Map<string, string>();

function pick(bankKey: string, options: string[]): string {
  if (options.length === 1) return options[0];
  const prev = lastUsed.get(bankKey);
  const pool = options.filter((o) => o !== prev);
  const choice = pool[Math.floor(Math.random() * pool.length)];
  lastUsed.set(bankKey, choice);
  return choice;
}

/**
 * Their own line for this moment, preferring lines whose {placeholders} all have something to
 * say (an English stand-in like "your work" would break a line in another language).
 */
function own(kind: CoachLineKind, persona: Persona, values: object = {}, strict = false): string | null {
  const lines = styleLines(kind, persona);
  if (!lines) return null;
  const v = values as Record<string, unknown>;
  const usable = lines.filter((l) => [...l.matchAll(/\{(\w+)\}/g)].every((m) => v[m[1]] !== undefined && v[m[1]] !== null && v[m[1]] !== ''));
  if (!usable.length && strict) return null;
  return pick(`S:${kind}`, usable.length ? usable : lines);
}

const GOAL_VERBS = new Set(['finish', 'write', 'ship', 'build', 'study', 'read', 'review', 'fix', 'draft', 'prepare', 'plan', 'edit', 'design', 'code', 'research', 'learn', 'practice', 'update', 'send', 'clean', 'make', 'do', 'work', 'outline', 'test', 'smoke', 'answer', 'reply', 'debug', 'refactor', 'record', 'film', 'call', 'email', 'submit', 'pay', 'book']);

/** "Finish the deck" reads as "finish the deck" mid-sentence; proper nouns stay capitalized. */
function goalMid(goal: string): string {
  const first = goal.split(/\s+/)[0]?.toLowerCase() ?? '';
  return GOAL_VERBS.has(first) ? goal.charAt(0).toLowerCase() + goal.slice(1) : goal;
}

/** "1 things" → "1 thing", "1 are overdue" → "1 is overdue". */
function grammar(text: string): string {
  return text
    .replace(/\b1 (thing|task|to-do|drift)s\b/g, '1 $1')
    .replace(/\b1 (of them )?are\b/g, '1 $1is')
    .replace(/\bzero (thing|task|to-do)s\b/g, 'zero $1s');
}

/** Task titles keep their own capitalization, in quotes. */
const quoted = (title: string) => `“${title.replace(/[“”"]/g, '')}”`;

function sentenceAware(template: string, key: string, value: string): string {
  return template.replace(new RegExp(`\\{${key}\\}`, 'g'), (_x, offset: number, str: string) =>
    /(^|[.!?]\s+)$/.test(str.slice(0, offset)) ? value.charAt(0).toUpperCase() + value.slice(1) : goalMid(value),
  );
}

export function fill(template: string, c: LineCtx): string {
  const m = Math.max(1, Math.round(c.min));
  let t = sentenceAware(template, 'goal', c.goal || 'your work');
  t = c.top ? t.replace(/\{top\}/g, quoted(c.top)) : sentenceAware(t, 'top', c.goal || 'the first thing on your list');
  return grammar(
    t
    .replace(/(^|[.!?]\s+)\{min\} minutes/g, (_x, pre: string) => `${pre}${m === 1 ? 'A minute' : `${m} minutes`}`)
    .replace(/\{min\} minutes/g, m === 1 ? 'a minute' : `${m} minutes`)
    .replace(/\{site\}/g, c.site)
    .replace(/\{min\}/g, String(m))
    .replace(/\{work\}/g, c.work || 'your work')
    .replace(/\{step\}/g, c.step ?? '')
    .replace(/\{n\}/g, String(c.n ?? 5))
    .replace(/\{focus\}/g, String(c.focus ?? 0))
    .replace(/\{tasks\}/g, String(c.tasks ?? 0))
    .replace(/\{overdue\}/g, String(c.overdue ?? 0))
    .replace(/\s+/g, ' ')
    .trim(),
  );
}

export function levelLine(level: 1 | 2 | 3 | 4, persona: Persona, c: LineCtx): string {
  const mine = own(`level${level}` as CoachLineKind, persona, c);
  if (mine) return fill(mine, c);
  const pool = [...LEVEL[level][persona]];
  if (level > 1 && (c.tasks ?? 0) > 0 && c.top) pool.push(...TASK_LEVEL[level as 2 | 3 | 4][persona]);
  return fill(pick(`L${level}:${persona}`, pool), c);
}

export function repeatLine(persona: Persona, c: LineCtx): string {
  const mine = own('repeat', persona, c);
  if (mine) return fill(mine, c);
  return fill(pick(`R:${persona}`, REPEAT[persona]), c);
}

export function confirmLine(option: RouteOption | 'self', persona: Persona, c: LineCtx): string {
  const mine = own(option, persona, c);
  if (mine) return fill(mine, c);
  return fill(pick(`C:${option}:${persona}`, CONFIRM[option][persona]), c);
}

export function miscLine(kind: 'breakOver' | 'away' | 'halfway' | 'streak' | 'pomodoroBreak', persona: Persona, c: LineCtx): string {
  const mine = own(kind, persona, c);
  if (mine) return fill(mine, c);
  return fill(pick(`M:${kind}:${persona}`, MISC[kind][persona]), c);
}

export function wellbeingLine(c: LineCtx): string {
  return fill(MISC.wellbeing[0], c);
}

export function unclearLine(): string {
  return MISC.unclear[0];
}

function fillTodo(template: string, c: TodoCtx & Partial<RoutineCtx>): string {
  let t = c.top ? template.replace(/\{top\}/g, quoted(c.top)) : sentenceAware(template, 'top', 'the first thing on your list');
  t = c.task ? t.replace(/\{task\}/g, quoted(c.task)) : sentenceAware(t, 'task', 'that');
  return grammar(
    t
    .replace(/\{active\}/g, c.active)
    .replace(/\{done\}/g, c.done === 0 ? 'zero' : String(c.done))
    .replace(/\{open\}/g, String(c.open))
    .replace(/\{overdue\}/g, String(c.overdue))
    .replace(/\{time\}/g, c.time ?? '')
    .replace(/\{hours\}/g, String(c.hours ?? 0))
    .replace(/\{minutes\}/g, String(c.minutes ?? 50))
    .replace(/\s+/g, ' ')
    .trim(),
  );
}

export function roastLine(severity: 1 | 2 | 3, persona: Persona, c: TodoCtx): string {
  const mine = own(`roast${severity}` as CoachLineKind, persona, c);
  if (mine) {
    // Their own add-on, or none: a built-in sentence would switch voices mid-line.
    const tail = c.overdue > 0 ? own('overdue', persona) : null;
    return fillTodo(tail ? `${mine} ${tail}` : mine, c);
  }
  let line = fillTodo(pick(`T${severity}:${persona}`, ROAST[severity][persona]), c);
  if (c.overdue > 0) line += ' ' + fillTodo(pick(`TO:${persona}`, OVERDUE_TAIL[persona]), c);
  return line;
}

export function winLine(persona: Persona, c: TodoCtx): string {
  const mine = own(c.open === 0 ? 'allDone' : 'win', persona, c);
  if (mine) return fillTodo(mine, c);
  if (c.open === 0) return fillTodo(pick(`WA:${persona}`, ALL_DONE[persona]), c);
  return fillTodo(pick(`W:${persona}`, WIN[persona]), c);
}

export function routineLine(kind: RoutineKind, persona: Persona, c: RoutineCtx): string {
  if (kind === 'custom') return c.message || 'Reminder.';
  // Kickoff and deep work without a to-do need a line that doesn't name one.
  const mine = own(kind, persona, c, kind === 'kickoff' || kind === 'deepwork');
  if (mine) return fillTodo(mine, c);
  const bank = ROUTINE[kind];
  let pool = persona === 'sassy' ? bank.sassy : bank.other;
  if (kind === 'bedtime' && c.followUp) pool = persona === 'sassy' ? [bank.sassy[2], bank.sassy[1]] : bank.other;
  if ((kind === 'kickoff' || kind === 'deepwork') && !c.top) {
    return persona === 'sassy'
      ? 'Morning. Your to-do list is empty, which is either amazing or a lie. What are we locking in on?'
      : 'Good morning. What do you want to lock in on first?';
  }
  return fillTodo(pick(`RT:${kind}:${persona}`, pool), c);
}

/** A line filled in with example values, to hear it before the coach uses it. */
export function exampleLine(kind: CoachLineKind, template: string): string {
  const g = LINE_SPECS[kind]?.group;
  return g === 'todos' || g === 'routines' ? fillTodo(template, { ...EXAMPLE_VALUES.todo }) : fill(template, { ...EXAMPLE_VALUES.line });
}

/** "2 hours 10 minutes", "45 minutes". */
export function spokenDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} minute${r === 1 ? '' : 's'}`;
  const hs = `${h} hour${h === 1 ? '' : 's'}`;
  return r ? `${hs} ${r} minute${r === 1 ? '' : 's'}` : hs;
}

/** Keyword fallback for spoken or typed replies when there is no Claude key. */
export function parseReply(text: string): RouteOption | 'wellbeing' | null {
  const t = text.toLowerCase();
  if (/\b(unwell|sick|overwhelm\w*|anxious|anxiety|panic\w*|crying|exhausted|burn(ed|t)? out|sad|depressed|not okay|not ok)\b/.test(t)) return 'wellbeing';
  if (/\b(end (the |this )?session|stop (the |this )?session|quit|i'?m done|done for (today|now|the day))\b/.test(t)) return 'end';
  if (/\b(break|rest|pause|breather)\b/.test(t)) return 'break';
  if (/\b(this is work|it'?s work|for work|research|tutorial|it'?s for|work related|relevant)\b/.test(t)) return 'is_work';
  if (/\b(starter|small step|first step|tiny|where do i start|don'?t know where)\b/.test(t)) return 'starter';
  if (/\b(talk|stuck|blocked|help|hard|confused)\b/.test(t)) return 'talk';
  if (/\b(back|ok|okay|fine|going|sorry|yes|yeah|yep|on it|alright|sure)\b/.test(t)) return 'back';
  return null;
}
