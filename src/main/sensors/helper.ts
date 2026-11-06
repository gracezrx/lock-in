// Runs the Swift helper and keeps its latest reading.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export interface HelperReading {
  t: number;
  app?: string;
  bundleId?: string;
  pid?: number;
  title?: string;
  doc?: string;
  mic?: boolean;
  ax?: boolean;
  receivedAt: number;
}

export class HelperSensor {
  private proc: ChildProcess | null = null;
  private last: HelperReading | null = null;
  private restarts = 0;
  private stopped = false;

  constructor(private binPath: string, private log: (msg: string) => void) {}

  get built(): boolean {
    return process.platform === 'darwin' && existsSync(this.binPath);
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null && !!this.last && Date.now() - this.last.receivedAt < 5000;
  }

  get accessibility(): boolean | undefined {
    return this.last?.ax;
  }

  start(): void {
    if (!this.built || this.proc) return;
    this.stopped = false;
    const proc = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      try {
        const r = JSON.parse(line) as Omit<HelperReading, 'receivedAt'>;
        this.last = { ...r, receivedAt: Date.now() };
        this.restarts = 0;
      } catch {
        /* ignore partial lines */
      }
    });
    proc.stderr?.on('data', (d) => this.log(`[helper] ${String(d).trim()}`));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      this.log(`[helper] exited with code ${code}`);
      if (this.restarts++ < 5) setTimeout(() => this.start(), 2000 * this.restarts);
    });
    proc.on('error', (err) => this.log(`[helper] failed to start: ${err.message}`));
  }

  promptAccessibility(): void {
    this.proc?.stdin?.write('prompt-ax\n');
  }

  latest(maxAgeMs = 3000): HelperReading | null {
    if (!this.last || Date.now() - this.last.receivedAt > maxAgeMs) return null;
    return this.last;
  }

  stop(): void {
    this.stopped = true;
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.proc = null;
  }
}
