/** The client's configuration, cancellation, uploads, downloads and secrets, beyond what the scenarios hold it to. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import VerifyInboxes, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  AuthenticationError,
  MissingAPIKeyError,
  VERSION,
  VerifyInboxes as Named,
  VerifyInboxesError,
  WaitTimeoutError,
} from '../src';
import {
  FakeAPI,
  JOB_ID,
  KEY,
  PaperClock,
  answerWith,
  apiError,
  clientOf,
  dropped,
  exchange,
  resultJSON,
  runningJob,
  singleJobId,
} from './fakeapi';
import type { Exchange, FakeAPIOptions, ScriptedResponse } from './fakeapi';
import { sleep } from '../src/internal';

/**
 * `fs.openAsBlob`, which an upload from a path calls, with a way to hand back a stand-in for one call: the file a
 * runtime opens (Bun's) can lose its bytes when it is put in another Blob.
 */
const opened = vi.hoisted(() => ({ next: undefined as unknown }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const openAsBlob = async (path: string): Promise<unknown> => {
    const stub = opened.next;
    opened.next = undefined;
    if (stub !== undefined) return stub;
    const real = (fs as { openAsBlob?: (path: string) => Promise<Blob> }).openAsBlob;
    return real ? real(path) : new Blob([(await fs.promises.readFile(path)) as Uint8Array<ArrayBuffer>]);
  };
  return { ...fs, default: { ...fs, openAsBlob }, openAsBlob };
});

const CSV = 'email\nann@example.com\nbob@example.com\n';
const CREATED = { id: JOB_ID, status: 'running', total: 2 };
const SECRET = '6f1d0c9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e';
const ACCOUNT = { name: 'acme', balance: 10, reviewed: false, test_emails: false, safe_to_send_threshold: 0.8 };
const EMAILS = Array.from({ length: 10 }, (_, i) => `p${i + 1}@example.com`);

const cleanups: (() => Promise<void>)[] = [];

async function serve(exchanges: Exchange[], options: FakeAPIOptions = {}): Promise<FakeAPI> {
  const api = await FakeAPI.start(exchanges, options);
  cleanups.push(() => api.close());
  return api;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'verifyinboxes-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('it did not throw');
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('the client', () => {
  it('is the default export and a named one', () => {
    expect(VerifyInboxes).toBe(Named);
  });

  it('refuses to run in a browser page unless told to', () => {
    vi.stubGlobal('window', { document: {} });
    vi.stubGlobal('document', {});
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0' });
    expect(() => new VerifyInboxes({ apiKey: KEY })).toThrow(VerifyInboxesError);
    expect(() => new VerifyInboxes({ apiKey: KEY })).toThrow(/dangerouslyAllowBrowser/);
    expect(new VerifyInboxes({ apiKey: KEY, dangerouslyAllowBrowser: true })).toBeInstanceOf(VerifyInboxes);
  });

  it('reads the key from the environment, and names the variable when there is none', async () => {
    const fromEnv = await serve([exchange('GET', '/v1/account', answerWith(200, ACCOUNT))]);
    vi.stubEnv('VERIFYINBOXES_API_KEY', `  ${KEY}\n`);
    vi.stubEnv('VERIFYINBOXES_BASE_URL', `${fromEnv.url}/`);
    const client = new VerifyInboxes();
    expect(client.baseURL).toBe(fromEnv.url);
    expect((await client.account.get()).balance).toBe(10);
    const sent = fromEnv.requests[0]!.headers;
    expect(sent['authorization']).toBe(`Bearer ${KEY}`);
    expect(sent['accept']).toBe('application/json');
    expect(sent['user-agent']).toBe(`verifyinboxes-js/${VERSION}`);

    // A personal access token goes the same way; what is given beats the environment.
    const token = 'vi_at_testtesttesttesttesttesttesttesttesttest';
    const given = await serve([exchange('GET', '/v1/account', answerWith(200, ACCOUNT))]);
    await new VerifyInboxes({ apiKey: token, baseURL: given.url }).account.get();
    expect(given.requests[0]!.headers['authorization']).toBe(`Bearer ${token}`);
    expect(fromEnv.requests).toHaveLength(1);

    vi.stubEnv('VERIFYINBOXES_BASE_URL', '');
    expect(new VerifyInboxes().baseURL).toBe('https://api.verifyinboxes.com');

    vi.stubEnv('VERIFYINBOXES_API_KEY', '');
    for (const make of [() => new VerifyInboxes(), () => new VerifyInboxes({ apiKey: '   ' })]) {
      const error = (() => {
        try {
          make();
        } catch (e) {
          return e as Error;
        }
        throw new Error('no error');
      })();
      expect(error).toBeInstanceOf(MissingAPIKeyError);
      expect(error).toBeInstanceOf(VerifyInboxesError);
      expect(error.message).toMatch(/VERIFYINBOXES_API_KEY/);
      expect(error.message).toMatch(/admin/);
      expect(error.message).toMatch(/Developers/);
      expect(error.message).toMatch(/API keys/);
    }
  });

  it('refuses a key with a space, a control character or a character that is not ASCII, without echoing it', () => {
    for (const bad of [`${KEY}\nX-Other: 1`, 'bv_test test', `${KEY}\u0000`, 'bv_\ttest', `${KEY}​`, ` ${KEY}x y`, 'bv_tést']) {
      expect(() => new VerifyInboxes({ apiKey: bad })).toThrow(TypeError);
      expect(() => new VerifyInboxes({ apiKey: bad })).toThrow(/copy it again/);
      try {
        new VerifyInboxes({ apiKey: bad });
      } catch (error) {
        expect(String(error)).not.toContain('bv_');
      }
    }
  });

  it('puts your product in front of its own User-Agent, and refuses one that is not visible ASCII', async () => {
    const api = await serve([exchange('GET', '/v1/account', answerWith(200, ACCOUNT)), exchange('GET', '/v1/account', answerWith(200, ACCOUNT))]);
    await clientOf(api, undefined, { userAgent: 'my-app/1.2' }).account.get();
    await clientOf(api, undefined, { userAgent: '' }).account.get();
    expect(api.requests.map((r) => r.headers['user-agent'])).toEqual([`my-app/1.2 verifyinboxes-js/${VERSION}`, `verifyinboxes-js/${VERSION}`]);
    for (const bad of ['my app/1.2', 'app/1\r\nX-Other: 1', 'appé/1', 'app/1\u0000', 7]) {
      expect(() => new VerifyInboxes({ apiKey: KEY, userAgent: bad as string })).toThrow(TypeError);
      expect(() => new VerifyInboxes({ apiKey: KEY, userAgent: bad as string })).toThrow(/my-app\/1\.2/);
    }
  });

  it('takes http and https base URLs only, dropping one trailing slash', () => {
    for (const bad of ['ftp://api.example.com', 'api.example.com', 'file:///etc/passwd']) {
      expect(() => new VerifyInboxes({ apiKey: KEY, baseURL: bad })).toThrow(TypeError);
    }
    expect(new VerifyInboxes({ apiKey: KEY, baseURL: 'http://127.0.0.1:8080/' }).baseURL).toBe('http://127.0.0.1:8080');
  });

  it('refuses a maxRetries or a timeout that makes no sense', () => {
    expect(() => new VerifyInboxes({ apiKey: KEY, maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => new VerifyInboxes({ apiKey: KEY, maxRetries: 1.5 })).toThrow(/maxRetries/);
    expect(() => new VerifyInboxes({ apiKey: KEY, timeout: 0 })).toThrow(/timeout/);
    const client = new VerifyInboxes({ apiKey: KEY });
    expect([client.timeout, client.maxRetries]).toEqual([60_000, 2]);
  });

  it('hides the key and the secrets shown once from util.inspect, and keeps the secrets in JSON', async () => {
    const client = new VerifyInboxes({ apiKey: KEY });
    expect(inspect(client, { depth: 5, showHidden: true })).not.toContain(KEY);
    expect(inspect(client)).not.toContain(KEY.slice(0, 7));
    expect(JSON.stringify(client)).not.toContain('bv_');

    const hook = 'https://api.verifyinboxes.com/hooks/instantly/whk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const api = await serve([
      exchange('POST', '/v1/webhooks', answerWith(201, {
        id: '019a4f10-2b3c-7d4e-8f5a-6b7c8d9e0f12', url: 'https://example.com/hook', events: ['job.completed'],
        secret: SECRET, created_at: '2026-11-18T10:00:00Z',
      })),
      exchange('POST', '/v1/integrations', answerWith(201, {
        id: '019a4f22-7c1d-7e2f-9a3b-4c5d6e7f8a90', provider: 'instantly', label: null, url: hook,
        created_at: '2026-11-18T10:00:00Z',
      })),
    ]);
    const c = clientOf(api);
    const created = await c.webhooks.create('https://example.com/hook', { events: ['job.completed'] });
    expect(inspect(created)).not.toContain(SECRET);
    expect(inspect([created], { depth: 3 })).not.toContain(SECRET);
    expect(created.secret).toBe(SECRET);
    expect(JSON.parse(JSON.stringify(created)).secret).toBe(SECRET);

    const integration = await c.integrations.create('instantly');
    expect(inspect(integration)).not.toContain('whk_');
    expect(integration.url).toBe(hook);
    expect(JSON.parse(JSON.stringify(integration)).url).toBe(hook);
  });

  it('never puts the key in an error', async () => {
    const refused = answerWith(401, apiError('unauthorized', 'missing, malformed or revoked API key'), {
      requestId: '019a7e00-0000-7000-8000-0000000000bb',
    });
    const api = await serve([exchange('GET', '/v1/account', refused)]);
    const error = await caught(clientOf(api).account.get());
    expect(error).toBeInstanceOf(AuthenticationError);
    const shown = `${String(error)} ${(error as Error).stack} ${inspect(error, { depth: 10, showHidden: true })}`;
    expect(shown).toContain('019a7e00-0000-7000-8000-0000000000bb');
    expect(shown).not.toContain('bv_');
  });

  it('keeps unknown fields and enum values', async () => {
    const api = await serve([
      exchange('POST', '/v1/verify', answerWith(200, {
        ...resultJSON('ann@example.com', 'spam_trap', { reason: 'new_reason', flags: ['new_flag'] }),
        job_id: JOB_ID,
        something_new: { nested: 1 },
      })),
    ]);
    const result = await clientOf(api).verify('ann@example.com');
    expect(result.verdict).toBe('spam_trap');
    expect(result.reason).toBe('new_reason');
    expect(result.flags).toEqual(['new_flag']);
    expect(result.job_id).toBe(JOB_ID);
    expect((result as unknown as Record<string, unknown>)['something_new']).toEqual({ nested: 1 });
  });

  it('names the request of a success answer that is not JSON', async () => {
    const api = await serve([
      exchange('GET', '/v1/account', answerWith(200, undefined, { text: '<html>', headers: { 'content-type': 'text/html' } })),
    ]);
    const error = await caught(clientOf(api).account.get());
    expect(error).toBeInstanceOf(VerifyInboxesError);
    expect(String(error)).toContain(`(request id ${'019a7e00-0000-7000-8000-0000000000aa'})`);
  });
});

/** A `_sleep` that aborts `controller` when a pause of `ms` begins, then waits as the client's own does. */
function abortingAt(ms: number, controller: AbortController): (pause: number, signal?: AbortSignal) => Promise<void> {
  return (pause, signal) => {
    if (pause === ms) controller.abort();
    return sleep(pause === ms ? 60_000 : pause, signal);
  };
}

/** Waits until `ok()` holds (at most 5 seconds). */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(ok()).toBe(true);
}

/** Whether `promise` has settled, after the turns already queued. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true), () => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return done;
}

describe('cancellation', () => {
  it("aborts with the caller's signal", async () => {
    // Before anything is sent.
    const api = await serve([]);
    const done = new AbortController();
    done.abort();
    expect(await caught(clientOf(api).account.get({ signal: done.signal }))).toBeInstanceOf(APIUserAbortError);
    expect(api.requests).toHaveLength(0);

    // While a request is on its way: not sent again.
    let calls = 0;
    const hanging = (_url: string, init?: RequestInit): Promise<Response> => {
      calls++;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });
    };
    const client = new VerifyInboxes({ apiKey: KEY, baseURL: 'http://127.0.0.1:9', fetch: hanging });
    const controller = new AbortController();
    const pending = caught(client.account.get({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const error = await pending;
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect(error).toBeInstanceOf(VerifyInboxesError);
    expect(calls).toBe(1);
  });

  it('names the check it was waiting for when aborted', async () => {
    const api = await serve([
      exchange('POST', '/v1/verify', answerWith(202, { status: 'pending', job_id: JOB_ID })),
      exchange('GET', `/v1/jobs/${JOB_ID}`, answerWith(200, runningJob(JOB_ID))),
    ]);
    const controller = new AbortController();
    const client = clientOf(api);
    client._sleep = abortingAt(2000, controller); // during the first 2-second pause
    const error = await caught(client.verify('ann@example.com', { signal: controller.signal }));
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect((error as APIUserAbortError).jobIds).toEqual([JOB_ID]);

    const again = await serve([exchange('GET', `/v1/jobs/${JOB_ID}`, answerWith(200, runningJob(JOB_ID)))]);
    const second = new AbortController();
    const waiting = clientOf(again);
    waiting._sleep = abortingAt(2000, second);
    const stopped = await caught(waiting.checks.wait(JOB_ID, { signal: second.signal }));
    expect(stopped).toBeInstanceOf(APIUserAbortError);
    expect((stopped as APIUserAbortError).jobIds).toEqual([JOB_ID]);
  });

  it('lets a check already sent finish when aborted, and names it', async () => {
    const api = await serve([exchange('POST', '/v1/verify', answerWith(202, { status: 'pending', job_id: JOB_ID }))], {
      gated: true,
    });
    const controller = new AbortController();
    const pending = caught(clientOf(api).verify('ann@example.com', { signal: controller.signal }));
    await until(() => api.requests.length === 1);
    controller.abort();
    expect(await settled(pending), 'the check sent is not cut off').toBe(false);
    api.release();
    const error = await pending;
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect((error as APIUserAbortError).jobIds).toEqual([JOB_ID]);
    expect(api.requests, 'nothing after the abort').toHaveLength(1);
  });

  it('lets the checks verifyMany already sent finish when aborted, and names every one', async () => {
    // Even checks answer at once (200), odd ones are still running (202): either way the server made a job.
    const exchanges = EMAILS.map((email, i) =>
      exchange(
        'POST',
        '/v1/verify',
        i % 2 === 0
          ? answerWith(200, { ...resultJSON(email), job_id: singleJobId(i + 1) })
          : answerWith(202, { status: 'pending', job_id: singleJobId(i + 1) }),
        { json: { email } },
      ));
    const api = await serve(exchanges, { unordered: true, gated: true });
    const client = clientOf(api);
    let starts = 0;
    client._sleep = (ms, signal) => sleep(ms === 100 && ++starts < 4 ? 0 : 60_000, signal); // 4 start, the 5th waits
    const controller = new AbortController();
    const pending = caught(client.verifyMany(EMAILS, { signal: controller.signal }));
    await until(() => api.requests.length === 4);
    controller.abort();
    expect(await settled(pending), 'the checks sent are not cut off').toBe(false);
    api.release();
    const error = await pending;
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect((error as APIUserAbortError).jobIds).toEqual([1, 2, 3, 4].map(singleJobId));
    expect(api.requests, 'no check started and no poll after the abort').toHaveLength(4);
  });

  it('lets the list verifyMany already sent finish when aborted, and names it', async () => {
    const emails = Array.from({ length: 11 }, (_, i) => `p${i + 1}@example.com`);
    const api = await serve(
      [exchange('POST', '/v1/jobs', answerWith(201, { id: JOB_ID, status: 'running', total: 11 }), { json: { emails } })],
      { gated: true },
    );
    const controller = new AbortController();
    const pending = caught(clientOf(api).verifyMany(emails, { signal: controller.signal }));
    await until(() => api.requests.length === 1);
    controller.abort();
    expect(await settled(pending)).toBe(false);
    api.release();
    const error = await pending;
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect((error as APIUserAbortError).jobIds).toEqual([JOB_ID]);
    expect(api.requests).toHaveLength(1);
  });

  it('names every check verifyMany made when aborted', async () => {
    const pendingChecks = EMAILS.map((email, i) =>
      exchange('POST', '/v1/verify', answerWith(202, { status: 'pending', job_id: singleJobId(i + 1) }), { json: { email } }));
    const api = await serve(pendingChecks, { unordered: true });
    const client = clientOf(api);
    const controller = new AbortController();
    let starts = 0;
    let polls = 0;
    client._sleep = (ms, signal) => {
      // The first two starts pass; the third waits. Once the three checks started have their answers (each then
      // pauses before its first poll), the caller aborts.
      if (ms === 2000 && ++polls === 3) controller.abort();
      return sleep(ms === 100 && ++starts < 3 ? 0 : 60_000, signal);
    };
    const error = await caught(client.verifyMany(EMAILS, { signal: controller.signal }));
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect((error as APIUserAbortError).jobIds).toEqual([1, 2, 3].map(singleJobId));
  });

  it('names the list verifyMany made when aborted', async () => {
    const emails = Array.from({ length: 11 }, (_, i) => `p${i + 1}@example.com`);
    const api = await serve([
      exchange('POST', '/v1/jobs', answerWith(201, { id: JOB_ID, status: 'running', total: 11 }), { json: { emails } }),
      exchange('GET', `/v1/jobs/${JOB_ID}`, answerWith(200, runningJob(JOB_ID, 'bulk'))),
    ]);
    const controller = new AbortController();
    const client = clientOf(api);
    client._sleep = abortingAt(2000, controller); // while waiting for the list
    const error = await caught(client.verifyMany(emails, { signal: controller.signal }));
    expect(error).toBeInstanceOf(APIUserAbortError);
    expect((error as APIUserAbortError).jobIds).toEqual([JOB_ID]);
  });
});

describe('verifyMany', () => {
  it('sends up to ten checks together, started 100 ms apart', async () => {
    const singles = EMAILS.map((email, i) =>
      exchange('POST', '/v1/verify', answerWith(200, { ...resultJSON(email), job_id: singleJobId(i + 1) }), {
        json: { email },
        idempotency_key: 'new',
      }));
    const api = await serve(singles, { unordered: true, holdUntil: 10 });
    const clock = new PaperClock();
    const results = await clientOf(api, clock).verifyMany(EMAILS);
    expect(api.heldOut, `only ${api.maxInFlight} checks were in flight at once`).toBe(false);
    expect(results.map((r) => r.email)).toEqual(EMAILS);
    expect(results.map((r) => r.job_id)).toEqual(EMAILS.map((_, i) => singleJobId(i + 1)));
    expect(clock.slept).toEqual(Array(9).fill(100));
  });

  it('names every job it made when one of them fails', async () => {
    // p3 is still running when the time runs out, p7 is refused (402), the others answer at once.
    const exchanges = EMAILS.map((email, i) => {
      const n = i + 1;
      if (n === 3) return exchange('POST', '/v1/verify', answerWith(202, { status: 'pending', job_id: singleJobId(3) }), { json: { email } });
      if (n === 7) return exchange('POST', '/v1/verify', answerWith(402, apiError('insufficient_credits')), { json: { email } });
      return exchange('POST', '/v1/verify', answerWith(200, { ...resultJSON(email), job_id: singleJobId(n) }), { json: { email } });
    });
    for (let i = 0; i < 20; i++) exchanges.push(exchange('GET', `/v1/jobs/${singleJobId(3)}`, answerWith(200, runningJob(singleJobId(3)))));
    const api = await serve(exchanges, { unordered: true });
    const error = await caught(clientOf(api, new PaperClock()).verifyMany(EMAILS, { timeout: 5_000 }));
    // The first error in input order (p3's wait), naming every job the call made, in input order.
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect((error as WaitTimeoutError).jobIds).toEqual(EMAILS.map((_, i) => i + 1).filter((n) => n !== 7).map(singleJobId));
  });

  it('refuses an empty list or one that is not addresses, before any request', async () => {
    const api = await serve([]);
    const client = clientOf(api);
    for (const bad of [[], ['ann@example.com', ''], ['ann@example.com', null], ['ann@example.com', 7], 'ann@example.com']) {
      expect(await caught(client.verifyMany(bad as string[]))).toBeInstanceOf(TypeError);
    }
    expect(api.requests).toHaveLength(0);
  });
});

describe('results', () => {
  const path = `/v1/jobs/${JOB_ID}/results`;
  const page = (emails: string[], start: number, next: string | null) => ({
    data: emails.map((email, i) => ({ ...resultJSON(email), row: start + i })),
    next_cursor: next,
    complete: true,
  });

  it('reads nothing until iterated, then every row once', async () => {
    const api = await serve([
      exchange('GET', path, answerWith(200, page(['a@example.com', 'b@example.com'], 1, 'c1')), { query: { limit: '2' } }),
      exchange('GET', path, answerWith(200, page([], 3, 'c2')), { query: { limit: '2', cursor: 'c1' } }),
      exchange('GET', path, answerWith(200, page(['c@example.com'], 3, null)), { query: { limit: '2', cursor: 'c2' } }),
    ]);
    const rows = clientOf(api).lists.results(JOB_ID, { pageSize: 2 });
    expect(api.requests).toHaveLength(0);
    const seen: [number, string][] = [];
    for await (const row of rows) seen.push([row.row, row.email]);
    expect(seen).toEqual([[1, 'a@example.com'], [2, 'b@example.com'], [3, 'c@example.com']]);
  });

  it('stops when a page with rows repeats the cursor', async () => {
    const repeated = page(['a@example.com'], 1, 'c1');
    const api = await serve([
      exchange('GET', path, answerWith(200, repeated), { query: { limit: '500' } }),
      exchange('GET', path, answerWith(200, repeated), { query: { limit: '500', cursor: 'c1' } }),
    ]);
    const seen: string[] = [];
    const error = await caught((async () => {
      for await (const row of clientOf(api).lists.results(JOB_ID)) seen.push(row.email);
    })());
    expect((error as Error).constructor).toBe(VerifyInboxesError);
    expect(String(error)).toMatch(/same cursor/);
    expect(seen).toEqual(['a@example.com', 'a@example.com']);
    expect(api.requests).toHaveLength(2);
  });
});

describe('uploads', () => {
  function uploads(first: ScriptedResponse, filename = 'list.csv'): Exchange[] {
    const multipart = [
      { name: 'email_column', value: 'email' },
      { name: 'file', filename, content_type: 'text/csv', value: CSV },
    ];
    return [
      exchange('POST', '/v1/jobs', first, { multipart, idempotency_key: 'new' }),
      exchange('POST', '/v1/jobs', answerWith(201, CREATED), { multipart, idempotency_key: 'same' }),
    ];
  }

  function sentFiles(api: FakeAPI): string[] {
    return api.requests.map((r) => r.multipart?.[1]?.value ?? '');
  }

  function oneWay(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 10));
        controller.enqueue(bytes.subarray(10));
        controller.close();
      },
    });
  }

  it('uploads a file given by path, a Blob and a stream, retrying only what it can send again', async () => {
    // A path: opened again for the retry, and named by its file name.
    const dir = await tempDir();
    const file = join(dir, 'prospects.csv');
    await writeFile(file, CSV);
    let api = await serve(uploads(dropped, 'prospects.csv'));
    let clock = new PaperClock();
    expect((await clientOf(api, clock).lists.create({ file })).id).toBe(JOB_ID);
    expect(sentFiles(api)).toEqual([CSV, CSV]);
    expect(api.requests[0]!.headers['idempotency-key']).toBe(api.requests[1]!.headers['idempotency-key']);

    // A Blob, and bytes: sent again whole.
    for (const source of [new Blob([CSV]), new TextEncoder().encode(CSV)]) {
      api = await serve(uploads(answerWith(503, apiError('unavailable'), { headers: { 'retry-after': '1' } })));
      clock = new PaperClock();
      expect((await clientOf(api, clock).lists.create({ file: source })).id).toBe(JOB_ID);
      expect(sentFiles(api)).toEqual([CSV, CSV]);
      expect(clock.slept).toEqual([1000]);
    }

    // A stream: sent as it is read, so never again once its sending began.
    api = await serve(uploads(dropped));
    clock = new PaperClock();
    const error = await caught(clientOf(api, clock).lists.create({ file: oneWay(CSV) }));
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(sentFiles(api)).toEqual([CSV]);
    expect(clock.slept).toEqual([]);
  });

  it('sends the whole file when putting it in the body loses some of its bytes', async () => {
    const dir = await tempDir();
    const file = join(dir, 'prospects.csv');
    await writeFile(file, CSV);
    const bytes = new TextEncoder().encode(CSV);
    // A Blob-like whose size is the file's, but which yields far fewer bytes when another Blob is made of it.
    const shortBlob = { size: bytes.byteLength, type: '', arrayBuffer: async () => bytes.slice().buffer };
    expect(new Blob([shortBlob as unknown as Blob]).size).toBeLessThan(bytes.byteLength);
    opened.next = shortBlob;
    const multipart = [
      { name: 'email_column', value: 'email' },
      { name: 'file', filename: 'prospects.csv', content_type: 'text/csv', value: CSV },
    ];
    const api = await serve([exchange('POST', '/v1/jobs', answerWith(201, CREATED), { multipart, idempotency_key: 'new' })]);
    expect((await clientOf(api).lists.create({ file })).id).toBe(JOB_ID);
    expect(opened.next, 'the stand-in was used').toBeUndefined();
    expect(api.requests[0]!.multipart).toEqual(multipart);
    expect(api.requests[0]!.headers['content-length']).toBe(String(api.requests[0]!.body.length));
  });

  it('says how to pass a Node.js stream, which it does not take as it is', async () => {
    const api = await serve([]);
    const { Readable } = await import('node:stream');
    const error = await caught(clientOf(api).lists.create({ file: Readable.from([CSV]) as unknown as ReadableStream<Uint8Array> }));
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toMatch(/web ReadableStream/);
    expect(String(error)).toMatch(/Readable\.toWeb\(stream\)/);
    expect(api.requests).toHaveLength(0);
  });

  it('takes exactly one of emails, file or csv', async () => {
    const api = await serve([]);
    const client = clientOf(api);
    expect(await caught(client.lists.create({}))).toBeInstanceOf(TypeError);
    expect(await caught(client.lists.create({ emails: ['a@example.com'], csv: CSV }))).toBeInstanceOf(TypeError);
    expect(api.requests).toHaveLength(0);
  });
});

describe('downloads', () => {
  const path = `/v1/jobs/${JOB_ID}/download`;
  const BODY = 'email,verdict\n' + 'ann@example.com,invalid\n'.repeat(50);
  const csv = { headers: { 'content-type': 'text/csv; charset=utf-8' }, text: BODY };

  it('writes a download to a file only when all of it arrived', async () => {
    const dir = await tempDir();
    const target = join(dir, 'results.csv');
    await writeFile(target, 'the results from before\n');

    let api = await serve([exchange('GET', path, answerWith(200, undefined, { ...csv, cut_after: 100 }), { headers: { accept: 'text/csv' } })]);
    expect(await caught(clientOf(api, new PaperClock(), { maxRetries: 0 }).lists.downloadToFile(JOB_ID, target))).toBeInstanceOf(APIConnectionError);
    expect(await readFile(target, 'utf8')).toBe('the results from before\n');
    expect(await readdir(dir)).toEqual(['results.csv']);

    api = await serve([
      exchange('GET', path, answerWith(200, undefined, { ...csv, cut_after: 100 })),
      exchange('GET', path, answerWith(200, undefined, csv)),
    ]);
    expect(await clientOf(api, new PaperClock()).lists.downloadToFile(JOB_ID, target)).toBe(Buffer.byteLength(BODY));
    expect(await readFile(target, 'utf8')).toBe(BODY);
    expect(await readdir(dir)).toEqual(['results.csv']);
  });

  it('hands a download over as a stream once its answer has come', async () => {
    const api = await serve([
      exchange('GET', path, dropped),
      exchange('GET', path, answerWith(200, undefined, csv), { query: { only: 'safe_to_send' }, headers: { accept: 'text/csv' } }),
    ]);
    const stream = await clientOf(api, new PaperClock()).lists.download(JOB_ID, { onlySafeToSend: true });
    expect(await new Response(stream).text()).toBe(BODY);
    expect(api.requests).toHaveLength(2);
  });
});

describe('retries', () => {
  /** A fetch that fails as Node's does when the connection was refused, or was closed with no answer. */
  function failing(code: string): Error {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(`${code} on the way`), { code }) });
  }

  function scripted(...outcomes: (Error | Response)[]) {
    const calls: RequestInit[] = [];
    const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      calls.push(init ?? {});
      const next = outcomes.shift();
      if (next === undefined) throw new Error('more requests than scripted');
      if (next instanceof Error) throw next;
      return next;
    };
    return { calls, fetch };
  }

  const created = () =>
    new Response(JSON.stringify({ id: '019a4f10-2b3c-7d4e-8f5a-6b7c8d9e0f12', url: 'https://example.com/hook', events: [], secret: SECRET, created_at: '2026-11-18T10:00:00Z' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });

  it('sends a webhook again only when its connection was never made', async () => {
    let script = scripted(failing('ECONNREFUSED'), created());
    let client = new VerifyInboxes({ apiKey: KEY, fetch: script.fetch });
    client._sleep = new PaperClock().sleep;
    expect((await client.webhooks.create('https://example.com/hook')).secret).toBe(SECRET);
    expect(script.calls).toHaveLength(2);
    const keys = script.calls.map((init) => (init.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);

    script = scripted(failing('UND_ERR_SOCKET'), created());
    client = new VerifyInboxes({ apiKey: KEY, fetch: script.fetch });
    client._sleep = new PaperClock().sleep;
    expect(await caught(client.webhooks.create('https://example.com/hook'))).toBeInstanceOf(APIConnectionError);
    expect(script.calls).toHaveLength(1);
  });

  it('gives each attempt its timeout, and says so when every attempt ran out', async () => {
    let calls = 0;
    const hanging = (_url: string, init?: RequestInit): Promise<Response> => {
      calls++;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });
    };
    const clock = new PaperClock();
    const client = new VerifyInboxes({ apiKey: KEY, fetch: hanging, timeout: 20 });
    client._sleep = clock.sleep;
    const error = await caught(client.account.get());
    expect(error).toBeInstanceOf(APIConnectionTimeoutError);
    expect(error).toBeInstanceOf(APIConnectionError);
    expect(calls).toBe(3);
    expect(clock.slept).toHaveLength(2);
  });
});
