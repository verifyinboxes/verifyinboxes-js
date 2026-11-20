/**
 * The conformance scenarios: what every official VerifyInboxes SDK must send and do, replayed here against a fake API.
 *
 * `tests/conformance/scenarios.json` is shared, byte for byte, by the Python, JavaScript, Go and Java SDKs. Each
 * scenario names a call (`call.op` and its `args`, by the Python library's names, mapped below to this library's),
 * the exchanges the server expects and answers (`exchanges`, in order unless `unordered`), the seconds the client
 * must sleep (`sleeps`; absent: not checked) and the outcome: `returns` (compared as a subset, all the way down: an
 * object's keys must be there with those values, an array has exactly those elements) or `raises` (the error's kind,
 * and its status, code, request id, `retry_after` and `job_ids` when given). A request is checked for its method,
 * path (as escaped on the wire), query, body (`json`, compared so that `true`, `1` and `1.0` differ, or the ordered
 * `multipart` parts), the `headers` named, its `Idempotency-Key` (`"new"`: present and unseen, `"same"`: the one of
 * the exchange listed just before it, `{"equals": …}`, absent: none) and, always, the bearer credential and the
 * `User-Agent`. An answer can be dropped (`"drop": true`: the connection closes with no answer) or cut short
 * (`"cut_after"`). Each scenario runs on a clock that moves only when the client sleeps.
 *
 * Each signature vector says whether `verifySignature` must accept a webhook signature.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  ConflictError,
  InsufficientCreditsError,
  InvalidRequestError,
  MissingAPIKeyError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  VERSION,
  VerifyInboxesError,
  WaitTimeoutError,
  verifySignature,
} from '../src';
import type { VerifyInboxes } from '../src';
import { FakeAPI, PaperClock, StrictNumber, clientOf, isObject, parseStrict, strictEqual } from './fakeapi';
import type { Exchange, ExpectedRequest } from './fakeapi';

const TEXT = await readFile(new URL('./conformance/scenarios.json', import.meta.url), 'utf8');

interface Scenario {
  name: string;
  about: string;
  client?: { max_retries?: number; api_key?: string };
  call: { op: string; args?: Record<string, unknown> };
  unordered?: boolean;
  exchanges: Exchange[];
  sleeps?: (number | { min: number; max: number })[];
  outcome: { returns?: unknown; raises?: Raises; file?: 'unchanged' };
}

interface Raises {
  kind: string;
  status?: number;
  code?: string | null;
  request_id?: string;
  retry_after?: number;
  job_ids?: string[];
  message_has_request_id?: boolean;
}

interface Vector {
  name: string;
  secret: string;
  body: string;
  header: string;
  now: number;
  tolerance: number;
  valid: boolean;
}

/** The file as `JSON.parse` reads it: what the calls and the fake server use. */
const DATA = JSON.parse(TEXT) as { api_key: string; scenarios: Scenario[]; signatures: Vector[] };
/** The file read so that `1` and `1.0` differ: what a request's body is compared with. */
const STRICT = parseStrict(TEXT) as { scenarios: { exchanges: { request: ExpectedRequest }[]; outcome: { returns?: unknown } }[] };

/** The error kinds of the scenario file, and the class each one is here (exactly that class, not a subclass). */
const KINDS: Record<string, new (...args: never[]) => Error> = {
  invalid_request: InvalidRequestError,
  authentication: AuthenticationError,
  insufficient_credits: InsufficientCreditsError,
  permission: PermissionDeniedError,
  not_found: NotFoundError,
  conflict: ConflictError,
  rate_limit: RateLimitError,
  server: ServerError,
  api: APIError,
  connection: APIConnectionError,
  timeout: APIConnectionTimeoutError,
  wait_timeout: WaitTimeoutError,
  missing_api_key: MissingAPIKeyError,
  sdk: VerifyInboxesError,
};

const VISIBLE_ASCII = /^[!-~]{1,255}$/;

// --- running a call ------------------------------------------------------------------------------------------------

/** A duration of the scenario file (seconds) as this library takes it (milliseconds). */
function ms(seconds: unknown): number | undefined {
  return typeof seconds === 'number' ? seconds * 1000 : undefined;
}

/** Calls `op` with the scenario's arguments, under this library's names; answers what the wire would name. */
async function run(client: VerifyInboxes, op: string, args: Record<string, unknown>, dir: string): Promise<unknown> {
  const a = args as Record<string, any>;
  switch (op) {
    case 'account.get':
      return client.account.get();
    case 'verify':
      return client.verify(a.email, {
        forceRecheck: a.force_recheck,
        wait: a.wait ?? true,
        timeout: ms(a.timeout),
        idempotencyKey: a.idempotency_key,
      });
    case 'checks.get':
      return client.checks.get(a.job_id);
    case 'checks.wait':
      return client.checks.wait(a.job_id, { timeout: ms(a.timeout) });
    case 'verify_many':
      return client.verifyMany(a.emails, { timeout: ms(a.timeout) });
    case 'lists.create':
      return client.lists.create({
        emails: a.emails,
        csv: a.csv,
        emailColumn: a.email_column,
        filename: a.filename,
        idempotencyKey: a.idempotency_key,
      });
    case 'lists.get':
      return client.lists.get(a.id);
    case 'lists.wait':
      return client.lists.wait(a.id, { timeout: ms(a.timeout) });
    case 'lists.results': {
      const rows = await client.lists
        .results(a.id, { pageSize: a.page_size, onlySafeToSend: a.only_safe_to_send, verdicts: a.verdicts, partial: a.partial })
        .toArray();
      return { rows: rows.map((row) => row.email) };
    }
    case 'lists.download': {
      const path = join(dir, 'results.csv');
      await writeFile(path, a.before);
      await client.lists.downloadToFile(a.id, path, {
        onlySafeToSend: a.only_safe_to_send,
        verdicts: a.verdicts,
        partial: a.partial,
      });
      return { file: await readFile(path, 'utf8') };
    }
    case 'lists.resolve':
      return client.lists.resolve(a.id, { emails: a.emails, idempotencyKey: a.idempotency_key });
    case 'domains.get':
      return client.domains.get(a.domain);
    case 'suppressions.list':
      return client.suppressions.list();
    case 'suppressions.add':
      return client.suppressions.add({ emails: a.emails, domains: a.domains });
    case 'suppressions.remove':
      return client.suppressions.remove({ emails: a.emails, domains: a.domains });
    case 'webhooks.create':
      return client.webhooks.create(a.url, { events: a.events });
    case 'webhooks.list':
      return client.webhooks.list();
    case 'webhooks.delete':
      return client.webhooks.delete(a.id);
    case 'notices.list':
      return client.notices.list({ after: a.after, limit: a.limit });
    case 'feedback.report':
      return client.feedback.report(a.events, { idempotencyKey: a.idempotency_key });
    case 'integrations.create':
      return client.integrations.create(a.provider, { label: a.label, signingSecret: a.signing_secret });
    case 'integrations.list':
      return client.integrations.list();
    case 'integrations.delete':
      return client.integrations.delete(a.id);
    default:
      throw new Error(`no such op in this runner: ${op}`);
  }
}

// --- checking what happened ----------------------------------------------------------------------------------------

/** `got` (what the call returned) holds `want` (read by `parseStrict`), all the way down. */
function assertSubset(got: unknown, want: unknown, where = 'returns'): void {
  if (want instanceof StrictNumber) {
    expect(typeof got, `${where}: ${String(got)} is not a number`).toBe('number');
    expect(got, where).toBe(want.value);
    if (want.whole) expect(Number.isInteger(got), `${where}: ${String(got)} is not whole`).toBe(true);
  } else if (Array.isArray(want)) {
    expect(Array.isArray(got), `${where}: ${JSON.stringify(got)} is not an array`).toBe(true);
    const list = got as unknown[];
    expect(list.length, `${where}: ${list.length} elements, not ${want.length}`).toBe(want.length);
    want.forEach((item, index) => assertSubset(list[index], item, `${where}[${index}]`));
  } else if (isObject(want)) {
    expect(isObject(got), `${where}: ${JSON.stringify(got)} is not an object`).toBe(true);
    const object = got as Record<string, unknown>;
    for (const [key, value] of Object.entries(want)) {
      expect(Object.prototype.hasOwnProperty.call(object, key), `${where}: no ${key} in ${Object.keys(object).join(', ')}`).toBe(true);
      assertSubset(object[key], value, `${where}.${key}`);
    }
  } else {
    // `null` is a call that returns nothing.
    expect(want === null ? (got ?? null) : got, where).toBe(want);
  }
}

function checkRequests(index: number, scenario: Scenario, api: FakeAPI): void {
  const unexpected = api.unexpected.map((r) => `${r.method} ${r.path}?${r.rawQuery} ${r.body.toString('utf8').slice(0, 200)}`);
  expect(unexpected, 'requests the scenario does not have').toEqual([]);
  const credential = scenario.client?.api_key ?? DATA.api_key;
  const keys: (string | undefined)[] = [];
  STRICT.scenarios[index]!.exchanges.forEach(({ request: want }, i) => {
    const where = `exchange ${i} (${want.method} ${want.path})`;
    const got = api.matched[i];
    expect(got, `${where} was never requested`).toBeDefined();
    if (got === undefined) return;
    expect(got.method, where).toBe(want.method);
    expect(got.path, where).toBe(want.path);
    if (want.query !== undefined) expect(got.query, `${where}: query`).toEqual(want.query);
    else expect(got.rawQuery, `${where}: a query`).toBe('');
    if (want.json !== undefined) {
      expect(strictEqual(got.json, want.json), `${where}: body ${got.body.toString('utf8').slice(0, 500)}`).toBe(true);
    } else if (want.multipart !== undefined) {
      expect(got.multipart, `${where}: parts`).toEqual(want.multipart);
    } else {
      expect(got.body.toString('utf8'), `${where}: a body`).toBe('');
    }
    for (const [name, value] of Object.entries(want.headers ?? {})) expect(got.headers[name], `${where}: ${name}`).toBe(value);
    expect(got.headers['authorization'], `${where}: the credential`).toBe(`Bearer ${credential}`);
    expect(got.headers['user-agent']?.startsWith(`verifyinboxes-js/${VERSION}`), `${where}: the user agent`).toBe(true);
    const key = got.headers['idempotency-key'];
    const rule = want.idempotency_key;
    if (rule === undefined) {
      expect(key, `${where}: an Idempotency-Key`).toBeUndefined();
    } else if (rule === 'new') {
      expect(key !== undefined && VISIBLE_ASCII.test(key), `${where}: Idempotency-Key ${key}`).toBe(true);
      expect(keys.includes(key), `${where}: an Idempotency-Key used earlier`).toBe(false);
    } else if (rule === 'same') {
      expect(i > 0 && key !== undefined && key === keys[i - 1], `${where}: not the same Idempotency-Key`).toBe(true);
    } else {
      expect(key, `${where}: Idempotency-Key`).toBe(rule.equals);
    }
    keys.push(key);
  });
}

function checkSleeps(scenario: Scenario, clock: PaperClock): void {
  if (scenario.sleeps === undefined) return;
  const slept = clock.slept.map((m) => m / 1000);
  expect(slept.length, `slept ${JSON.stringify(slept)}, not ${JSON.stringify(scenario.sleeps)}`).toBe(scenario.sleeps.length);
  scenario.sleeps.forEach((want, i) => {
    if (typeof want === 'number') expect(slept[i]).toBeCloseTo(want, 6);
    else {
      expect(slept[i]).toBeGreaterThanOrEqual(want.min);
      expect(slept[i]).toBeLessThanOrEqual(want.max);
    }
  });
}

function checkRaised(raises: Raises, error: unknown): void {
  const kind = KINDS[raises.kind]!;
  expect(error, `raised ${String(error)}, not ${kind.name}`).toBeInstanceOf(kind);
  expect((error as Error).constructor, `raised ${String(error)}, not exactly ${kind.name}`).toBe(kind);
  const e = error as APIError & WaitTimeoutError;
  if (raises.status !== undefined) expect(e.status).toBe(raises.status);
  if (raises.code !== undefined) expect(e.code).toBe(raises.code);
  if (raises.request_id !== undefined) expect(e.requestId).toBe(raises.request_id);
  if (raises.retry_after !== undefined) expect(e.retryAfter).toBe(raises.retry_after);
  if (raises.job_ids !== undefined) expect(e.jobIds).toEqual(raises.job_ids);
  if (raises.message_has_request_id) expect(String(error).endsWith(`(request id ${raises.request_id})`), String(error)).toBe(true);
}

async function checkFile(scenario: Scenario, dir: string): Promise<void> {
  if (scenario.outcome.file !== 'unchanged') return;
  expect(await readFile(join(dir, 'results.csv'), 'utf8')).toBe(scenario.call.args?.['before']);
  expect(await readdir(dir), 'a part file was left behind').toEqual(['results.csv']);
}

// --- the tests -----------------------------------------------------------------------------------------------------

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('the conformance scenarios', () => {
  it('runs every scenario and vector', () => {
    expect(DATA.scenarios.length).toBeGreaterThanOrEqual(50);
    expect(DATA.signatures.length).toBeGreaterThanOrEqual(20);
    expect(new Set(DATA.scenarios.map((s) => s.name)).size).toBe(DATA.scenarios.length);
  });

  DATA.scenarios.forEach((scenario, index) => {
    it(scenario.name, async () => {
      const api = await FakeAPI.start(scenario.exchanges, { unordered: Boolean(scenario.unordered) });
      const dir = await mkdtemp(join(tmpdir(), 'verifyinboxes-conformance-'));
      cleanups.push(() => api.close(), () => rm(dir, { recursive: true, force: true }));
      const clock = new PaperClock();
      const client = clientOf(api, clock, {
        apiKey: scenario.client?.api_key ?? DATA.api_key,
        ...(scenario.client?.max_retries === undefined ? {} : { maxRetries: scenario.client.max_retries }),
      });
      const { raises, returns } = scenario.outcome;
      if (raises !== undefined) {
        let error: unknown;
        try {
          await run(client, scenario.call.op, scenario.call.args ?? {}, dir);
        } catch (caught) {
          error = caught;
        }
        expect(error, 'it did not throw').toBeDefined();
        checkRaised(raises, error);
        await checkFile(scenario, dir);
      } else {
        const got = await run(client, scenario.call.op, scenario.call.args ?? {}, dir);
        expect(returns).not.toBeUndefined();
        assertSubset(got, STRICT.scenarios[index]!.outcome.returns);
      }
      checkRequests(index, scenario, api);
      checkSleeps(scenario, clock);
    });
  });
});

describe('the signature vectors', () => {
  for (const vector of DATA.signatures) {
    it(vector.name, async () => {
      const options = { toleranceSeconds: vector.tolerance, nowSeconds: vector.now };
      expect(await verifySignature(vector.body, vector.header, vector.secret, options)).toBe(vector.valid);
      const bytes = new TextEncoder().encode(vector.body);
      expect(await verifySignature(bytes, vector.header, vector.secret, options)).toBe(vector.valid);
      expect(await verifySignature(bytes.buffer, vector.header, vector.secret, options)).toBe(vector.valid);
    });
  }
});

describe('the runner', () => {
  it('tells true from 1 and 1 from 1.0', () => {
    const read = (text: string): unknown => parseStrict(text);
    expect(strictEqual(read('{"a":[1,{"b":"x"}],"c":null}'), read('{"a": [1, {"b": "x"}], "c": null}'))).toBe(true);
    for (const [got, want] of [
      ['1', 'true'],
      ['true', '1'],
      ['1', '1.0'],
      ['0', 'false'],
      ['{"a":[1]}', '{"a":[true]}'],
      ['[1.0]', '[1]'],
      ['{"a":1}', '{"a":1,"b":2}'],
      ['"1"', '1'],
    ] as const) {
      expect(strictEqual(read(got), read(want)), `${got} against ${want}`).toBe(false);
    }
    expect(strictEqual(read('1.0'), read('1.00'))).toBe(true);
  });
});
