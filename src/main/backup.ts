// A whole-Lock-In backup in one .zip: every record Lock In keeps (sessions, to-dos day by day,
// what you finished, deadlines, routines, settings, your profile, crew, achievements…), so you
// can move to a new Mac or just keep a copy. API keys are left out: they're locked to this
// Mac's keychain, and they're secrets.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export const BACKUP_VERSION = 1;

/**
 * Lock In's own records: top-level .json / .ndjson files, the to-do days, and coaches made from
 * people you know (the coach and its transcripts; the recordings themselves are too big).
 */
const DATA = /^(?:todo-days\/\d{4}-\d{2}-\d{2}\.json|coaches\/[a-f0-9]{12}\/(?:coach|[a-f0-9]{12})\.json|[A-Za-z0-9][A-Za-z0-9._-]*\.(?:json|ndjson))$/;
// Secrets stay on this Mac: API keys, and the keys of phones paired with it.
const NEVER = new Set(['keys.json', 'phone-devices.json', 'Preferences', 'Local State']);

export interface BackupManifest {
  app: 'Lock In';
  backup: number;
  createdAt: string;
  appVersion: string;
  files: string[];
}

export function isDataFile(name: string): boolean {
  return DATA.test(name) && !NEVER.has(name) && !name.endsWith('.tmp');
}

/** The files a backup holds, read from Lock In's data folder. */
export function collect(dir: string): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = [];
  const add = (name: string) => {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile() && isDataFile(name)) out.push({ name, data: readFileSync(p) });
    } catch {
      /* gone */
    }
  };
  for (const f of readdirSync(dir)) add(f);
  if (existsSync(join(dir, 'todo-days'))) for (const f of readdirSync(join(dir, 'todo-days'))) add(`todo-days/${f}`);
  if (existsSync(join(dir, 'coaches'))) {
    for (const c of readdirSync(join(dir, 'coaches'))) {
      try {
        if (statSync(join(dir, 'coaches', c)).isDirectory()) for (const f of readdirSync(join(dir, 'coaches', c))) add(`coaches/${c}/${f}`);
      } catch {
        /* gone */
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function makeBackup(dir: string, appVersion: string, now = new Date()): Uint8Array {
  const files = collect(dir);
  const manifest: BackupManifest = { app: 'Lock In', backup: BACKUP_VERSION, createdAt: now.toISOString(), appVersion, files: files.map((f) => f.name) };
  const zip: Record<string, Uint8Array> = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) };
  for (const f of files) zip[`data/${f.name}`] = f.data;
  return zipSync(zip, { level: 6 });
}

/** Opens a backup and checks it's really one of ours (and nothing in it tries to write elsewhere). */
export function readBackup(bytes: Uint8Array): { manifest: BackupManifest; files: { name: string; data: Uint8Array }[] } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("That file isn't a zip. Pick a \"Lock In backup\" file.");
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(strFromU8(entries['manifest.json'])) as BackupManifest;
  } catch {
    throw new Error("That zip isn't a Lock In backup.");
  }
  if (manifest?.app !== 'Lock In' || typeof manifest.backup !== 'number') throw new Error("That zip isn't a Lock In backup.");
  if (manifest.backup > BACKUP_VERSION) throw new Error('That backup is from a newer Lock In. Update Lock In on this Mac first.');
  const files: { name: string; data: Uint8Array }[] = [];
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith('data/')) continue;
    const name = path.slice(5);
    if (!isDataFile(name)) continue; // anything odd (../, keys, folders) is skipped
    files.push({ name, data });
  }
  if (!files.length) throw new Error('That backup is empty.');
  return { manifest, files };
}

/**
 * Puts a backup's records in place of the current ones. Records not in the backup are moved
 * aside (into a "before-restore" folder) rather than deleted.
 */
export function restore(dir: string, bytes: Uint8Array, now = Date.now()): { files: number; createdAt: string } {
  const { manifest, files } = readBackup(bytes);
  const aside = join(dir, `before-restore-${now}`);
  mkdirSync(join(aside, 'todo-days'), { recursive: true });
  for (const f of collect(dir)) {
    try {
      mkdirSync(dirname(join(aside, f.name)), { recursive: true });
      renameSync(join(dir, f.name), join(aside, f.name));
    } catch {
      /* in use or gone */
    }
  }
  mkdirSync(join(dir, 'todo-days'), { recursive: true });
  for (const f of files) {
    const p = join(dir, f.name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, f.data);
    renameSync(`${p}.tmp`, p);
  }
  return { files: files.length, createdAt: manifest.createdAt };
}

/** Keeps the newest `keep` daily backups in a folder. */
export function prune(folder: string, keep: number): void {
  if (!existsSync(folder)) return;
  const daily = readdirSync(folder)
    .filter((f) => /^Lock In backup \d{4}-\d{2}-\d{2}\.zip$/.test(f))
    .sort();
  for (const f of daily.slice(0, Math.max(0, daily.length - keep))) rmSync(join(folder, f), { force: true });
}
