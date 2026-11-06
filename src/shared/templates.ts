// Role templates loaded by quiz question 1. Later answers edit these.
import type { AppUsage, CalendarSettings, Channel, CrewSettings, ExportSettings, NotifyKind, Profile, Role, Routine, RouteOption, SoundId, TalkSettings, TodoSettings } from './types';

export interface RoleTemplate {
  label: string;
  /** One plain line about the work, shown on the quiz card. */
  desc: string;
  workApps: string[];
  workDomains: string[];
  /** Extra distractions specific to the role (added to the common list). */
  extraDistractions?: Record<string, number>;
  /** Common distractions that are actually work for this role. */
  notDistractions?: string[];
  /** Distraction choices (quiz question 4/5 ids) that are "sometimes work" for this role. */
  graySuggest?: string[];
}

export const BROWSER_APPS = [
  'Google Chrome', 'Google Chrome Canary', 'Arc', 'Dia', 'Brave Browser', 'Microsoft Edge', 'Safari',
  'Firefox', 'Chromium', 'Opera', 'Vivaldi', 'Orion', 'Zen Browser',
];

export const BROWSER_BUNDLE_PREFIXES = [
  'com.google.chrome', 'company.thebrowser.', 'com.brave.browser', 'com.microsoft.edgemac', 'com.apple.safari',
  'org.mozilla.firefox', 'org.chromium.chromium', 'com.operasoftware.opera', 'com.vivaldi.vivaldi', 'com.kagi.kagimacos',
  'app.zen-browser.zen',
];

export const CALL_APPS = ['zoom.us', 'Microsoft Teams', 'FaceTime', 'Webex', 'Around', 'Tuple', 'Discord'];
export const CALL_DOMAINS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'whereby.com', 'meet.jit.si', 'app.gather.town'];

export const DEFAULT_NEUTRAL_APPS = [
  'Finder', 'System Settings', 'System Preferences', 'Mail', 'Calendar', 'Slack', 'Spotify', 'Music',
  'Activity Monitor', 'Preview', 'Lock In', 'Electron', 'Notes', 'Reminders', 'Microsoft Outlook', 'Superhuman',
  'Loginwindow', 'ScreenSaverEngine', 'Raycast', 'Alfred',
];

export const COMMON_DISTRACTIONS: Record<string, number> = {
  'youtube.com': 1.5,
  'x.com': 1.2,
  'twitter.com': 1.2,
  'reddit.com': 1.2,
  'instagram.com': 1.3,
  'tiktok.com': 1.5,
  'facebook.com': 1.1,
  'netflix.com': 1.5,
  'twitch.tv': 1.4,
  'hulu.com': 1.5,
  'disneyplus.com': 1.5,
  'primevideo.com': 1.5,
  'pinterest.com': 1.0,
  'news.ycombinator.com': 1.0,
  'cnn.com': 1.0,
  'nytimes.com': 1.0,
  'espn.com': 1.2,
  'amazon.com': 0.8,
  'xiaohongshu.com': 1.3,
  'bilibili.com': 1.4,
  'douyin.com': 1.5,
  'weibo.com': 1.2,
};

export const COMMON_DISTRACTION_APPS: Record<string, number> = {
  Steam: 1.5,
  Messages: 0.8,
  WhatsApp: 0.8,
  WeChat: 0.8,
  Telegram: 0.8,
  TV: 1.5,
  Netflix: 1.5,
  'Minecraft': 1.5,
  'Battle.net': 1.5,
};

/**
 * Setup: apps that count as distractions. "usual" ones (games, streaming, social) are picked
 * when they're on the Mac; chat apps are offered but left off (for many people chat is work).
 */
export const DISTRACTION_APP_CHOICES: { name: string; group: 'usual' | 'chat' }[] = [
  ...['Steam', 'Epic Games Launcher', 'Battle.net', 'Minecraft', 'League of Legends', 'Riot Client', 'Roblox', 'GOG Galaxy', 'Chess'].map((name) => ({ name, group: 'usual' as const })),
  ...['TV', 'Netflix', 'Disney+', 'Prime Video', 'YouTube', 'Twitch', 'Plex', 'Infuse'].map((name) => ({ name, group: 'usual' as const })),
  ...['X', 'Twitter', 'TikTok', 'Instagram', 'Pinterest', 'Threads', 'Bluesky', 'Ivory', 'Reddit', '小红书', '哔哩哔哩', '抖音', '微博'].map((name) => ({ name, group: 'usual' as const })),
  ...['Messages', 'WhatsApp', 'WeChat', 'Telegram', 'Discord', 'Messenger', 'Signal', 'LINE', 'QQ'].map((name) => ({ name, group: 'chat' as const })),
];

/** Quiz question 4 choices: label → domains/apps it covers. */
export const DISTRACTION_CHOICES: { id: string; label: string; domains: string[]; apps?: string[] }[] = [
  { id: 'youtube', label: 'YouTube', domains: ['youtube.com'] },
  { id: 'x', label: 'X / Twitter', domains: ['x.com', 'twitter.com'] },
  { id: 'reddit', label: 'Reddit', domains: ['reddit.com'] },
  { id: 'instagram', label: 'Instagram', domains: ['instagram.com'] },
  { id: 'tiktok', label: 'TikTok', domains: ['tiktok.com', 'douyin.com'] },
  { id: 'xhs', label: '小红书 / Bilibili', domains: ['xiaohongshu.com', 'bilibili.com', 'weibo.com'] },
  { id: 'streaming', label: 'Netflix & streaming', domains: ['netflix.com', 'hulu.com', 'disneyplus.com', 'primevideo.com', 'twitch.tv'], apps: ['TV', 'Netflix'] },
  { id: 'news', label: 'News & HN', domains: ['news.ycombinator.com', 'cnn.com', 'nytimes.com', 'espn.com'] },
  { id: 'pinterest', label: 'Pinterest', domains: ['pinterest.com'] },
  { id: 'shopping', label: 'Shopping', domains: ['amazon.com'] },
  { id: 'games', label: 'Games', domains: [], apps: ['Steam', 'Minecraft', 'Battle.net'] },
  { id: 'messages', label: 'Messages & chat', domains: ['web.whatsapp.com'], apps: ['Messages', 'WhatsApp', 'WeChat', 'Telegram'] },
];

export const ROLE_TEMPLATES: Record<Role, RoleTemplate> = {
  founder: {
    label: 'Founder',
    desc: 'Building a company: product, fundraising, hiring, go-to-market',
    workApps: ['Notion', 'Linear', 'Figma', 'Visual Studio Code', 'Cursor', 'Keynote', 'Microsoft PowerPoint', 'Microsoft Excel', 'Numbers', 'Pages', 'Claude', 'Granola', 'Superhuman'],
    workDomains: ['docs.google.com', 'sheets.google.com', 'slides.google.com', 'drive.google.com', 'notion.so', 'linear.app', 'figma.com', 'github.com', 'stripe.com', 'hubspot.com', 'claude.ai', 'chatgpt.com', 'producthunt.com', 'pitch.com', 'canva.com', 'airtable.com', 'calendly.com', 'docsend.com', 'carta.com', 'ycombinator.com'],
  },
  engineer: {
    label: 'Software engineer',
    desc: 'Writing, reviewing and shipping code',
    workApps: ['Visual Studio Code', 'Cursor', 'Xcode', 'Zed', 'Code', 'Terminal', 'iTerm2', 'Warp', 'Ghostty', 'IntelliJ IDEA', 'PyCharm', 'WebStorm', 'Docker Desktop', 'Postman', 'TablePlus', 'Android Studio', 'Claude'],
    workDomains: ['github.com', 'gitlab.com', 'stackoverflow.com', 'developer.mozilla.org', 'docs.python.org', 'localhost', '127.0.0.1', 'vercel.com', 'console.aws.amazon.com', 'console.cloud.google.com', 'linear.app', 'atlassian.net', 'npmjs.com', 'pypi.org', 'claude.ai', 'docs.claude.com', 'chatgpt.com', 'supabase.com', 'sentry.io', 'datadoghq.com'],
  },
  pm: {
    label: 'Product manager',
    desc: 'Specs, roadmaps, tickets and user research',
    workApps: ['Linear', 'Notion', 'Figma', 'Miro', 'Jira', 'Productboard', 'Microsoft Excel', 'Keynote', 'Claude', 'Loom'],
    workDomains: ['linear.app', 'atlassian.net', 'notion.so', 'figma.com', 'miro.com', 'amplitude.com', 'mixpanel.com', 'productboard.com', 'docs.google.com', 'sheets.google.com', 'loom.com', 'claude.ai', 'dovetail.com'],
  },
  designer: {
    label: 'Designer',
    desc: 'Interfaces, brand and visual work',
    workApps: ['Figma', 'Sketch', 'Adobe Photoshop', 'Adobe Illustrator', 'Adobe XD', 'Framer', 'Affinity Designer', 'Rive', 'Spline', 'Blender', 'Canva'],
    workDomains: ['figma.com', 'framer.com', 'canva.com', 'coolors.co', 'fonts.google.com', 'unsplash.com', 'mobbin.com', 'dribbble.com', 'behance.net', 'linear.app', 'notion.so', 'claude.ai'],
    graySuggest: ['pinterest'],
  },
  finance: {
    label: 'Banking, consulting or finance',
    desc: 'Models, decks, memos, diligence and market research',
    workApps: ['Microsoft Excel', 'Microsoft PowerPoint', 'Microsoft Word', 'Numbers', 'Keynote', 'Bloomberg', 'FactSet', 'Tableau', 'Adobe Acrobat', 'PDF Expert', 'Claude'],
    workDomains: ['docs.google.com', 'sheets.google.com', 'capitaliq.com', 'capitaliq.spglobal.com', 'pitchbook.com', 'sec.gov', 'factset.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'reuters.com', 'finance.yahoo.com', 'macrotrends.net', 'investor.gov', 'claude.ai'],
    notDistractions: ['cnn.com', 'nytimes.com'],
  },
  data: {
    label: 'Data or analytics',
    desc: 'SQL, notebooks, dashboards and analysis',
    workApps: ['Visual Studio Code', 'Cursor', 'DataGrip', 'TablePlus', 'Jupyter', 'RStudio', 'Tableau', 'Power BI', 'Microsoft Excel', 'Terminal', 'Claude'],
    workDomains: ['github.com', 'colab.research.google.com', 'kaggle.com', 'databricks.com', 'snowflakecomputing.com', 'looker.com', 'lookerstudio.google.com', 'mode.com', 'hex.tech', 'metabase.com', 'stackoverflow.com', 'docs.google.com', 'sheets.google.com', 'claude.ai'],
  },
  marketing: {
    label: 'Marketing, growth or social',
    desc: 'Campaigns, social posts, newsletters and analytics',
    workApps: ['Canva', 'Figma', 'Notion', 'Adobe Photoshop', 'CapCut', 'Claude'],
    workDomains: ['canva.com', 'figma.com', 'notion.so', 'hubspot.com', 'mailchimp.com', 'buffer.com', 'hootsuite.com', 'later.com', 'analytics.google.com', 'ads.google.com', 'business.facebook.com', 'linkedin.com', 'beehiiv.com', 'substack.com', 'docs.google.com', 'claude.ai'],
    graySuggest: ['x', 'instagram', 'tiktok', 'xhs', 'reddit'],
  },
  creator: {
    label: 'Content creator',
    desc: 'Filming, editing, streaming and posting',
    workApps: ['Final Cut Pro', 'Adobe Premiere Pro', 'DaVinci Resolve', 'CapCut', 'OBS', 'Descript', 'Logic Pro', 'GarageBand', 'Adobe After Effects', 'iMovie', 'Canva'],
    workDomains: ['studio.youtube.com', 'canva.com', 'descript.com', 'riverside.fm', 'claude.ai', 'docs.google.com'],
    graySuggest: ['youtube', 'tiktok', 'instagram', 'xhs', 'x'],
  },
  sales: {
    label: 'Sales or partnerships',
    desc: 'CRM, outreach, demos and calls',
    workApps: ['Salesforce', 'HubSpot', 'Microsoft Outlook', 'Zoom', 'Gong', 'Claude'],
    workDomains: ['salesforce.com', 'lightning.force.com', 'hubspot.com', 'linkedin.com', 'apollo.io', 'gong.io', 'outreach.io', 'mail.google.com', 'calendar.google.com', 'docs.google.com', 'claude.ai'],
  },
  ops: {
    label: 'Operations or admin',
    desc: 'Docs, spreadsheets, scheduling and coordination',
    workApps: ['Microsoft Excel', 'Numbers', 'Notion', 'Airtable', 'Microsoft Word', 'Claude'],
    workDomains: ['docs.google.com', 'sheets.google.com', 'airtable.com', 'notion.so', 'asana.com', 'monday.com', 'mail.google.com', 'calendar.google.com', 'gusto.com', 'rippling.com', 'claude.ai'],
  },
  student: {
    label: 'Student',
    desc: 'Classes, problem sets, papers and studying',
    workApps: ['Microsoft Word', 'Pages', 'Notion', 'Obsidian', 'Anki', 'Zotero', 'GoodNotes', 'Notability', 'Preview', 'RStudio', 'MATLAB', 'Visual Studio Code', 'Claude'],
    workDomains: ['docs.google.com', 'drive.google.com', 'instructure.com', 'canvas.brown.edu', 'scholar.google.com', 'jstor.org', 'wikipedia.org', 'khanacademy.org', 'quizlet.com', 'coursera.org', 'edx.org', 'overleaf.com', 'wolframalpha.com', 'gradescope.com', 'piazza.com', 'edstem.org', 'claude.ai', 'chatgpt.com', 'notion.so'],
  },
  research: {
    label: 'Researcher or academic',
    desc: 'Reading papers, running experiments, writing',
    workApps: ['Zotero', 'Microsoft Word', 'Visual Studio Code', 'RStudio', 'MATLAB', 'Preview', 'Skim', 'Obsidian', 'Jupyter', 'Claude'],
    workDomains: ['scholar.google.com', 'arxiv.org', 'overleaf.com', 'jstor.org', 'pubmed.ncbi.nlm.nih.gov', 'semanticscholar.org', 'researchgate.net', 'wikipedia.org', 'github.com', 'claude.ai'],
  },
  writer: {
    label: 'Writer or editor',
    desc: 'Articles, scripts, books and editing',
    workApps: ['Microsoft Word', 'Pages', 'Scrivener', 'Ulysses', 'iA Writer', 'Obsidian', 'Bear', 'Notion', 'Claude'],
    workDomains: ['docs.google.com', 'grammarly.com', 'thesaurus.com', 'merriam-webster.com', 'notion.so', 'substack.com', 'medium.com', 'claude.ai'],
  },
  legal: {
    label: 'Lawyer or legal',
    desc: 'Contracts, research and drafting',
    workApps: ['Microsoft Word', 'Adobe Acrobat', 'PDF Expert', 'Microsoft Outlook', 'Claude'],
    workDomains: ['westlaw.com', 'lexisnexis.com', 'casetext.com', 'docusign.com', 'ironcladapp.com', 'harvey.ai', 'courtlistener.com', 'docs.google.com', 'claude.ai'],
  },
  teacher: {
    label: 'Teacher or tutor',
    desc: 'Lesson plans, grading and class prep',
    workApps: ['Keynote', 'Microsoft PowerPoint', 'Pages', 'Microsoft Word', 'Notion', 'Claude'],
    workDomains: ['classroom.google.com', 'docs.google.com', 'slides.google.com', 'instructure.com', 'quizlet.com', 'kahoot.com', 'khanacademy.org', 'claude.ai'],
  },
  other: {
    label: 'Something else',
    desc: 'Tell us in a few words',
    workApps: ['Notion', 'Microsoft Word', 'Microsoft Excel', 'Pages', 'Numbers', 'Keynote', 'Claude'],
    workDomains: ['docs.google.com', 'drive.google.com', 'notion.so', 'claude.ai'],
  },
};

export const ROLE_ORDER: Role[] = ['founder', 'engineer', 'pm', 'designer', 'finance', 'data', 'marketing', 'creator', 'sales', 'ops', 'student', 'research', 'writer', 'legal', 'teacher', 'other'];

export const VIDEO_SITES = ['youtube.com', 'vimeo.com', 'twitch.tv', 'bilibili.com', 'loom.com'];

export const DEFAULT_ROUTE_ORDER: RouteOption[] = ['back', 'starter', 'break', 'talk'];

/** Work apps and sites across every chosen role. */
export function combineRoles(roles: Role[]): { workApps: string[]; workDomains: string[]; notDistractions: string[]; graySuggest: string[] } {
  const list = roles.length ? roles : (['other'] as Role[]);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    workApps: uniq(list.flatMap((r) => ROLE_TEMPLATES[r].workApps)),
    workDomains: uniq(list.flatMap((r) => ROLE_TEMPLATES[r].workDomains)),
    notDistractions: uniq(list.flatMap((r) => ROLE_TEMPLATES[r].notDistractions ?? [])),
    graySuggest: uniq(list.flatMap((r) => ROLE_TEMPLATES[r].graySuggest ?? [])),
  };
}

export function buildDefaultProfile(roles: Role | Role[]): Profile {
  const list = Array.isArray(roles) ? (roles.length ? roles : (['other'] as Role[])) : [roles];
  const t = combineRoles(list);
  const extra = Object.assign({}, ...list.map((r) => ROLE_TEMPLATES[r].extraDistractions ?? {})) as Record<string, number>;
  const distractions: Record<string, number> = { ...COMMON_DISTRACTIONS, ...extra };
  for (const d of t.notDistractions) delete distractions[d];
  for (const d of t.workDomains) delete distractions[d];
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    role: list[0],
    roles: [...list],
    workApps: [...t.workApps],
    workDomains: [...t.workDomains],
    distractionDomains: distractions,
    distractionApps: { ...COMMON_DISTRACTION_APPS },
    neutralApps: [...DEFAULT_NEUTRAL_APPS],
    grayRules: [],
    schedule: null,
    toleranceMin: 5,
    persona: 'sassy',
    voice: { speak: true, listen: true },
    routeBackOrder: [...DEFAULT_ROUTE_ORDER],
  };
}

/** "Founder, Student; also: <their own words>", for prompts. */
export function roleText(p: Pick<Profile, 'role' | 'roles' | 'roleNote'>): string {
  const roles = p.roles?.length ? p.roles : [p.role];
  const labels = roles.filter((r) => r !== 'other' || !p.roleNote).map((r) => ROLE_TEMPLATES[r]?.label ?? r);
  return [labels.join(', '), p.roleNote?.trim()].filter(Boolean).join('; ');
}

export const DEFAULT_GRAY_KEYWORDS = ['tutorial', 'lecture', 'course', 'how to', 'talk', 'conference', 'explained', 'walkthrough', 'docs'];

// ---- notifications ---------------------------------------------------------------

export const CHANNELS: { id: Channel; label: string; help: string }[] = [
  { id: 'toast', label: 'Corner card', help: 'A card in the top-right corner with buttons' },
  { id: 'card', label: 'Full screen', help: 'The yellow or red card over everything' },
  { id: 'tab', label: 'Chrome card', help: 'A big Lock In card over the distracting tab for 5 seconds (only when the tab in front is a distraction)' },
  { id: 'voice', label: 'Voice', help: 'The coach says it out loud' },
  { id: 'sound', label: 'Sound', help: 'A whistle, horn or chime' },
  { id: 'system', label: 'macOS', help: 'A Notification Center banner' },
  { id: 'menubar', label: 'Menu bar', help: 'The menu bar title flashes' },
  { id: 'dock', label: 'Dock', help: 'The Dock icon bounces' },
  { id: 'phone', label: 'Phone', help: 'A push to your phone through ntfy' },
  { id: 'webhook', label: 'Slack/Discord', help: 'A message to a channel you choose' },
];

export const NOTIFY_KINDS: { id: NotifyKind; label: string; help: string }[] = [
  { id: 'nudge', label: 'Nudge', help: 'Level 1: drifting a little' },
  { id: 'speak', label: 'Coach speaks', help: 'Level 2: drifting for your full tolerance' },
  { id: 'yellow', label: 'Yellow card', help: 'Level 3: video paused, call-out' },
  { id: 'red', label: 'Red card', help: 'Level 4: site blocked' },
  { id: 'todo_roast', label: 'To-do roast', help: 'Hours on the computer, nothing ticked off' },
  { id: 'todo_win', label: 'Task done', help: 'You finished something' },
  { id: 'routine', label: 'Routines', help: 'Kickoff, deep work, check-ins, shutdown, weekly review' },
  { id: 'wellness', label: 'Body breaks', help: 'Water, stretch, eyes, lunch' },
  { id: 'bedtime', label: 'Bedtime', help: 'Still on the computer too late' },
  { id: 'session', label: 'Session start and end', help: 'Locked in, Pomodoro breaks, recaps' },
  { id: 'meeting', label: 'Meetings', help: 'A heads-up before a meeting, and a lock-in offer after one' },
  { id: 'deadline', label: 'Deadlines', help: 'Once 3 days before, twice 2 days before, three times the day before' },
];

export const DEFAULT_NOTIFY: Record<NotifyKind, Channel[]> = {
  nudge: ['toast', 'tab', 'sound'],
  speak: ['toast', 'tab', 'voice', 'sound'],
  yellow: ['card', 'tab', 'voice', 'sound', 'system', 'menubar'],
  red: ['card', 'tab', 'voice', 'sound', 'system', 'menubar', 'dock', 'phone'],
  todo_roast: ['toast', 'tab', 'voice', 'sound', 'system'],
  todo_win: ['toast', 'sound'],
  routine: ['toast', 'voice', 'sound', 'system'],
  wellness: ['toast', 'sound'],
  bedtime: ['toast', 'sound', 'system', 'menubar'],
  session: ['toast', 'voice'],
  meeting: ['toast', 'sound'],
  deadline: ['toast', 'voice', 'sound', 'system'],
};

export const DEFAULT_SOUNDS: Record<NotifyKind, SoundId> = {
  nudge: 'whistle',
  speak: 'whistle',
  yellow: 'airhorn',
  red: 'buzzer',
  todo_roast: 'sad_trombone',
  todo_win: 'fanfare',
  routine: 'chime',
  wellness: 'ding',
  bedtime: 'Purr',
  session: 'none',
  meeting: 'Glass',
  deadline: 'Hero',
};

export const SOUNDS: { id: SoundId; label: string }[] = [
  { id: 'none', label: 'No sound' },
  { id: 'whistle', label: 'Referee whistle' },
  { id: 'airhorn', label: 'Air horn' },
  { id: 'buzzer', label: 'Buzzer' },
  { id: 'sad_trombone', label: 'Sad trombone' },
  { id: 'fanfare', label: 'Fanfare' },
  { id: 'chime', label: 'Chime' },
  { id: 'ding', label: 'Ding' },
  { id: 'Glass', label: 'Mac: Glass' },
  { id: 'Ping', label: 'Mac: Ping' },
  { id: 'Pop', label: 'Mac: Pop' },
  { id: 'Purr', label: 'Mac: Purr' },
  { id: 'Sosumi', label: 'Mac: Sosumi' },
  { id: 'Submarine', label: 'Mac: Submarine' },
  { id: 'Tink', label: 'Mac: Tink' },
  { id: 'Funk', label: 'Mac: Funk' },
  { id: 'Hero', label: 'Mac: Hero' },
  { id: 'Basso', label: 'Mac: Basso' },
  { id: 'Blow', label: 'Mac: Blow' },
  { id: 'Bottle', label: 'Mac: Bottle' },
  { id: 'Frog', label: 'Mac: Frog' },
  { id: 'Morse', label: 'Mac: Morse' },
];

// ---- to-dos ----------------------------------------------------------------------

export const DEFAULT_TODO: TodoSettings = {
  provider: 'builtin',
  remindersList: '',
  remindersScope: 'today',
  thingsList: 'Today',
  todoistFilter: 'today | overdue',
  sheet: { kind: 'google', url: '', path: '', tab: '', token: '', task: null, done: null, due: null, priority: null, assignee: null, owner: null, scope: 'all' },
  roastsEnabled: true,
  noProgressMin: 90,
  maxRoastsPerDay: 6,
  celebrate: true,
  hidden: [],
};

export const DEFAULT_TALK: TalkSettings = { afterRoast: true, maxMinutes: 5, holdSpace: true };
export const DEFAULT_CALENDAR: CalendarSettings = { urls: [], mac: false, quietInMeetings: true, headsUpMin: 5, offerGaps: true, capSessions: true };
export const DEFAULT_EXPORT: ExportSettings = { auto: true, folder: '' };
export const DEFAULT_CREW: CrewSettings = { code: '', crewName: '', name: '', server: 'https://ntfy.sh', shareGoal: true, shareDistraction: false, bombsFullScreen: true, bombsLockout: true };

export const TODO_PROVIDERS: { id: TodoSettings['provider']; label: string; help: string }[] = [
  { id: 'reminders', label: 'Apple Reminders', help: 'Reads your Reminders on this Mac. macOS asks permission once.' },
  { id: 'things', label: 'Things 3', help: 'Reads your Today list in Things. macOS asks permission once.' },
  { id: 'todoist', label: 'Todoist', help: 'Needs your Todoist API token (Settings, Integrations, Developer).' },
  { id: 'sheet', label: 'Spreadsheet', help: 'Google Sheets, Excel, Numbers or CSV. Finds the task and done columns for you.' },
  { id: 'builtin', label: 'Lock In list', help: 'A simple list kept in this app.' },
  { id: 'none', label: 'No to-do list', help: 'Turns off to-do roasts and celebrations.' },
];

// ---- routines --------------------------------------------------------------------

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export const DEFAULT_ROUTINES: Routine[] = [
  { id: 'kickoff', kind: 'kickoff', name: 'Morning kickoff', enabled: true, trigger: { type: 'time', at: '09:00', days: WEEKDAYS } },
  { id: 'deepwork', kind: 'deepwork', name: 'Deep work block', enabled: false, minutes: 90, trigger: { type: 'time', at: '09:30', days: WEEKDAYS } },
  { id: 'hydrate', kind: 'hydrate', name: 'Drink water', enabled: true, trigger: { type: 'interval', everyMin: 60, from: '08:00', to: '21:00', days: EVERY_DAY } },
  { id: 'stretch', kind: 'stretch', name: 'Stand up and stretch', enabled: true, trigger: { type: 'interval', everyMin: 50, from: '08:00', to: '22:00', days: EVERY_DAY } },
  { id: 'eyes', kind: 'eyes', name: '20-20-20 eye break', enabled: false, trigger: { type: 'interval', everyMin: 20, from: '08:00', to: '22:00', days: EVERY_DAY } },
  { id: 'lunch', kind: 'lunch', name: 'Lunch', enabled: true, trigger: { type: 'time', at: '12:30', days: EVERY_DAY } },
  { id: 'midday', kind: 'midday', name: 'Midday reality check', enabled: true, trigger: { type: 'time', at: '14:00', days: WEEKDAYS } },
  { id: 'shutdown', kind: 'shutdown', name: 'End-of-day shutdown', enabled: true, trigger: { type: 'time', at: '18:00', days: WEEKDAYS } },
  { id: 'bedtime', kind: 'bedtime', name: 'Bedtime', enabled: true, trigger: { type: 'time', at: '23:30', days: EVERY_DAY } },
  { id: 'weekly', kind: 'weekly', name: 'Weekly review', enabled: true, trigger: { type: 'time', at: '17:00', days: [0] } },
];

export const ROUTINE_HELP: Record<Routine['kind'], string> = {
  kickoff: 'Reads your to-dos, picks the first one and offers to lock in on it.',
  deepwork: 'Offers a focus session on your top task.',
  hydrate: 'Every so many minutes of screen time.',
  stretch: 'Every so many minutes of screen time.',
  eyes: 'Look 20 feet away for 20 seconds.',
  lunch: 'Go eat something real.',
  midday: 'How many to-dos are done, with commentary.',
  shutdown: 'What you finished, what is left, and a nudge to close the laptop.',
  bedtime: 'Nags you every 15 minutes while you are still on the computer.',
  weekly: 'Focus hours and tasks done this week, then plan the next one.',
  custom: 'Your own reminder.',
};

/** The role apps you actually use: template ∩ used in 30 days (or ∩ installed when there is no usage data). */
export function suggestWorkApps(template: string[], apps: AppUsage[], now = Date.now()): string[] {
  const month = now - 30 * 86_400_000;
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const used = new Map(apps.filter((a) => a.lastUsed >= month).map((a) => [key(a.name), a.name]));
  const all = new Map(apps.map((a) => [key(a.name), a.name]));
  const pool = used.size ? used : all;
  if (!pool.size) return [...template];
  const out: string[] = [];
  for (const t of template) {
    const hit = pool.get(key(t));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}


/** The moments that get the Chrome card by default ("telling you to focus"). */
export const TAB_CARD_KINDS: NotifyKind[] = ['nudge', 'speak', 'yellow', 'red', 'todo_roast'];
