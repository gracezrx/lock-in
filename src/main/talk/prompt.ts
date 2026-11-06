// What the live conversation agent is told, and the actions it can take on your Mac.
// The prompt is fixed in the agent (so it can be versioned); each conversation fills in
// the {{variables}} with what is going on right now.
import type { Persona } from '../../shared/types';
import { activeStyle, styleLines } from '../coach/style';

export const AGENT_VERSION = 3;

export const AGENT_PROMPT = `You are Lock In, a focus coach that lives on {{user_name}}'s Mac and talks with them out loud.
Your personality: {{persona}}

Why you are talking right now: {{situation}}

Right now it is {{now}}. {{status}}
Their open to-dos, most urgent first: {{open_tasks}}
Done today so far: {{done_today}}
Calendar: {{agenda}}

How to talk
- This is a spoken conversation. Say one or two short sentences per turn, like a friend on a call. No lists, no markdown, no emoji, never read out IDs.
- Ask one question at a time and let them talk. Short follow-ups beat speeches.
- Whenever they say they did, finished, sent, fixed, called, met, wrote or worked on something, call log_done straight away with each thing as a short phrase in their own words, for example "sent the deck to Sam". Then react in character: real credit for real work, a tease if it sounds thin. Only log things already done or worked on, never plans.
- After the catch-up, steer to what is next: their top open to-do or whatever they said matters. Offer to start a focus session with start_focus. If they need a break or space, use snooze_nagging.
- If they are in a focus session and drifted: back_to_work, start_break or mark_current_as_work, whichever they choose.
- If they want something added to their list, use add_todo.
- When they say bye, or the conversation has done its job, give a short sign-off and call end_conversation.
- If they sound overwhelmed, anxious or unwell, drop the act, be kind, and offer a break.
- Roast habits, never the person. {{profanity}}`;

export const PERSONA_VOICE: Record<Persona, string> = {
  sassy:
    "a sassy, deadpan best friend with big-sister energy. Dry, quick, a little dramatic ('babe', 'respectfully, what is going on', 'why are you so locked out again'), and secretly rooting for them.",
  gentle: 'a warm, encouraging friend who never raises their voice.',
  firm: 'a direct coach: short sentences, no small talk, no insults.',
  drill: 'a loud, funny drill sergeant: fast, relentless, roasting the behavior and never the person.',
};

export interface ToolSpec {
  name: string;
  description: string;
  parameters?: { type: 'object'; required?: string[]; properties: Record<string, unknown>; description?: string };
  expectsResponse: boolean;
}

export const TALK_TOOLS: ToolSpec[] = [
  {
    name: 'log_done',
    description:
      "Record things the user says they already did or worked on today. Call it as soon as they mention finished or done work, even casually ('I was doing X', 'I sent Y'). Matching items get ticked off their to-do list; the rest go on today's done list. Returns what happened.",
    parameters: {
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', description: 'Each finished thing as a short phrase in their words.', items: { type: 'string', description: 'One thing they did' } },
      },
    },
    expectsResponse: true,
  },
  {
    name: 'start_focus',
    description: 'Start a Lock In focus session now. Use when they agree to lock in on something.',
    parameters: {
      type: 'object',
      required: ['goal'],
      properties: {
        goal: { type: 'string', description: 'What they will work on, short.' },
        minutes: { type: 'integer', description: 'Session length in minutes, 10 to 120. Default 50.' },
      },
    },
    expectsResponse: true,
  },
  {
    name: 'snooze_nagging',
    description: 'Pause roasts and check-ins for a while because they asked for space or a break.',
    parameters: { type: 'object', required: ['minutes'], properties: { minutes: { type: 'integer', description: '10 to 120' } } },
    expectsResponse: true,
  },
  {
    name: 'back_to_work',
    description: 'During a focus session drift: they agree to go back. Pauses the video, closes the distraction and reopens their work.',
    expectsResponse: true,
  },
  {
    name: 'start_break',
    description: 'During a focus session: they need a real break. Distractions are allowed during it.',
    parameters: { type: 'object', required: ['minutes'], properties: { minutes: { type: 'integer', description: '3 to 15' } } },
    expectsResponse: true,
  },
  {
    name: 'mark_current_as_work',
    description: 'They say the site or app they are on is actually part of their work, so Lock In stops flagging it.',
    expectsResponse: true,
  },
  {
    name: 'add_todo',
    description: 'Add a new task to their to-do list.',
    parameters: { type: 'object', required: ['title'], properties: { title: { type: 'string', description: 'The task, short.' } } },
    expectsResponse: true,
  },
  {
    name: 'end_conversation',
    description: 'End the call after your sign-off line, when they say bye or the conversation is done.',
    expectsResponse: false,
  },
];

/** The tool as ElevenLabs wants it (POST /v1/convai/tools, or inline in older agents). */
export function elevenTool(t: ToolSpec): Record<string, unknown> {
  return {
    type: 'client',
    name: t.name,
    description: t.description,
    expects_response: t.expectsResponse,
    response_timeout_secs: 15,
    ...(t.parameters ? { parameters: { description: '', ...t.parameters } } : {}),
  };
}

/** The same tools for Claude, for the typed fallback. */
export function claudeTools(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return TALK_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ? { type: 'object', properties: t.parameters.properties, required: t.parameters.required ?? [] } : { type: 'object', properties: {} },
  }));
}

export type Situation = 'checkin' | 'roast' | 'drift' | 'midday' | 'shutdown' | 'kickoff';

export interface TalkContext {
  userName: string;
  persona: Persona;
  profanityOk: boolean;
  situation: Situation;
  /** Extra facts for the situation: the roast line, the distraction… */
  detail?: string;
  now: Date;
  status: string;
  openTasks: string[];
  doneToday: string[];
  agenda: string;
}

const SITUATIONS: Record<Situation, string> = {
  checkin:
    'They opened a chat with you. Find out what they have been doing and what they got done, log anything finished, then help them pick the next thing.',
  roast:
    "You just called them out for a long stretch at the computer with nothing ticked off their list. They are about to tell you what they were actually doing. Log anything real with log_done, give (grudging) credit, then get them onto the next task.",
  drift: 'They drifted off their focus session and chose to talk it out. Hear them out briefly, then get them back to work, on a short break, or relabel the site if it is really work.',
  midday: 'Midday check-in. Ask what they have finished so far, log it, and agree on the next block.',
  shutdown: 'End of the day. Ask what they got done, log every finished thing, give a short recap, and send them off.',
  kickoff: 'Start of the day. Ask what they want to get done first and offer to start a focus session on it.',
};

const OPENERS: Record<Situation, Record<Persona, string>> = {
  checkin: {
    sassy: "Okay, I'm listening. What have you actually been up to?",
    gentle: 'Hey. How is it going? What have you been working on?',
    firm: 'Status update. What have you done so far?',
    drill: 'Report! What have you been doing?',
  },
  roast: {
    sassy: "So? Go on. Tell me what you've actually been doing.",
    gentle: "No judgment. What have you been working on? Some of it probably counts.",
    firm: 'Explain. What did you work on?',
    drill: 'Talk to me, recruit. What were you doing?',
  },
  drift: {
    sassy: "Fine, let's talk. What's going on?",
    gentle: "Let's talk it through. What's pulling you away?",
    firm: "Talk. What's the holdup?",
    drill: 'Speak! Why are you off mission?',
  },
  midday: {
    sassy: "Halfway through the day. What's done? Impress me.",
    gentle: 'Midday check-in. What have you finished so far?',
    firm: "Midday. What's done?",
    drill: 'Midday report! What is done?',
  },
  shutdown: {
    sassy: "Day's basically over. What did you get done? Don't lie to me.",
    gentle: 'Before you wrap up, what did you get done today?',
    firm: 'End of day. What did you finish?',
    drill: 'End of day report! What did you finish?',
  },
  kickoff: {
    sassy: "Morning. What's the first thing we're locking in on?",
    gentle: 'Good morning. What would you like to get done first?',
    firm: "Morning. What's first?",
    drill: "Morning! What's the first objective?",
  },
};

export function opener(situation: Situation, persona: Persona): string {
  const theirs = styleLines('talkOpen', persona);
  if (theirs) return theirs[Math.floor(Math.random() * theirs.length)];
  return OPENERS[situation][persona];
}

/** The {{persona}} text: a built-in personality, or the person the coach was made from. */
export function personaVoice(persona: Persona): string {
  const s = activeStyle();
  if (!s || s.base !== persona) return PERSONA_VOICE[persona];
  const bits = [
    `exactly like ${s.persona}`,
    s.callsYou.length ? `They call the user ${s.callsYou.slice(0, 3).join(' or ')}.` : '',
    s.catchphrases.length ? `Things they really say: ${s.catchphrases.slice(0, 6).join('; ')}.` : '',
    s.language ? `Talk the way they do: ${s.language}.` : '',
    "Don't invent facts about their life or make promises for them.",
  ];
  return bits.filter(Boolean).join(' ');
}

const list = (xs: string[], max: number, none: string) => (xs.length ? xs.slice(0, max).map((x) => `"${x}"`).join(', ') + (xs.length > max ? `, and ${xs.length - max} more` : '') : none);

/** The {{variables}} for one conversation. Every one is always set, or ElevenLabs refuses to start. */
export function dynamicVariables(c: TalkContext, first?: string): Record<string, string> {
  return {
    user_name: c.userName || 'the user',
    persona: personaVoice(c.persona),
    situation: `${SITUATIONS[c.situation]}${c.detail ? ` ${c.detail}` : ''}`,
    now: c.now.toLocaleString([], { weekday: 'long', hour: 'numeric', minute: '2-digit' }),
    status: c.status || 'Not in a focus session.',
    open_tasks: list(c.openTasks, 12, 'none on their list'),
    done_today: list(c.doneToday, 15, 'nothing yet'),
    agenda: c.agenda || 'no calendar connected',
    profanity: c.profanityOk ? 'Mild profanity is fine.' : 'No profanity.',
    opener: first ?? opener(c.situation, c.persona),
  };
}

/** The whole prompt with the variables filled in, for the typed fallback (Claude). */
export function filledPrompt(vars: Record<string, string>): string {
  return AGENT_PROMPT.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
}
