// Lock In's voice agent on your ElevenLabs account: created on first use, recreated when
// Lock In's prompt, tools or your voice change, and turned into a signed URL per conversation
// (your API key never leaves the main process).
import { createHash } from 'node:crypto';
import { AGENT_PROMPT, AGENT_VERSION, TALK_TOOLS, dynamicVariables, elevenTool } from './prompt';

const API = 'https://api.elevenlabs.io';
const LLM = 'gemini-2.5-flash';
const CLIENT_EVENTS = ['conversation_initiation_metadata', 'audio', 'interruption', 'user_transcript', 'agent_response', 'agent_response_correction', 'client_tool_call', 'ping'];

export interface AgentRecord {
  agentId: string;
  toolIds: string[];
  hash: string;
}

export interface AgentDeps {
  key: () => string | undefined;
  voiceId: () => string;
  /** The language the agent listens and talks in (ISO 639-1); English unless a coach made from someone speaks another. */
  language?: () => string;
  load: () => AgentRecord | null;
  save: (r: AgentRecord | null) => void;
  http?: typeof fetch;
  log: (m: string) => void;
}

/** Turns an ElevenLabs error into something you can act on. */
export function friendlyError(status: number, body: string): string {
  const b = body.toLowerCase();
  if (status === 401 && !b.includes('permission')) return 'ElevenLabs rejected your key. Paste it again in Settings, Keys.';
  if (b.includes('permission') || status === 403) {
    return 'Your ElevenLabs key needs ElevenAgents set to Write (plus Text to Speech and Speech to Text). Edit the key at elevenlabs.io under Developers, API keys.';
  }
  if (b.includes('quota') || b.includes('credits') || status === 402) return 'Your ElevenLabs account is out of credits for now.';
  if (status === 429) return 'ElevenLabs is busy (too many requests). Try again in a minute.';
  return `ElevenLabs said no (${status}). ${body.slice(0, 160)}`;
}

export class ElevenAgent {
  private inflight: Promise<string> | null = null;

  constructor(private d: AgentDeps) {}

  private get http(): typeof fetch {
    return this.d.http ?? fetch;
  }

  hash(): string {
    return createHash('sha1')
      .update(JSON.stringify({ v: AGENT_VERSION, p: AGENT_PROMPT, t: TALK_TOOLS, voice: this.d.voiceId(), llm: LLM, ...(this.lang() !== 'en' ? { lang: this.lang() } : {}) }))
      .digest('hex')
      .slice(0, 16);
  }

  private lang(): string {
    return this.d.language?.() || 'en';
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; text: string }> {
    const key = this.d.key();
    if (!key) throw new Error('Add your ElevenLabs key in Settings, Keys first.');
    const res = await this.http(`${API}${path}`, {
      method,
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  private body(tools: Record<string, unknown>, full: boolean): Record<string, unknown> {
    const placeholders = dynamicVariables({
      userName: 'there', persona: 'sassy', profanityOk: false, situation: 'checkin', now: new Date(0), status: '', openTasks: [], doneToday: [], agenda: '',
    });
    return {
      name: 'Lock In coach',
      tags: ['lock-in'],
      conversation_config: {
        agent: {
          first_message: '{{opener}}',
          language: this.lang(),
          ...(full ? { dynamic_variables: { dynamic_variable_placeholders: placeholders } } : {}),
          prompt: { prompt: AGENT_PROMPT, ...(full ? { llm: LLM, temperature: 0.7 } : {}), ...tools },
        },
        // Agents in other languages need a multilingual voice model.
        tts: { voice_id: this.d.voiceId(), ...(this.lang() !== 'en' ? { model_id: 'eleven_flash_v2_5' } : {}) },
        ...(full ? { turn: { turn_eagerness: 'normal' }, conversation: { max_duration_seconds: 900, client_events: CLIENT_EVENTS } } : {}),
      },
    };
  }

  private async create(): Promise<AgentRecord> {
    // Tools are their own objects now; older accounts take them inline.
    const toolIds: string[] = [];
    let inline = false;
    for (const t of TALK_TOOLS) {
      const r = await this.call('POST', '/v1/convai/tools', { tool_config: elevenTool(t) });
      if (r.status === 404 || r.status === 405) {
        inline = true;
        break;
      }
      if (!r.ok) throw new Error(friendlyError(r.status, r.text));
      const id = String(r.json.id ?? r.json.tool_id ?? '');
      if (!id) throw new Error('ElevenLabs did not return a tool id.');
      toolIds.push(id);
    }
    const tools = inline ? { tools: TALK_TOOLS.map(elevenTool) } : { tool_ids: toolIds };
    let r = await this.call('POST', '/v1/convai/agents/create', this.body(tools, true));
    if (!r.ok && (r.status === 400 || r.status === 422)) {
      this.d.log(`[talk] full agent config refused (${r.status}): ${r.text.slice(0, 300)}; trying the basic one`);
      r = await this.call('POST', '/v1/convai/agents/create', this.body(tools, false));
    }
    if (!r.ok) {
      // Don't leave half-made tools behind on your account.
      for (const id of toolIds) await this.call('DELETE', `/v1/convai/tools/${encodeURIComponent(id)}`).catch(() => undefined);
      this.d.log(`[talk] agent not created (${r.status}): ${r.text.slice(0, 300)}`);
      throw new Error(friendlyError(r.status, r.text));
    }
    const agentId = String(r.json.agent_id ?? '');
    if (!agentId) throw new Error('ElevenLabs did not return an agent id.');
    this.d.log(`[talk] created agent ${agentId} with ${inline ? 'inline' : toolIds.length} tools`);
    return { agentId, toolIds, hash: this.hash() };
  }

  /** The agent id, creating or replacing the agent when needed. */
  ensure(): Promise<string> {
    if (!this.inflight) {
      this.inflight = (async () => {
        const prev = this.d.load();
        if (prev && prev.hash === this.hash()) return prev.agentId;
        const rec = await this.create();
        this.d.save(rec);
        if (prev) void this.remove(prev);
        return rec.agentId;
      })().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Best effort: clean up an agent and its tools that Lock In no longer uses. */
  private async remove(r: AgentRecord): Promise<void> {
    try {
      await this.call('DELETE', `/v1/convai/agents/${encodeURIComponent(r.agentId)}`);
      for (const id of r.toolIds) await this.call('DELETE', `/v1/convai/tools/${encodeURIComponent(id)}`);
    } catch (e) {
      this.d.log(`[talk] cleanup: ${(e as Error).message}`);
    }
  }

  /** A one-time URL the talk window connects to (valid 15 minutes). */
  async signedUrl(retry = true): Promise<string> {
    const agentId = await this.ensure();
    const r = await this.call('GET', `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
    if (r.status === 404 && retry) {
      // Deleted on the ElevenLabs site: make a new one.
      this.d.save(null);
      return this.signedUrl(false);
    }
    if (!r.ok) throw new Error(friendlyError(r.status, r.text));
    const url = String(r.json.signed_url ?? '');
    if (!url.startsWith('wss://')) throw new Error('ElevenLabs did not return a conversation link.');
    return url;
  }
}
