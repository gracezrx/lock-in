// Minimal Claude Messages API client plus the prompts Lock In uses.
import type { Persona, Profile, RouteOption, Settings } from '../../shared/types';
import type { ModelAnswer, ModelRequest } from '../engine/classifier';
import { roleText } from '../../shared/templates';
import { activeStyle, type ActiveStyle } from './style';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface Msg {
  role: 'user' | 'assistant';
  content: string | Block[];
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const API_URL = 'https://api.anthropic.com/v1/messages';

export class Claude {
  constructor(private getKey: () => string | undefined, private log: (m: string) => void) {}

  get available(): boolean {
    return !!this.getKey();
  }

  async messages(p: { model: string; system: string; messages: Msg[]; tools?: Tool[]; maxTokens?: number; timeoutMs?: number }): Promise<{ content: Block[]; stop_reason: string } | null> {
    const key = this.getKey();
    if (!key) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), p.timeoutMs ?? 10_000);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: p.model,
          max_tokens: p.maxTokens ?? 300,
          system: p.system,
          messages: p.messages,
          ...(p.tools?.length ? { tools: p.tools } : {}),
        }),
      });
      if (!res.ok) {
        this.log(`[claude] ${res.status} ${(await res.text()).slice(0, 300)}`);
        return null;
      }
      const json = (await res.json()) as { content: Block[]; stop_reason: string };
      return json;
    } catch (e) {
      this.log(`[claude] ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async text(p: { model: string; system: string; prompt: string; maxTokens?: number; timeoutMs?: number }): Promise<string | null> {
    const r = await this.messages({ model: p.model, system: p.system, messages: [{ role: 'user', content: p.prompt }], maxTokens: p.maxTokens, timeoutMs: p.timeoutMs });
    if (!r) return null;
    const t = r.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(' ');
    return cleanSpoken(t) || null;
  }
}

/** Strip quotes, markdown and stage directions so the line is safe to speak. */
export function cleanSpoken(t: string): string {
  return t
    .replace(/\*\*?|__|`/g, '')
    .replace(/\[[^\]]*\]|\([^)]*(sighs|laughs|shouts|yells)[^)]*\)/gi, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Classifier

const CLASSIFY_SYSTEM = `You label what someone is doing on their computer during a focus session.
Answer with JSON only: {"label":"work"|"neutral"|"distraction","confidence":0-1,"reason":"<10 words"}.
work = directly useful for their role or their session goal.
distraction = entertainment, social feeds, shopping, games or news unrelated to the goal.
neutral = utilities, email, chat, settings, or anything you are unsure about.
When in doubt, answer neutral.`;

export function makeLabeler(claude: Claude, settings: () => Settings) {
  return async (req: ModelRequest): Promise<ModelAnswer | null> => {
    const lines = [
      `Role: ${req.role}`,
      req.goal ? `Session goal: ${req.goal}` : 'Session goal: (none set)',
      `App: ${req.app}`,
      req.domain ? `Website: ${req.domain}` : '',
      req.title ? `Window or page title: ${req.title}` : '',
      req.kind === 'page' ? 'Judge this specific page, not the whole site.' : req.kind === 'site' ? 'Judge the website as a whole.' : 'Judge the app as a whole.',
    ].filter(Boolean);
    const out = await claude.text({ model: settings().classifierModel, system: CLASSIFY_SYSTEM, prompt: lines.join('\n'), maxTokens: 80, timeoutMs: 8000 });
    if (!out) return null;
    const m = /\{[\s\S]*\}/.exec(out);
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]) as { label?: string; confidence?: number; reason?: string };
      if (j.label !== 'work' && j.label !== 'neutral' && j.label !== 'distraction') return null;
      return { label: j.label, confidence: Number(j.confidence ?? 0.5), reason: String(j.reason ?? '') };
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Coach

const PERSONA_DESC: Record<Persona, string> = {
  sassy:
    "a sassy, deadpan best friend with big-sister energy. Dry, funny, a little dramatic ('why are you so locked out again?', 'babe', 'respectfully, what is going on'). Roasts the habit, never the person, and is secretly rooting for them",
  gentle: 'a warm, supportive friend who never raises their voice',
  firm: 'a direct coach: short sentences, no small talk, no insults',
  drill: 'a loud, funny drill sergeant who is fast and relentless and roasts the behavior, never the person',
};

/** The coach made from someone you know, when it is the coach for this persona. */
function styleFor(persona: Persona): ActiveStyle | null {
  const s = activeStyle();
  return s && s.base === persona ? s : null;
}

/** A few of their lines, so Claude hears how they actually talk. */
function examples(s: ActiveStyle, n = 6): string[] {
  const all = Object.values(s.lines).flat().filter((l): l is string => !!l);
  const step = Math.max(1, Math.floor(all.length / n));
  return all.filter((_l, i) => i % step === 0).slice(0, n);
}

/** Who the coach is: a built-in personality, or someone you know. */
export function personaBlock(persona: Persona, wellbeing = false): string {
  const s = styleFor(persona);
  if (!s) return `Persona: ${PERSONA_DESC[wellbeing ? 'gentle' : persona]}.`;
  const ex = examples(s);
  return [
    `Persona: you talk like ${s.persona}`,
    `Sound like them: their words, rhythm, humor, how they push and how they praise.${s.callsYou.length ? ` They call the user ${s.callsYou.slice(0, 3).join(' or ')}.` : ''}${s.catchphrases.length ? ` Things they really say: ${s.catchphrases.slice(0, 6).join('; ')}.` : ''}`,
    ex.length ? `Lines in their voice (match the style, don't repeat them): ${ex.join(' / ')}` : '',
    s.language ? `Speak the way they do: ${s.language}.` : '',
    `Underneath you are still Lock In: don't invent facts about their life or make promises for them.${wellbeing ? ' Right now the user is not okay: be this person at their kindest and softest.' : ''}`,
  ].filter(Boolean).join('\n');
}

export function coachSystem(persona: Persona, profanityOk: boolean, wellbeing: boolean): string {
  const s = styleFor(persona);
  const p = wellbeing ? 'gentle' : persona;
  return `You are Lock In, a focus coach that speaks out loud to the user through their computer speakers.
${personaBlock(persona, wellbeing)}
You are called because the user drifted from their session goal, or is answering you.

Rules
- Speak 1-2 short sentences${p === 'drill' ? ', under 15 words in total' : ', under 25 words in total'}. Name the distraction and the goal or the last work item.
- Plain spoken ${s?.language ? 'words' : 'English'} only: no quotes, emoji, markdown, stage directions or bracketed tags.
- When the user answers, choose the matching tool and also say one short confirming line. If the answer is unclear, ask one short question and call no tool.
- ${p === 'drill' ? 'You may be loud and roast the behavior. ' : p === 'sassy' ? 'Be witty and specific: use the numbers and names you are given. ' : ''}Never insult the person, their looks, intelligence or identity. ${profanityOk ? 'Mild profanity is allowed.' : 'No profanity.'}
- If the user says they are unwell, overwhelmed or upset, drop the persona, be kind, and offer a break or ending the session.`;
}

export const COACH_TOOLS: Tool[] = [
  {
    name: 'back_to_work',
    description: 'The user agrees to go back to work. Pauses media, closes the distraction and reopens their last work item.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'start_starter_task',
    description: 'Give the user one tiny first step they can finish in 5 minutes, then reopen their work and start a 5-minute timer.',
    input_schema: {
      type: 'object',
      properties: { step: { type: 'string', description: 'One concrete, imperative step, under 20 words.' } },
      required: ['step'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_break',
    description: 'The user needs a real break. Distractions are allowed during it; the coach calls them back after.',
    input_schema: {
      type: 'object',
      properties: { minutes: { type: 'integer', minimum: 3, maximum: 15 } },
      required: ['minutes'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_as_work',
    description: 'The user says the current site or app is actually part of their work. Relabels it so the coach stops flagging it.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'end_session',
    description: 'The user wants to end the focus session now.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const TOOL_TO_OPTION: Record<string, RouteOption> = {
  back_to_work: 'back',
  start_starter_task: 'starter',
  start_break: 'break',
  mark_as_work: 'is_work',
  end_session: 'end',
};

export interface ContextPack {
  profile: Profile;
  goal: string;
  minutesLeft: number;
  plannedMin: number;
  app: string;
  title?: string;
  domain?: string;
  minutesOnIt: number;
  level: number;
  lastWork?: string;
  driftsToday: number;
  topDistraction?: string;
  whatWorked: string;
  titlesStayLocal: boolean;
  tasksOpen?: number;
  topTask?: string;
  tasksDoneToday?: number;
}

export function contextText(c: ContextPack): string {
  const where = c.domain ? `${c.domain}${c.title && !c.titlesStayLocal ? ` ("${c.title}")` : ''}` : `${c.app}${c.title && !c.titlesStayLocal ? ` ("${c.title}")` : ''}`;
  return [
    `Role: ${roleText(c.profile)}. Session goal: "${c.goal || 'focused work'}". Minutes left: ${Math.max(0, Math.round(c.minutesLeft))} of ${c.plannedMin}.`,
    `Right now: ${where}. ${Math.max(1, Math.round(c.minutesOnIt))} minutes on it this session. Ladder level ${c.level} of 4.`,
    `Last work: ${c.lastWork ?? 'unknown'}.`,
    `Today: ${c.driftsToday} drifts${c.topDistraction ? `, top distraction ${c.topDistraction}` : ''}.`,
    `Options that worked before: ${c.whatWorked || 'no history yet'}.`,
    c.tasksOpen !== undefined ? `To-do list: ${c.tasksOpen} open today${c.topTask ? `, top one "${c.topTask}"` : ''}; ${c.tasksDoneToday ?? 0} done today.` : '',
  ].filter(Boolean).join('\n');
}

export async function starterStep(claude: Claude, settings: Settings, goal: string, lastWork: string | undefined): Promise<string | null> {
  return claude.text({
    model: settings.classifierModel,
    system: 'You write one tiny, concrete first step someone can finish in five minutes. Imperative mood, under 20 words, no preamble, no quotes.',
    prompt: `Session goal: ${goal || 'focused work'}\nLast thing they worked on: ${lastWork ?? 'unknown'}\nWrite the step.`,
    maxTokens: 60,
    timeoutMs: 6000,
  });
}

/** A one-off spoken line for a routine, roast or celebration, written from facts. */
export async function announceLine(claude: Claude, settings: Settings, persona: Persona, profanityOk: boolean, what: string, facts: string): Promise<string | null> {
  return claude.text({
    model: settings.coachModel,
    system: `${coachSystem(persona, profanityOk, false)}\n\nRight now you are not reacting to a distraction. You are delivering: ${what}. One or two short spoken sentences, under 35 words. Use the specific numbers and task names you are given.`,
    prompt: facts,
    maxTokens: 120,
    timeoutMs: 3500,
  });
}

export async function recapLine(claude: Claude, settings: Settings, persona: Persona, facts: string): Promise<string | null> {
  return claude.text({
    model: settings.classifierModel,
    system: `You are Lock In, a focus coach.\n${personaBlock(persona)}\nWrite a spoken end-of-session recap in 2-3 short sentences, under 45 words. Mention focused minutes, drifts and one thing to try next time. Plain spoken ${styleFor(persona)?.language ? 'words in their language' : 'English'}, no lists.`,
    prompt: facts,
    maxTokens: 120,
    timeoutMs: 8000,
  });
}
