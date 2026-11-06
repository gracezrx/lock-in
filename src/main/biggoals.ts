// Big goals: what you're going after ("Fundraise well", "Launch cool side products"), usually
// with an end date. They can't be measured in hours, so Lock In looks for the work that counts
// toward them (to-dos you finish, what you lock in on, meetings) using a short list of words
// that count. When something you keep working on isn't on any list, it asks:
// "Is Lock In one of your cool side products?" Your answer goes on the list.
//
// Pure functions: no Electron, no clock of their own.

export interface DayItem {
  kind: 'todo' | 'session' | 'meeting';
  text: string;
  /** When it happened (ms). */
  at?: number;
  /** Session minutes, meeting minutes. */
  min?: number;
}

/** Words that don't say what a goal is about. */
const STOP = new Set(
  'a an the to and or of for in on at by with from into my our your we i me us it its is be am are this that these those some any more most very really lot lots just also etc so get got do make makes sure can could would will should want keep try well good better best great cool nice new side time times goal goals thing things stuff work working launch ship build start finish run hit grow product products project projects'.split(' '),
);

/** Verbs and filler that start to-dos and meeting titles: "Fix Lock In", "Call with Sequoia". */
const LEAD = new Set(
  'fix send call write finish review update email reply schedule prep prepare make build add redo use check plan draft read meet meeting sync follow book pay buy submit apply post share ship launch test clean set get do new start respond work talk chat catch lunch dinner coffee with and the for about on to of weekly daily team standup quick intro re fw fwd ask tell look find go see try finalize polish edit record'.split(' '),
);

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The words of a goal's title that say what it's about: "Fundraise well" → ["fundraise"]. */
export function seedTerms(title: string): string[] {
  const out: string[] = [];
  for (const w of norm(title).split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
  }
  return out.slice(0, 6);
}

/** "fundraise" also matches fundraising and fundraiser; "investors" matches investor. Names match whole. */
export function termRe(term: string): RegExp {
  const t = norm(term);
  // Not Latin letters (Chinese, say): plain containment.
  if (/[^\x00-\x7f]/.test(t)) return new RegExp(esc(t), 'u');
  const single = !/\s/.test(t);
  if (single && t.length >= 5) {
    const stem = t.replace(/(?:ing|ers|er|ed|es|e|s)$/, '');
    return new RegExp(`(?:^|[^a-z0-9])${esc(stem)}(?:e|es|s|ed|ing|er|ers|ion|ions)?(?![a-z0-9])`);
  }
  return new RegExp(`(?:^|[^a-z0-9])${esc(t).replace(/\s+/g, '\\s+')}(?![a-z0-9])`);
}

export interface BigGoalLike {
  title?: string;
  counts?: string[];
}

/** What counts toward a goal: its list (or the words of its title), and the title itself. */
export function termsOf(g: BigGoalLike): string[] {
  const list = g.counts?.length ? g.counts : seedTerms(g.title ?? '');
  return [...new Set([...(g.title ? [g.title] : []), ...list].map((x) => x.trim()).filter(Boolean))];
}

export function matches(text: string, terms: string[]): boolean {
  const t = norm(text);
  return terms.some((term) => term.trim() && termRe(term).test(t));
}

/** The day's to-dos, sessions and meetings that count toward a goal. */
export function movedItems(g: BigGoalLike, items: DayItem[] | undefined): DayItem[] {
  if (!items?.length) return [];
  const terms = termsOf(g);
  return items.filter((i) => matches(i.text, terms));
}

/** Days from `today` to `until` (both YYYY-MM-DD), counting today: 0 is the last day, negative is past. */
export function daysLeft(today: string, until?: string): number | undefined {
  if (!until || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return undefined;
  const a = new Date(`${today}T12:00:00`).getTime();
  const b = new Date(`${until}T12:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function daysLeftText(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 0) return 'Past its end date';
  if (n === 0) return 'Last day';
  if (n === 1) return '1 day left';
  if (n < 70) return `${n} days left`;
  return `${Math.round(n / 7)} weeks left`;
}

/** Names and projects in a line of text: "Fix Lock In" → ["Lock In"], "Call with Sequoia" → ["Sequoia"]. */
export function thingsIn(text: string): string[] {
  const words = text.split(/[\s:;,.!?()[\]{}"“”'‘’/|–—-]+/).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    while (run.length && LEAD.has(run[0].toLowerCase())) run.shift();
    while (run.length && LEAD.has(run[run.length - 1].toLowerCase())) run.pop();
    const phrase = run.join(' ');
    if (phrase.length >= 3 && phrase.length <= 30 && !out.includes(phrase)) out.push(phrase);
    run = [];
  };
  for (const w of words) {
    // Capitalised words, and short two-letter ones inside a name ("Lock In").
    const cap = /^\p{Lu}/u.test(w) || (run.length > 0 && /^(?:In|On|Of|AI|OS|X)$/.test(w));
    if (cap && !/^\d/.test(w)) run.push(w);
    else flush();
  }
  flush();
  return out;
}

export interface Thing {
  term: string;
  /** Days it came up on, out of the last week. */
  days: number;
  /** A few of the lines it came up in. */
  examples: string[];
}

/** Things you keep working on (2 days or more in the last week) that aren't part of any goal yet. */
export function recurringThings(byDay: DayItem[][], goals: (BigGoalLike & { notCounts?: string[] })[], ignored: string[]): Thing[] {
  const seen = new Map<string, Thing & { daySet: Set<number> }>();
  byDay.forEach((items, d) => {
    for (const i of items)
      for (const term of thingsIn(i.text)) {
        const key = norm(term);
        const t = seen.get(key) ?? { term, days: 0, examples: [], daySet: new Set<number>() };
        t.daySet.add(d);
        if (t.examples.length < 3 && !t.examples.includes(i.text)) t.examples.push(i.text);
        seen.set(key, t);
      }
  });
  const skip = new Set(ignored.map(norm));
  return [...seen.entries()]
    .map(([key, t]) => ({ key, term: t.term, days: t.daySet.size, examples: t.examples }))
    .filter((t) => t.days >= 2 && !skip.has(t.key))
    // Already counts toward a goal (by its list or its title), or you said it doesn't for every goal.
    .filter((t) => !goals.some((g) => matches(t.term, termsOf(g))))
    .filter((t) => !goals.length || !goals.every((g) => (g.notCounts ?? []).some((n) => norm(n) === t.key)))
    .sort((a, b) => b.days - a.days || a.term.localeCompare(b.term))
    .map(({ term, days, examples }) => ({ term, days, examples }));
}

export interface Question {
  id: string;
  term: string;
  /** The goals it might belong to (one when Lock In or the coach has a good guess). */
  goalIds: string[];
  text: string;
  evidence: string;
}

const short = (s: string, n = 34) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** "Is “Lock In” part of “Launch cool side products”?" — or, with several goals and no guess, "Which goal…". */
export function questionFor(t: Thing, goals: { id: string; title?: string; notCounts?: string[] }[], guess?: { goalId: string; text?: string }): Question | null {
  const open = goals.filter((g) => !(g.notCounts ?? []).some((n) => norm(n) === norm(t.term)));
  if (!open.length) return null;
  const pick = guess ? open.filter((g) => g.id === guess.goalId) : open.length === 1 ? open : [];
  const ex = t.examples.slice(0, 2).map((e) => `“${short(e, 40)}”`).join(', ');
  const evidence = `You came back to “${t.term}” on ${t.days} days this week${ex ? `: ${ex}` : ''}.`;
  const id = `q:${norm(t.term)}`;
  if (pick.length === 1) return { id, term: t.term, goalIds: [pick[0].id], text: guess?.text?.trim() || `Is “${t.term}” part of “${pick[0].title}”?`, evidence };
  if (guess) return null;
  return { id, term: t.term, goalIds: open.map((g) => g.id), text: `Is “${t.term}” part of one of your goals?`, evidence };
}

// ---- common goals, without a Claude key ---------------------------------------------------------------

interface Theme {
  /** Goals about this: matched against the title and why. */
  about: RegExp;
  /** Words that usually count toward it. */
  terms: string[];
  /** Words in a to-do or session that suggest the work belongs to it. */
  cues: RegExp;
}

const THEMES: Theme[] = [
  { about: /\b(fundrais\w*|raise|raising|investors?|seed round|series [a-c]|vc)\b/i, terms: ['investors', 'VC', 'pitch', 'deck', 'term sheet', 'data room', 'angel'], cues: /\b(investor|pitch|deck|vc|raise|fundrais|term sheet|data room|angel)/i },
  { about: /\b(products?|launch\w*|ship|side projects?|apps?)\b/i, terms: ['side project', 'prototype', 'landing page', 'Product Hunt', 'beta', 'waitlist'], cues: /\b(ship|launch|release|fix|build|beta|onboarding|feature|bug|landing|v\d|prototype|demo|mvp)/i },
  { about: /\b(hire|hiring|recruit\w*|team)\b/i, terms: ['interview', 'candidate', 'hiring', 'recruit'], cues: /\b(interview|candidate|hire|hiring|recruit)/i },
  { about: /\b(users?|customers?|sales|revenue|growth|clients?)\b/i, terms: ['customers', 'users', 'sales', 'leads', 'outreach', 'pipeline'], cues: /\b(customer|user|sales|lead|outreach|pipeline|client)/i },
  { about: /\b(jobs?|internships?|recruiting|career)\b/i, terms: ['application', 'interview', 'resume', 'cover letter', 'networking', 'coffee chat'], cues: /\b(application|apply|interview|resume|cover letter|coffee chat|networking)/i },
  { about: /\b(health|healthy|fitness|fit|gym|running|run|exercise|sleep|weight)\b/i, terms: ['gym', 'run', 'workout', 'yoga', 'walk'], cues: /\b(gym|run|workout|yoga|walk|swim)\b/i },
  { about: /\b(write|writing|book|blog|essay|newsletter)\b/i, terms: ['draft', 'writing', 'essay', 'chapter', 'newsletter'], cues: /\b(draft|write|writing|essay|chapter|post)\b/i },
  { about: /\b(study|studies|exams?|class|classes|course|thesis|school|grades|gpa)\b/i, terms: ['study', 'exam', 'problem set', 'pset', 'lecture', 'thesis'], cues: /\b(study|exam|pset|problem set|lecture|thesis|homework)/i },
];

const themesOf = (g: { title?: string; why?: string }) => THEMES.filter((t) => t.about.test(`${g.title ?? ''} ${g.why ?? ''}`));

/** Words that usually count toward goals like this one ("Fundraise well" → investors, pitch, deck…). */
export function themeTerms(title: string, why?: string): string[] {
  return [...new Set(themesOf({ title, why }).flatMap((t) => t.terms))];
}

/** Without the coach: the one goal a thing probably belongs to, from the words around it ("Ship Lock In 1.2" → a product goal). */
export function guessGoal(t: Thing, goals: { id: string; title?: string; why?: string }[]): string | undefined {
  const lines = t.examples.map((e) => e.replace(new RegExp(esc(t.term), 'gi'), ' '));
  const hits = goals.filter((g) => themesOf(g).some((th) => lines.some((l) => th.cues.test(l))));
  return hits.length === 1 ? hits[0].id : undefined;
}

// ---- the coach's help (only with a Claude key) ----------------------------------------------------

export const TERMS_SYSTEM = `You help a focus app recognise work that counts toward someone's big goal. Given the goal, list 6 to 12 short words or names that would appear in their to-dos, calendar events or work sessions when they work on it (for "Fundraise well": investors, pitch deck, VC, term sheet, data room, and any firm or person names they mention). Prefer specific nouns over verbs. Answer with a JSON array of strings only.`;

export function termsPrompt(title: string, why: string | undefined, role: string, recent: string[]): string {
  return `Goal: ${title}${why ? `\nWhy: ${why}` : ''}\nTheir role: ${role}${recent.length ? `\nThings they've worked on lately: ${recent.slice(0, 20).join('; ')}` : ''}`;
}

/** Claude's list, checked: short strings, no duplicates, at most 12. */
export function parseTerms(text: string): string[] {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  try {
    const raw = JSON.parse(text.slice(a, b + 1)) as unknown;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const x of raw) {
      const s = typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '';
      if (s.length >= 2 && s.length <= 30 && !out.some((o) => norm(o) === norm(s))) out.push(s);
    }
    return out.slice(0, 12);
  } catch {
    return [];
  }
}

export const LINK_SYSTEM = `You help a focus app keep someone's big goals in view. For each thing they keep working on, decide which of their goals it most likely belongs to, or none. Only link when it's likely. For each link, write one short, friendly yes/no question to ask them, in second person, like "Is Lock In one of your cool side products?". Answer with JSON only: [{"term":"…","goal":"<goal id or null>","question":"…"}]`;

export function linkPrompt(goals: { id: string; title?: string; why?: string }[], things: Thing[]): string {
  return `Goals:\n${goals.map((g) => `- ${g.id}: ${g.title}${g.why ? ` (why: ${g.why})` : ''}`).join('\n')}\n\nThings they keep working on:\n${things.map((t) => `- ${t.term} (${t.days} days; e.g. ${t.examples.join('; ')})`).join('\n')}`;
}

export function parseLinks(text: string, goalIds: string[]): Record<string, { goalId: string | null; text?: string }> {
  const a = text.indexOf('[');
  const b = text.lastIndexOf(']');
  const out: Record<string, { goalId: string | null; text?: string }> = {};
  if (a < 0 || b <= a) return out;
  try {
    const raw = JSON.parse(text.slice(a, b + 1)) as unknown;
    if (!Array.isArray(raw)) return out;
    for (const r of raw as Record<string, unknown>[]) {
      const term = typeof r?.term === 'string' ? r.term.trim() : '';
      if (!term) continue;
      const goal = typeof r.goal === 'string' && goalIds.includes(r.goal) ? r.goal : null;
      const q = typeof r.question === 'string' ? r.question.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
      out[norm(term)] = { goalId: goal, text: goal && q.endsWith('?') ? q : undefined };
    }
  } catch {
    /* nothing usable */
  }
  return out;
}

export const termKey = norm;
