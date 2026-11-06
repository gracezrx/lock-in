// Speaking (ElevenLabs → macOS `say` fallback) and listening (mic in a hidden
// window → ElevenLabs speech-to-text). Audio is cached on disk, never logged.
import { ipcMain, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../../shared/types';
import { activeStyle } from './style';

/** Mac voices for a coach who speaks another language, when there's no ElevenLabs key. */
const SAY_FOR: Record<string, string> = { zh: 'Tingting', ja: 'Kyoko', ko: 'Yuna', es: 'Monica', fr: 'Thomas', de: 'Anna', it: 'Alice', pt: 'Luciana', ru: 'Milena', hi: 'Lekha', nl: 'Xander', tr: 'Yelda', pl: 'Zosia', sv: 'Alva', th: 'Kanya', id: 'Damayanti', ar: 'Maged' };

export interface VoiceDeps {
  cacheDir: string;
  settings: () => Settings;
  elevenKey: () => string | undefined;
  /** The coach's voice right now (a coach made from someone may bring their own). */
  voiceId?: () => string;
  window: () => BrowserWindow | null;
  log: (m: string) => void;
}

export class Voice {
  speaking = false;
  recording = false;
  private playWaiters = new Map<string, () => void>();
  private recordWaiters = new Map<string, (r: { data: Uint8Array | null; mime: string }) => void>();
  private sayProc: ChildProcess | null = null;
  private currentPlayId: string | null = null;

  constructor(private d: VoiceDeps) {
    mkdirSync(d.cacheDir, { recursive: true });
    ipcMain.on('voice:ended', (_e, id: string) => {
      const w = this.playWaiters.get(id);
      if (w) {
        this.playWaiters.delete(id);
        w();
      }
    });
    ipcMain.on('voice:recorded', (_e, payload: { id: string; data: Uint8Array | ArrayBuffer | null; mime: string }) => {
      const w = this.recordWaiters.get(payload.id);
      if (w) {
        this.recordWaiters.delete(payload.id);
        w({ data: payload.data ? new Uint8Array(payload.data) : null, mime: payload.mime });
      }
    });
  }

  /** Speak a line. Resolves when playback ends (or fails). */
  async speak(text: string, opts: { shout?: boolean } = {}): Promise<void> {
    this.stop();
    const s = this.d.settings();
    const audio = await this.tts(text, opts.shout ? s.ttsModelShout : s.ttsModelLive, !!opts.shout);
    this.speaking = true;
    try {
      if (audio) await this.play(audio, s.volumeCap);
      else await this.say(text);
    } finally {
      this.speaking = false;
    }
  }

  stop(): void {
    if (this.currentPlayId) {
      this.d.window()?.webContents.send('voice:stop');
      const w = this.playWaiters.get(this.currentPlayId);
      this.playWaiters.delete(this.currentPlayId);
      w?.();
      this.currentPlayId = null;
    }
    this.sayProc?.kill();
    this.sayProc = null;
  }

  /** Generate (or load cached) speech audio. Returns null when ElevenLabs is unavailable. */
  async tts(text: string, model: string, shout: boolean, voiceId = this.d.voiceId?.() || this.d.settings().voiceId): Promise<Buffer | null> {
    const key = this.d.elevenKey();
    if (!key) return null;
    const s = this.d.settings();
    const expressive = model.includes('v3');
    const finalText = shout && expressive ? `[shouts] ${text}` : text;
    const hash = createHash('sha1').update(`${model}|${voiceId}|${finalText}`).digest('hex');
    const file = join(this.d.cacheDir, `${hash}.mp3`);
    if (existsSync(file)) return readFileSync(file);
    const started = Date.now();
    const { buf } = await this.fetchTts(key, voiceId, model, finalText);
    if (buf) {
      this.d.log(`[voice] ${model} ${Date.now() - started} ms`);
      writeFileSync(file, buf);
      return buf;
    }
    // Expressive model failed (or is slow/unavailable on this plan): retry with the live model.
    if (model !== s.ttsModelLive) return this.tts(text, s.ttsModelLive, false, voiceId);
    return null;
  }

  /**
   * Plays a line in another voice (the voice picker): the coach's own words when ElevenLabs can
   * speak them, else ElevenLabs' sample clip. Resolves when playback ends.
   */
  async preview(voiceId: string, text: string, sample: () => Promise<Buffer | null>): Promise<'coach' | 'sample' | 'none'> {
    this.stop();
    let how: 'coach' | 'sample' | 'none' = 'none';
    let audio = await this.tts(text, this.d.settings().ttsModelLive, false, voiceId);
    if (audio) how = 'coach';
    else {
      audio = await sample();
      if (audio) how = 'sample';
    }
    if (!audio) return 'none';
    this.speaking = true;
    try {
      await this.play(audio, this.d.settings().volumeCap);
    } finally {
      this.speaking = false;
    }
    return how;
  }

  /** Can ElevenLabs speak with this voice on your key? (A tiny request, a few credits.) */
  async check(voiceId: string): Promise<{ ok: boolean; status: number; body: string }> {
    const key = this.d.elevenKey();
    if (!key) return { ok: false, status: 0, body: 'no key' };
    const r = await this.fetchTts(key, voiceId, this.d.settings().ttsModelLive, 'Okay.');
    return { ok: !!r.buf, status: r.status, body: r.body };
  }

  private async fetchTts(key: string, voiceId: string, model: string, text: string): Promise<{ buf: Buffer | null; status: number; body: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: model }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        this.d.log(`[voice] tts ${res.status} ${body.slice(0, 200)}`);
        return { buf: null, status: res.status, body };
      }
      return { buf: Buffer.from(await res.arrayBuffer()), status: res.status, body: '' };
    } catch (e) {
      this.d.log(`[voice] tts error ${(e as Error).message}`);
      return { buf: null, status: 0, body: (e as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }

  private play(audio: Buffer, volume: number): Promise<void> {
    const win = this.d.window();
    if (!win || win.isDestroyed()) return Promise.resolve();
    const id = randomUUID();
    this.currentPlayId = id;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.playWaiters.delete(id);
        resolve();
      }, 30_000);
      this.playWaiters.set(id, () => {
        clearTimeout(timeout);
        if (this.currentPlayId === id) this.currentPlayId = null;
        resolve();
      });
      win.webContents.send('voice:play', { id, data: new Uint8Array(audio), volume });
    });
  }

  private say(text: string, voice = this.d.settings().sayVoice || SAY_FOR[activeStyle()?.languageCode ?? ''] || ''): Promise<void> {
    if (process.platform !== 'darwin') {
      this.d.log(`[voice] (no TTS available) ${text}`);
      return Promise.resolve();
    }
    const picked = !this.d.settings().sayVoice && !!voice;
    return new Promise((resolve) => {
      const proc = spawn('say', voice ? ['-v', voice, text] : [text]);
      this.sayProc = proc;
      proc.on('exit', (code) => {
        const stopped = this.sayProc !== proc;
        if (!stopped) this.sayProc = null;
        // A language voice that isn't installed: say it with the system voice instead.
        if (code && picked && !stopped) void this.say(text, '').then(resolve);
        else resolve();
      });
      proc.on('error', () => resolve());
    });
  }

  get canListen(): boolean {
    return !!this.d.elevenKey();
  }

  /** Record one reply (stops after a pause in speech) and transcribe it. */
  async listen(maxMs = 15_000): Promise<string | null> {
    const win = this.d.window();
    const key = this.d.elevenKey();
    if (!win || win.isDestroyed() || !key || this.recording) return null;
    const id = randomUUID();
    this.recording = true;
    let rec: { data: Uint8Array | null; mime: string };
    try {
      rec = await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.recordWaiters.delete(id);
          resolve({ data: null, mime: '' });
        }, maxMs + 5000);
        this.recordWaiters.set(id, (r) => {
          clearTimeout(timeout);
          resolve(r);
        });
        win.webContents.send('voice:listen', { id, maxMs });
      });
    } finally {
      this.recording = false;
    }
    if (!rec.data || rec.data.byteLength < 2000) return null;
    return this.transcribe(key, rec.data, rec.mime || 'audio/webm');
  }

  stopListening(): void {
    this.d.window()?.webContents.send('voice:stopListening');
  }

  private async transcribe(key: string, data: Uint8Array, mime: string): Promise<string | null> {
    const models = [this.d.settings().sttModel, 'scribe_v1'].filter((m, i, a) => a.indexOf(m) === i);
    for (const model of models) {
      try {
        const form = new FormData();
        form.append('model_id', model);
        form.append('file', new Blob([Buffer.from(data)], { type: mime }), mime.includes('mp4') ? 'reply.mp4' : 'reply.webm');
        const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
        if (!res.ok) {
          this.d.log(`[voice] stt ${model} ${res.status} ${(await res.text()).slice(0, 200)}`);
          continue;
        }
        const j = (await res.json()) as { text?: string };
        const text = (j.text ?? '').replace(/\([^)]*\)/g, '').trim();
        return text || null;
      } catch (e) {
        this.d.log(`[voice] stt error ${(e as Error).message}`);
      }
    }
    return null;
  }
}
