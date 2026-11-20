# VerifyInboxes JavaScript and TypeScript library

[![CI](https://github.com/verifyinboxes/verifyinboxes-js/actions/workflows/ci.yml/badge.svg)](https://github.com/verifyinboxes/verifyinboxes-js/actions/workflows/ci.yml)

The official JavaScript and TypeScript library for the [VerifyInboxes](https://verifyinboxes.com) API: check whether
email addresses can receive mail, one at a time or as lists of any size, and read the results. For Node, Bun and Deno.

- Written in TypeScript: every answer and every error is typed
- Retries that never charge twice, waiting for checks and lists, results read page by page
- Cancellation with `AbortSignal`; a cancelled `verify` or `verifyMany` names every job it made
- Webhook signature checks
- No dependencies: it uses the runtime's own `fetch` and Web Crypto
- ES modules and CommonJS; Node 18 or later, Bun, Deno

## Install

Not published yet: until the first release is on npm, build it from this repository and install the package it makes:

```bash
git clone https://github.com/verifyinboxes/verifyinboxes-js && cd verifyinboxes-js
pnpm install && pnpm build && npm pack          # makes verifyinboxes-0.1.0.tgz
cd ../your-project && npm install ../verifyinboxes-js/verifyinboxes-0.1.0.tgz
```

Once released:

```bash
npm install verifyinboxes
# or: pnpm add verifyinboxes / yarn add verifyinboxes / bun add verifyinboxes
deno add npm:verifyinboxes
```

## Quickstart

An organisation admin makes an API key in the VerifyInboxes app under **Developers** → **API keys**. Put it in the
environment:

```bash
export VERIFYINBOXES_API_KEY="bv_..."
```

```ts
import VerifyInboxes from 'verifyinboxes';

const client = new VerifyInboxes(); // reads VERIFYINBOXES_API_KEY

const result = await client.verify('ann@example.com');
console.log(result.verdict);      // 'valid', 'invalid', 'catch_all', 'risky' or 'unknown'
console.log(result.safe_to_send); // true or false
console.log(result.reason);       // why, e.g. 'mailbox_not_found'
console.log(result.job_id);       // the check's job

for (const each of await client.verifyMany(['bob@example.com', 'cat@example.com'])) {
  console.log(each.email, each.verdict);
}
```

CommonJS works the same way:

```js
const { VerifyInboxes } = require('verifyinboxes');
```

## The client

```ts
import VerifyInboxes from 'verifyinboxes';

const client = new VerifyInboxes({
  apiKey: 'bv_...',                          // default: the VERIFYINBOXES_API_KEY environment variable
  baseURL: 'https://api.verifyinboxes.com',  // default: VERIFYINBOXES_BASE_URL, else this
  timeout: 60_000,                           // milliseconds one attempt of one request may take
  maxRetries: 2,                             // see "Retries"
  fetch: myFetch,                            // default: the global fetch
  userAgent: 'my-app/1.2',                   // put in front of verifyinboxes-js/<version>
});
```

Without a key, the constructor throws `MissingAPIKeyError`; a key with a space or a control character in it, or one
that is not ASCII (half of a copy and paste), throws a `TypeError`. Keep the key out of your code: the environment
variable is the place for it. The client never logs it, and `console.log(client)` shows only its first 6 characters.

**Keep the key on a server.** A key in a web page is a key shown to everyone who opens it, so the client refuses to
run in one: it throws unless you pass `dangerouslyAllowBrowser: true`, which is only for a page no stranger opens,
with a credential that may be seen.

Every duration is in milliseconds, but for the webhook check's `toleranceSeconds`. Every method that calls the API
takes an options object last, with a `signal` in it (see "Cancellation").

### Personal access tokens

Where an API key works, so does a personal access token (`vi_at_...`): what an app gets when a person signs in to it
with their VerifyInboxes account. It acts as that person, with their role in the organisation they chose, and lives
an hour; after that the API answers `401` (`AuthenticationError`) and the app signs in again or uses its refresh
token. Pass it as the key:

```ts
const client = new VerifyInboxes({ apiKey: accessToken });
```

## Checking addresses

### One address

```ts
const result = await client.verify('ann@example.com');
const fresh = await client.verify('ann@example.com', { forceRecheck: true }); // skip the cache
```

The API answers within about 5 seconds, or says the check is still running; then the client asks every 2 seconds
until it is done, for up to `timeout` milliseconds (default 60 000). Every result names its job (`result.job_id`): a
`catch_all` or `risky` one can later be sent to `client.lists.resolve(result.job_id)`.

| `Result` field | |
| --- | --- |
| `email` | The address, as checked. |
| `verdict` | `valid`, `invalid`, `catch_all`, `risky` or `unknown`. |
| `safe_to_send` | Whether to send to it: `valid`, or a `catch_all` whose score reaches your organisation's threshold. |
| `score` | For a `catch_all` verdict, the probability that the mailbox exists (0 to 1), else `null`. |
| `reason` | Why: `mailbox_exists`, `mailbox_not_found`, `no_mail_server`, `accept_all`, `syntax`, `typo`, ... |
| `did_you_mean` | For a `typo`: the address it probably is. |
| `flags` | `disposable`, `role`, `free_provider`, `gateway`. |
| `provider`, `catch_all_domain`, `source`, `verified_at` | The domain's mail provider, whether it accepts every address, where the answer came from, and when. |
| `job_id` | The job that holds the result. |

The API adds verdicts, reasons and flags over time: a value you do not know is kept as the string it is, never an
error, and the types say so (`Verdict` is `'valid' | ... | (string & {})`). Show it, and act on `safe_to_send`.

### Waiting, and picking a check up again

A check that has not finished when `timeout` runs out throws `WaitTimeoutError`. The check carries on, and the error
names its job in `jobIds`, so nothing is lost:

```ts
import { WaitTimeoutError } from 'verifyinboxes';

try {
  const result = await client.verify('ann@example.com', { timeout: 10_000 });
} catch (error) {
  if (!(error instanceof WaitTimeoutError)) throw error;
  const [jobId] = error.jobIds;
  // ... later: picks it up where it was
  const result = await client.checks.wait(jobId!);
}
```

`wait: false` does not wait at all: you get the result, or a `PendingCheck` with its `job_id`.

```ts
const started = await client.verify('ann@example.com', { wait: false });
if ('verdict' in started) {
  console.log(started.verdict);
} else {
  const result = await client.checks.wait(started.job_id, { timeout: 120_000 });
}

const job = await client.checks.get(jobId); // the job as it is now; job.result once it is done
```

`timeout: null` waits as long as it takes.

### Many addresses

**Never check many addresses with a loop of `verify`.** Checks go ahead of lists only up to 10 running at once:
past that, your checks wait behind other work, and a loop gains nothing over the ways below.

`verifyMany` returns the results in the order of its input:

```ts
const results = await client.verifyMany(addresses, { timeout: 600_000 });
```

Up to 10 addresses are checked one by one, together. More go as one list (below), which the call waits for and
reads back; every result's `job_id` is then the list's. For a large or long-running batch, use a list yourself.

### Lists

```ts
const fromFile = await client.lists.create({ file: 'prospects.csv', emailColumn: 'email' }); // a path
const fromBlob = await client.lists.create({ file: new Blob([bytes]) });  // a Blob or a File, bytes, or a stream
const fromText = await client.lists.create({ csv: 'email\nann@example.com\n' });           // a CSV's text
const created = await client.lists.create({ emails: ['ann@example.com', 'bob@example.com'] });

const job = await client.lists.wait(created.id); // asks at once, then after 2, 4, 8, 16 and every 30 seconds
console.log(job.status, job.counts);             // 'done', { valid: ..., invalid: ..., ... }
```

A path works in Node, Bun and Deno. The upload's name is the path's file name, else `list.csv` (or `filename`). A
stream is a web `ReadableStream`; pass a Node.js stream as `Readable.toWeb(stream)`.

**How long a list takes.** A few hundred addresses take minutes, and Microsoft-hosted ones longer. `lists.wait` has no
time limit unless you give one; `lists.wait(id, { timeout })` throws `WaitTimeoutError` (the list carries on), and
`lists.wait(id)` picks it up again at any time. Instead of waiting, you can be told: see "Webhooks" below.

The results, every row once and in order, read a page at a time as you iterate (nothing is asked until then):

```ts
for await (const row of client.lists.results(created.id)) {
  console.log(row.row, row.email, row.verdict, row.safe_to_send);
}

const rows = await client.lists.results(created.id).toArray();
client.lists.results(created.id, { onlySafeToSend: true });
client.lists.results(created.id, { verdicts: ['valid', 'catch_all'] });
client.lists.results(created.id, { partial: true });  // a list still running, as it stands
client.lists.results(created.id, { pageSize: 1000 }); // rows per request, 1 to 1000 (default 500)
```

To keep your own cursor (to resume elsewhere), read one page at a time:

```ts
let page = await client.lists.resultsPage(created.id, { pageSize: 1000 });
for (;;) {
  await save(page.data);
  if (page.next_cursor === null) break;
  page = await client.lists.resultsPage(created.id, { cursor: page.next_cursor, pageSize: 1000 });
}
```

A page may hold fewer rows than asked, even none, before the last one: follow `next_cursor` until it is `null`.

The CSV you sent, with the results appended:

```ts
const written = await client.lists.downloadToFile(created.id, 'results.csv'); // bytes written
await client.lists.downloadToFile(created.id, 'safe.csv', { onlySafeToSend: true });

const stream = await client.lists.download(created.id); // a ReadableStream<Uint8Array>, to put anywhere
```

`downloadToFile` writes beside the file and renames over it once the whole download is there: if it fails, the file
that was there is untouched, and a download cut short is made again from the start. `download` is sent again until
its answer starts; after that the stream is yours, and no timeout applies to it: to bound the whole download, pass
`signal: AbortSignal.timeout(ms)`.

`client.lists.get(id)` is the list as it is now.

### Catch-all resolution

For an organisation allowed to send test emails, the `catch_all` and `risky` addresses of a finished list or check
can be settled by a test email. Most are settled within about 3 days of sending, some take up to 7 days. One request
takes at most 500 addresses (more is refused with `too_many_to_resolve`): for a list with more, name them in parts of
at most 500:

```ts
const resolution = await client.lists.resolve(created.id);                               // all of them, if at most 500
const some = await client.lists.resolve(created.id, { emails: ['bob@example.com'] });    // some (at most 500)
const job = await client.lists.wait(resolution.id);
```

## Everything else

```ts
const account = await client.account.get(); // name, balance, reviewed, test_emails, safe_to_send_threshold

const domain = await client.domains.get('example.com'); // provider, mx_hosts, catch_all, email_pattern, ... (1 credit)

await client.suppressions.add({ emails: ['ann@example.com'], domains: ['competitor.example'] }); // -> how many added
await client.suppressions.remove({ emails: ['ann@example.com'] }); // -> how many removed
await client.suppressions.list(); // domains, and the number of addresses (kept only as a hash)

const hook = await client.webhooks.create('https://example.com/webhooks/verifyinboxes', { events: ['job.completed'] });
hook.secret; // shown only now: store it
await client.webhooks.list();
await client.webhooks.delete(hook.id);

const page = await client.notices.list({ after: lastSeen, limit: 100 }); // verdicts you bought, overturned since
lastSeen = page.next_after;

await client.feedback.report([
  { email: 'ann@example.com', type: 'hard_bounce', observed_at: '2026-11-04T10:00:00Z', dsn_code: '5.1.1',
    event_id: 'b-1' },
]);

const integration = await client.integrations.create('instantly', { label: 'main workspace' });
integration.url; // shown only now: paste it into the provider
await client.integrations.list();
await client.integrations.delete(integration.id);
```

## Errors

```text
VerifyInboxesError                    the base of all; also "the API broke its own rules"
├── MissingAPIKeyError                no key given and VERIFYINBOXES_API_KEY not set
├── APIConnectionError                the request got no answer
│   └── APIConnectionTimeoutError     ... in time
├── APIUserAbortError                 your AbortSignal aborted the call
├── APIError                          the API answered with an error (any other 4xx)
│   ├── InvalidRequestError           400, 413, 414, 415, 422
│   ├── AuthenticationError           401
│   ├── InsufficientCreditsError      402
│   ├── PermissionDeniedError         403
│   ├── NotFoundError                 404, 410
│   ├── ConflictError                 409
│   ├── RateLimitError                429
│   └── ServerError                   5xx
└── WaitTimeoutError                  a check or a list was still running when the time to wait ran out
```

A wrong argument (an empty list of addresses, a page size of 0) is a `TypeError`, thrown before anything is sent.

An `APIError` carries what the API said, and the request id support asks for:

```ts
import { APIError, InsufficientCreditsError } from 'verifyinboxes';

try {
  await client.lists.create({ file: 'prospects.csv' });
} catch (error) {
  if (error instanceof InsufficientCreditsError) {
    console.log('top up first');
  } else if (error instanceof APIError) {
    console.log(error.status);    // 422
    console.log(error.code);      // 'consumer_list'  <- match on this
    console.log(error.requestId); // the answer's X-Request-Id: quote it when you write to support
    console.log(error.message);   // '422 consumer_list: ... (request id 019a...)'
  } else {
    throw error;
  }
}
```

| Property | |
| --- | --- |
| `status` | The HTTP status. |
| `code` | The API's error code, or `null` when the answer was not the API's (a proxy's error page). Match on it; treat one you do not know by its status. |
| `message` | `<status> <code>: <what the API said> (request id <id>)`. Show it or log it; do not parse it. |
| `requestId` | The answer's `X-Request-Id`. After retries, the last answer's. |
| `retryAfter` | The answer's `Retry-After`, in seconds, when it had one; else `null`. |
| `body` | The answer's JSON body (its text when it is not JSON). |
| `jobIds` | On every error: the jobs the call had made when it failed, as far as it knows (an aborted `lists.create` or `lists.resolve` may not know its own: see "Cancellation"). |

**`jobIds`.** Every error thrown while waiting, and by `verifyMany`, names every job the call made, in the order of
its input. Those jobs carry on, and the credits they hold are spent on them: pick them up with
`client.checks.wait(jobId)` or `client.lists.wait(jobId)` instead of starting again.

## Cancellation

Every method that calls the API takes a `signal`. When it aborts, the call stops, whatever it was doing (a request,
a pause before a retry, waiting for a check or a list) and throws `APIUserAbortError`; nothing is sent again. One
request is let finish, so that no job you are charged for goes unnamed: the one that starts a check (`verify`, each
check of `verifyMany`) or `verifyMany`'s list, when it was already sent. It ends within the client's `timeout`, the
job it made goes into the error's `jobIds`, and nothing more is started or waited for.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);
try {
  const results = await client.verifyMany(addresses, { signal: controller.signal });
} catch (error) {
  if (error instanceof APIUserAbortError) console.log('still running:', error.jobIds);
}
```

A check or a list that `verify` or `verifyMany` had started is not stopped by the abort: it carries on and its
credits are held, and the error names it in `jobIds`: wait for it again with `checks.wait` or `lists.wait`.
`AbortSignal.timeout(ms)` works too.

`lists.create` and `lists.resolve` stop at once, even when their request has already reached the API (so that an
upload can be cancelled). If it had, the list or the resolution exists and holds credits, but it is not in `jobIds`.
If you may abort one, pass your own `idempotencyKey`, and after an `APIUserAbortError` make the same call again with
the same key, within 24 hours (the API keeps a key's answer that long):

- if the first request ran, the API answers with what it answered then (the list it made, or its error) and runs
  nothing again: nothing more is charged;
- if it is still running, the API answers `409 idempotency_in_progress`, which the library sends again after its
  `Retry-After` (up to `maxRetries` times);
- if it never ran (for example it never arrived, or was answered `429` or `5xx`), it runs now, once.

An upload is known by its key alone, never by its file: send the same file again under the same key, and a new key
with a new file.

## Retries

A request that fails in a way worth retrying is sent again, up to `maxRetries` times (default 2):

| Failure | Retried |
| --- | --- |
| No answer: the connection failed, was reset or closed, or timed out | Yes |
| `429` | Yes, after `Retry-After` |
| `409 idempotency_in_progress` | Yes, after `Retry-After` |
| `5xx` | Yes |
| Any other `4xx` | No: the same request would get the same answer |

The wait is the answer's `Retry-After` when it has one. A `Retry-After` over 60 seconds is not waited for: the error
is thrown at once, with the wait on `.retryAfter`. Otherwise it backs off exponentially, with jitter: up to half a
second before the first retry, up to a second before the second, doubling to at most eight.

**Nothing is charged twice.** Every `POST` carries an `Idempotency-Key`, the same on every attempt of one call.
When an answer is lost after the API ran the request (a check, a list, an upload, a resolution, feedback, a
suppression), the retry gets the first answer again: one job, charged once.

A `409 idempotency_in_progress` (`ConflictError`) left after the retries means the first request with that key is
still running on the API. Repeat the call later with your own `idempotencyKey`, the same one: the API then answers
with what the first request answered, and runs nothing twice. (Without a key of your own, each call makes a new one,
which cannot be sent again: pass your own where a repeat matters.)

Your own key makes one request safe to send again after your program restarts. A key names **one** request, and the
API keeps its answer for 24 hours: in that time the same key gets that answer again, whatever you send with it. An
upload is known by its key alone, never by its file, so another file under a used key gets the first file's list;
and an error is kept like any answer, so a `402` stays a `402` under its key. So make the key from the request
itself, and give a new file, or a retry after you topped up, a new key:

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

await client.verify('ann@example.com', { idempotencyKey: `order-${orderId}` }); // one key per order

const digest = createHash('sha256').update(await readFile('prospects.csv')).digest('hex');
await client.lists.create({ file: 'prospects.csv', idempotencyKey: `import-${digest}` }); // one key per file
```

A file is sent again whole: a path is read again, a `Blob` or bytes sent again. A `ReadableStream` is sent as it is
read, so it is not sent again once its sending began.

Two requests are not sent again once they may have arrived: `webhooks.create` and `integrations.create`, whose
answers hold a secret shown once. They are retried only when the connection was never made, or after a `429`; after
an `APIConnectionError`, look at `webhooks.list()` or `integrations.list()` before making another. A `DELETE` whose
answer was lost is sent again; if the retry finds it gone, the first one did it.

```ts
const client = new VerifyInboxes({ maxRetries: 0 }); // never retry
```

## Webhooks

A webhook gets a `POST` when a list finishes (`job.completed`) and when a verdict you bought is overturned
(`address.contradicted`). Check its signature before you read anything in it, against the raw body as it arrived,
never JSON parsed and written again:

```ts
import { SIGNATURE_HEADER, verifySignature } from 'verifyinboxes';

// Express: app.post('/webhooks/verifyinboxes', express.raw({ type: 'application/json' }), handler)
async function handler(req, res) {
  const valid = await verifySignature(req.body, req.get(SIGNATURE_HEADER), secret);
  if (!valid) return res.sendStatus(400); // not from VerifyInboxes, changed on the way, or older than 5 minutes
  const event = JSON.parse(req.body.toString('utf8'));
  // ...
  res.sendStatus(204);
}
```

`rawBody` is a string, a `Uint8Array` (a Node `Buffer` too) or an `ArrayBuffer`; `secret` is the 64 characters
`webhooks.create` returned. A signature more than `toleranceSeconds` (default 300) from your clock is refused, so an
old delivery cannot be sent again; `nowSeconds` sets the clock. It never throws: anything it cannot read is `false`.
A missing header (`undefined` or `null`, as `Headers.get` gives it) is `false` too. It needs no client and no key, and
`client.webhooks.verifySignature` is the same function. Deliveries come at least once: `X-Boxverifier-Delivery` is
the same on every retry of one, to drop duplicates. The two header names are `SIGNATURE_HEADER` and
`DELIVERY_HEADER`.

## Types

Every answer is a plain object, typed after the API's schemas (`Result`, `Job`, `JobCreated`, `ResultRow`,
`ResultsPage`, `Domain`, ...), with the API's field names. Timestamps are ISO 8601 strings. A field this version does
not know is kept as it came, never an error. `WebhookCreated.secret` and `IntegrationCreated.url` are left out of what
`console.log` and `util.inspect` show, and kept when you read them or `JSON.stringify` them.

```ts
import type { Result, ResultRow, Job } from 'verifyinboxes';
```

## Runtimes

Node 18 or later, Bun and Deno: the library needs only `fetch`, `Blob`, `AbortController`, `TextEncoder` and Web
Crypto. Node 18, which has no global Web Crypto, uses `node:crypto`'s. A path to upload or to download to is read
and written through `node:fs`, which Bun and Deno have too. In Deno, give it `--allow-net` (and `--allow-env` to read
the key from the environment, `--allow-read` and `--allow-write` for files).

## Examples

- [`examples/quickstart.ts`](https://github.com/verifyinboxes/verifyinboxes-js/blob/main/examples/quickstart.ts):
  one check, then several with `verifyMany`.
- [`examples/list-from-csv.ts`](https://github.com/verifyinboxes/verifyinboxes-js/blob/main/examples/list-from-csv.ts):
  a list from a CSV: start it, wait, read the results, download them.
- [`examples/webhook-receiver.ts`](https://github.com/verifyinboxes/verifyinboxes-js/blob/main/examples/webhook-receiver.ts):
  a webhook receiver on Node's HTTP server, checking the signature before anything else.

Node 22.18 or later runs them as they are (`node examples/quickstart.ts ann@example.com`), once the package is built.

## Versioning

The library follows [semantic versioning](https://semver.org). It is `0.x` until the API's public launch, when it
becomes `1.0.0`; until then a minor version may change the library's surface, and the changes are listed in its
release notes. The API itself changes without breaking you: it adds fields, values and error codes, which this
library keeps as they are.

## Development

```bash
pnpm install
pnpm typecheck   # the type check, of the package, the tests and the examples
pnpm test        # the tests, against a fake API on 127.0.0.1 (no network)
pnpm build       # dist/: ES modules, CommonJS and their types
pnpm smoke       # the built package, imported and required by its name
pnpm check       # all of the above
```

`tests/conformance/scenarios.json` is shared by every official VerifyInboxes library: what each must send and do on
the wire (retries with the same `Idempotency-Key`, job ids kept on a timeout, request ids on errors, results through
empty pages, the webhook signature cases). `tests/conformance.test.ts` replays it. `tests/smoke.test.ts` runs against
the live API when `VERIFYINBOXES_SMOKE_API_KEY` holds a key (it spends a few credits). Vite, which the tests run on,
is held at version 6 (`pnpm.overrides`) so that they run on Node 18 too.

## Licence

MIT. See [LICENSE](https://github.com/verifyinboxes/verifyinboxes-js/blob/main/LICENSE). To report a security
problem, see [SECURITY.md](https://github.com/verifyinboxes/verifyinboxes-js/blob/main/SECURITY.md).
