/** `verifySignature` beyond the shared vectors: it never throws, it needs no client, and it works without a global crypto. */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DELIVERY_HEADER, SIGNATURE_HEADER, VerifyInboxes, verifySignature } from '../src';
import { KEY } from './fakeapi';

const SECRET = '6f1d0c9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e';
const BODY = '{"event":"job.completed","job_id":"019a3b71-3c4d-7e5f-8a6b-7c8d9e0f1a2b","status":"done"}';

function sign(body: string, t: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifySignature', () => {
  it('checks signatures without a client or a key', async () => {
    // Node 18 has no global crypto: the check falls back to node:crypto's.
    vi.stubGlobal('crypto', undefined);
    expect(globalThis.crypto).toBeUndefined();
    const t = Math.floor(Date.now() / 1000);
    expect(await verifySignature(BODY, `t=${t},v1=${sign(BODY, t)}`, SECRET)).toBe(true);
    expect(await verifySignature(new TextEncoder().encode(BODY), `t=${t},v1=${sign(BODY, t)}`, SECRET)).toBe(true);
    expect(await verifySignature(`${BODY} `, `t=${t},v1=${sign(BODY, t)}`, SECRET)).toBe(false);
    expect(await verifySignature(BODY, `t=${t - 301},v1=${sign(BODY, t - 301)}`, SECRET)).toBe(false);
    expect(await verifySignature(BODY, `t=${t - 301},v1=${sign(BODY, t - 301)}`, SECRET, { toleranceSeconds: 600 })).toBe(true);
  });

  it('names the headers the API sends', () => {
    expect(SIGNATURE_HEADER).toBe('X-Boxverifier-Signature');
    expect(DELIVERY_HEADER).toBe('X-Boxverifier-Delivery'); // the same on every retry of one delivery
  });

  it('takes a header that may be missing, as Headers.get gives it', async () => {
    const headers = new Headers();
    // No cast: the header's type takes what Headers.get and an optional value give.
    expect(await verifySignature(BODY, headers.get(SIGNATURE_HEADER), SECRET)).toBe(false);
    expect(await verifySignature(BODY, undefined, SECRET)).toBe(false);
    const t = Math.floor(Date.now() / 1000);
    headers.set(SIGNATURE_HEADER, `t=${t},v1=${sign(BODY, t)}`);
    expect(await verifySignature(BODY, headers.get(SIGNATURE_HEADER), SECRET)).toBe(true);
  });

  it('is false for anything it cannot read, and never throws', async () => {
    const headers: unknown[] = [
      null, undefined, 7, new TextEncoder().encode('t=1,v1=00'), `t=1,v1=${'é'.repeat(64)}`, `t=1,v1=${'ü'.repeat(32)}`,
      `t=${'²'.repeat(3)},v1=${'0'.repeat(64)}`, 't=,v1=', '=,=,=', ',,,', 't=1'.repeat(1000),
      `t=99999999999999999999999999999999,v1=${'0'.repeat(64)}`, `v1=${'a'.repeat(64)}`, '\u0000', '',
    ];
    for (const header of headers) {
      expect(await verifySignature(BODY, header as string, SECRET, { nowSeconds: 1 }), String(header).slice(0, 40)).toBe(false);
    }
    const header = `t=1,v1=${'0'.repeat(64)}`;
    const args: unknown[][] = [[null, header, SECRET], [BODY, header, null], [BODY, header, 7], [12, header, SECRET], [BODY, header, ''], [{}, header, SECRET]];
    for (const [body, h, secret] of args) {
      expect(await verifySignature(body as string, h as string, secret as string, { nowSeconds: 1 })).toBe(false);
    }
    expect(await verifySignature(BODY, header, SECRET, { toleranceSeconds: 'a' as unknown as number, nowSeconds: 1 })).toBe(false);
  });

  it('is false when the tolerance or the clock is not a finite number', async () => {
    const signedAt = 1762858800 - 1_000_000; // a million seconds old
    const header = `t=${signedAt},v1=${sign(BODY, signedAt)}`;
    for (const [toleranceSeconds, nowSeconds] of [
      [NaN, 1762858800], [300, NaN], [Infinity, 1762858800], [300, Infinity], [-Infinity, 1762858800],
    ] as const) {
      expect(await verifySignature(BODY, header, SECRET, { toleranceSeconds, nowSeconds })).toBe(false);
    }
  });

  it('is on the client too', async () => {
    const t = 1762858800;
    const header = `t=${t},v1=${sign(BODY, t)}`;
    const client = new VerifyInboxes({ apiKey: KEY });
    expect(await client.webhooks.verifySignature(BODY, header, SECRET, { nowSeconds: t })).toBe(true);
    expect(await client.webhooks.verifySignature(`${BODY} `, header, SECRET, { nowSeconds: t })).toBe(false);
  });
});
