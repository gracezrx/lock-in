// A friend's Lock In bomb locks every distraction on this Mac for 5 minutes: distracting sites
// are blocked in the browser (through the extension), and distracting apps are hidden the moment
// they come to the front. The red card that locks the screen for 5 seconds comes on top.
//
// Pure logic: no Electron, no clock of its own. index.ts feeds it what's in front once a second
// and carries out what it says.
import type { Label } from '../shared/types';
import type { LabelCache } from './engine/classifier';

export const BOMB_LOCKOUT_MIN = 5;
/** Hide an app again at most this often (it may take a moment to go). */
const HIDE_EVERY_MS = 2500;
/** Re-block a site at most this often (a session ending clears the browser's blocks). */
const BLOCK_EVERY_MS = 4000;
/** "Still locked" at most this often. */
const NOTICE_EVERY_MS = 45_000;

export interface LockoutState {
  /** When the lock lifts. A second bomb pushes it out. */
  until: number;
  /** Who threw the bomb. */
  from: string;
  startedAt: number;
}

export interface InFront {
  app: string;
  domain?: string;
  browser?: boolean;
  label: Label;
}

export type LockoutAction = { kind: 'block-site'; domain: string } | { kind: 'hide-app'; app: string };

export class Lockout {
  state: LockoutState | null = null;
  private last = new Map<string, number>();
  private noticeAt = 0;

  start(from: string, now: number, min = BOMB_LOCKOUT_MIN): LockoutState {
    const until = Math.max(this.state && this.active(now) ? this.state.until : 0, now + min * 60_000);
    this.state = { until, from, startedAt: this.state && this.active(now) ? this.state.startedAt : now };
    this.last.clear();
    this.noticeAt = 0;
    return this.state;
  }

  active(now: number): boolean {
    return !!this.state && now < this.state.until;
  }

  leftSec(now: number): number {
    return this.state ? Math.max(0, Math.ceil((this.state.until - now) / 1000)) : 0;
  }

  /** True once, when the lock runs out. */
  expire(now: number): boolean {
    if (!this.state || now < this.state.until) return false;
    this.state = null;
    this.last.clear();
    return true;
  }

  /**
   * What to do about what's in front. A distracting site is blocked in the browser when the
   * extension is there; without it, the browser itself is hidden while the site is in front.
   * A distracting app is hidden. Work, neutral and private things are left alone.
   */
  act(s: InFront | null, now: number, extension: boolean): LockoutAction | null {
    if (!this.active(now) || !s || s.label !== 'distraction') return null;
    if (s.browser && s.domain && extension) return this.throttle(`site:${s.domain}`, BLOCK_EVERY_MS, now) ? { kind: 'block-site', domain: s.domain } : null;
    return this.throttle(`app:${s.app}`, HIDE_EVERY_MS, now) ? { kind: 'hide-app', app: s.app } : null;
  }

  /** May we tell them it's still locked? (Not every time they try.) */
  notice(now: number): boolean {
    if (now - this.noticeAt < NOTICE_EVERY_MS) return false;
    this.noticeAt = now;
    return true;
  }

  private throttle(key: string, every: number, now: number): boolean {
    const at = this.last.get(key) ?? 0;
    if (now - at < every) return false;
    this.last.set(key, now);
    return true;
  }
}

/**
 * Every site Lock In knows as a distraction: your profile's list (the usual suspects, plus what you
 * picked) and sites you (or the model) marked as one. Sites you call work are left out.
 */
export function distractionDomains(profile: Record<string, number>, cache: LabelCache, work: string[]): string[] {
  const out = new Set<string>(Object.keys(profile));
  for (const [k, v] of Object.entries(cache)) if (k.startsWith('site:') && v.label === 'distraction') out.add(k.slice(5));
  const isWork = (d: string) => work.some((w) => d === w || d.endsWith(`.${w}`));
  return [...out].map((d) => d.replace(/^www\./, '').toLowerCase()).filter((d) => d && !isWork(d)).sort();
}

export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
