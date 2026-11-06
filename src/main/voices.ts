// Choosing the coach's voice: a few hand-picked natural ElevenLabs voices, the voices on your
// own ElevenLabs account, and a search of the public ElevenLabs Voice Library. The key stays in
// the main process; the page only sees names, descriptions and ids.
import type { Persona, VoiceOption } from '../shared/types';

const API = 'https://api.elevenlabs.io';

/** ElevenLabs default voices that sound most like a person talking to you (every account has them). */
export const PICKS: { id: string; name: string; vibe: string; accent: string; gender: string }[] = [
  { id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', vibe: 'Young, playful and a little extra. Built for sass.', accent: 'American', gender: 'female' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', vibe: 'Warm and confident, like a friend who believes in you.', accent: 'American', gender: 'female' },
  { id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura', vibe: 'Sunny and quirky. Roasts you with a smile.', accent: 'American', gender: 'female' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', vibe: 'Velvety British. Disappointed in you, elegantly.', accent: 'British', gender: 'female' },
  { id: 'SAz9YHcvj6GT2YYXdXww', name: 'River', vibe: 'Relaxed and easy to talk to. Great for live chats.', accent: 'American', gender: 'neutral' },
  { id: 'bIHbv24MWmeRgasZH58o', name: 'Will', vibe: 'Laid-back and conversational.', accent: 'American', gender: 'male' },
  { id: 'iP95p4xoKVk53GoZ742B', name: 'Chris', vibe: 'Natural and down-to-earth. No nonsense.', accent: 'American', gender: 'male' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', vibe: 'Energetic Australian. Hypes you up.', accent: 'Australian', gender: 'male' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', vibe: 'Brash and confident. Drill sergeant energy.', accent: 'American', gender: 'male' },
];

/** The pick that suits each coach personality. */
export const SUGGESTED: Record<Persona, string> = {
  sassy: 'cgSgspJ2msm6clMCkdW9',
  gentle: 'EXAVITQu4vr4xnSDxMaL',
  firm: 'iP95p4xoKVk53GoZ742B',
  drill: 'pNInz6obpgDQGcFmaJgB',
};

/** What the coach says when you preview a voice, so you hear it as your coach. */
export function previewLine(persona: Persona, name?: string): string {
  const n = name?.trim();
  switch (persona) {
    case 'gentle':
      return `Hi${n ? ` ${n}` : ''}, it's your Lock In coach. Looks like you drifted a little. Want to get back to the deck together?`;
    case 'firm':
      return `${n ? `${n}, it's` : "It's"} your Lock In coach. You're off task. Close the tab and get back to the deck.`;
    case 'drill':
      return `${n ? `${n}! ` : ''}Lock In coach! Off YouTube, right now! Back to work!`;
    default:
      return `Hey${n ? ` ${n}` : ''}, it's your Lock In coach. Twenty minutes on YouTube? Cute. Back to the deck, babe.`;
  }
}

type Json = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const cap = (v: string) => (v ? v[0].toUpperCase() + v.slice(1) : v);
/** "american" → "American", "en-us" stays readable, junk is dropped. */
const label = (v: unknown) => cap(s(v).replace(/[_-]+/g, ' ').trim());

/** A one-line description from ElevenLabs' labels when the voice has no description of its own. */
export function describe(v: { description?: string; labels?: Record<string, string>; descriptive?: string; use_case?: string; age?: string }): string {
  const d = s(v.description).replace(/\s+/g, ' ').trim();
  if (d) return d.length > 110 ? `${d.slice(0, 107).trimEnd()}…` : d;
  const l = v.labels ?? {};
  const bits = [v.descriptive ?? l.descriptive ?? l.description, v.age ?? l.age, v.use_case ?? l.use_case ?? l['use case']].map(label).filter(Boolean);
  return bits.join(', ');
}

const KIND: Record<string, string> = {
  cloned: 'A voice you cloned.',
  generated: 'A voice you designed.',
  professional: 'Saved from the Voice Library.',
};

/** A voice from your account (GET /v2/voices). */
export function fromAccount(v: Json): VoiceOption {
  const labels = (v.labels as Record<string, string>) ?? {};
  const category = s(v.category);
  return {
    id: s(v.voice_id),
    name: s(v.name).split(' - ')[0].trim() || 'Voice',
    vibe: describe({ description: s(v.description), labels }) || KIND[category] || '',
    accent: label(labels.accent) || undefined,
    gender: label(labels.gender).toLowerCase() || undefined,
    previewUrl: s(v.preview_url) || undefined,
    source: category === 'premade' ? 'pick' : 'mine',
    category,
  };
}

/** A voice from the public Voice Library (GET /v1/shared-voices). */
export function fromLibrary(v: Json): VoiceOption {
  return {
    id: s(v.voice_id),
    name: s(v.name).split(' - ')[0].trim() || 'Voice',
    vibe: describe({ description: s(v.description), descriptive: s(v.descriptive), use_case: s(v.use_case), age: s(v.age) }),
    accent: label(v.accent) || undefined,
    gender: label(v.gender).toLowerCase() || undefined,
    previewUrl: s(v.preview_url) || undefined,
    source: 'library',
    ownerId: s(v.public_owner_id) || undefined,
    added: v.is_added_by_user === true,
    paidOnly: v.free_users_allowed === false,
    uses: typeof v.cloned_by_count === 'number' ? v.cloned_by_count : undefined,
  };
}

export interface LibraryQuery {
  search?: string;
  gender?: string;
  accent?: string;
  page?: number;
}

/** The Voice Library request: natural English voices people actually use for conversations. */
export function libraryUrl(q: LibraryQuery, pageSize = 12): string {
  const p = new URLSearchParams({ page_size: String(pageSize), language: 'en', sort: 'trending' });
  const search = q.search?.trim();
  if (search) p.set('search', search.slice(0, 80));
  else p.set('use_cases', 'conversational');
  if (q.gender) p.set('gender', q.gender);
  if (q.accent) p.set('accent', q.accent);
  if (q.page) p.set('page', String(q.page));
  return `${API}/v1/shared-voices?${p}`;
}

/** Only ElevenLabs' own sample files are fetched for previews. */
export function safeSampleUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (/(^|\.)elevenlabs\.io$/.test(u.hostname) || u.hostname === 'storage.googleapis.com');
  } catch {
    return false;
  }
}

export function voiceError(status: number, body: string, action: 'list' | 'search' | 'add'): string {
  const b = body.toLowerCase();
  if (status === 401 && !b.includes('permission')) return 'ElevenLabs rejected your key. Paste it again under Keys.';
  if (status === 403 || b.includes('permission') || b.includes('missing_permissions')) {
    return action === 'add'
      ? 'Your ElevenLabs key can read voices but not add them. Either set Voices to Write on the key (elevenlabs.io, Developers, API keys), or open the voice on elevenlabs.io and press "Add to my voices"; it then shows up under Your ElevenLabs voices.'
      : 'Your ElevenLabs key needs Voices set to Read (elevenlabs.io, Developers, API keys).';
  }
  if (status === 429) return 'ElevenLabs is busy. Try again in a minute.';
  if (b.includes('voice_limit') || b.includes('voice limit') || b.includes('slots')) return 'Your ElevenLabs plan has no free voice slots. Remove a voice on elevenlabs.io, then try again.';
  return `ElevenLabs said no (${status}). ${body.slice(0, 140)}`;
}

export interface CatalogDeps {
  key: () => string | undefined;
  http?: typeof fetch;
  log: (m: string) => void;
}

export interface VoiceList {
  hasKey: boolean;
  picks: VoiceOption[];
  mine: VoiceOption[];
  error?: string;
}

export class VoiceCatalog {
  private cache: { at: number; list: VoiceList } | null = null;

  constructor(private d: CatalogDeps) {}

  private get http(): typeof fetch {
    return this.d.http ?? fetch;
  }

  private async get(path: string, method = 'GET', body?: unknown): Promise<{ ok: boolean; status: number; json: Json; text: string }> {
    const key = this.d.key();
    if (!key) throw new Error('Add your ElevenLabs key first.');
    const res = await this.http(path.startsWith('http') ? path : `${API}${path}`, {
      method,
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  private static picks(account: VoiceOption[] = []): VoiceOption[] {
    const byId = new Map(account.map((v) => [v.id, v]));
    return PICKS.map((p) => ({ ...p, previewUrl: byId.get(p.id)?.previewUrl, source: 'pick' as const }));
  }

  /** The picks plus every non-default voice on your account. */
  async list(force = false): Promise<VoiceList> {
    if (!this.d.key()) return { hasKey: false, picks: VoiceCatalog.picks(), mine: [] };
    if (!force && this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.list;
    const all: VoiceOption[] = [];
    let token = '';
    try {
      for (let page = 0; page < 5; page++) {
        const q = new URLSearchParams({ page_size: '100', include_total_count: 'false' });
        if (token) q.set('next_page_token', token);
        const r = await this.get(`/v2/voices?${q}`);
        if (!r.ok) throw new Error(voiceError(r.status, r.text, 'list'));
        all.push(...((r.json.voices as Json[]) ?? []).map(fromAccount).filter((v) => v.id));
        token = s(r.json.next_page_token);
        if (!r.json.has_more || !token) break;
      }
    } catch (e) {
      this.d.log(`[voices] ${(e as Error).message}`);
      return { hasKey: true, picks: VoiceCatalog.picks(), mine: [], error: (e as Error).message };
    }
    const pickIds = new Set(PICKS.map((p) => p.id));
    const mine = all.filter((v) => v.source === 'mine' && !pickIds.has(v.id)).sort((a, b) => a.name.localeCompare(b.name));
    const list = { hasKey: true, picks: VoiceCatalog.picks(all), mine };
    this.cache = { at: Date.now(), list };
    return list;
  }

  /** Natural English voices from the public ElevenLabs Voice Library. */
  async search(q: LibraryQuery): Promise<{ voices: VoiceOption[]; hasMore: boolean; error?: string }> {
    if (!this.d.key()) return { voices: [], hasMore: false, error: 'Add your ElevenLabs key first.' };
    try {
      let r = await this.get(libraryUrl(q));
      // An older API may not know the sort; ask again without it.
      if (!r.ok && (r.status === 400 || r.status === 422)) r = await this.get(libraryUrl(q).replace(/&?sort=trending/, ''));
      if (!r.ok) return { voices: [], hasMore: false, error: voiceError(r.status, r.text, 'search') };
      const seen = new Set<string>();
      const voices = ((r.json.voices as Json[]) ?? [])
        .map(fromLibrary)
        .filter((v) => v.id && v.ownerId && !seen.has(v.id) && (seen.add(v.id), true));
      return { voices, hasMore: r.json.has_more === true };
    } catch (e) {
      return { voices: [], hasMore: false, error: (e as Error).message };
    }
  }

  /** Saves a Voice Library voice to your account so Lock In (and its live agent) can use it. */
  async add(ownerId: string, voiceId: string, name: string): Promise<{ ok: boolean; voiceId: string; error?: string; status?: number }> {
    try {
      const r = await this.get(`/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`, 'POST', { new_name: name.slice(0, 60) });
      if (!r.ok) {
        // Already in your voices counts as done.
        if (/already/i.test(r.text)) return { ok: true, voiceId };
        return { ok: false, voiceId, status: r.status, error: voiceError(r.status, r.text, 'add') };
      }
      this.cache = null;
      return { ok: true, voiceId: s(r.json.voice_id) || voiceId };
    } catch (e) {
      return { ok: false, voiceId, error: (e as Error).message };
    }
  }

  /** ElevenLabs' own sample clip for a voice (free, no credits). */
  async sample(url: string | undefined): Promise<Buffer | null> {
    if (!url || !safeSampleUrl(url)) return null;
    try {
      const res = await this.http(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.byteLength > 1000 ? buf : null;
    } catch {
      return null;
    }
  }
}
