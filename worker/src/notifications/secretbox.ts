// AES-256-GCM "sealed box" for adapter secrets stored in D1 (e.g. an org's Zulip
// bot credentials). The key is the SECRETS_KEY worker secret: base64 of exactly
// 32 random bytes (`openssl rand -base64 32`).
//
// Placement note: this file lives directly under notifications/ (NOT adapters/)
// so BOTH adapters and routes may import it without crossing the eslint walls in
// .eslintrc.cjs — adapters are only barred from routes/cron/dao/registry/index
// and sibling adapters. WebCrypto only; no Node APIs.

/** Wire format: base64( iv(12 bytes) || ciphertext+tag ). */
const IV_BYTES = 12;

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAesKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = b64decode(keyB64);
  } catch {
    throw new Error('secretbox: SECRETS_KEY is not valid base64');
  }
  if (raw.length !== 32) {
    throw new Error(
      `secretbox: SECRETS_KEY must decode to exactly 32 bytes (got ${raw.length}) — generate with \`openssl rand -base64 32\``,
    );
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt `plaintext` under the base64 32-byte key. Fresh random IV per call, so
 *  sealing the same plaintext twice yields different blobs. */
export async function seal(keyB64: string, plaintext: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return b64encode(out);
}

/** Inverse of seal(). Throws on a wrong key, a truncated blob, or tampered
 *  ciphertext (GCM authenticates) — callers decide whether that's fatal. */
export async function open(keyB64: string, sealed: string): Promise<string> {
  const key = await importAesKey(keyB64);
  const blob = b64decode(sealed);
  if (blob.length <= IV_BYTES) throw new Error('secretbox: sealed blob too short');
  const iv = blob.slice(0, IV_BYTES);
  const ct = blob.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** SHA-256 of a UTF-8 string as lowercase hex — the webhook-token lookup hash. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
