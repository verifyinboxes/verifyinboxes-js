// Checks that the built package can be imported as an ES module, by its own name (through the `exports` map), in
// Node, Bun and Deno: a webhook signature checked with the runtime's Web Crypto, and two calls (a GET and a POST)
// through an injected fetch. Run `pnpm build` first. Nothing is sent.
import assert from 'node:assert/strict';

import VerifyInboxes, {
  APIError,
  AuthenticationError,
  SIGNATURE_HEADER,
  VerifyInboxes as Named,
  VERSION,
  verifySignature,
} from 'verifyinboxes';

assert.equal(VerifyInboxes, Named);
assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.ok(AuthenticationError.prototype instanceof APIError);
assert.ok(APIError.prototype instanceof Error);
assert.equal(SIGNATURE_HEADER, 'X-Boxverifier-Signature');

// The conformance vector "valid": a real HMAC-SHA256 over the body, through the runtime's own crypto.
const secret = '6f1d0c9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e';
const body =
  '{"event": "job.completed", "job_id": "019a3b6e-8f0c-7d2e-9a41-5c3e2f1b0a77", "kind": "bulk", "status": "done", ' +
  '"total": 2, "counts": {"valid": 1, "invalid": 1}, "finished_at": "2026-10-31T11:00:00.123456+00:00", ' +
  '"download_url": "https://api.verifyinboxes.com/v1/jobs/019a3b6e-8f0c-7d2e-9a41-5c3e2f1b0a77/download"}';
const header = 't=1762858800,v1=b10b95be47b898cc89c3d20033c9b43376187d64f091ef22f9714ade07fc317f';
assert.equal(await verifySignature(body, header, secret, { nowSeconds: 1762858800 }), true);
assert.equal(await verifySignature(new TextEncoder().encode(body), header, secret, { nowSeconds: 1762858800 }), true);
assert.equal(await verifySignature(`${body} `, header, secret, { nowSeconds: 1762858800 }), false);
assert.equal(await verifySignature('{}', 't=1,v1=00', 'secret'), false);

const calls = [];
const client = new VerifyInboxes({
  apiKey: 'bv_testtesttesttesttesttesttesttest',
  fetch: async (url, init) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method, ua: headers.get('user-agent'), key: headers.get('idempotency-key'),
      type: headers.get('content-type'), body: init.body ?? null });
    const answer = url.endsWith('/v1/account')
      ? { name: 'acme', balance: 1, reviewed: false, test_emails: false, safe_to_send_threshold: 0.8 }
      : { email: 'ann@example.com', verdict: 'invalid', score: null, safe_to_send: false, flags: [], provider: 'google',
          catch_all_domain: false, verified_at: '2026-11-18T10:12:00.123Z', source: 'smtp', reason: 'mailbox_not_found',
          job_id: '019a3b71-3c4d-7e5f-8a6b-7c8d9e0f1a2b' };
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal((await client.account.get()).name, 'acme');
const result = await client.verify('ann@example.com');
assert.equal(result.verdict, 'invalid');
assert.equal(result.job_id, '019a3b71-3c4d-7e5f-8a6b-7c8d9e0f1a2b');
const [get, post] = calls;
assert.equal(calls.length, 2);
assert.deepEqual([get.url, get.method, get.ua], ['https://api.verifyinboxes.com/v1/account', 'GET', `verifyinboxes-js/${VERSION}`]);
assert.deepEqual([post.url, post.method, post.type], ['https://api.verifyinboxes.com/v1/verify', 'POST', 'application/json']);
assert.deepEqual(JSON.parse(post.body), { email: 'ann@example.com' });
assert.match(post.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

console.log(`esm ok: verifyinboxes ${VERSION}`);
