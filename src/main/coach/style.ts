// The coach made from someone you know, while it is the active coach. Lines, prompts and the
// talk agent read it from here, so every built-in persona keeps working unchanged without one.
import type { CoachLineKind, CoachLines, CustomCoach, Persona } from '../../shared/types';

export interface ActiveStyle {
  id: string;
  name: string;
  relation: string;
  /** The built-in personality they push like. Lines are theirs only while this one is in use. */
  base: Persona;
  persona: string;
  lines: CoachLines;
  /** "Mandarin with some English", or '' for English. */
  language: string;
  /** ISO 639-1 code for the voice agent ('en' when unknown). */
  languageCode: string;
  callsYou: string[];
  catchphrases: string[];
}

let current: ActiveStyle | null = null;

export function setActiveStyle(s: ActiveStyle | null): void {
  current = s;
}

export function activeStyle(): ActiveStyle | null {
  return current;
}

/** Their lines for a moment, when they're the coach and the coach is in their usual mood. */
export function styleLines(kind: CoachLineKind, persona: Persona): string[] | null {
  const s = current;
  if (!s || s.base !== persona) return null;
  const lines = s.lines[kind];
  return lines && lines.length ? lines : null;
}

/** How a coach made from someone talks, for Claude and the voice agent. */
export function describeStyle(c: Pick<CustomCoach, 'name' | 'relation' | 'notes' | 'style'>): string {
  const who = `${c.name}${c.relation ? `, the user's ${c.relation.replace(/^(my|our)\s+/i, '')}` : ''}`;
  const body = c.style?.persona?.trim() || c.notes.trim().slice(0, 900);
  return `${who}. ${body}`.replace(/\s+/g, ' ').trim();
}

export function toActiveStyle(c: CustomCoach): ActiveStyle {
  const lang = (c.language || c.style?.language || '').trim();
  return {
    id: c.id,
    name: c.name,
    relation: c.relation,
    base: c.base,
    persona: describeStyle(c),
    lines: c.lines,
    language: /^english\b/i.test(lang) ? '' : lang,
    languageCode: languageCode(c.language) ?? c.style?.languageCode ?? 'en',
    callsYou: c.style?.callsYou ?? [],
    catchphrases: c.style?.catchphrases ?? [],
  };
}

const CODES: Record<string, string> = {
  english: 'en', chinese: 'zh', mandarin: 'zh', cantonese: 'zh', 中文: 'zh', 普通话: 'zh', 粤语: 'zh', spanish: 'es', french: 'fr', german: 'de', italian: 'it',
  portuguese: 'pt', japanese: 'ja', korean: 'ko', hindi: 'hi', russian: 'ru', vietnamese: 'vi', arabic: 'ar', turkish: 'tr', dutch: 'nl', polish: 'pl', tagalog: 'tl', indonesian: 'id', thai: 'th',
};
const ISO3: Record<string, string> = { eng: 'en', zho: 'zh', cmn: 'zh', yue: 'zh', spa: 'es', fra: 'fr', deu: 'de', ita: 'it', por: 'pt', jpn: 'ja', kor: 'ko', hin: 'hi', rus: 'ru', vie: 'vi', ara: 'ar', tur: 'tr', nld: 'nl', pol: 'pl', tgl: 'tl', fil: 'tl', ind: 'id', tha: 'th' };

/** "Mandarin with English" → "zh", "eng" → "en"; null when it can't tell. */
export function languageCode(v: string | undefined): string | null {
  const t = (v ?? '').trim().toLowerCase();
  if (!t) return null;
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(t)) return t.slice(0, 2);
  if (ISO3[t]) return ISO3[t];
  // The language it starts with wins: "Mandarin with English words" is Mandarin.
  for (const [name, code] of Object.entries(CODES)) if (t.startsWith(name)) return code;
  for (const [name, code] of Object.entries(CODES)) if (t.includes(name)) return code;
  return null;
}
