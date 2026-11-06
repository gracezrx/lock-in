// Limits on when the coach may speak or interrupt.
import type { Profile, Settings } from '../shared/types';

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  return (h || 0) * 60 + (m || 0);
}

export function inQuietHours(settings: Settings, now = new Date()): boolean {
  const start = minutesOf(settings.quietStart);
  const end = minutesOf(settings.quietEnd);
  if (start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export class Guardrails {
  muteUntil = 0;
  private spokenAt: number[] = [];

  muted(now = Date.now()): boolean {
    return now < this.muteUntil;
  }

  mute(minutes: number, now = Date.now()): void {
    this.muteUntil = now + minutes * 60_000;
  }

  unmute(): void {
    this.muteUntil = 0;
  }

  /** May the coach use its voice right now? (Visuals follow their own rules.) */
  canSpeak(profile: Profile, settings: Settings, inCall: boolean, now = Date.now()): boolean {
    if (!profile.voice.speak || inCall || this.muted(now)) return false;
    if (inQuietHours(settings, new Date(now))) return false;
    return true;
  }

  /** Rate limit on spoken interventions: at most N per rolling hour. */
  spokenBudgetLeft(settings: Settings, now = Date.now()): boolean {
    this.spokenAt = this.spokenAt.filter((t) => now - t < 3_600_000);
    return this.spokenAt.length < settings.maxSpokenPerHour;
  }

  noteSpokenIntervention(now = Date.now()): void {
    this.spokenAt.push(now);
  }
}
