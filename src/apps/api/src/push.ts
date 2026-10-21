/**
 * Web Push for reminders: the sender core, built on node:crypto alone (no web-push dependency).
 *
 *   RFC 8292  VAPID: an ES256 JWT (aud = the push service origin, exp <= 24 h, sub = a contact URL)
 *             signed with the server's P-256 key, sent as `Authorization: vapid t=<jwt>, k=<key>`.
 *   RFC 8291  Message encryption: ECDH between a fresh application-server key and the browser's
 *             p256dh key, mixed with the subscription's auth secret, then
 *   RFC 8188  the aes128gcm content coding: one record, salt || rs || idlen || keyid header.
 *
 * Why it does no network I/O: every outbound request must go through the egress wrapper (spec §3
 * "Privacy (absolute)"), which decides whether a push service host may be reached and logs the
 * call without its body. So this module only *builds* the request (`buildPushRequest` returns
 * `{ url, init }`) and interprets the reply status (`pushResult`); the caller sends it.
 *
 * Secrets: the VAPID private key and the subscription's auth secret never appear in a thrown
 * error, a return value (except from `generateVapidKeys`) or a log line. Errors say what was wrong
 * ("VAPID keys are invalid"), never which bytes.
 */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  ECDH,
  generateKeyPairSync,
  KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';

/** base64url, no padding. publicKey: the uncompressed P-256 point (65 bytes, 0x04 || x || y); privateKey: the 32-byte scalar d. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** `PushSubscription.toJSON()` as the browser sends it (base64url keys). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';
export type PushOutcome = 'ok' | 'gone' | 'retry' | 'error';

export interface EncryptOptions {
  /** 16 bytes; random when omitted (tests pass the RFC 8291 salt) */
  salt?: Uint8Array;
  /** the application server's ephemeral ECDH key: raw 32-byte d, base64url d, or a P-256 KeyObject; fresh when omitted (tests only) */
  asPrivateKey?: Uint8Array | string | KeyObject;
  /** the aes128gcm record size `rs` (default 4096) */
  recordSize?: number;
}

export interface PushRequestOptions {
  /** VAPID `sub`: a mailto: or https: URL the push service can contact */
  subject: string;
  /** how long the push service keeps an undeliverable message, seconds (default 4 h: an older reminder is stale) */
  ttlSec?: number;
  urgency?: Urgency;
  /** replaces an undelivered message with the same topic: up to 32 base64url characters */
  topic?: string;
  /** Unix time in seconds for the VAPID token (tests) */
  now?: number;
}

export interface PushRequest {
  url: string;
  init: { method: 'POST'; headers: Record<string, string>; body: Buffer };
}

export class PushError extends Error {
  code = 'PUSH_INVALID';
}

/** RFC 8291 §4: a push service need not accept a body over 4096 bytes; 4096 − 86 (header) − 16 (tag) − 1 (delimiter). */
export const MAX_PLAINTEXT = 3993;
export const RECORD_SIZE = 4096;
export const DEFAULT_TTL_SEC = 4 * 3600;
/** RFC 8292 §2: exp must be no more than 24 hours after the request */
export const MAX_VAPID_TTL_SEC = 24 * 3600;
/** the longest TTL push services honour (FCM: 4 weeks) */
const MAX_TTL_SEC = 28 * 24 * 3600;
const MAX_ENDPOINT = 2048;
const URGENCIES: readonly Urgency[] = ['very-low', 'low', 'normal', 'high'];
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
const CURVE = 'prime256v1';

function b64uDecode(s: unknown): Buffer | null {
  if (typeof s !== 'string' || !B64URL.test(s)) return null;
  return Buffer.from(s, 'base64url');
}

function b64uJson(v: unknown): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}

/** left-pad a JWK coordinate to the 32-byte field size */
function pad32(b: Buffer): Buffer {
  return b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]);
}

function isPoint(p: Buffer | null): p is Buffer {
  if (!p || p.length !== 65 || p[0] !== 0x04) return false;
  try {
    ECDH.convertKey(p, CURVE, undefined, undefined, 'uncompressed'); // throws off the curve
    return true;
  } catch {
    return false;
  }
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y || !jwk.d) throw new PushError('could not export the generated VAPID key');
  const x = pad32(Buffer.from(jwk.x, 'base64url'));
  const y = pad32(Buffer.from(jwk.y, 'base64url'));
  return {
    publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
    privateKey: pad32(Buffer.from(jwk.d, 'base64url')).toString('base64url'),
  };
}

/** Lengths after decoding, a point on the curve, a valid scalar, and the public key derived from that scalar. */
export function isVapidKeys(x: unknown): x is VapidKeys {
  if (!x || typeof x !== 'object') return false;
  const { publicKey, privateKey } = x as Record<string, unknown>;
  const pub = b64uDecode(publicKey);
  const d = b64uDecode(privateKey);
  if (!isPoint(pub) || !d || d.length !== 32) return false;
  try {
    const e = createECDH(CURVE);
    e.setPrivateKey(d);
    return e.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

export function validSubscription(x: unknown): x is PushSubscriptionJson {
  if (!x || typeof x !== 'object') return false;
  const { endpoint, keys } = x as Record<string, unknown>;
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT || /[\s\x00-\x1f\x7f]/.test(endpoint)) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return false;
  if (!keys || typeof keys !== 'object') return false;
  const { p256dh, auth } = keys as Record<string, unknown>;
  const a = b64uDecode(auth);
  return isPoint(b64uDecode(p256dh)) && !!a && a.length === 16;
}

function validSubject(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 512) return false;
  try {
    const u = new URL(s);
    if (u.protocol === 'mailto:') return /^[^@\s]+@[^@\s]+$/.test(decodeURIComponent(u.pathname));
    return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

function vapidKeyObject(keys: VapidKeys): KeyObject {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  try {
    return createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url'),
        d: Buffer.from(keys.privateKey, 'base64url').toString('base64url'),
      },
      format: 'jwk',
    });
  } catch {
    throw new PushError('VAPID keys are invalid');
  }
}

/** RFC 8292: `vapid t=<ES256 JWT>, k=<public key>`. */
export function vapidAuthorization(
  endpoint: string,
  subject: string,
  keys: VapidKeys,
  nowSec: number = Math.floor(Date.now() / 1000),
  ttlSec: number = 12 * 3600,
): string {
  let aud: string;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') throw new Error();
    aud = u.origin;
  } catch {
    throw new PushError('push endpoint must be an https URL');
  }
  if (!validSubject(subject)) throw new PushError('VAPID subject must be a mailto: or https: URL');
  if (!Number.isInteger(nowSec) || nowSec <= 0 || nowSec > 1e10) throw new PushError('VAPID time must be Unix seconds');
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_VAPID_TTL_SEC) throw new PushError('VAPID token lifetime must be 1 s to 24 h');
  if (!isVapidKeys(keys)) throw new PushError('VAPID keys are invalid');
  const input = `${b64uJson({ typ: 'JWT', alg: 'ES256' })}.${b64uJson({ aud, exp: nowSec + ttlSec, sub: subject })}`;
  let sig: Buffer;
  try {
    sig = sign('sha256', Buffer.from(input, 'ascii'), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  } catch {
    throw new PushError('VAPID signing failed');
  }
  const k = Buffer.from(keys.publicKey, 'base64url').toString('base64url'); // unpadded
  return `vapid t=${input}.${sig.toString('base64url')}, k=${k}`;
}

function hmac(key: Uint8Array, ...data: Uint8Array[]): Buffer {
  const h = createHmac('sha256', key);
  for (const d of data) h.update(d);
  return h.digest();
}

const ONE = Buffer.from([0x01]);
const DELIMITER = Buffer.from([0x02]); // RFC 8188: last record
const KEY_INFO = Buffer.from('WebPush: info\0', 'ascii');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'ascii');

function asScalar(k: Uint8Array | string | KeyObject): Buffer {
  let d: Buffer | null;
  if (k instanceof KeyObject) {
    const jwk = k.type === 'private' ? k.export({ format: 'jwk' }) : {};
    d = jwk.crv === 'P-256' && jwk.d ? pad32(Buffer.from(jwk.d, 'base64url')) : null;
  } else if (typeof k === 'string') {
    d = b64uDecode(k);
  } else {
    d = Buffer.from(k);
  }
  if (!d || d.length !== 32) throw new PushError('application server key is invalid');
  return d;
}

/** RFC 8291 encryption, aes128gcm coding (RFC 8188), one record: header || AES-128-GCM(plaintext || 0x02) || tag. */
export function encryptPayload(sub: PushSubscriptionJson, plaintext: Uint8Array, opts: EncryptOptions = {}): Buffer {
  if (!validSubscription(sub)) throw new PushError('push subscription is invalid');
  const rs = opts.recordSize ?? RECORD_SIZE;
  if (!Number.isInteger(rs) || rs < 18 || rs > 0xffffffff) throw new PushError('record size must be 18 to 2^32-1');
  // RFC 8291 §4: one record, and rs greater than plaintext + delimiter + tag
  const max = Math.min(MAX_PLAINTEXT, rs - 18);
  if (plaintext.length > max) throw new PushError(`push payload is ${plaintext.length} bytes; the limit is ${max}`);
  const salt = opts.salt ? Buffer.from(opts.salt) : randomBytes(16);
  if (salt.length !== 16) throw new PushError('salt must be 16 bytes');

  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = createECDH(CURVE);
  let ecdhSecret: Buffer;
  try {
    if (opts.asPrivateKey === undefined) ecdh.generateKeys();
    else ecdh.setPrivateKey(asScalar(opts.asPrivateKey));
    ecdhSecret = ecdh.computeSecret(uaPublic);
  } catch (e) {
    if (e instanceof PushError) throw e;
    throw new PushError('key agreement failed');
  }
  const asPublic = ecdh.getPublicKey();

  // HKDF-SHA-256 with a single-block expand, written out as in RFC 8291 §3.4
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, KEY_INFO, uaPublic, asPublic, ONE);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, CEK_INFO, ONE).subarray(0, 16);
  const nonce = hmac(prk, NONCE_INFO, ONE).subarray(0, 12); // record 0: NONCE xor 0

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.update(DELIMITER), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext]);
}

/** The whole request for one push; the caller sends it through the egress wrapper. */
export function buildPushRequest(sub: PushSubscriptionJson, payload: string, vapid: VapidKeys, opts: PushRequestOptions): PushRequest {
  if (!validSubscription(sub)) throw new PushError('push subscription is invalid');
  const ttl = opts.ttlSec ?? DEFAULT_TTL_SEC;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL_SEC) throw new PushError('TTL must be 0 to 28 days in seconds');
  const urgency = opts.urgency ?? 'normal';
  if (!URGENCIES.includes(urgency)) throw new PushError('urgency must be very-low, low, normal or high');
  if (opts.topic !== undefined && !TOPIC.test(opts.topic)) throw new PushError('topic must be 1 to 32 base64url characters');
  const headers: Record<string, string> = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
  };
  if (opts.topic !== undefined) headers.Topic = opts.topic;
  headers.Authorization = vapidAuthorization(sub.endpoint, opts.subject, vapid, opts.now ?? Math.floor(Date.now() / 1000));
  const body = encryptPayload(sub, Buffer.from(payload, 'utf8'));
  return { url: sub.endpoint, init: { method: 'POST', headers, body } };
}

/** What to do with the push service's reply (RFC 8030 §5, §7). */
export function pushResult(status: number): PushOutcome {
  if (status === 200 || status === 201 || status === 202) return 'ok';
  if (status === 404 || status === 410) return 'gone'; // the subscription expired: the caller deletes it
  if (status === 429 || (status >= 500 && status <= 599)) return 'retry';
  return 'error';
}
