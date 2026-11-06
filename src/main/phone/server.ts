// Lock In on your phone: a small web server on your Mac that your phone opens over the same
// Wi-Fi (http://<your-mac>.local:47620). Pairing takes the 6-digit code your Mac shows; after
// that every request is sealed with a key only that phone and this Mac know (see shared/seal.ts),
// so other people on the Wi-Fi see neither your data nor a way in. The page itself holds no data.
import { execFile } from 'node:child_process';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import {
  PHONE_PORT, b64, hex, keyPair, randomBytes, seal, sealJson, sharedKey, unb64, unsealJson, unsealParts, type RpcReply, type RpcRequest, type UploadHeader,
} from '../../shared/seal';

export interface PhoneDevice {
  id: string;
  name: string;
  /** The shared key (base64). */
  key: string;
  pairedAt: number;
  lastSeen: number;
}

export interface PhoneDeps {
  port?: number;
  host?: string;
  /** Where a page file is on disk (phone.html, phone.js, fonts/…), or null. */
  file: (name: string) => string | null;
  devices: { load: () => PhoneDevice[]; save: (d: PhoneDevice[]) => void };
  call: (method: string, args: unknown[], device: PhoneDevice) => Promise<unknown>;
  blob: (kind: string, id: string) => Buffer | null;
  upload: (coach: string, path: string, name: string) => Promise<unknown>;
  uploadDir: string;
  /** Something changed that the Mac's Setup page shows (a phone paired, the server stopped). */
  onChange?: () => void;
  log: (m: string) => void;
  now?: () => number;
  macName?: () => string;
}

export interface PairingInfo {
  code: string;
  expiresAt: number;
}

const MAX_RPC = 4 * 1024 * 1024;
const MAX_CHUNK = 3 * 1024 * 1024;
export const MAX_UPLOAD = 150 * 1024 * 1024;
const PAIR_MINUTES = 10;
const PAIR_TRIES = 5;
const CLOCK_SKEW = 10 * 60_000;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', png: 'image/png', svg: 'image/svg+xml', map: 'application/json',
  webmanifest: 'application/manifest+json',
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** A phone name worth showing: "Grace's iPhone", never markup. */
const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} '’._-]/gu, '').trim().slice(0, 40) : '') || 'Phone';

export class PhoneServer {
  private server: Server | null = null;
  private devices: PhoneDevice[];
  private pairing: { code: string; secret: Uint8Array; pub: Uint8Array; expires: number; tries: number } | null = null;
  private seen = new Map<string, number>();
  private uploads = new Map<string, { next: number; size: number; device: string }>();
  private savedAt = 0;
  error = '';
  port = 0;

  constructor(private d: PhoneDeps) {
    this.devices = d.devices.load();
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  get running(): boolean {
    return !!this.server?.listening;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const port = this.d.port ?? PHONE_PORT;
    return new Promise((resolve) => {
      const s = createServer((req, res) => void this.handle(req, res).catch((e) => {
        this.d.log(`[phone] ${(e as Error).message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }));
      s.requestTimeout = 120_000;
      s.on('error', (e: NodeJS.ErrnoException) => {
        this.error = e.code === 'EADDRINUSE' ? `Port ${port} is taken by another app. Quit it (or restart your Mac) and turn this on again.` : e.message;
        this.d.log(`[phone] ${this.error}`);
        this.server = null;
        this.d.onChange?.();
        resolve();
      });
      s.listen(port, this.d.host ?? '0.0.0.0', () => {
        this.error = '';
        this.port = (s.address() as { port: number }).port;
        this.d.log(`[phone] listening on ${this.port}`);
        resolve();
      });
      this.server = s;
    });
  }

  stop(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
    this.pairing = null;
  }

  // ---- pairing -------------------------------------------------------------------------

  /** A new 6-digit code for the phone to type. One at a time; it lasts 10 minutes and allows 5 tries. */
  startPairing(): PairingInfo {
    const kp = keyPair();
    this.pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), secret: kp.secretKey, pub: kp.publicKey, expires: this.now() + PAIR_MINUTES * 60_000, tries: 0 };
    return { code: this.pairing.code, expiresAt: this.pairing.expires };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  get pairingInfo(): PairingInfo | null {
    if (this.pairing && this.pairing.expires < this.now()) this.pairing = null;
    return this.pairing ? { code: this.pairing.code, expiresAt: this.pairing.expires } : null;
  }

  list(): Omit<PhoneDevice, 'key'>[] {
    return this.devices.map(({ key: _k, ...rest }) => rest);
  }

  remove(id: string): void {
    this.devices = this.devices.filter((x) => x.id !== id);
    this.d.devices.save(this.devices);
  }

  // ---- requests --------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/api/pair' && req.method === 'GET') return this.pairHello(res);
      if (req.method !== 'POST') return void res.writeHead(405).end();
      if (url.pathname === '/api/pair') return this.pair(req, res);
      if (url.pathname === '/api/rpc') return this.rpc(req, res);
      if (url.pathname === '/api/blob') return this.blob(req, res);
      if (url.pathname === '/api/upload') return this.upload(req, res);
      return void res.writeHead(404).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    return this.page(url.pathname, res);
  }

  private page(path: string, res: ServerResponse): void {
    if (path === '/manifest.webmanifest') {
      const body = JSON.stringify({ name: 'Lock In', short_name: 'Lock In', start_url: '/', scope: '/', display: 'standalone', background_color: '#f3f4f1', theme_color: '#101820', icons: [{ src: '/icon.png', sizes: '1024x1024', type: 'image/png' }] });
      return void res.writeHead(200, { 'content-type': TYPES.webmanifest, 'cache-control': 'no-cache' }).end(body);
    }
    const name = path === '/' || path === '/index.html' ? 'phone.html' : path.slice(1);
    if (!/^(?:[\w.-]+|fonts\/[\w.-]+)$/.test(name) || name.includes('..')) return void res.writeHead(404).end();
    const file = this.d.file(name);
    if (!file || !existsSync(file)) return void res.writeHead(404).end();
    const type = TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': name.startsWith('fonts/') || name === 'icon.png' ? 'max-age=86400' : 'no-cache' };
    if (name === 'phone.html') headers['content-security-policy'] = CSP;
    res.writeHead(200, headers).end(readFileSync(file));
  }

  private body(req: IncomingMessage, max: number): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const parts: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) {
          done = true;
          resolve(null);
          req.destroy();
          return;
        }
        parts.push(c);
      });
      req.on('end', () => !done && resolve(new Uint8Array(Buffer.concat(parts))));
      req.on('error', () => !done && resolve(null));
    });
  }

  private pairHello(res: ServerResponse): void {
    const p = this.pairingInfo && this.pairing;
    if (!p) return void res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no-code' }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pub: b64(p.pub), mac: this.d.macName?.() ?? 'your Mac' }));
  }

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, v: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    const raw = await this.body(req, 16 * 1024);
    const p = this.pairingInfo && this.pairing;
    if (!p) return json(409, { error: 'no-code' });
    let msg: { pub?: string; box?: string };
    try {
      msg = JSON.parse(Buffer.from(raw ?? []).toString('utf8')) as { pub?: string; box?: string };
    } catch {
      return json(400, { error: 'bad' });
    }
    let key: Uint8Array;
    let inner: { code?: string; name?: string } | null = null;
    try {
      key = sharedKey(unb64(String(msg.pub)), p.secret);
      inner = unsealJson<{ code?: string; name?: string }>(key, unb64(String(msg.box)));
    } catch {
      return json(400, { error: 'bad' });
    }
    // A box that won't open was sealed for an older code: the phone should ask again.
    if (!inner) return json(409, { error: 'stale' });
    const want = Buffer.from(p.code);
    const got = Buffer.from(String(inner.code ?? '').replace(/\D/g, '').slice(0, 6).padEnd(6, 'x'));
    if (!timingSafeEqual(want, got)) {
      p.tries++;
      if (p.tries >= PAIR_TRIES) {
        this.pairing = null;
        this.d.onChange?.();
        return json(403, { error: 'too-many' });
      }
      return json(403, { error: 'wrong', left: PAIR_TRIES - p.tries });
    }
    const device: PhoneDevice = { id: hex(randomBytes(8)), name: cleanName(inner.name), key: b64(key), pairedAt: this.now(), lastSeen: this.now() };
    this.devices = [...this.devices, device];
    this.d.devices.save(this.devices);
    this.pairing = null;
    this.d.log(`[phone] paired ${device.name}`);
    this.d.onChange?.();
    json(200, { box: b64(sealJson(key, { id: device.id, mac: this.d.macName?.() ?? 'your Mac' })) });
  }

  private device(req: IncomingMessage): { device: PhoneDevice; key: Uint8Array } | null {
    const id = String(req.headers['x-lockin-device'] ?? '');
    const device = this.devices.find((x) => x.id === id);
    return device ? { device, key: unb64(device.key) } : null;
  }

  /** Recent, and never seen before: a captured request can't be played again. */
  private fresh(t: unknown, n: unknown): boolean {
    const now = this.now();
    if (typeof t !== 'number' || typeof n !== 'string' || n.length < 8 || n.length > 64) return false;
    if (Math.abs(now - t) > CLOCK_SKEW) return false;
    if (this.seen.has(n)) return false;
    this.seen.set(n, now);
    if (this.seen.size > 2000) for (const [k, at] of this.seen) if (now - at > 2 * CLOCK_SKEW) this.seen.delete(k);
    return true;
  }

  private touch(device: PhoneDevice): void {
    device.lastSeen = this.now();
    if (this.now() - this.savedAt > 60_000) {
      this.savedAt = this.now();
      this.d.devices.save(this.devices);
    }
  }

  private refuse(res: ServerResponse): void {
    res.writeHead(401, { 'content-type': 'text/plain' }).end('pair again');
  }

  private async rpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = this.device(req);
    const raw = await this.body(req, MAX_RPC);
    if (!who || !raw) return this.refuse(res);
    const r = unsealJson<RpcRequest>(who.key, raw);
    if (!r || !this.fresh(r.t, r.n) || typeof r.m !== 'string') return this.refuse(res);
    this.touch(who.device);
    let reply: RpcReply;
    try {
      reply = { ok: true, r: await this.d.call(r.m, Array.isArray(r.a) ? r.a : [], who.device) };
    } catch (e) {
      reply = { ok: false, e: (e as Error).message };
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(sealJson(who.key, reply)));
  }

  private async blob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = this.device(req);
    const raw = await this.body(req, 64 * 1024);
    if (!who || !raw) return this.refuse(res);
    const r = unsealJson<RpcRequest>(who.key, raw);
    if (!r || !this.fresh(r.t, r.n)) return this.refuse(res);
    const [kind, id] = (r.a ?? []).map(String);
    const data = this.d.blob(kind, id);
    if (!data) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(seal(who.key, new Uint8Array(data))));
  }

  /** A file from the phone, a few MB at a time, each piece sealed. */
  private async upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = this.device(req);
    const raw = await this.body(req, MAX_CHUNK + 64 * 1024);
    if (!who || !raw) return this.refuse(res);
    const p = unsealParts<UploadHeader>(who.key, raw);
    if (!p || !this.fresh(p.header.t, p.header.n)) return this.refuse(res);
    const h = p.header;
    const reply = (v: RpcReply) => void res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from(sealJson(who.key, v)));
    if (!/^[a-z0-9]{8,32}$/.test(String(h.up)) || typeof h.i !== 'number') return reply({ ok: false, e: 'Bad upload.' });
    if (h.size > MAX_UPLOAD) return reply({ ok: false, e: 'That file is over 150 MB. Trim it, or add it on your Mac.' });
    mkdirSync(this.d.uploadDir, { recursive: true });
    const part = join(this.d.uploadDir, `${who.device.id}-${h.up}.part`);
    const state = this.uploads.get(h.up);
    if (h.i === 0) {
      writeFileSync(part, p.body);
      this.uploads.set(h.up, { next: 1, size: p.body.length, device: who.device.id });
    } else {
      if (!state || state.device !== who.device.id || state.next !== h.i || !existsSync(part)) return reply({ ok: false, e: 'The upload got out of order. Try again.' });
      if (state.size + p.body.length > MAX_UPLOAD) {
        rmSync(part, { force: true });
        this.uploads.delete(h.up);
        return reply({ ok: false, e: 'That file is over 150 MB.' });
      }
      appendFileSync(part, p.body);
      state.next++;
      state.size += p.body.length;
    }
    this.touch(who.device);
    if (!h.last) return reply({ ok: true, r: { received: h.i } });
    this.uploads.delete(h.up);
    const dir = join(this.d.uploadDir, h.up);
    const safe = String(h.name).replace(/[\/\\:\0]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'recording';
    try {
      mkdirSync(dir, { recursive: true });
      const final = join(dir, safe);
      renameSync(part, final);
      this.d.log(`[phone] got ${safe} (${Math.round(statSync(final).size / 1024)} KB)`);
      reply({ ok: true, r: await this.d.upload(String(h.coach), final, safe) });
    } catch (e) {
      reply({ ok: false, e: (e as Error).message });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(part, { force: true });
    }
  }
}

// ---- where the phone finds this Mac ------------------------------------------------------------

/** This Mac's Bonjour name ("Graces-MacBook-Air"), which phones on the same Wi-Fi can open as <name>.local. */
export function bonjourName(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 3000 }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

/** Wi-Fi and Ethernet addresses (not VPNs, not the Mac talking to itself). */
export function lanAddresses(): string[] {
  const out: { name: string; ip: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/^(utun|ipsec|ppp|bridge|awdl|llw|vmnet|vboxnet|docker|lo)/.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, ip: a.address });
    }
  }
  return out.sort((a, b) => (a.name === 'en0' ? -1 : b.name === 'en0' ? 1 : a.name.localeCompare(b.name))).map((x) => x.ip);
}
