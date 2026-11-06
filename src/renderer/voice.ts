// Hidden window: plays the coach's audio and records replies with a simple
// voice-activity detector (stops after a pause, gives up if nobody speaks).
import { api } from './lib';

let audio: HTMLAudioElement | null = null;
let playingId: string | null = null;
let stopRequested = false;

function finishPlayback(): void {
  if (playingId) api.send('voice:ended', playingId);
  playingId = null;
  if (audio) {
    URL.revokeObjectURL(audio.src);
    audio = null;
  }
}

api.on('voice:play', (raw) => {
  const { id, data, volume } = raw as { id: string; data: Uint8Array; volume: number };
  if (audio) {
    audio.pause();
    finishPlayback();
  }
  const url = URL.createObjectURL(new Blob([data as unknown as ArrayBuffer], { type: 'audio/mpeg' }));
  const a = new Audio(url);
  a.volume = Math.max(0, Math.min(1, volume));
  audio = a;
  playingId = id;
  a.onended = () => finishPlayback();
  a.onerror = () => finishPlayback();
  a.play().catch(() => finishPlayback());
});

api.on('voice:stop', () => {
  audio?.pause();
  finishPlayback();
});

api.on('voice:stopListening', () => {
  stopRequested = true;
});

api.on('voice:listen', async (raw) => {
  const { id, maxMs } = raw as { id: string; maxMs: number };
  stopRequested = false;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    api.send('voice:recorded', { id, data: null, mime: '' });
    return;
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  let heardMs = 0;
  let silenceMs = 0;
  let floor = 0;
  let calibrated = 0;
  const started = performance.now();
  const STEP = 50;

  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    const spoke = heardMs >= 250;
    const data = spoke ? new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer()) : null;
    api.send('voice:recorded', { id, data, mime: 'audio/webm' });
  };
  recorder.start(250);

  const loop = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const elapsed = performance.now() - started;
    if (elapsed < 300) {
      floor = (floor * calibrated + rms) / (calibrated + 1);
      calibrated += 1;
      return;
    }
    const speaking = rms > Math.max(0.015, floor * 3);
    if (speaking) {
      heardMs += STEP;
      silenceMs = 0;
    } else {
      silenceMs += STEP;
    }
    const done =
      stopRequested ||
      elapsed >= maxMs ||
      (heardMs >= 250 && silenceMs >= 1200) ||
      (heardMs < 250 && elapsed >= 6000);
    if (done) {
      clearInterval(loop);
      if (recorder.state !== 'inactive') recorder.stop();
    }
  }, STEP);
});

// ---- Sound effects (synthesized, so they work offline and need no files) --------

type Note = { f: number; t: number; d: number; type?: OscillatorType; vib?: number };

function playNotes(ctx: AudioContext, out: AudioNode, notes: Note[], gain: number): number {
  let end = 0;
  for (const n of notes) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = n.type ?? 'triangle';
    o.frequency.value = n.f;
    if (n.vib) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = n.vib;
      depth.gain.value = n.f * 0.03;
      lfo.connect(depth).connect(o.frequency);
      lfo.start(ctx.currentTime + n.t);
      lfo.stop(ctx.currentTime + n.t + n.d);
    }
    const t0 = ctx.currentTime + n.t;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.setValueAtTime(gain, t0 + Math.max(0.03, n.d - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.d);
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + n.d + 0.02);
    end = Math.max(end, n.t + n.d);
  }
  return end;
}

const SOUNDS: Record<string, { notes: Note[]; gain: number; lowpass?: number }> = {
  whistle: { gain: 0.16, notes: [{ f: 2093, t: 0, d: 0.18, vib: 28 }, { f: 2349, t: 0.2, d: 0.28, vib: 28 }] },
  airhorn: {
    gain: 0.12,
    lowpass: 2600,
    notes: [
      { f: 466, t: 0, d: 0.35, type: 'sawtooth' }, { f: 470, t: 0, d: 0.35, type: 'sawtooth' }, { f: 233, t: 0, d: 0.35, type: 'square' },
      { f: 466, t: 0.45, d: 0.9, type: 'sawtooth' }, { f: 471, t: 0.45, d: 0.9, type: 'sawtooth' }, { f: 233, t: 0.45, d: 0.9, type: 'square' },
    ],
  },
  buzzer: { gain: 0.1, lowpass: 1800, notes: [{ f: 110, t: 0, d: 0.8, type: 'square' }, { f: 116, t: 0, d: 0.8, type: 'square' }] },
  chime: { gain: 0.14, notes: [{ f: 1047, t: 0, d: 0.5, type: 'sine' }, { f: 1319, t: 0.18, d: 0.5, type: 'sine' }, { f: 1568, t: 0.36, d: 0.55, type: 'sine' }] },
  ding: { gain: 0.18, notes: [{ f: 1319, t: 0, d: 0.7, type: 'sine' }, { f: 2637, t: 0, d: 0.35, type: 'sine' }] },
  sad_trombone: {
    gain: 0.14,
    lowpass: 1300,
    notes: [
      { f: 233, t: 0, d: 0.42, type: 'sawtooth' },
      { f: 220, t: 0.45, d: 0.42, type: 'sawtooth' },
      { f: 208, t: 0.9, d: 0.42, type: 'sawtooth' },
      { f: 196, t: 1.35, d: 1.1, type: 'sawtooth', vib: 6 },
    ],
  },
  fanfare: {
    gain: 0.1,
    lowpass: 3500,
    notes: [
      { f: 392, t: 0, d: 0.14, type: 'square' }, { f: 523, t: 0.15, d: 0.14, type: 'square' }, { f: 659, t: 0.3, d: 0.14, type: 'square' },
      { f: 784, t: 0.45, d: 0.9, type: 'square' }, { f: 523, t: 0.45, d: 0.9, type: 'triangle' },
    ],
  },
};

api.on('voice:sound', (raw) => {
  const { id, volume } = raw as { id: string; volume: number };
  const spec = SOUNDS[id];
  if (!spec) return;
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = Math.max(0, Math.min(1, volume));
    let out: AudioNode = master;
    if (spec.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = spec.lowpass;
      f.connect(master);
      out = f;
    }
    master.connect(ctx.destination);
    const end = playNotes(ctx, out, spec.notes, spec.gain);
    setTimeout(() => void ctx.close(), (end + 0.3) * 1000);
  } catch {
    /* no audio device */
  }
});
