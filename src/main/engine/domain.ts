// URL, domain and title helpers shared by the classifier and the coach.

export function domainOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome-extension:' || u.protocol === 'chrome:' || u.protocol === 'about:' || u.protocol === 'edge:' || u.protocol === 'brave:' || u.protocol === 'arc:') {
      return undefined;
    }
    if (u.protocol === 'file:') return 'local-file';
    return u.hostname.replace(/^www\./, '').toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** True when host is the domain itself or a subdomain of it ("m.youtube.com" matches "youtube.com"). */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^www\./, '');
  return h === d || h.endsWith('.' + d);
}

export function findDomain<T>(host: string | undefined, map: Record<string, T>): [string, T] | undefined {
  if (!host) return undefined;
  let best: [string, T] | undefined;
  for (const [d, v] of Object.entries(map)) {
    if (domainMatches(host, d) && (!best || d.length > best[0].length)) best = [d, v];
  }
  return best;
}

export function inDomainList(host: string | undefined, list: string[]): string | undefined {
  if (!host) return undefined;
  let best: string | undefined;
  for (const d of list) {
    if (domainMatches(host, d) && (!best || d.length > best.length)) best = d;
  }
  return best;
}

export function sameApp(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function inAppList(app: string | undefined, bundleId: string | undefined, list: string[]): string | undefined {
  for (const entry of list) {
    if (sameApp(app, entry) || sameApp(bundleId, entry)) return entry;
  }
  return undefined;
}

/** Remove emails, phone numbers and long digit runs before a title leaves the machine. */
export function redact(text: string | undefined): string | undefined {
  if (!text) return text;
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .replace(/\b\d{5,}\b/g, '[number]')
    .slice(0, 160);
}

/** Strip browser suffixes and counters like "(3) " so cache keys stay stable. */
export function normalizeTitle(title: string | undefined): string {
  if (!title) return '';
  return title
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s+[-–—|]\s+(Google Chrome|Arc|Brave|Microsoft Edge|Safari|Firefox|YouTube)$/i, '')
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

export function fileUrlToPath(u: string | undefined): string | undefined {
  if (!u) return undefined;
  if (!u.startsWith('file://')) return u.startsWith('/') ? u : undefined;
  try {
    return decodeURIComponent(new URL(u).pathname);
  } catch {
    return undefined;
  }
}

export function displayName(s: { domain?: string; app: string }): string {
  return s.domain ?? s.app;
}
