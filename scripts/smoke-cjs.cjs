// Checks that the built package can be required as CommonJS, by its own name (through the `exports` map).
// Run `pnpm build` first. Nothing is sent: the call goes to an injected fetch.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

// The CommonJS build loads Node's modules with require: a CommonJS file with an `import()` in it fails where it is
// loaded in a VM without dynamic import support (Jest).
const built = readFileSync(require.resolve('verifyinboxes'), 'utf8');
assert.ok(!/\bimport\(/.test(built), 'dist/index.cjs has an import(): build it with dynamic-import off');

const sdk = require('verifyinboxes');
const { VerifyInboxes, APIError, AuthenticationError, VERSION, verifySignature } = sdk;

assert.equal(sdk.default, VerifyInboxes);
assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.ok(AuthenticationError.prototype instanceof APIError);
assert.ok(APIError.prototype instanceof Error);

const calls = [];
const client = new VerifyInboxes({
  apiKey: 'bv_testtesttesttesttesttesttesttest',
  fetch: async (url, init) => {
    calls.push([url, new Headers(init.headers).get('user-agent')]);
    const account = { name: 'acme', balance: 1, reviewed: false, test_emails: false, safe_to_send_threshold: 0.8 };
    return new Response(JSON.stringify(account), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

(async () => {
  assert.equal((await client.account.get()).name, 'acme');
  assert.deepEqual(calls, [['https://api.verifyinboxes.com/v1/account', `verifyinboxes-js/${VERSION}`]]);
  assert.equal(await verifySignature('{}', 't=1,v1=00', 'secret'), false);
  console.log(`cjs ok: verifyinboxes ${VERSION}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
