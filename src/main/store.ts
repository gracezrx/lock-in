// Local persistence in the app's user-data folder. JSON for small state, NDJSON
// (one record per line) for logs. API keys are encrypted with the OS keychain.
import { safeStorage } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoachTurn, InterventionRecord, KeyStatus, LastWork, Profile, Routine, SessionRecord, Settings, Span } from '../shared/types';
import { DEFAULT_ROUTINES } from '../shared/templates';
import { migrateSettings } from './settings';

export { DEFAULT_SETTINGS, migrateSettings } from './settings';
import type { LabelCache } from './engine/classifier';

export type KeyName = 'anthropic' | 'elevenlabs' | 'todoist';
const KEY_NAMES: KeyName[] = ['anthropic', 'elevenlabs', 'todoist'];
const KEY_ENV: Record<KeyName, string> = { anthropic: 'ANTHROPIC_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', todoist: 'TODOIST_API_TOKEN' };


interface StoredKeys {
  encrypted: boolean;
  anthropic?: string;
  elevenlabs?: string;
  todoist?: string;
}

interface AppState {
  lastGoal: string;
  lastWork: LastWork | null;
}

export class Store {
  private keyCache: (Partial<Record<KeyName, string>> & { encrypted: boolean }) | null = null;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(this.path(name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeJson(name: string, value: unknown): void {
    const p = this.path(name);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, p);
  }

  append(name: string, value: unknown): void {
    appendFileSync(this.path(name), JSON.stringify(value) + '\n');
  }

  /** Read an NDJSON log, newest last. Only the last `maxBytes` are read. */
  readLog<T>(name: string, maxBytes = 4_000_000): T[] {
    const p = this.path(name);
    if (!existsSync(p)) return [];
    let text = readFileSync(p, 'utf8');
    if (text.length > maxBytes) text = text.slice(text.length - maxBytes).replace(/^[^\n]*\n/, '');
    const out: T[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }

  // ---- typed accessors -------------------------------------------------------

  profile(): Profile | null {
    return this.readJson<Profile | null>('profile.json', null);
  }
  saveProfile(p: Profile): void {
    this.writeJson('profile.json', p);
  }

  settings(): Settings {
    return migrateSettings(this.readJson<Partial<Settings>>('settings.json', {}));
  }

  routines(): Routine[] {
    const saved = this.readJson<Routine[] | null>('routines.json', null);
    if (!saved) return structuredClone(DEFAULT_ROUTINES);
    // Add any built-in routine introduced after the file was saved.
    const ids = new Set(saved.map((r) => r.id));
    return [...saved, ...structuredClone(DEFAULT_ROUTINES).filter((r) => !ids.has(r.id))];
  }
  saveRoutines(r: Routine[]): void {
    this.writeJson('routines.json', r);
  }
  saveSettings(s: Settings): void {
    this.writeJson('settings.json', s);
  }

  labels(): LabelCache {
    return this.readJson<LabelCache>('labels.json', {});
  }
  saveLabels(c: LabelCache): void {
    this.writeJson('labels.json', c);
  }

  state(): AppState {
    return { lastGoal: '', lastWork: null, ...this.readJson<Partial<AppState>>('state.json', {}) };
  }
  saveState(s: AppState): void {
    this.writeJson('state.json', s);
  }

  logSpan(s: Span): void {
    this.append('spans.ndjson', s);
  }
  logSession(s: SessionRecord): void {
    this.append('sessions.ndjson', s);
  }
  /** Interventions are logged on start and again on update; the last line per id wins. */
  logIntervention(i: InterventionRecord): void {
    this.append('interventions.ndjson', i);
  }
  logTurn(t: CoachTurn): void {
    this.append('coach_turns.ndjson', t);
  }

  sessions(): SessionRecord[] {
    const byId = new Map<string, SessionRecord>();
    for (const s of this.readLog<SessionRecord>('sessions.ndjson')) byId.set(s.id, s);
    return [...byId.values()];
  }

  interventions(): InterventionRecord[] {
    const byId = new Map<string, InterventionRecord>();
    for (const i of this.readLog<InterventionRecord>('interventions.ndjson')) byId.set(i.id, { ...byId.get(i.id), ...i });
    return [...byId.values()];
  }

  // ---- API keys --------------------------------------------------------------

  private keysRaw(): StoredKeys {
    return this.readJson<StoredKeys>('keys.json', { encrypted: false });
  }

  getKey(name: KeyName): string | undefined {
    if (!this.keyCache) {
      const c: Partial<Record<KeyName, string>> & { encrypted: boolean } = { encrypted: this.keysRaw().encrypted };
      for (const k of KEY_NAMES) c[k] = this.readKey(k);
      this.keyCache = c;
    }
    return this.keyCache[name];
  }

  private readKey(name: KeyName): string | undefined {
    const env = process.env[KEY_ENV[name]];
    const k = this.keysRaw();
    const v = k[name];
    if (!v) return env || undefined;
    if (!k.encrypted) return v;
    try {
      return safeStorage.decryptString(Buffer.from(v, 'base64'));
    } catch {
      return env || undefined;
    }
  }

  setKey(name: KeyName, value: string | null): void {
    const current: Partial<Record<KeyName, string>> = {};
    for (const k of KEY_NAMES) current[k] = this.getKey(k);
    current[name] = value?.trim() || undefined;
    const encrypted = safeStorage.isEncryptionAvailable();
    const enc = (v?: string) => (v ? (encrypted ? safeStorage.encryptString(v).toString('base64') : v) : undefined);
    const out: StoredKeys = { encrypted };
    for (const k of KEY_NAMES) out[k] = enc(current[k]);
    this.writeJson('keys.json', out);
    this.keyCache = null;
  }

  keyStatus(): KeyStatus {
    const anthropic = !!this.getKey('anthropic');
    return { anthropic, elevenlabs: !!this.getKey('elevenlabs'), todoist: !!this.getKey('todoist'), encrypted: this.keyCache?.encrypted ?? false };
  }

  // ---- export / delete -------------------------------------------------------

  exportAll(): Record<string, unknown> {
    return {
      exportedAt: new Date().toISOString(),
      profile: this.profile(),
      settings: this.settings(),
      labels: this.labels(),
      sessions: this.sessions(),
      interventions: this.interventions(),
      spans: this.readLog('spans.ndjson'),
      coachTurns: this.readLog('coach_turns.ndjson'),
    };
  }

  deleteActivity(): void {
    for (const f of ['spans.ndjson', 'sessions.ndjson', 'interventions.ndjson', 'coach_turns.ndjson', 'labels.json', 'state.json', 'activity.json', 'routine-state.json', 'rhythm.json', 'attention.json']) {
      rmSync(this.path(f), { force: true });
    }
    rmSync(this.path('tts-cache'), { recursive: true, force: true });
  }

  sizeOf(name: string): number {
    try {
      return statSync(this.path(name)).size;
    } catch {
      return 0;
    }
  }
}
