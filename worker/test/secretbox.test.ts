import { describe, expect, it } from 'vitest';
import { open, seal, sha256Hex } from '../src/notifications/secretbox';

// base64("0123456789abcdef0123456789abcdef") — exactly 32 bytes.
const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const OTHER_KEY = 'YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODk=';

describe('secretbox', () => {
  it('round-trips seal -> open', async () => {
    const sealed = await seal(KEY, '{"site":"https://z.example","apiKey":"s3cret"}');
    expect(await open(KEY, sealed)).toBe('{"site":"https://z.example","apiKey":"s3cret"}');
  });

  it('uses a fresh IV per seal (same plaintext, different blobs)', async () => {
    const a = await seal(KEY, 'same');
    const b = await seal(KEY, 'same');
    expect(a).not.toBe(b);
    expect(await open(KEY, a)).toBe('same');
    expect(await open(KEY, b)).toBe('same');
  });

  it('open throws on the wrong key', async () => {
    const sealed = await seal(KEY, 'top secret');
    await expect(open(OTHER_KEY, sealed)).rejects.toThrow();
  });

  it('open throws on tampered ciphertext (GCM authenticates)', async () => {
    const sealed = await seal(KEY, 'top secret');
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1]! ^= 0xff; // flip a tag bit
    const tampered = btoa(String.fromCharCode(...bytes));
    await expect(open(KEY, tampered)).rejects.toThrow();
  });

  it('open throws on a truncated blob', async () => {
    await expect(open(KEY, btoa('short'))).rejects.toThrow(/too short/);
  });

  it('rejects a key that is not 32 bytes', async () => {
    await expect(seal(btoa('too-short'), 'x')).rejects.toThrow(/32 bytes/);
    await expect(seal('%%%not-base64%%%', 'x')).rejects.toThrow(/base64/);
  });

  it('sha256Hex matches the known test vector', async () => {
    // FIPS 180-2 vector for "abc".
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
