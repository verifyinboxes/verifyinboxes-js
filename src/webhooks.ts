/** Checking that a webhook delivery came from VerifyInboxes, before reading anything in it. */
import { webCrypto } from './internal';

/** The header that carries a delivery's signature: `t=<unix seconds>,v1=<hex>`. */
export const SIGNATURE_HEADER = 'X-Boxverifier-Signature';
/** The same on every retry of one delivery: deliveries come at least once, so drop the ones you have seen. */
export const DELIVERY_HEADER = 'X-Boxverifier-Delivery';
/** How far, in seconds, a signature's time may be from yours (5 minutes). */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifySignatureOptions {
  /** How far, in seconds, the signature's time may be from `nowSeconds`. Default 300. */
  toleranceSeconds?: number;
  /** The time to compare with, in Unix seconds. Default: your clock. */
  nowSeconds?: number;
}

const V1 = /^[0-9a-f]{64}$/;
const DIGITS = /^[0-9]+$/;

/**
 * Whether `header` (the delivery's `X-Boxverifier-Signature`) signs `rawBody` with your webhook's `secret`.
 *
 * Pass the body exactly as it arrived, before any JSON parsing: its bytes, or text that is those bytes decoded as
 * UTF-8. `secret` is the 64 characters `webhooks.create` returned. A signature more than `toleranceSeconds` from
 * `nowSeconds` (default: your clock) is refused, so an old delivery cannot be sent again. Anything that cannot be read
 * is `false` (a missing header too): this never throws. It needs no client and no key.
 *
 * ```ts
 * // request: a web Request (the Fetch API's), read before anything else
 * const rawBody = new Uint8Array(await request.arrayBuffer());
 * if (!(await verifySignature(rawBody, request.headers.get(SIGNATURE_HEADER), secret))) {
 *   return new Response(null, { status: 400 });
 * }
 * ```
 */
export async function verifySignature(
  rawBody: string | Uint8Array | ArrayBuffer,
  header: string | null | undefined,
  secret: string,
  options: VerifySignatureOptions = {},
): Promise<boolean> {
  try {
    let body: Uint8Array;
    if (typeof rawBody === 'string') body = new TextEncoder().encode(rawBody);
    else if (rawBody instanceof Uint8Array) body = rawBody;
    else if (rawBody instanceof ArrayBuffer || Object.prototype.toString.call(rawBody) === '[object ArrayBuffer]') {
      body = new Uint8Array(rawBody as ArrayBuffer);
    }
    else if (ArrayBuffer.isView(rawBody as unknown)) {
      const view = rawBody as unknown as ArrayBufferView;
      body = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    else return false;
    if (typeof header !== 'string' || typeof secret !== 'string' || secret === '') return false;
    const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    const now = options.nowSeconds ?? Date.now() / 1000;
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance)) return false;
    if (typeof now !== 'number' || !Number.isFinite(now)) return false;

    const stamps: string[] = [];
    const signatures: string[] = [];
    for (const part of header.split(',')) {
      const at = part.indexOf('=');
      if (at < 0) continue;
      const name = part.slice(0, at).trim();
      const value = part.slice(at + 1).trim();
      if (name === 't') stamps.push(value);
      else if (name === 'v1' && V1.test(value)) signatures.push(value);
    }
    const stamp = stamps[0];
    if (stamps.length !== 1 || stamp === undefined || !DIGITS.test(stamp) || signatures.length === 0) return false;
    if (Math.abs(now - Number(stamp)) > tolerance) return false;

    const { subtle } = await webCrypto();
    const key = await subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const prefix = new TextEncoder().encode(`${stamp}.`);
    const signed = new Uint8Array(prefix.byteLength + body.byteLength);
    signed.set(prefix, 0);
    signed.set(body, prefix.byteLength);
    const expected = toHex(new Uint8Array(await subtle.sign('HMAC', key, signed)));
    let matched = false;
    for (const signature of signatures) {
      // Every one compared, in constant time: which of them matched is not told by the time it took.
      const same = constantTimeEqual(expected, signature);
      matched = same || matched;
    }
    return matched;
  } catch {
    return false; // anything unreadable is "not valid", never an exception
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Two strings of the same length compared without stopping at the first difference. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
