// Which apps are installed, and which ones you actually use, from Spotlight's
// own records (last-used date and open count). No extra permission needed.
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AppUsage } from '../shared/types';

export type { AppUsage };


const SKIP = new Set(['Lock In', 'Electron', 'App Store', 'System Settings', 'System Preferences', 'Launchpad', 'Mission Control', 'Time Machine', 'Migration Assistant', 'Boot Camp Assistant', 'Font Book', 'Automator', 'Stickies', 'Chess', 'Photo Booth', 'Image Capture', 'Console', 'Disk Utility', 'Terminal Helper']);

const DIRS = () => ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', join(homedir(), 'Applications')];

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8_000_000 }, (err, out) => resolve(err ? '' : String(out))));
}

export function installedAppPaths(): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of DIRS()) {
    try {
      for (const f of readdirSync(d)) {
        if (!f.endsWith('.app')) continue;
        const name = f.slice(0, -4);
        if (!out.has(name)) out.set(name, join(d, f));
      }
    } catch {
      /* folder missing */
    }
  }
  return out;
}

/** mdls date format: "2026-10-17 20:31:05 +0000". */
export function parseMdDate(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return 0;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Parses `mdls -raw -nullMarker "" -name kMDItemLastUsedDate -name kMDItemUseCount <paths…>`:
 * two NUL-separated values per path. The order of the two is not relied on.
 */
export function parseMdlsRaw(out: string, paths: string[]): Map<string, { uses: number; lastUsed: number }> {
  const parts = out.split('\0');
  const res = new Map<string, { uses: number; lastUsed: number }>();
  paths.forEach((p, i) => {
    let uses = 0;
    let lastUsed = 0;
    for (const v of [parts[i * 2] ?? '', parts[i * 2 + 1] ?? '']) {
      const s = v.trim();
      if (/^\d+$/.test(s)) uses = Number(s);
      else if (s) lastUsed = parseMdDate(s) || lastUsed;
    }
    res.set(p, { uses, lastUsed });
  });
  return res;
}

/** Every installed app, the ones used in the last 30 days first (most-opened first). */
export async function appUsage(now = Date.now()): Promise<AppUsage[]> {
  const installed = installedAppPaths();
  const names = [...installed.keys()].filter((n) => !SKIP.has(n));
  if (process.platform !== 'darwin') return names.sort().map((name) => ({ name, uses: 0, lastUsed: 0 }));

  const paths = names.map((n) => installed.get(n)!);
  const stats = new Map<string, { uses: number; lastUsed: number }>();
  for (let i = 0; i < paths.length; i += 80) {
    const batch = paths.slice(i, i + 80);
    const out = await run('mdls', ['-raw', '-nullMarker', '', '-name', 'kMDItemLastUsedDate', '-name', 'kMDItemUseCount', ...batch]);
    if (out) for (const [p, v] of parseMdlsRaw(out, batch)) stats.set(p, v);
  }
  const month = now - 30 * 86_400_000;
  return names
    .map((name) => {
      const s = stats.get(installed.get(name)!) ?? { uses: 0, lastUsed: 0 };
      return { name, uses: s.uses, lastUsed: s.lastUsed };
    })
    .sort((a, b) => {
      const ar = a.lastUsed >= month ? 1 : 0;
      const br = b.lastUsed >= month ? 1 : 0;
      if (ar !== br) return br - ar;
      if (a.uses !== b.uses) return b.uses - a.uses;
      return a.name.localeCompare(b.name);
    });
}

export const appNameFromPath = (p: string) => basename(p).replace(/\.app$/, '');
