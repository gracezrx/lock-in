// One lock-in session: stats, merged spans, the last work context, breaks.
import { randomUUID } from 'node:crypto';
import type { LabeledSample, LastWork, Level, SessionRecord, Span } from '../../shared/types';
import { DriftEngine, type DriftEvent } from './drift';

const SELF_APPS = ['lock in', 'electron'];

export class Session {
  readonly record: SessionRecord;
  readonly engine: DriftEngine;
  lastWork: LastWork | null;
  onBreakUntil?: number;
  halfwayDone = false;
  streakPraisedAt = 0;
  /** Pomodoro mode: short breaks are scheduled inside the session. */
  pomodoro?: { focusMin: number; breakMin: number; cycles: number; breaksTaken: number };
  private span: Span | null = null;

  constructor(
    goal: string,
    plannedMin: number,
    toleranceMin: number,
    private writeSpan: (s: Span) => void,
    lastWork: LastWork | null,
    now = Date.now(),
  ) {
    this.record = {
      id: randomUUID(),
      goal,
      plannedMin,
      startedAt: now,
      focusSec: 0,
      driftSec: 0,
      neutralSec: 0,
      awaySec: 0,
      breakSec: 0,
      maxLevel: 0,
      interventions: 0,
      topDistractions: {},
    };
    this.engine = new DriftEngine(toleranceMin);
    this.lastWork = lastWork;
  }

  elapsedSec(now = Date.now()): number {
    return Math.floor((now - this.record.startedAt) / 1000);
  }

  isOver(now = Date.now()): boolean {
    return this.elapsedSec(now) >= this.record.plannedMin * 60;
  }

  /** Pomodoro: true when it is time for the next scheduled break. */
  pomodoroBreakDue(now = Date.now()): boolean {
    const p = this.pomodoro;
    if (!p || this.onBreakUntil || p.breaksTaken >= p.cycles - 1) return false;
    const k = p.breaksTaken + 1;
    const at = (k * p.focusMin + (k - 1) * p.breakMin) * 60;
    return this.elapsedSec(now) >= at;
  }

  tick(s: LabeledSample, dtSec = 1): DriftEvent[] {
    const r = this.record;
    const label = this.engine.effectiveLabel(s);
    if (this.onBreakUntil) {
      r.breakSec += dtSec;
    } else {
      switch (label) {
        case 'work':
          r.focusSec += dtSec;
          break;
        case 'distraction': {
          r.driftSec += dtSec;
          const name = s.domain ?? s.app;
          r.topDistractions[name] = (r.topDistractions[name] ?? 0) + dtSec;
          break;
        }
        case 'away':
          r.awaySec += dtSec;
          break;
        default:
          r.neutralSec += dtSec;
      }
    }

    if (label === 'work' && !SELF_APPS.includes(s.app.toLowerCase()) && s.label === 'work' && s.source !== 'call') {
      this.lastWork = {
        app: s.app,
        bundleId: s.bundleId,
        title: s.title,
        url: s.url,
        documentPath: s.documentPath,
        tabId: s.tabId,
        updatedAt: s.t,
      };
    }

    this.trackSpan(s, label);
    const events = this.engine.tick(s, dtSec);
    if (this.engine.level > r.maxLevel) r.maxLevel = this.engine.level as Level;
    return events;
  }

  startBreak(minutes: number, now = Date.now()): void {
    this.onBreakUntil = now + minutes * 60_000;
    this.engine.paused = true;
    this.engine.acknowledge();
  }

  endBreak(): void {
    this.onBreakUntil = undefined;
    this.engine.paused = false;
  }

  end(by: SessionRecord['endedBy'], now = Date.now()): SessionRecord {
    this.flushSpan();
    this.record.endedAt = now;
    this.record.endedBy = by;
    return this.record;
  }

  private trackSpan(s: LabeledSample, label: LabeledSample['label']): void {
    const same =
      this.span &&
      this.span.app === s.app &&
      this.span.domain === s.domain &&
      this.span.title === s.title &&
      this.span.label === label;
    if (same && this.span) {
      this.span.end = s.t;
      this.span.idleSec = Math.max(this.span.idleSec, s.idleSec);
      this.span.mediaPlaying = this.span.mediaPlaying || s.mediaPlaying;
      return;
    }
    this.flushSpan();
    this.span = {
      sessionId: this.record.id,
      app: s.app,
      bundleId: s.bundleId,
      title: s.title,
      url: s.url,
      domain: s.domain,
      label,
      start: s.t,
      end: s.t,
      idleSec: s.idleSec,
      mediaPlaying: s.mediaPlaying,
    };
  }

  private flushSpan(): void {
    if (this.span) this.writeSpan(this.span);
    this.span = null;
  }
}
