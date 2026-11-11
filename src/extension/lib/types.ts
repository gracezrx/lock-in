// What the panel shows and asks for. The same view whether Lock In Extended is linked to the
// Mac app (it shows the Mac's session, to-dos, goals and crew) or running on its own.
import type { CrewView, Label, Level, Persona, Role } from '../../shared/types';

export interface ExtSettings {
  /** Your name in the crew. */
  name: string;
  persona: Persona;
  role: Role;
  /** How long you can drift before it steps in (minutes). */
  toleranceMin: 2 | 5 | 10;
  /** The coach talks (with Chrome's voices). */
  voice: boolean;
  voiceName: string;
  /** Private iCal links: no nudges in meetings. */
  calendarUrl: string;
  quietInMeetings: boolean;
  /** Link to Lock In for Mac when it's running. */
  link: boolean;
  /** Has seen the first-run setup in the panel. */
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: ExtSettings = {
  name: '',
  persona: 'sassy',
  role: 'founder',
  toleranceMin: 5,
  voice: true,
  voiceName: '',
  calendarUrl: '',
  quietInMeetings: true,
  link: true,
  onboarded: false,
};

export type SessionStatus = 'focused' | 'drifting' | 'neutral' | 'break' | 'away';

export interface PanelSession {
  goal: string;
  plannedMin: number;
  startedAt: number;
  elapsedSec: number;
  focusSec: number;
  driftSec: number;
  level: Level;
  status: SessionStatus;
  /** Drifting on (a site), for the status line. */
  where?: string;
  onBreakUntil?: number;
  /** How close the coach is to stepping in, 0..1. */
  drift: number;
}

export interface PanelTodo {
  id: string;
  title: string;
  due?: string;
  done?: boolean;
  /** From your Mac's list (copied for when it isn't running). */
  mac?: boolean;
}

export interface PanelGoal {
  id: string;
  name: string;
  daysLeft?: number;
  progress?: string;
  pct?: number | null;
  tone?: string;
  /** The Mac's water goal: a +1 button. */
  water?: boolean;
  /** Made in this panel (can be removed here). */
  own?: boolean;
}

export interface PanelView {
  mode: 'linked' | 'solo';
  desktop: { connected: boolean; version?: string; syncedAt?: number };
  session: PanelSession | null;
  current: { domain: string; label: Label } | null;
  today: { focusMin: number; sessions: number; streak: number };
  todos: { open: PanelTodo[]; done: PanelTodo[]; canAdd: boolean; canComplete: boolean; from: string };
  goals: PanelGoal[];
  crew: CrewView | null;
  muteUntil?: number;
  lockout?: { until: number; from: string };
  lastGoal: string;
  meeting?: { now?: string; next?: string; nextAt?: number };
  /** Ending early means typing a sentence first (a Mac setting). */
  commitment?: boolean;
  settings: ExtSettings;
  distractions: string[];
  voices: string[];
}

/** Panel → service worker. */
export type Action =
  | { a: 'start'; goal: string; minutes: number }
  | { a: 'end' }
  | { a: 'break'; minutes: number }
  | { a: 'todo:add'; title: string }
  | { a: 'todo:done'; id: string }
  | { a: 'todo:undo'; id: string }
  | { a: 'todo:remove'; id: string }
  | { a: 'goal:add'; name: string; due?: string }
  | { a: 'goal:remove'; id: string }
  | { a: 'goal:water' }
  | { a: 'label'; label: 'work' | 'neutral' | 'distraction' }
  | { a: 'mute'; minutes: number }
  | { a: 'unmute' }
  | { a: 'crew:create'; crewName: string; name: string }
  | { a: 'crew:join'; code: string; name: string }
  | { a: 'crew:leave' }
  | { a: 'crew:bomb'; to: string; insult: string }
  | { a: 'settings'; patch: Partial<ExtSettings> }
  | { a: 'distraction:add'; domain: string }
  | { a: 'distraction:remove'; domain: string }
  | { a: 'voice:test' }
  | { a: 'mac:open'; route?: string }
  | { a: 'mac:talk' }
  | { a: 'relink' };
