// Coaches made from someone you know. You feed Lock In recordings of them (voice memos, calls,
// meetings) and things they wrote; ElevenLabs turns the recordings into words and tells the
// voices apart, you say which voice is them, and Claude distills how they talk into the coach's
// lines. With a minute or two of their voice, and their say-so, ElevenLabs can copy the voice too.
//
// Everything lives in Lock In's data folder (coaches/<id>/): the coach, one transcript per
// source, and a copy of each recording. Recordings are only ever sent to ElevenLabs, and the
// words only to Claude, both with your own keys.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { CoachLineKind, CoachLines, CoachReadiness, CoachSource, CoachSpeaker, CoachStyle, CustomCoach, CustomCoachView, Persona, Settings } from '../../shared/types';
import { LINE_KINDS, LINE_SPECS, PLACEHOLDERS, lineProblem } from '../../shared/coachlines';
import { cleanSpoken, type Claude } from './llm';
import { languageCode } from './style';

const API = 'https://api.elevenlabs.io';

/** Their words needed for a first sketch, for "sounds like them", and for "spot on". */
export const WORDS = { sketch: 150, good: 800, great: 3000 };
/** Seconds of their voice ElevenLabs needs to copy it, and the amount it works best with. */
export const VOICE_SEC = { min: 60, good: 120, max: 180 };
const NOTE_WORDS_TO_DISTILL = 30;
/** Recordings bigger than this are not copied into the data folder (the original is used). */
const COPY_LIMIT = 150 * 1024 * 1024;
const UPLOAD_LIMIT = 500 * 1024 * 1024;

export const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'opus', 'webm', 'flac', 'mp4', 'mov', 'm4v', 'caf', 'aiff', 'aif', 'amr', '3gp', 'wma', 'mkv']);
export const TEXT_EXT = new Set(['txt', 'md', 'csv', 'srt', 'vtt', 'eml', 'html', 'htm']);
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', webm: 'audio/webm', flac: 'audio/flac',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', caf: 'audio/x-caf', aiff: 'audio/aiff', aif: 'audio/aiff', amr: 'audio/amr', '3gp': 'video/3gpp', wma: 'audio/x-ms-wma', mkv: 'video/x-matroska',
};
export const mimeOf = (file: string) => MIME[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

// ---- words ------------------------------------------------------------------------

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/g;

/** Words in any language (Chinese, Japanese and Korean count about 1.5 characters a word). */
export function countWords(t: string): number {
  const cjk = (t.match(CJK) ?? []).length;
  const rest = (t.replace(CJK, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return rest + Math.round(cjk / 1.5);
}

// ---- transcripts --------------------------------------------------------------------

/** One stretch of one person talking. */
export interface Turn {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language?: string;
  turns: Turn[];
}

export interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  type?: 'word' | 'spacing' | 'audio_event' | string;
  speaker_id?: string;
}

const isCjkChar = (ch: string) => /[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(ch);

/** ElevenLabs' word list → turns: a new turn when the speaker changes or after a 2-second pause. */
export function turnsFromWords(words: ScribeWord[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let prev = '';
  const close = () => {
    if (cur) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      if (cur.text) turns.push(cur);
    }
  };
  for (const w of words) {
    if (!w || typeof w.text !== 'string' || w.type === 'audio_event') continue;
    if (w.type === 'spacing') {
      if (cur) cur.text += w.text;
      prev = 'spacing';
      continue;
    }
    const sp = w.speaker_id || 'speaker_0';
    const start: number = Number(w.start ?? cur?.end ?? 0);
    const end: number = Math.max(start, Number(w.end ?? start));
    if (!cur || cur.speaker !== sp || start - cur.end > 2) {
      close();
      cur = { speaker: sp, start, end, text: w.text };
    } else {
      // Some answers have no spacing entries: put a space between words that need one.
      const last = cur.text.slice(-1);
      const first = w.text.charAt(0);
      if (prev === 'word' && /[\p{L}\p{N}]/u.test(last) && /[\p{L}\p{N}]/u.test(first) && !isCjkChar(last) && !isCjkChar(first)) cur.text += ' ';
      cur.text += w.text;
      cur.end = Math.max(cur.end, end);
    }
    prev = 'word';
  }
  close();
  return turns;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** Every voice in a recording, most talkative first, with a few lines each to recognise them by. */
export function speakerStats(turns: Turn[]): CoachSpeaker[] {
  const by = new Map<string, Turn[]>();
  for (const t of turns) by.set(t.speaker, [...(by.get(t.speaker) ?? []), t]);
  return [...by.entries()]
    .map(([id, ts]) => {
      const good = ts.filter((t) => t.text.length >= 12);
      const pool = good.length >= 3 ? good : ts;
      const quotes: string[] = [];
      for (const i of [0.15, 0.5, 0.85]) {
        const q = clip(pool[Math.min(pool.length - 1, Math.floor(pool.length * i))].text, 140);
        if (!quotes.includes(q)) quotes.push(q);
      }
      return {
        id,
        words: ts.reduce((n, t) => n + countWords(t.text), 0),
        seconds: Math.round(ts.reduce((n, t) => n + (t.end - t.start), 0)),
        quotes,
      };
    })
    .sort((a, b) => b.seconds - a.seconds || b.words - a.words);
}

/** Pasted or imported text: subtitles and web pages lose their timestamps and tags. */
export function cleanText(raw: string, ext = 'txt'): string {
  let t = raw.replace(/\r\n?/g, '\n');
  if (ext === 'srt' || ext === 'vtt') {
    t = t
      .split('\n')
      .filter((l) => !/^\s*\d+\s*$/.test(l) && !/-->/.test(l) && !/^WEBVTT/.test(l) && !/^(NOTE|STYLE)\b/.test(l))
      .join('\n');
  }
  if (ext === 'html' || ext === 'htm') {
    t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }
  return t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 400_000);
}

// ---- readiness --------------------------------------------------------------------

export function readiness(c: CustomCoach): CoachReadiness {
  const ready = c.sources.filter((s) => s.status === 'ready');
  const words = ready.reduce((n, s) => n + s.words, 0);
  const noteWords = countWords(c.notes);
  const theirSec = Math.round(ready.reduce((n, s) => n + (s.kind === 'recording' ? s.theirSec ?? 0 : 0), 0));
  return {
    words,
    noteWords,
    theirSec,
    style: words >= WORDS.great ? 'great' : words >= WORDS.good ? 'good' : words >= WORDS.sketch ? 'sketch' : 'empty',
    canDistill: words >= WORDS.sketch || noteWords >= NOTE_WORDS_TO_DISTILL,
    canClone: theirSec >= VOICE_SEC.min,
    newWords: c.distilledAt ? Math.max(0, words - (c.distilledWords ?? 0)) : words,
    pending: c.sources.filter((s) => s.status === 'waiting' || s.status === 'transcribing').length,
    pickSpeaker: c.sources.filter((s) => s.status === 'pick-speaker').length,
  };
}

// ---- distilling -----------------------------------------------------------------------

const BASE_PUSH: Record<Persona, string> = {
  gentle: 'a gentle friend: warm, never harsh',
  firm: 'a firm coach: direct and short, no small talk',
  sassy: 'a sassy best friend: teasing, dramatic, funny',
  drill: 'a drill sergeant: loud, fast and relentless',
};

/** Their words for Claude, spread across every source and kept under a budget (characters). */
export function buildMaterial(c: CustomCoach, read: (s: CoachSource) => Transcript | { text: string } | null, budget = 48_000): string {
  const out: string[] = [];
  const notes = c.notes.trim();
  if (notes) out.push(`## What the user says about ${c.name}\n${clip(notes, 4000)}`);
  let left = budget - Math.min(notes.length, 4000);
  const parts = c.sources
    .filter((s) => s.status === 'ready' && s.words > 0)
    .map((s) => {
      const data = read(s);
      const pieces =
        !data ? [] : 'turns' in data ? data.turns.filter((t) => t.speaker === s.speaker).map((t) => t.text) : data.text.split(/\n{2,}|\n(?=\S+:)/).map((p) => p.trim()).filter(Boolean);
      return { s, pieces, size: pieces.reduce((n, p) => n + p.length + 1, 0) };
    })
    .filter((p) => p.pieces.length);
  // Share the budget fairly: small sources whole, big ones sampled from start, middle and end.
  const order = parts.map((_p, i) => i).sort((a, b) => parts[a].size - parts[b].size);
  const alloc = new Array<number>(parts.length).fill(0);
  let count = parts.length;
  for (const i of order) {
    alloc[i] = Math.min(parts[i].size, Math.floor(Math.max(0, left) / count));
    left -= alloc[i];
    count--;
  }
  parts.forEach((p, i) => {
    let text: string;
    if (p.size <= alloc[i]) text = p.pieces.join('\n');
    else {
      const thirds = [0, 1, 2].map((k) => p.pieces.slice(Math.floor((p.pieces.length * k) / 3), Math.floor((p.pieces.length * (k + 1)) / 3)));
      const keep: string[] = [];
      for (const third of thirds) {
        let used = 0;
        for (const piece of third) {
          if (used + piece.length > alloc[i] / 3) break;
          keep.push(piece);
          used += piece.length + 1;
        }
        keep.push('…');
      }
      text = keep.join('\n');
    }
    const what = p.s.kind === 'recording' ? `recording, only ${c.name}'s own words` : 'messages or writing; use only what they wrote';
    out.push(`## ${p.s.title} (${what})\n${text}`);
  });
  return out.join('\n\n');
}

export function distillPrompt(c: CustomCoach, material: string, userName: string): { system: string; prompt: string } {
  const user = userName.trim() || 'the user';
  const rel = c.relation.trim().replace(/^(my|our)\s+/i, '') || 'someone they know';
  const lang = c.language.trim()
    ? `Write every line in ${c.language.trim()}.`
    : 'Write in the language they speak in the material, mixing languages exactly the way they do.';
  const system = `You study how one real person talks and write lines in their voice for Lock In, a focus coach app that speaks out loud to ${user} on their Mac. The person is ${c.name}, ${user}'s ${rel}. ${user} gave you recordings, messages and notes and wants the coach to sound like ${c.name}.

How to work
- Learn only from ${c.name}. Recordings below hold only their speech. In chats or emails, use only what ${c.name} wrote. Notes are ${user}'s own description of them.
- Copy their texture: the words they pick, what they call ${user}, sentence length, humor, how they nag, push and praise, their language and how they mix languages. Reuse their real phrases where they fit.
- Push about as hard as ${BASE_PUSH[c.base]}.
- Keep their warmth. Leave out anything cruel: nothing about looks, weight, intelligence, identity, money or health, no threats, no guilt trips. Tease the habit, never the person.
- Don't invent facts about their life, don't name other people from the material, and don't repeat private details. Pet names and sayings are fine.
- Every line is spoken aloud: one or two short sentences, at most 25 words (about 40 characters in Chinese or Japanese). No emoji, markdown, quotation marks, stage directions or bracketed tags.
- ${lang}
- Words in curly braces are placeholders the app fills in. Use only the ones listed for each moment, spelled exactly and never translated. Where a moment says "needs", every line must contain it.
Answer with one JSON object and nothing else.`;

  const ph = Object.entries(PLACEHOLDERS).map(([k, v]) => `{${k}}: ${v}`).join('\n');
  const moments = LINE_KINDS.map((k) => {
    const s = LINE_SPECS[k];
    return `${k}: ${s.label}. ${s.when} Placeholders: ${s.vars.length ? s.vars.map((v) => `{${v}}`).join(' ') : 'none'}${s.needs ? `; needs ${s.needs.map((v) => `{${v}}`).join(' ')}` : ''}.`;
  }).join('\n');
  const prompt = `# Material about ${c.name}
${material || '(only the notes above)'}

# Placeholders
${ph}

# Moments to write for
${moments}

# Answer format
{
  "summary": "2-3 sentences, for ${user}, on how ${c.name} talks",
  "persona": "60-120 words for an actor playing ${c.name} talking to ${user}: tone, rhythm, signature words, how they push and how they praise, what they call ${user}, language mix",
  "callsYou": ["what ${c.name} calls ${user}"],
  "catchphrases": ["up to 8 short things they really say"],
  "language": "the language or languages they speak, e.g. Mandarin with some English",
  "languageCode": "ISO 639-1 code of their main language, e.g. zh",
  "lines": { "level1": ["line", "line", "line"], "level2": ["…"], "…": ["one entry for every moment above, 3 lines each"] }
}`;
  return { system, prompt };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? clip(v.replace(/\s+/g, ' ').trim(), max) : '');
const strs = (v: unknown, n: number, max: number) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, max)).filter(Boolean))].slice(0, n) : []);

/** A line as it will be spoken: no emoji, quotes or stage directions. */
export function cleanLine(line: string): string {
  return cleanSpoken(String(line).replace(/\p{Extended_Pictographic}|️/gu, '').replace(/^[-•*\d.)\s]+/, '')).replace(/^[「『]|[」』]$/g, '');
}

/** Lines for one moment, cleaned and checked, without repeats. */
export function checkLines(kind: CoachLineKind, lines: unknown, max = 8): { ok: string[]; problems: { line: string; problem: string }[] } {
  const ok: string[] = [];
  const problems: { line: string; problem: string }[] = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    if (typeof raw !== 'string') continue;
    const line = cleanLine(raw);
    if (!line || ok.includes(line)) continue;
    const problem = lineProblem(kind, line);
    if (problem) problems.push({ line, problem });
    else if (ok.length < max) ok.push(line);
  }
  return { ok, problems };
}

/** Claude's answer → their style and lines. Moments you rewrote by hand keep your version. */
export function parseDistilled(text: string, keep: { lines: CoachLines; edited: CoachLineKind[] }): { style: CoachStyle; lines: CoachLines } | null {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const raw = (j.lines ?? {}) as Record<string, unknown>;
  const lines: CoachLines = {};
  for (const k of LINE_KINDS) {
    if (keep.edited.includes(k)) {
      if (keep.lines[k]?.length) lines[k] = keep.lines[k];
      continue;
    }
    const { ok } = checkLines(k, raw[k], 6);
    if (ok.length) lines[k] = ok;
  }
  const persona = str(j.persona, 1400);
  if (!persona && !Object.keys(lines).length) return null;
  const language = str(j.language, 80);
  return {
    style: {
      summary: str(j.summary, 600),
      persona,
      callsYou: strs(j.callsYou, 4, 40),
      catchphrases: strs(j.catchphrases, 8, 80),
      language,
      languageCode: languageCode(str(j.languageCode, 8)) ?? languageCode(language) ?? 'en',
    },
    lines,
  };
}

// ---- voice clips ---------------------------------------------------------------------------

export interface Segment {
  start: number;
  end: number;
}

/**
 * The best stretches of their voice in one recording: their longer turns where nobody talks over
 * them, up to `maxSec` in all, in the order they were said.
 */
export function planClips(turns: Turn[], speaker: string, maxSec: number): Segment[] {
  const others = turns.filter((t) => t.speaker !== speaker);
  const clear = (t: Turn) => !others.some((o) => o.start < t.end && o.end > t.start);
  const cands = turns
    .filter((t) => t.speaker === speaker && t.end - t.start >= 2.5 && clear(t))
    .map((t) => ({ start: Math.max(0, t.start - 0.1), end: Math.min(t.end + 0.15, t.start + 30) }))
    .sort((a, b) => b.end - b.start - (a.end - a.start));
  const out: Segment[] = [];
  let total = 0;
  for (const s of cands) {
    if (total >= maxSec) break;
    out.push(s);
    total += s.end - s.start;
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface ClipFile {
  name: string;
  data: Uint8Array;
  mime: string;
  seconds: number;
}

/** macOS's own converter cuts recordings the page can't open (long ones, .caf, .amr…). */
function avconvert(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/avconvert', args, { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    p.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function cutOnMac(src: string, segs: Segment[], tmp: string): Promise<ClipFile[]> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/avconvert') || !existsSync(src)) return [];
  mkdirSync(tmp, { recursive: true });
  const out: ClipFile[] = [];
  try {
    for (const [i, s] of segs.slice(0, 20).entries()) {
      const file = join(tmp, `clip-${i}.m4a`);
      const ok = await avconvert(['--source', src, '--output', file, '--preset', 'PresetAppleM4A', '--start', s.start.toFixed(2), '--duration', (s.end - s.start).toFixed(2), '--replace']);
      if (ok && existsSync(file)) out.push({ name: `clip-${i}.m4a`, data: readFileSync(file), mime: 'audio/mp4', seconds: s.end - s.start });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

// ---- ElevenLabs errors -----------------------------------------------------------------

export function sttError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401 && !b.includes('permission')) return 'ElevenLabs rejected your key. Paste it again under Keys.';
  if (status === 403 || b.includes('permission')) return 'Your ElevenLabs key needs Speech to Text turned on (elevenlabs.io, Developers, API keys).';
  if (status === 402 || b.includes('quota') || b.includes('credits')) return 'Your ElevenLabs account is out of credits for now.';
  if (status === 413 || b.includes('too large')) return 'That file is too big for ElevenLabs. Export just the audio (QuickTime: File, Export As, Audio Only) and add that.';
  if (status === 429) return 'ElevenLabs is busy. Try again in a minute.';
  if (b.includes('format') || b.includes('decode') || b.includes('unsupported')) return "ElevenLabs couldn't read that file. Try an .m4a, .mp3 or .wav.";
  return `ElevenLabs said no (${status}). ${body.slice(0, 140)}`;
}

export function cloneError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (b.includes('can_not_use_instant_voice_cloning') || b.includes('instant voice clon') || b.includes('subscription') || b.includes('upgrade')) {
    return 'Copying a voice needs a paid ElevenLabs plan (Starter or up). You can still use their words with any voice.';
  }
  if (b.includes('voice_limit') || b.includes('voice limit') || b.includes('slots')) return 'Your ElevenLabs plan has no free voice slots. Remove a voice on elevenlabs.io, then try again.';
  if (status === 401 && !b.includes('permission')) return 'ElevenLabs rejected your key. Paste it again under Keys.';
  if (status === 403 || b.includes('permission')) return 'Your ElevenLabs key needs Voices set to Write (elevenlabs.io, Developers, API keys).';
  if (b.includes('captcha') || b.includes('verification')) return 'ElevenLabs wants to verify this voice. Open elevenlabs.io, Voices, and finish the check there.';
  if (status === 429) return 'ElevenLabs is busy. Try again in a minute.';
  return `ElevenLabs said no (${status}). ${body.slice(0, 160)}`;
}

// ---- the store ------------------------------------------------------------------------

export interface CoachesDeps {
  /** Lock In's data folder; coaches live in coaches/ inside it. */
  dir: string;
  elevenKey: () => string | undefined;
  claude: Pick<Claude, 'available' | 'messages'>;
  settings: () => Settings;
  userName: () => string;
  http?: typeof fetch;
  onChange: (id: string) => void;
  log: (m: string) => void;
  now?: () => number;
}

const newId = () => randomBytes(6).toString('hex');
const ID = /^[a-f0-9]{12}$/;

export class Coaches {
  private queue: Promise<void> = Promise.resolve();
  private busy = new Map<string, string>();
  private errors = new Map<string, string>();
  private cache = new Map<string, CustomCoach>();

  constructor(private d: CoachesDeps) {
    mkdirSync(this.root, { recursive: true });
    // Recordings that were being transcribed when Lock In quit start again.
    for (const c of this.list()) {
      for (const s of c.sources) if (s.kind === 'recording' && (s.status === 'waiting' || s.status === 'transcribing')) this.enqueue(c.id, s.id);
    }
  }

  private get http(): typeof fetch {
    return this.d.http ?? fetch;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  get root(): string {
    return join(this.d.dir, 'coaches');
  }

  private folder(id: string): string {
    if (!ID.test(id)) throw new Error('No such coach.');
    return join(this.root, id);
  }

  // -- reading and writing

  list(): CustomCoach[] {
    const out: CustomCoach[] = [];
    for (const id of existsSync(this.root) ? readdirSync(this.root) : []) {
      if (!ID.test(id)) continue;
      const c = this.get(id);
      if (c) out.push(c);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): CustomCoach | null {
    if (!ID.test(id)) return null;
    const hit = this.cache.get(id);
    if (hit) return hit;
    try {
      const c = JSON.parse(readFileSync(join(this.folder(id), 'coach.json'), 'utf8')) as CustomCoach;
      c.sources ??= [];
      c.lines ??= {};
      c.edited ??= [];
      c.notes ??= '';
      c.language ??= '';
      this.cache.set(id, c);
      return c;
    } catch {
      return null;
    }
  }

  private save(c: CustomCoach, quiet = false): void {
    c.updatedAt = this.now();
    const dir = this.folder(c.id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'coach.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(c, null, 2));
    renameSync(`${file}.tmp`, file);
    this.cache.set(c.id, c);
    if (!quiet) this.d.onChange(c.id);
  }

  private must(id: string): CustomCoach {
    const c = this.get(id);
    if (!c) throw new Error('That coach is gone.');
    return c;
  }

  view(id: string, activeId?: string): CustomCoachView | null {
    const c = this.get(id);
    if (!c) return null;
    return { ...c, readiness: readiness(c), active: c.id === activeId, busy: this.busy.get(id), lastError: this.errors.get(id) };
  }

  private readSource(c: CustomCoach, s: CoachSource): Transcript | { text: string } | null {
    try {
      return JSON.parse(readFileSync(join(this.folder(c.id), `${s.id}.json`), 'utf8')) as Transcript | { text: string };
    } catch {
      return null;
    }
  }

  private writeSource(c: CustomCoach, s: CoachSource, data: Transcript | { text: string }): void {
    const file = join(this.folder(c.id), `${s.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(data));
    renameSync(`${file}.tmp`, file);
  }

  // -- the coach itself

  create(p: { name: string; relation?: string; base?: Persona }): CustomCoach {
    const name = p.name.trim().slice(0, 40) || 'Someone';
    const c: CustomCoach = {
      id: newId(),
      name,
      relation: (p.relation ?? '').trim().slice(0, 60),
      base: p.base ?? 'firm',
      language: '',
      notes: '',
      createdAt: this.now(),
      updatedAt: this.now(),
      sources: [],
      lines: {},
      edited: [],
      useVoice: true,
    };
    this.save(c);
    return c;
  }

  update(id: string, patch: Partial<Pick<CustomCoach, 'name' | 'relation' | 'base' | 'language' | 'notes' | 'useVoice'>> & { persona?: string }): CustomCoach {
    const c = this.must(id);
    if (patch.name !== undefined) c.name = patch.name.trim().slice(0, 40) || c.name;
    if (patch.relation !== undefined) c.relation = patch.relation.trim().slice(0, 60);
    if (patch.base && BASE_PUSH[patch.base]) c.base = patch.base;
    if (patch.language !== undefined) c.language = patch.language.trim().slice(0, 60);
    if (patch.notes !== undefined) c.notes = patch.notes.slice(0, 20_000);
    if (patch.useVoice !== undefined) c.useVoice = !!patch.useVoice;
    if (patch.persona !== undefined) {
      c.style = { summary: '', callsYou: [], catchphrases: [], language: '', languageCode: 'en', ...c.style, persona: patch.persona.trim().slice(0, 1400) };
    }
    this.save(c);
    if (patch.notes !== undefined) this.maybeAutoDistill(c.id);
    return c;
  }

  remove(id: string): void {
    rmSync(this.folder(id), { recursive: true, force: true });
    this.cache.delete(id);
    this.busy.delete(id);
    this.errors.delete(id);
  }

  /** Your own lines for a moment. Empty puts the distilled (or built-in) ones back in charge. */
  setLines(id: string, kind: CoachLineKind, lines: string[]): { ok: string[]; problems: { line: string; problem: string }[] } {
    if (!LINE_SPECS[kind]) throw new Error('No such moment.');
    const c = this.must(id);
    const r = checkLines(kind, lines.map((l) => String(l)), 12);
    if (r.ok.length) c.lines[kind] = r.ok;
    else delete c.lines[kind];
    c.edited = r.ok.length ? [...new Set([...c.edited, kind])] : c.edited.filter((k) => k !== kind);
    this.save(c);
    return r;
  }

  // -- material

  /** Adds recordings and text files. Recordings are transcribed one after another. */
  addFiles(id: string, paths: string[]): { added: number; skipped: { name: string; reason: string }[] } {
    const c = this.must(id);
    const skipped: { name: string; reason: string }[] = [];
    let added = 0;
    for (const path of paths) {
      const name = basename(path);
      const ext = extname(path).slice(1).toLowerCase();
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        skipped.push({ name, reason: "Couldn't open it." });
        continue;
      }
      if (AUDIO_EXT.has(ext)) {
        if (size > UPLOAD_LIMIT) {
          skipped.push({ name, reason: 'Too big (over 500 MB). Export just the audio and add that.' });
          continue;
        }
        const s: CoachSource = { id: newId(), kind: 'recording', title: name, addedAt: this.now(), status: 'waiting', words: 0, originalPath: path };
        if (size <= COPY_LIMIT) {
          mkdirSync(join(this.folder(id), 'audio'), { recursive: true });
          const file = `audio/${s.id}.${ext}`;
          copyFileSync(path, join(this.folder(id), file));
          s.audioFile = file;
        }
        c.sources.push(s);
        this.save(c, true);
        this.enqueue(c.id, s.id);
        added++;
      } else if (TEXT_EXT.has(ext)) {
        try {
          const text = cleanText(readFileSync(path, 'utf8'), ext);
          if (!text) throw new Error('empty');
          this.addTextTo(c, name, text);
          added++;
        } catch {
          skipped.push({ name, reason: 'No text in it.' });
        }
      } else {
        skipped.push({ name, reason: 'Lock In reads recordings (.m4a, .mp3, .wav, .mp4, .mov…) and text (.txt, .md, .srt…).' });
      }
    }
    this.save(c);
    this.maybeAutoDistill(id);
    return { added, skipped };
  }

  addText(id: string, title: string, text: string): CoachSource {
    const c = this.must(id);
    const clean = cleanText(text);
    if (!clean) throw new Error('Paste some of their messages first.');
    const s = this.addTextTo(c, title.trim() || 'Messages', clean);
    this.save(c);
    this.maybeAutoDistill(id);
    return s;
  }

  private addTextTo(c: CustomCoach, title: string, text: string): CoachSource {
    const s: CoachSource = { id: newId(), kind: 'text', title: clip(title, 80), addedAt: this.now(), status: 'ready', words: countWords(text) };
    this.writeSource(c, s, { text });
    c.sources.push(s);
    return s;
  }

  removeSource(id: string, sid: string): void {
    const c = this.must(id);
    const s = c.sources.find((x) => x.id === sid);
    if (!s) return;
    c.sources = c.sources.filter((x) => x.id !== sid);
    rmSync(join(this.folder(id), `${sid}.json`), { force: true });
    if (s.audioFile) rmSync(join(this.folder(id), s.audioFile), { force: true });
    this.save(c);
  }

  /** Which voice in a recording is them (null: none of them). */
  pickSpeaker(id: string, sid: string, speaker: string | null): CoachSource {
    const c = this.must(id);
    const s = c.sources.find((x) => x.id === sid);
    if (!s || s.kind !== 'recording') throw new Error('No such recording.');
    const t = this.readSource(c, s);
    if (!t || !('turns' in t)) throw new Error('That recording has no transcript yet.');
    const theirs = speaker ? t.turns.filter((x) => x.speaker === speaker) : [];
    s.speaker = speaker ?? 'none';
    s.words = theirs.reduce((n, x) => n + countWords(x.text), 0);
    s.theirSec = Math.round(theirs.reduce((n, x) => n + (x.end - x.start), 0));
    s.status = 'ready';
    this.save(c);
    this.maybeAutoDistill(id);
    return s;
  }

  retry(id: string, sid: string): void {
    const c = this.must(id);
    const s = c.sources.find((x) => x.id === sid);
    if (!s || s.kind !== 'recording') return;
    s.status = 'waiting';
    s.error = undefined;
    this.save(c);
    this.enqueue(id, sid);
  }

  private audioPath(c: CustomCoach, s: CoachSource): string | null {
    if (s.audioFile && existsSync(join(this.folder(c.id), s.audioFile))) return join(this.folder(c.id), s.audioFile);
    if (s.originalPath && existsSync(s.originalPath)) return s.originalPath;
    return null;
  }

  /** The recording itself, for cutting their voice out of it on the page. */
  audio(id: string, sid: string): { data: Uint8Array; mime: string } | null {
    const c = this.must(id);
    const s = c.sources.find((x) => x.id === sid);
    const path = s ? this.audioPath(c, s) : null;
    if (!path) return null;
    return { data: new Uint8Array(readFileSync(path)), mime: mimeOf(path) };
  }

  // -- transcribing

  private enqueue(id: string, sid: string): void {
    this.queue = this.queue.then(() => this.transcribe(id, sid)).catch((e) => this.d.log(`[coaches] ${(e as Error).message}`));
  }

  /** Waits for every queued transcription (for tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private async transcribe(id: string, sid: string): Promise<void> {
    const c = this.get(id);
    const s = c?.sources.find((x) => x.id === sid);
    if (!c || !s || s.kind !== 'recording') return;
    s.status = 'transcribing';
    s.error = undefined;
    this.save(c);
    try {
      const t = await this.scribe(c, s);
      this.writeSource(c, s, t);
      s.speakers = speakerStats(t.turns);
      s.seconds = Math.round(Math.max(0, ...t.turns.map((x) => x.end)));
      s.language = t.language;
      const total = s.speakers.reduce((n, x) => n + x.seconds, 0);
      // One voice, or one voice with a few stray seconds of someone else: that's them.
      if (s.speakers.length === 1 || (s.speakers[0].seconds >= total * 0.92 && total - s.speakers[0].seconds < 10)) {
        const only = s.speakers[0];
        s.speaker = only.id;
        s.words = only.words;
        s.theirSec = only.seconds;
        s.status = 'ready';
      } else {
        s.status = 'pick-speaker';
      }
      this.d.log(`[coaches] ${s.title}: ${s.speakers.length} voices, ${s.seconds}s`);
    } catch (e) {
      s.status = 'error';
      s.error = (e as Error).message;
      this.d.log(`[coaches] ${s.title}: ${s.error}`);
    }
    if (!this.get(id)?.sources.some((x) => x.id === sid)) return; // removed meanwhile
    this.save(c);
    this.maybeAutoDistill(id);
  }

  private async scribe(c: CustomCoach, s: CoachSource): Promise<Transcript> {
    const key = this.d.elevenKey();
    if (!key) throw new Error('Add your ElevenLabs key under Keys: it turns recordings into words.');
    const path = this.audioPath(c, s);
    if (!path) throw new Error("Can't find the recording any more. Add it again.");
    const data = readFileSync(path);
    const models = [this.d.settings().sttModel, 'scribe_v1'].filter((m, i, a) => m && a.indexOf(m) === i);
    let lastErr = 'ElevenLabs did not answer.';
    for (const model of models) {
      const form = new FormData();
      form.append('model_id', model);
      form.append('file', new Blob([data], { type: mimeOf(path) }), basename(path));
      form.append('diarize', 'true');
      form.append('timestamps_granularity', 'word');
      form.append('tag_audio_events', 'false');
      let res: Response;
      try {
        res = await this.http(`${API}/v1/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(20 * 60_000) });
      } catch (e) {
        lastErr = (e as Error).name === 'TimeoutError' ? 'ElevenLabs took too long. Try a shorter recording.' : `Couldn't reach ElevenLabs (${(e as Error).message}).`;
        continue;
      }
      const body = await res.text();
      if (!res.ok) {
        lastErr = sttError(res.status, body);
        // An unknown model: try the next one. Anything else won't get better.
        if ((res.status === 400 || res.status === 422) && /model/i.test(body)) continue;
        throw new Error(lastErr);
      }
      const j = JSON.parse(body) as { words?: ScribeWord[]; text?: string; language_code?: string };
      let turns = turnsFromWords(j.words ?? []);
      if (!turns.length && j.text?.trim()) turns = [{ speaker: 'speaker_0', start: 0, end: 0, text: j.text.trim() }];
      if (!turns.length) throw new Error("Couldn't hear any words in it.");
      return { language: j.language_code, turns };
    }
    throw new Error(lastErr);
  }

  // -- distilling

  private maybeAutoDistill(id: string): void {
    const c = this.get(id);
    if (!c || c.distilledAt || this.busy.has(id) || this.errors.has(id) || !this.d.claude.available) return;
    const r = readiness(c);
    // "Once there's enough": the first distill happens by itself.
    if (r.pending === 0 && r.pickSpeaker === 0 && r.words >= WORDS.good) void this.distill(id);
  }

  async distill(id: string): Promise<{ ok: boolean; error?: string }> {
    const c = this.must(id);
    if (this.busy.has(id)) return { ok: false, error: 'Already working on it.' };
    if (!this.d.claude.available) return { ok: false, error: 'Distilling needs your Claude key (under Keys). You can still write their lines yourself below.' };
    const r = readiness(c);
    if (!r.canDistill) return { ok: false, error: `Add a bit more first: about ${WORDS.sketch} of their words, or a few sentences of notes.` };
    this.busy.set(id, 'distilling');
    this.errors.delete(id);
    this.d.onChange(id);
    try {
      const material = buildMaterial(c, (s) => this.readSource(c, s));
      const { system, prompt } = distillPrompt(c, material, this.d.userName());
      const res = await this.d.claude.messages({ model: this.d.settings().coachModel, system, messages: [{ role: 'user', content: prompt }], maxTokens: 8000, timeoutMs: 180_000 });
      const text = res?.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('') ?? '';
      const out = text ? parseDistilled(text, { lines: c.lines, edited: c.edited }) : null;
      if (!out) throw new Error(res ? "Claude's answer didn't make sense. Try again." : "Couldn't reach Claude. Check your key and connection, then try again.");
      const fresh = this.must(id);
      fresh.style = out.style;
      fresh.lines = out.lines;
      fresh.distilledAt = this.now();
      fresh.distilledWords = readiness(fresh).words;
      this.busy.delete(id);
      this.save(fresh);
      this.d.log(`[coaches] distilled ${fresh.name}: ${Object.keys(out.lines).length} moments`);
      return { ok: true };
    } catch (e) {
      this.busy.delete(id);
      this.errors.set(id, (e as Error).message);
      this.d.onChange(id);
      return { ok: false, error: (e as Error).message };
    }
  }

  // -- their voice

  /** Where their voice is in each recording, best stretches first, up to three minutes in all. */
  clipPlan(id: string): { sources: { sid: string; title: string; mime: string; seconds: number; segments: Segment[] }[]; seconds: number } {
    const c = this.must(id);
    let left: number = VOICE_SEC.max;
    const sources: { sid: string; title: string; mime: string; seconds: number; segments: Segment[] }[] = [];
    const recs = c.sources.filter((s) => s.kind === 'recording' && s.status === 'ready' && s.speaker && s.speaker !== 'none' && (s.theirSec ?? 0) > 0).sort((a, b) => (b.theirSec ?? 0) - (a.theirSec ?? 0));
    for (const s of recs) {
      if (left <= 0) break;
      const t = this.readSource(c, s);
      const path = this.audioPath(c, s);
      if (!t || !('turns' in t) || !path) continue;
      const segments = planClips(t.turns, s.speaker!, left);
      const got = segments.reduce((n, x) => n + x.end - x.start, 0);
      if (!segments.length) continue;
      sources.push({ sid: s.id, title: s.title, mime: mimeOf(path), seconds: s.seconds ?? 0, segments });
      left -= got;
    }
    return { sources, seconds: Math.round(VOICE_SEC.max - left) };
  }

  /**
   * Makes a copy of their voice on your ElevenLabs account from clips the page cut (and, for
   * recordings it couldn't open, clips macOS cuts). Only with their consent.
   */
  async cloneVoice(id: string, p: { files: ClipFile[]; macCut?: string[]; consent: boolean }): Promise<{ ok: boolean; error?: string }> {
    const c = this.must(id);
    if (!p.consent) return { ok: false, error: `Tick the box once ${c.name} has said yes.` };
    const key = this.d.elevenKey();
    if (!key) return { ok: false, error: 'Add your ElevenLabs key under Keys first.' };
    if (this.busy.has(id)) return { ok: false, error: 'Already working on it.' };
    this.busy.set(id, 'cloning');
    this.errors.delete(id);
    this.d.onChange(id);
    try {
      const files = [...(p.files ?? [])];
      if (p.macCut?.length) {
        const plan = this.clipPlan(id);
        for (const sid of p.macCut) {
          const src = plan.sources.find((x) => x.sid === sid);
          const s = c.sources.find((x) => x.id === sid);
          const path = s ? this.audioPath(c, s) : null;
          if (src && path) files.push(...(await cutOnMac(path, src.segments, join(this.folder(id), `cut-${sid}`))));
        }
      }
      const seconds = Math.round(files.reduce((n, f) => n + f.seconds, 0));
      if (seconds < 30) throw new Error("Couldn't cut enough of their voice out of the recordings. Add a recording where they talk on their own for a minute or two (a voice memo works).");
      const form = new FormData();
      form.append('name', `${c.name} (Lock In)`.slice(0, 60));
      form.append('description', `Lock In coach voice for ${c.name}, made with their consent.`);
      form.append('remove_background_noise', 'true');
      form.append('labels', JSON.stringify({ source: 'lock-in' }));
      for (const f of files.slice(0, 25)) form.append('files', new Blob([Buffer.from(f.data)], { type: f.mime }), f.name);
      const res = await this.http(`${API}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(120_000) });
      const body = await res.text();
      if (!res.ok) throw new Error(cloneError(res.status, body));
      const j = JSON.parse(body) as { voice_id?: string; requires_verification?: boolean };
      if (!j.voice_id) throw new Error('ElevenLabs did not return a voice.');
      const fresh = this.must(id);
      fresh.voice = { id: j.voice_id, name: `${c.name} (Lock In)`, consentAt: this.now(), madeAt: this.now(), seconds };
      fresh.useVoice = true;
      this.busy.delete(id);
      this.save(fresh);
      this.d.log(`[coaches] made a voice for ${c.name} from ${seconds}s`);
      return { ok: true };
    } catch (e) {
      this.busy.delete(id);
      this.errors.set(id, (e as Error).message);
      this.d.onChange(id);
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Forgets the voice, and deletes it from your ElevenLabs account too. */
  async deleteVoice(id: string): Promise<{ ok: boolean; error?: string }> {
    const c = this.must(id);
    if (!c.voice) return { ok: true };
    const key = this.d.elevenKey();
    if (key) {
      try {
        const res = await this.http(`${API}/v1/voices/${encodeURIComponent(c.voice.id)}`, { method: 'DELETE', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok && res.status !== 404) this.d.log(`[coaches] voice delete ${res.status}`);
      } catch (e) {
        this.d.log(`[coaches] voice delete: ${(e as Error).message}`);
      }
    }
    delete c.voice;
    this.save(c);
    return { ok: true };
  }
}
