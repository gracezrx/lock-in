// A crew's invite code is 128 random bits written in Crockford base32 (no look-alike letters).
// It is the crew's only secret: the relay topic and the encryption key both come from it, so
// the relay (ntfy) only ever sees an unguessable topic name and ciphertext.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decode32(text: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Upper-case, drop spaces and dashes, and read the letters people mix up (O/0, I/L/1). */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** "K7Q2M-9XW4T-…" in groups of five, easy to read out or paste. */
export function formatCode(code: string): string {
  return normalizeCode(code).replace(/(.{5})(?=.)/g, '$1-');
}

export function newCode(): string {
  return formatCode(encode32(randomBytes(16)));
}

/** The 16 secret bytes, or null when the code isn't a valid invite. */
export function codeSecret(code: string): Buffer | null {
  const n = normalizeCode(code);
  if (n.length !== 26) return null;
  const b = decode32(n);
  return b && b.length === 16 ? b : null;
}

export interface CrewKeys {
  topic: string;
  key: Buffer;
}

export function crewKeys(code: string): CrewKeys | null {
  const secret = codeSecret(code);
  if (!secret) return null;
  const topic = `lockin-${createHash('sha256').update('lockin-topic-v1').update(secret).digest('hex').slice(0, 32)}`;
  const key = Buffer.from(hkdfSync('sha256', secret, 'lockin-crew-v1', 'message-key', 32));
  return { topic, key };
}

const PREFIX = 'LI1.';

export function seal(key: Buffer, data: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** The message, or null if it isn't one of ours (wrong crew, tampered, or junk). */
export function open<T = unknown>(key: Buffer, text: string): T | null {
  if (!text.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64url');
    if (raw.length < 12 + 16 + 2) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const json = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
