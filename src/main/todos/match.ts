// Turning what you say ("I was doing the deck and sent Sam the invoice") into done items,
// and matching them to tasks on your list. Pure functions, unit tested.
import type { Task } from '../../shared/types';

const STOP = new Set(
  'a an the to of for on in at with and or but my our your his her their it its this that these those some any all just really also then so up out off about into from by is was were be been am are do did done doing get got make made stuff things thing bit lot lots kinda kind sort'.split(
    ' ',
  ),
);

/** A crude stem so "fixing", "fixed" and "fixes" meet. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) w = w.slice(0, -1); // "fixx" ← "fixxing" style doubles
  return w;
}

/** Meaningful words, stemmed. CJK text is split into characters pairs so it can still match. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (/\p{Script=Han}/u.test(raw)) {
      const chars = [...raw.replace(/[^\p{Script=Han}]/gu, '')];
      for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
      if (chars.length === 1) out.push(chars[0]);
      const rest = raw.replace(/\p{Script=Han}/gu, ' ').trim();
      if (rest) out.push(...tokens(rest));
      continue;
    }
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** How well something you said covers a task title (0 to 1). */
export function matchScore(said: string, title: string): number {
  const a = new Set(tokens(said));
  const b = [...new Set(tokens(title))];
  if (!a.size || !b.length) return 0;
  const hit = b.filter((w) => a.has(w)).length;
  return hit / b.length;
}

/** The open task you most likely meant, if any is a confident match. */
export function bestMatch(said: string, open: Task[], taken = new Set<string>()): Task | null {
  let best: Task | null = null;
  let bestScore = 0;
  for (const t of open) {
    if (taken.has(t.id)) continue;
    const sc = matchScore(said, t.title);
    const words = new Set(tokens(t.title)).size;
    const need = words <= 1 ? 1 : words === 2 ? 1 : 0.6;
    if (sc >= need && sc > bestScore) {
      best = t;
      bestScore = sc;
    }
  }
  return best;
}

const LEAD = /^(?:(?:so|well|um+|uh+|yeah|yes|ok(?:ay)?|honestly|basically|actually|like|i mean|look)[\s,]+)*(?:(?:i|we)(?:'ve|'d| have| had)?\s+)?(?:was|were|been|have been|had been|am|did|also|just|already|actually|mostly|mainly|finally)?\s*/i;

/** "I was doing the deck and then sent Sam the invoice" → ["The deck", "Sent Sam the invoice"]. */
export function splitDone(text: string): string[] {
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/\s*(?:[,;\n]|\.\s|\.$|\band then\b|\bthen\b|\band also\b|\balso\b|\bplus\b|\band\b(?=\s+(?:i\b|we\b|then\s|did\s|was\s|sent\s|called\s|finished\s|wrote\s|fixed\s|made\s|worked\s|met\s|had\s|went\s|replied\s|emailed\s|reviewed\s|updated\s|cleaned\s|booked\s)))\s*/i);
  const out: string[] = [];
  for (let p of parts) {
    p = p.trim().replace(LEAD, '').trim();
    p = p.replace(/^(?:doing|working on|work on|busy with|on)\s+/i, (m) => (/work/i.test(m) ? 'Worked on ' : ''));
    p = p.replace(/[.!?]+$/, '').trim();
    if (p.length < 3) continue;
    if (/^(?:nothing|not much|stuff|things|random stuff|a lot|everything|idk|i don'?t know|no|nope|yes|yeah|ok|okay|hi|hey|hello|thanks|thank you)$/i.test(p)) continue;
    if (/^(?:i'?m going to|i will|i'll|gonna|going to|i need to|i have to|i should|i want to|i plan to|next i|tomorrow)\b/i.test(p)) continue;
    out.push(p[0].toUpperCase() + p.slice(1));
  }
  return out.slice(0, 10);
}
