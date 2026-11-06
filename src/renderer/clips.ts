// Cuts one person's voice out of a recording, right here in the page: the browser's audio
// decoder opens the file, and their stretches are joined into one mono WAV for ElevenLabs.

export interface Segment {
  start: number;
  end: number;
}

/** Mono 16-bit PCM WAV. */
export function wav(samples: Float32Array, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => out.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** Their stretches of a recording, joined with short pauses and evened out in volume. */
export async function cutVoice(bytes: Uint8Array, segs: Segment[], rate = 22050): Promise<{ data: Uint8Array; seconds: number }> {
  // Decoding into a context at this rate also resamples, which keeps memory down for long files.
  const ctx = new OfflineAudioContext(1, 1, rate);
  const copy = bytes.slice().buffer;
  const buf = await ctx.decodeAudioData(copy);
  const sr = buf.sampleRate;
  const chans = Array.from({ length: buf.numberOfChannels }, (_x, i) => buf.getChannelData(i));
  const gap = Math.round(sr * 0.3);
  const pieces: Float32Array[] = [];
  let seconds = 0;
  for (const s of segs) {
    const a = Math.max(0, Math.floor(s.start * sr));
    const b = Math.min(buf.length, Math.ceil(s.end * sr));
    if (b - a < sr) continue;
    const piece = new Float32Array(b - a);
    for (let i = 0; i < piece.length; i++) {
      let v = 0;
      for (const c of chans) v += c[a + i];
      piece[i] = v / chans.length;
    }
    pieces.push(piece);
    seconds += piece.length / sr;
  }
  if (!pieces.length) return { data: new Uint8Array(0), seconds: 0 };
  const all = new Float32Array(pieces.reduce((n, p) => n + p.length + gap, 0));
  let at = 0;
  let peak = 0;
  for (const p of pieces) {
    all.set(p, at);
    at += p.length + gap;
    for (let i = 0; i < p.length; i++) peak = Math.max(peak, Math.abs(p[i]));
  }
  // Quiet recordings are brought up (never past 90% of full scale).
  if (peak > 0 && peak < 0.6) {
    const g = 0.9 / peak;
    for (let i = 0; i < all.length; i++) all[i] *= g;
  }
  return { data: wav(all, sr), seconds };
}
