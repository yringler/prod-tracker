// Web Push (VAPID + RFC 8291 aes128gcm) on WebCrypto — no Node 'web-push' dep.
// VAPID keys are base64url raw: public = 65-byte uncompressed point, private =
// 32-byte scalar d. Set via `wrangler secret put VAPID_PUBLIC_KEY/PRIVATE_KEY`.

import type { Env } from '../env';

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const enc = new TextEncoder();

export async function sendPush(
  env: Env,
  sub: PushSubscription,
  payload: unknown,
): Promise<{ ok: boolean; status: number }> {
  const body = await encrypt(JSON.stringify(payload), sub.keys.p256dh, sub.keys.auth);
  const jwt = await vapidJwt(env, new URL(sub.endpoint).origin);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '2419200',
    },
    body,
  });
  return { ok: res.ok, status: res.status };
}

// --- VAPID JWT (ES256) -------------------------------------------------------

async function vapidJwt(env: Env, audience: string): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url(
    enc.encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.VAPID_SUBJECT,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function importVapidPrivateKey(pub: string, priv: string): Promise<CryptoKey> {
  const pubBytes = ub64url(pub); // 0x04 || x(32) || y(32)
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64url(pubBytes.slice(1, 33)),
    y: b64url(pubBytes.slice(33, 65)),
    d: b64url(ub64url(priv)),
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
}

// --- RFC 8291 / RFC 8188 aes128gcm content encryption ------------------------

async function encrypt(plaintext: string, p256dhB64: string, authB64: string): Promise<Uint8Array> {
  const uaPublic = ub64url(p256dhB64); // 65 bytes
  const authSecret = ub64url(authB64); // 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral application server keypair.
  const asKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const asPublicRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', asKeyPair.publicKey)) as ArrayBuffer,
  ); // 65

  // ECDH shared secret with the subscription's public key.
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhAlgo = { name: 'ECDH', public: uaKey } as unknown as Parameters<
    SubtleCrypto['deriveBits']
  >[0];
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhAlgo, asKeyPair.privateKey, 256),
  );

  // ikm = HKDF(salt=authSecret, ikm=ecdhSecret, info="WebPush: info\0"||ua||as)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // CEK + nonce from the message salt.
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Pad: plaintext || 0x02 (single, last record).
  const padded = concat(enc.encode(plaintext), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded),
  );

  // Header: salt(16) || rs(4 BE) || idlen(1)=65 || as_public(65), then ciphertext.
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// --- base64url helpers -------------------------------------------------------

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function ub64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
