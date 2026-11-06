// Combines the helper, the extension and the fallbacks into one Sample per second.
import type { Sample, Settings } from '../../shared/types';
import { BROWSER_APPS, BROWSER_BUNDLE_PREFIXES, CALL_APPS, CALL_DOMAINS } from '../../shared/templates';
import { domainOf, fileUrlToPath, inAppList, inDomainList, sameApp } from '../engine/domain';
import type { Bridge } from './bridge';
import type { FallbackSensor } from './fallback';
import type { HelperSensor } from './helper';

export function isBrowserApp(app: string, bundleId?: string): boolean {
  const b = bundleId?.toLowerCase();
  if (b && BROWSER_BUNDLE_PREFIXES.some((p) => b.startsWith(p))) return true;
  return BROWSER_APPS.some((a) => sameApp(a, app));
}

export interface SamplerDeps {
  helper: HelperSensor;
  fallback: FallbackSensor;
  bridge: Bridge;
  idleSec: () => number;
  settings: () => Settings;
  /** True while Lock In itself is recording the mic, so it does not count as a call. */
  selfRecording: () => boolean;
}

export class Sampler {
  constructor(private d: SamplerDeps) {}

  /** Kick off the async fallback polls; cheap no-ops when the helper/extension cover it. */
  pollFallbacks(): void {
    const h = this.d.helper.latest();
    if (!h) void this.d.fallback.pollFront();
    const front = h ? { app: h.app ?? '', bundleId: h.bundleId } : this.d.fallback.latestFront();
    if (front && isBrowserApp(front.app, front.bundleId) && !this.d.bridge.connected) {
      void this.d.fallback.pollTab(front.bundleId, front.app);
    }
  }

  sample(now = Date.now()): Sample | null {
    const h = this.d.helper.latest();
    const f = h ? null : this.d.fallback.latestFront();
    const app = h?.app || f?.app;
    if (!app) return null;
    const bundleId = h?.bundleId || f?.bundleId || undefined;
    const settings = this.d.settings();
    const browser = isBrowserApp(app, bundleId);

    let url: string | undefined;
    let title: string | undefined = h?.title || undefined;
    let tabId: number | undefined;
    let mediaPlaying = false;
    let incognito = false;
    let documentPath: string | undefined;

    if (browser) {
      const tab = this.d.bridge.activeTab();
      if (tab) {
        url = tab.url;
        title = tab.title || title;
        tabId = tab.tabId;
        mediaPlaying = tab.playing || tab.audible;
        incognito = tab.incognito;
      } else {
        const ft = this.d.fallback.latestTab();
        if (ft) {
          url = ft.url;
          title = ft.title || title;
        }
      }
    } else {
      documentPath = fileUrlToPath(h?.doc);
    }

    const domain = domainOf(url);
    const inCall =
      (!!h?.mic && !this.d.selfRecording()) ||
      CALL_APPS.some((a) => sameApp(a, app)) ||
      !!inDomainList(domain, CALL_DOMAINS);
    const isPrivate =
      incognito ||
      !!inAppList(app, bundleId, settings.sensitiveApps) ||
      !!inDomainList(domain, settings.sensitiveDomains);

    const s: Sample = {
      t: now,
      app,
      bundleId,
      title,
      url,
      domain,
      documentPath,
      tabId,
      browser,
      idleSec: this.d.idleSec(),
      mediaPlaying,
      inCall,
      isPrivate,
    };
    if (isPrivate) {
      s.title = undefined;
      s.url = undefined;
      s.domain = undefined;
      s.documentPath = undefined;
    }
    return s;
  }
}
