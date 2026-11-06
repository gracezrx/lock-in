// "Hold the space bar to talk": runs the small Swift key watcher (native/mac-helper/keys.swift)
// and tells it when to listen. A quick tap still types a space; a hold opens a conversation.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** Apps where holding space already means something (pan the canvas, play, push to talk). */
const APPS = /^(figma|sketch|miro|blender|freeform|canva|framer|penpot|pixelmator|procreate|adobe (photoshop|illustrator|indesign|xd|premiere|after effects|animate)|affinity|final cut|logic pro|garageband|davinci resolve|ableton|zoom\.us|zoom|discord|microsoft teams|webex|facetime|lock in|electron)\b/i;
/** Sites where it does too. */
const SITES = ['figma.com', 'miro.com', 'excalidraw.com', 'tldraw.com', 'canva.com', 'whimsical.com', 'lucid.app', 'framer.com', 'penpot.app', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com', 'whereby.com', 'discord.com', 'zoom.us'];

const onSite = (domain: string | undefined) => !!domain && SITES.some((s) => domain === s || domain.endsWith(`.${s}`));

/** Should a long press of space open Lock In right now? */
export function holdSpaceAllowed(front: { app?: string; domain?: string; inCall?: boolean } | null, opts: { on: boolean; self: boolean }): boolean {
  if (!opts.on || opts.self) return false;
  if (!front) return true;
  if (front.inCall) return false;
  if (front.app && APPS.test(front.app.trim())) return false;
  if (onSite(front.domain)) return false;
  return true;
}

export type HoldSpaceStatus = 'off' | 'missing' | 'starting' | 'ready' | 'permission';

export interface HoldSpaceDeps {
  bin: () => string | null;
  onHold: () => void;
  log: (m: string) => void;
  spawn?: typeof nodeSpawn;
}

export class HoldSpace {
  status: HoldSpaceStatus = 'off';
  private proc: ChildProcess | null = null;
  private active = false;
  private intercept = false;
  private sent: boolean | null = null;
  private restarts: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private d: HoldSpaceDeps) {}

  /** Turn the whole feature on or off (the setting). */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) this.start();
    else this.stop();
  }

  /** Listen for holds in the app in front, or let space through untouched. */
  setIntercept(on: boolean): void {
    this.intercept = on;
    this.push();
  }

  private push(): void {
    if (!this.proc?.stdin?.writable || this.sent === this.intercept) return;
    this.sent = this.intercept;
    this.proc.stdin.write(`${this.intercept ? 'on' : 'off'}\n`);
  }

  private start(): void {
    const bin = this.d.bin();
    if (!bin || (!this.d.spawn && !existsSync(bin))) {
      this.status = 'missing';
      return;
    }
    this.status = 'starting';
    let p: ChildProcess;
    try {
      p = (this.d.spawn ?? nodeSpawn)(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      this.d.log(`[hold space] ${(e as Error).message}`);
      this.status = 'missing';
      return;
    }
    this.proc = p;
    this.sent = null;
    p.stdin?.on('error', () => undefined);
    if (p.stdout) {
      createInterface({ input: p.stdout }).on('line', (line) => this.onLine(line));
    }
    p.on('error', (e) => this.d.log(`[hold space] ${e.message}`));
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      if (!this.active) return;
      // Came down unexpectedly: start it again, but not in a tight loop.
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 60_000);
      this.restarts.push(now);
      if (this.restarts.length > 3) {
        this.d.log('[hold space] the key watcher keeps stopping; giving up until Lock In restarts');
        this.status = 'missing';
        return;
      }
      this.timer = setTimeout(() => this.active && this.start(), 3000);
    });
    this.push();
  }

  private onLine(line: string): void {
    let msg: { event?: string; reason?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === 'ready') {
      if (this.status !== 'ready') this.d.log('[hold space] listening for a long press of space');
      this.status = 'ready';
      this.push();
    } else if (msg.event === 'error') {
      this.status = msg.reason === 'permission' ? 'permission' : 'missing';
      if (msg.reason === 'permission') this.d.log('[hold space] needs Accessibility for Lock In');
    } else if (msg.event === 'hold') {
      this.d.onHold();
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.proc;
    this.proc = null;
    this.sent = null;
    p?.stdin?.end();
    p?.kill();
    this.status = 'off';
  }
}
