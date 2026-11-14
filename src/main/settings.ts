// Lock In's settings: the defaults, and how a saved settings file is brought up to date.
// (Separate from store.ts so it can be tested without Electron.)
import type { Settings } from '../shared/types';
import { DEFAULT_CALENDAR, DEFAULT_CREW, DEFAULT_EXPORT, DEFAULT_NOTIFY, DEFAULT_SOUNDS, DEFAULT_TALK, DEFAULT_TODO, TAB_CARD_KINDS } from '../shared/templates';

export const DEFAULT_SETTINGS: Settings = {
  notify: DEFAULT_NOTIFY,
  sounds: DEFAULT_SOUNDS,
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  webhookUrl: '',
  todo: DEFAULT_TODO,
  voiceId: 'pNInz6obpgDQGcFmaJgB',
  ttsModelLive: 'eleven_flash_v2_5',
  ttsModelShout: 'eleven_v3',
  sttModel: 'scribe_v2',
  sayVoice: '',
  coachModel: 'claude-sonnet-5-5',
  classifierModel: 'claude-haiku-5-5',
  volumeCap: 0.8,
  quietStart: '22:00',
  quietEnd: '08:00',
  profanityOk: false,
  titlesStayLocal: false,
  maxSpokenPerHour: 6,
  commitmentMode: false,
  sensitiveDomains: ['paypal.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'schwab.com', 'fidelity.com', 'robinhood.com', 'venmo.com', 'mercury.com', 'brex.com', 'americanexpress.com', 'capitalone.com'],
  sensitiveApps: ['1Password', '1Password 7', 'Bitwarden', 'Dashlane', 'LastPass', 'Keychain Access', 'Passwords'],
  breakMinutes: 7,
  talk: DEFAULT_TALK,
  calendar: DEFAULT_CALENDAR,
  exportCsv: DEFAULT_EXPORT,
  crew: DEFAULT_CREW,
  phone: { enabled: false },
  look: { theme: 'jail', keyCursor: true },
  goals: { enabled: true, suggest: true, nudges: true },
  attention: { pauses: true, maxPerDay: 12, minGapMin: 20 },
  ui: 'panel',
  telemetry: { features: true, apps: false, asked: false },
};

/** Saved settings plus defaults for anything added since, and one-time upgrades. */
export function migrateSettings(raw: Partial<Settings>): Settings {
  const notify = { ...DEFAULT_SETTINGS.notify, ...(raw.notify ?? {}) };
  const migrated = [...(raw.migrated ?? [])];
  // The Chrome card arrived after these were saved: turn it on for the "lock in" moments, once.
  if (!migrated.includes('tab-card')) {
    if (raw.notify) for (const k of TAB_CARD_KINDS) if (raw.notify[k] && !notify[k].includes('tab')) notify[k] = [...notify[k], 'tab'];
    migrated.push('tab-card');
  }
  // Nested groups merge key by key, so new event kinds and options get their defaults.
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    migrated,
    notify,
    sounds: { ...DEFAULT_SETTINGS.sounds, ...(raw.sounds ?? {}) },
    todo: { ...DEFAULT_SETTINGS.todo, ...(raw.todo ?? {}), sheet: { ...DEFAULT_SETTINGS.todo.sheet, ...(raw.todo?.sheet ?? {}) } },
    talk: { ...DEFAULT_TALK, ...(raw.talk ?? {}) },
    calendar: { ...DEFAULT_CALENDAR, ...(raw.calendar ?? {}) },
    exportCsv: { ...DEFAULT_EXPORT, ...(raw.exportCsv ?? {}) },
    crew: { ...DEFAULT_CREW, ...(raw.crew ?? {}) },
    phone: { ...DEFAULT_SETTINGS.phone, ...(raw.phone ?? {}) },
    look: { ...DEFAULT_SETTINGS.look, ...(raw.look ?? {}) },
    goals: { ...DEFAULT_SETTINGS.goals, ...(raw.goals ?? {}) },
    attention: { ...DEFAULT_SETTINGS.attention, ...(raw.attention ?? {}) },
    telemetry: { ...DEFAULT_SETTINGS.telemetry, ...(raw.telemetry ?? {}) },
  };
}
