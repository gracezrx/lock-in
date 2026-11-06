// The actions that physically route the user back to work.
import { shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { LastWork } from '../shared/types';
import type { Bridge } from './sensors/bridge';

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000 }, (err) => resolve(!err)));
}

const mac = process.platform === 'darwin';

export class Router {
  constructor(private bridge: Bridge, private log: (m: string) => void) {}

  pauseMedia(): Promise<boolean> {
    return this.bridge.send({ cmd: 'pause_media' });
  }

  async closeTab(tabId: number | undefined): Promise<boolean> {
    if (tabId === undefined) return false;
    return this.bridge.send({ cmd: 'close_tab', tabId });
  }

  /** Block a site in the browser. With `lock`, the blocked page says whose bomb it was and counts down. */
  blockDomain(domain: string, lock?: { from: string; until: number }): Promise<boolean> {
    return this.bridge.send({ cmd: 'block_domain', domain, ...(lock ?? {}) });
  }

  unblockAll(): Promise<boolean> {
    return this.bridge.send({ cmd: 'unblock_all' });
  }

  /** Hide a distracting desktop app (Steam, Messages…). Needs Automation permission for System Events. */
  async hideApp(app: string): Promise<boolean> {
    if (!mac) return false;
    const safe = app.replace(/["\\]/g, '');
    return run('osascript', ['-e', `tell application "System Events" to set visible of application process "${safe}" to false`]);
  }

  /** Bring the last work item back to the front: the exact tab, file or app. */
  async openWork(lw: LastWork | null): Promise<boolean> {
    if (!lw) return false;
    try {
      if (lw.url) {
        let ok = false;
        if (this.bridge.connected) ok = await this.bridge.send({ cmd: 'focus_or_open', url: lw.url, tabId: lw.tabId }, 'active');
        if (mac && lw.bundleId) {
          if (ok) await run('open', ['-b', lw.bundleId]);
          else ok = await run('open', ['-b', lw.bundleId, lw.url]);
        } else if (!ok) {
          await shell.openExternal(lw.url);
          ok = true;
        }
        return ok;
      }
      if (lw.documentPath && existsSync(lw.documentPath)) {
        if (mac) return run('open', lw.bundleId ? ['-b', lw.bundleId, lw.documentPath] : [lw.documentPath]);
        return (await shell.openPath(lw.documentPath)) === '';
      }
      if (mac) {
        if (lw.bundleId) return run('open', ['-b', lw.bundleId]);
        return run('open', ['-a', lw.app]);
      }
      return false;
    } catch (e) {
      this.log(`[router] openWork failed: ${(e as Error).message}`);
      return false;
    }
  }
}
