// The drift score: turns a stream of labeled samples into ladder levels.
// Pure logic, no Electron imports, so it is unit tested directly.
import type { Label, LabeledSample, Level } from '../../shared/types';

export interface DriftConfig {
  toleranceSec: number;
  graceSec: number;
  neutralFreeSec: number;
  idleThresholdSec: number;
  idleWorkFreeSec: number;
  awaySec: number;
  awayCheckinSec: number;
  recoverySec: number;
  patternSwitches: number;
  patternWindowSec: number;
  thresholds: [number, number, number, number];
}

export const DEFAULT_DRIFT: Omit<DriftConfig, 'toleranceSec'> = {
  graceSec: 60,
  neutralFreeSec: 180,
  idleThresholdSec: 60,
  idleWorkFreeSec: 600,
  awaySec: 300,
  awayCheckinSec: 900,
  recoverySec: 120,
  patternSwitches: 6,
  patternWindowSec: 600,
  thresholds: [0.4, 1, 1.5, 2],
};

export type DriftEvent =
  | { type: 'level'; level: Level; reason: 'score' | 'pattern' | 'repeat' }
  | { type: 'recovered' }
  | { type: 'away_checkin' };

export class DriftEngine {
  readonly cfg: DriftConfig;
  drift = 0;
  level: Level = 0;
  callouts = 0;
  paused = false;
  /** Seconds of uninterrupted work, used for recovery and streak praise. */
  workStreakSec = 0;
  private runLabel: Label | null = null;
  private runSec = 0;
  private idleWorkSec = 0;
  private awayRunSec = 0;
  private awayCheckinFired = false;
  private entries: number[] = [];

  constructor(toleranceMin: number, overrides: Partial<DriftConfig> = {}) {
    this.cfg = { ...DEFAULT_DRIFT, toleranceSec: toleranceMin * 60, ...overrides };
  }

  /** Seconds of drift needed for each level. */
  thresholdSec(level: 1 | 2 | 3 | 4): number {
    return this.cfg.thresholds[level - 1] * this.cfg.toleranceSec;
  }

  /** The effective label after idle and away rules. */
  effectiveLabel(s: LabeledSample): Label {
    if (s.idleSec >= this.cfg.awaySec && !s.mediaPlaying) return 'away';
    return s.label;
  }

  /** Weight per second for this sample. Positive builds drift, negative drains it. */
  weight(s: LabeledSample, label: Label): number {
    const idle = s.idleSec >= this.cfg.idleThresholdSec;
    switch (label) {
      case 'away':
      case 'private':
        return 0;
      case 'work':
        if (idle) return this.idleWorkSec > this.cfg.idleWorkFreeSec ? 0.5 : 0;
        return -2;
      case 'distraction':
        if (idle && s.mediaPlaying) return Math.max(1.5, s.weight);
        return this.runSec < this.cfg.graceSec ? 0 : s.weight;
      case 'neutral':
        if (idle && s.mediaPlaying) return 1.5;
        return this.runSec < this.cfg.neutralFreeSec ? 0 : 0.3;
    }
  }

  tick(s: LabeledSample, dtSec = 1): DriftEvent[] {
    const events: DriftEvent[] = [];
    if (this.paused) return events;
    const label = this.effectiveLabel(s);
    const idle = s.idleSec >= this.cfg.idleThresholdSec;

    // Track the current run of one label (switching sites inside "distraction" keeps the run).
    if (label !== this.runLabel) {
      if (label === 'distraction') this.recordEntry(s.t);
      this.runLabel = label;
      this.runSec = 0;
    }

    // Away tracking.
    if (label === 'away') {
      this.awayRunSec += dtSec;
      if (!this.awayCheckinFired && this.awayRunSec >= this.cfg.awayCheckinSec) {
        this.awayCheckinFired = true;
        events.push({ type: 'away_checkin' });
      }
    } else {
      this.awayRunSec = 0;
      this.awayCheckinFired = false;
    }

    // Work streak and idle-on-work tracking.
    if (label === 'work') {
      this.workStreakSec += dtSec;
      this.idleWorkSec = idle ? this.idleWorkSec + dtSec : 0;
    } else if (label !== 'away') {
      this.workStreakSec = 0;
      this.idleWorkSec = 0;
    }

    const w = this.weight(s, label);
    this.drift = Math.max(0, this.drift + w * dtSec);
    this.runSec += dtSec;

    // Recovery: two straight minutes of work after an intervention.
    if (this.level > 0 && label === 'work' && this.workStreakSec >= this.cfg.recoverySec) {
      this.level = 0;
      this.drift = 0;
      events.push({ type: 'recovered' });
      return events;
    }

    // Pattern trigger: lots of short trips into distractions.
    if (this.level < 2 && this.patternCount(s.t) >= this.cfg.patternSwitches) {
      this.entries = [];
      this.setLevel(2);
      events.push({ type: 'level', level: 2, reason: 'pattern' });
      return events;
    }

    // Score thresholds.
    let target: Level = 0;
    for (const lvl of [1, 2, 3, 4] as const) if (this.drift >= this.thresholdSec(lvl)) target = lvl;
    if (target > this.level) {
      let next = target;
      let reason: 'score' | 'repeat' = 'score';
      if (next === 3 && this.callouts >= 2) {
        next = 4;
        reason = 'repeat';
      }
      this.setLevel(next);
      events.push({ type: 'level', level: next, reason });
    }
    return events;
  }

  /** Force a level from outside (a break that ran over, a manual test). */
  force(level: Level): DriftEvent[] {
    if (level <= this.level) return [];
    this.setLevel(level);
    if (level >= 1) this.drift = Math.max(this.drift, this.thresholdSec(level as 1 | 2 | 3 | 4));
    return [{ type: 'level', level, reason: 'score' }];
  }

  /** The user answered the coach: back to level 0, drift cleared. */
  acknowledge(): void {
    this.level = 0;
    this.drift = 0;
    this.workStreakSec = 0;
  }

  setTolerance(toleranceMin: number): void {
    this.cfg.toleranceSec = toleranceMin * 60;
  }

  private setLevel(level: Level): void {
    this.level = level;
    if (level === 3) this.callouts += 1;
  }

  private recordEntry(t: number): void {
    this.entries.push(t);
    const cutoff = t - this.cfg.patternWindowSec * 1000;
    this.entries = this.entries.filter((x) => x >= cutoff);
  }

  private patternCount(t: number): number {
    const cutoff = t - this.cfg.patternWindowSec * 1000;
    return this.entries.filter((x) => x >= cutoff).length;
  }
}
