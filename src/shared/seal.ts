// The phone and the Mac talk over plain Wi-Fi (http), so everything between them is sealed
// with a key only the two of them know: NaCl secretbox (XSalsa20-Poly1305), in pure JS so it
// also works on a phone page that isn't https. The key comes from a one-time key exchange when
// you pair the phone with the 6-digit code your Mac shows.
import nacl from 'tweetnacl';

export const NONCE = nacl.secretbox.nonceLength;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function seal(key: Uint8Array, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const nonce = nacl.randomBytes(NONCE);
  const box = nacl.secretbox(data, nonce, key);
  const out = new Uint8Array(NONCE + box.length);
  out.set(nonce);
  out.set(box, NONCE);
  return out;
}

export function unseal(key: Uint8Array, data: Uint8Array): Uint8Array | null {
  if (data.length < NONCE + nacl.secretbox.overheadLength) return null;
  return nacl.secretbox.open(data.subarray(NONCE), data.subarray(0, NONCE), key);
}

export const sealJson = (key: Uint8Array, v: unknown): Uint8Array<ArrayBuffer> => seal(key, enc.encode(JSON.stringify(v)));

export function unsealJson<T = unknown>(key: Uint8Array, data: Uint8Array): T | null {
  const b = unseal(key, data);
  if (!b) return null;
  try {
    return JSON.parse(dec.decode(b)) as T;
  } catch {
    return null;
  }
}

/** A JSON header and a chunk of bytes in one sealed message (file uploads). */
export function sealParts(key: Uint8Array, header: unknown, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const h = enc.encode(JSON.stringify(header));
  const plain = new Uint8Array(4 + h.length + body.length);
  new DataView(plain.buffer).setUint32(0, h.length);
  plain.set(h, 4);
  plain.set(body, 4 + h.length);
  return seal(key, plain);
}

export function unsealParts<T = unknown>(key: Uint8Array, data: Uint8Array): { header: T; body: Uint8Array } | null {
  const p = unseal(key, data);
  if (!p || p.length < 4) return null;
  const n = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0);
  if (4 + n > p.length) return null;
  try {
    return { header: JSON.parse(dec.decode(p.subarray(4, 4 + n))) as T, body: p.subarray(4 + n) };
  } catch {
    return null;
  }
}

export const keyPair = () => nacl.box.keyPair();
/** The shared key from my secret key and their public key (the same on both sides). */
export const sharedKey = (theirPublic: Uint8Array, mySecret: Uint8Array) => nacl.box.before(theirPublic, mySecret);
export const randomBytes = (n: number) => nacl.randomBytes(n);

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** What the phone and the Mac say to each other (inside the seal). */
export interface RpcRequest {
  /** When it was sent (ms), and a one-time id: old or repeated requests are refused. */
  t: number;
  n: string;
  m: string;
  a: unknown[];
}

export interface RpcReply {
  ok: boolean;
  r?: unknown;
  e?: string;
}

export interface UploadHeader {
  t: number;
  n: string;
  /** One id per file; chunks arrive in order. */
  up: string;
  i: number;
  last: boolean;
  name: string;
  size: number;
  coach: string;
}

export const PHONE_PORT = 47620;
