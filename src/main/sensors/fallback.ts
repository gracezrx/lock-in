// Reduced sensing for when the Swift helper is not built:
//  - front app via `lsappinfo` (no permission needed)
//  - browser tab URL and title via AppleScript (asks for Automation permission once per browser)
import { execFile } from 'node:child_process';

export interface FrontApp {
  app: string;
  bundleId?: string;
  at: number;
}

export interface BrowserTab {
  url?: string;
  title?: string;
  at: number;
}

function run(cmd: string, args: string[], timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

const CHROME_FAMILY: Record<string, string> = {
  'com.google.chrome': 'com.google.Chrome',
  'com.google.chrome.canary': 'com.google.Chrome.canary',
  'company.thebrowser.browser': 'company.thebrowser.Browser',
  'com.brave.browser': 'com.brave.Browser',
  'com.microsoft.edgemac': 'com.microsoft.edgemac',
  'com.vivaldi.vivaldi': 'com.vivaldi.Vivaldi',
  'com.operasoftware.opera': 'com.operasoftware.Opera',
  'org.chromium.chromium': 'org.chromium.Chromium',
};

export class FallbackSensor {
  private front: FrontApp | null = null;
  private tab: BrowserTab | null = null;
  private busy = false;
  private tabBusy = false;
  private tabFailures = new Map<string, number>();

  async pollFront(): Promise<void> {
    if (process.platform !== 'darwin' || this.busy) return;
    this.busy = true;
    try {
      const asn = (await run('lsappinfo', ['front'])).trim();
      if (!asn) return;
      const info = await run('lsappinfo', ['info', asn]);
      // Handles both the default format ("Finder" ASN:… / bundleID="…") and the key=value format.
      const name = /^"([^"]+)"\s+ASN:/m.exec(info)?.[1] ?? /"LSDisplayName"="([^"]*)"/.exec(info)?.[1];
      const bundleId = /bundleID="([^"]*)"/.exec(info)?.[1] ?? /"CFBundleIdentifier"="([^"]*)"/.exec(info)?.[1];
      if (name) this.front = { app: name, bundleId, at: Date.now() };
    } finally {
      this.busy = false;
    }
  }

  latestFront(maxAgeMs = 5000): FrontApp | null {
    if (!this.front || Date.now() - this.front.at > maxAgeMs) return null;
    return this.front;
  }

  /** Ask the browser for its active tab. Only used when the extension is not connected. */
  async pollTab(bundleId: string | undefined, appName: string): Promise<void> {
    if (process.platform !== 'darwin' || this.tabBusy || !bundleId) return;
    const key = bundleId.toLowerCase();
    const failures = this.tabFailures.get(key) ?? 0;
    if (failures >= 3) return;
    let script: string | null = null;
    const chromeId = CHROME_FAMILY[key];
    if (chromeId) {
      script = `tell application id "${chromeId}" to return (URL of active tab of front window) & linefeed & (title of active tab of front window)`;
    } else if (key === 'com.apple.safari') {
      script = `tell application id "com.apple.Safari" to return (URL of front document) & linefeed & (name of front document)`;
    }
    if (!script) return;
    this.tabBusy = true;
    try {
      const out = await run('osascript', ['-e', script], 1200);
      if (!out.trim()) {
        this.tabFailures.set(key, failures + 1);
        return;
      }
      const [url, ...rest] = out.replace(/\n$/, '').split('\n');
      this.tab = { url: url?.trim(), title: rest.join(' ').trim() || undefined, at: Date.now() };
      void appName;
    } finally {
      this.tabBusy = false;
    }
  }

  latestTab(maxAgeMs = 4000): BrowserTab | null {
    if (!this.tab || Date.now() - this.tab.at > maxAgeMs) return null;
    return this.tab;
  }
}
