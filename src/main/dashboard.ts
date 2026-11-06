import type { DashboardData, SessionRecord } from '../shared/types';
import type { Store } from './store';

export function buildDashboard(store: Store, live: SessionRecord | null): DashboardData {
  const byId = new Map<string, SessionRecord>();
  for (const s of store.sessions()) byId.set(s.id, s);
  if (live) byId.set(live.id, { ...live });
  const sessions = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const weekAgo = t0 - 6 * 86_400_000;
  const todays = sessions.filter((s) => s.startedAt >= t0);

  const dist: Record<string, number> = {};
  for (const s of sessions.filter((x) => x.startedAt >= weekAgo)) {
    for (const [k, v] of Object.entries(s.topDistractions ?? {})) dist[k] = (dist[k] ?? 0) + v;
  }

  const stats: Record<string, { used: number; worked: number }> = {};
  for (const i of store.interventions()) {
    if (!i.option || i.option === 'self') continue;
    stats[i.option] = stats[i.option] ?? { used: 0, worked: 0 };
    stats[i.option].used += 1;
    if (i.worked) stats[i.option].worked += 1;
  }

  return {
    todayFocusMin: Math.round(todays.reduce((n, s) => n + s.focusSec, 0) / 60),
    todaySessions: todays.length,
    todayDrifts: todays.reduce((n, s) => n + s.interventions, 0),
    sessions: sessions.slice(0, 25),
    topDistractions: Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, sec]) => ({ name, minutes: Math.round(sec / 60) })),
    optionStats: Object.entries(stats)
      .map(([option, v]) => ({ option, ...v }))
      .sort((a, b) => b.used - a.used),
  };
}
