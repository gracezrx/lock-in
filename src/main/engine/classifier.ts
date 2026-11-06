// Labels each sample work / neutral / distraction / private, cheapest method first:
// profile rules → gray-zone rules → label cache → model (async, cached) → neutral.
import type { Label, LabeledSample, LabelSource, Profile, Sample } from '../../shared/types';
import { VIDEO_SITES, roleText } from '../../shared/templates';
import { domainMatches, findDomain, inAppList, inDomainList, normalizeTitle, redact, sameApp } from './domain';

export interface CacheEntry {
  label: Label;
  source: 'model' | 'user';
  confidence?: number;
  reason?: string;
  updatedAt: number;
}
export type LabelCache = Record<string, CacheEntry>;

export interface ModelRequest {
  key: string;
  kind: 'site' | 'page' | 'app';
  app: string;
  domain?: string;
  title?: string;
  goal?: string;
  role: string;
}
export interface ModelAnswer {
  label: 'work' | 'neutral' | 'distraction';
  confidence: number;
  reason: string;
}
export type ModelLabeler = (req: ModelRequest) => Promise<ModelAnswer | null>;

export interface ClassifierOptions {
  titlesStayLocal: () => boolean;
  now?: () => number;
  minDwellMs?: number;
  minGapMs?: number;
  maxPerHour?: number;
}

export class Classifier {
  goal = '';
  /** Only ask the model during a session, so nothing is sent (or billed) otherwise. */
  modelEnabled = false;
  private pending = new Set<string>();
  private firstSeen = new Map<string, number>();
  private failedAt = new Map<string, number>();
  private calls: number[] = [];

  constructor(
    private getProfile: () => Profile,
    readonly cache: LabelCache,
    private onCacheChange: () => void,
    private opts: ClassifierOptions,
    private labeler?: ModelLabeler,
  ) {}

  setLabeler(labeler: ModelLabeler | undefined): void {
    this.labeler = labeler;
  }

  /** The most specific cache key for a sample. */
  keyFor(s: Sample): { key: string; kind: 'site' | 'page' | 'app' } {
    if (s.browser && s.domain) {
      const p = this.getProfile();
      const gray = p.grayRules.find((r) => domainMatches(s.domain!, r.domain));
      const video = VIDEO_SITES.find((d) => domainMatches(s.domain!, d));
      const base = gray?.domain ?? video;
      if (base && s.title) return { key: `page:${base}|${normalizeTitle(s.title)}`, kind: 'page' };
      return { key: `site:${s.domain}`, kind: 'site' };
    }
    return { key: `app:${s.bundleId ?? s.app}`, kind: 'app' };
  }

  classify(s: Sample): LabeledSample {
    const mk = (label: Label, source: LabelSource, itemKey: string, weight = 1): LabeledSample => ({ ...s, label, source, itemKey, weight });
    if (s.isPrivate) return mk('private', 'rule', 'private');
    if (s.inCall) return mk('work', 'call', 'call');
    const p = this.getProfile();

    if (s.browser) {
      const host = s.domain;
      if (!host) return mk('neutral', 'fallback', `app:${s.bundleId ?? s.app}`);
      const siteKey = `site:${host}`;
      const { key: specificKey, kind } = this.keyFor(s);
      const pageKey = kind === 'page' ? specificKey : undefined;

      // 1. The user's own labels always win.
      const userPage = pageKey ? this.cache[pageKey] : undefined;
      if (userPage?.source === 'user') return mk(userPage.label, 'user', pageKey!);
      const userSite = this.userSiteEntry(host);
      if (userSite) return mk(userSite[1].label, 'user', userSite[0]);

      // 2. Gray-zone rules ("YouTube is work when the title says tutorial").
      const gray = p.grayRules.find((r) => domainMatches(host, r.domain));
      if (gray && s.title) {
        const t = s.title.toLowerCase();
        if (gray.workIfTitleContains.some((k) => k && t.includes(k.toLowerCase()))) return mk('work', 'gray', pageKey ?? siteKey);
      }

      // 3. Profile rules.
      const work = inDomainList(host, p.workDomains);
      if (work) return mk('work', 'rule', `site:${work}`);
      const dist = findDomain(host, p.distractionDomains);
      if (dist) {
        if (gray && pageKey) {
          const cached = this.cache[pageKey];
          if (cached) return mk(cached.label, 'cache', pageKey, cached.label === 'distraction' ? dist[1] : 1);
          this.maybeAsk(pageKey, 'page', s);
        }
        return mk('distraction', 'rule', pageKey ?? `site:${dist[0]}`, dist[1]);
      }

      // 4. Cache, then 5. model, then neutral.
      const cached = this.cache[siteKey];
      if (cached) return mk(cached.label, 'cache', siteKey);
      this.maybeAsk(siteKey, 'site', s);
      return mk('neutral', 'fallback', siteKey);
    }

    const appKey = `app:${s.bundleId ?? s.app}`;
    const userApp = this.cache[appKey];
    if (userApp?.source === 'user') return mk(userApp.label, 'user', appKey);
    if (inAppList(s.app, s.bundleId, p.workApps)) return mk('work', 'rule', appKey);
    const da = Object.entries(p.distractionApps).find(([a]) => sameApp(a, s.app) || sameApp(a, s.bundleId));
    if (da) return mk('distraction', 'rule', appKey, da[1]);
    if (inAppList(s.app, s.bundleId, p.neutralApps)) return mk('neutral', 'rule', appKey);
    if (userApp) return mk(userApp.label, 'cache', appKey);
    this.maybeAsk(appKey, 'app', s);
    return mk('neutral', 'fallback', appKey);
  }

  /** "This is work" (or any manual relabel). Returns the key that was saved. */
  setUserLabel(s: Sample, label: Label): string {
    const { key } = this.keyFor(s);
    this.cache[key] = { label, source: 'user', updatedAt: Date.now() };
    this.onCacheChange();
    return key;
  }

  setKey(key: string, label: Label | null): void {
    if (label === null) delete this.cache[key];
    else this.cache[key] = { label, source: 'user', updatedAt: Date.now() };
    this.onCacheChange();
  }

  private userSiteEntry(host: string): [string, CacheEntry] | undefined {
    let best: [string, CacheEntry] | undefined;
    for (const [k, v] of Object.entries(this.cache)) {
      if (v.source !== 'user' || !k.startsWith('site:')) continue;
      const d = k.slice(5);
      if (domainMatches(host, d) && (!best || d.length > best[0].length - 5)) best = [k, v];
    }
    return best;
  }

  private maybeAsk(key: string, kind: 'site' | 'page' | 'app', s: Sample): void {
    if (!this.labeler || !this.modelEnabled || this.pending.has(key)) return;
    const now = this.opts.now?.() ?? Date.now();
    const failed = this.failedAt.get(key);
    if (failed && now - failed < 10 * 60_000) return;
    const first = this.firstSeen.get(key);
    if (first === undefined) {
      this.firstSeen.set(key, now);
      if (this.firstSeen.size > 2000) this.firstSeen.clear();
      return;
    }
    if (now - first < (this.opts.minDwellMs ?? 5000)) return;
    this.calls = this.calls.filter((t) => now - t < 3_600_000);
    const last = this.calls[this.calls.length - 1] ?? 0;
    if (now - last < (this.opts.minGapMs ?? 3000) || this.calls.length >= (this.opts.maxPerHour ?? 60)) return;
    this.calls.push(now);
    this.pending.add(key);
    const req: ModelRequest = {
      key,
      kind,
      app: s.app,
      domain: s.domain,
      title: this.opts.titlesStayLocal() ? undefined : redact(s.title),
      goal: this.goal || undefined,
      role: roleText(this.getProfile()),
    };
    this.labeler(req)
      .then((ans) => {
        if (ans) {
          this.cache[key] = { label: ans.label, source: 'model', confidence: ans.confidence, reason: ans.reason, updatedAt: Date.now() };
          this.onCacheChange();
        } else {
          this.failedAt.set(key, Date.now());
        }
      })
      .catch(() => this.failedAt.set(key, Date.now()))
      .finally(() => this.pending.delete(key));
  }
}
