// The crew invite code and its encryption, for the browser: the same format as the Mac app's
// src/main/crew/code.ts (AES-256-GCM, keys from HKDF-SHA256), so a crew can have Macs and
// Chrome-only friends in it. Synchronous, like the Mac's, so crew.ts runs unchanged on top.
import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8, randomBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode32(bytes: Uint8Array): string {
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

function decode32(text: string): Uint8Array | null {
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
  return Uint8Array.from(out);
}

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function formatCode(code: string): string {
  return normalizeCode(code).replace(/(.{5})(?=.)/g, '$1-');
}

export function newCode(): string {
  return formatCode(encode32(randomBytes(16)));
}

export function codeSecret(code: string): Uint8Array | null {
  const n = normalizeCode(code);
  if (n.length !== 26) return null;
  const b = decode32(n);
  return b && b.length === 16 ? b : null;
}

export interface CrewKeys {
  topic: string;
  key: Uint8Array;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function crewKeys(code: string): CrewKeys | null {
  const secret = codeSecret(code);
  if (!secret) return null;
  const tag = utf8ToBytes('lockin-topic-v1');
  const both = new Uint8Array(tag.length + secret.length);
  both.set(tag);
  both.set(secret, tag.length);
  const topic = `lockin-${hex(sha256(both)).slice(0, 32)}`;
  const key = hkdf(sha256, secret, utf8ToBytes('lockin-crew-v1'), utf8ToBytes('message-key'), 32);
  return { topic, key };
}

function toBase64Url(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PREFIX = 'LI1.';

/** iv (12) + ciphertext + tag (16), base64url: what Node's createCipheriv('aes-256-gcm') makes. */
export function seal(key: Uint8Array, data: unknown): string {
  const iv = randomBytes(12);
  const sealed = gcm(key, iv).encrypt(utf8ToBytes(JSON.stringify(data)));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv);
  out.set(sealed, 12);
  return PREFIX + toBase64Url(out);
}

export function open<T = unknown>(key: Uint8Array, text: string): T | null {
  if (!text.startsWith(PREFIX)) return null;
  try {
    const raw = fromBase64Url(text.slice(PREFIX.length));
    if (raw.length < 12 + 16 + 2) return null;
    const plain = gcm(key, raw.subarray(0, 12)).decrypt(raw.subarray(12));
    return JSON.parse(bytesToUtf8(plain)) as T;
  } catch {
    return null;
  }
}
