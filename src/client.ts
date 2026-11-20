import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  VerifyInboxesError,
  errorFromAnswer,
} from './errors';
import {
  CHECK_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  INITIAL_RETRY_DELAY,
  LONG_TIMEOUT,
  MANY_TIMEOUT,
  MAX_RETRY_AFTER,
  MAX_RETRY_DELAY,
  PartFile,
  checkDuration,
  inBrowserPage,
  monotonicNow,
  resolveApiKey,
  resolveBaseURL,
  sleep,
  throwIfAborted,
  timerDelay,
} from './internal';
import type { Upload } from './internal';
import { AccountResource } from './resources/account';
import { Checks } from './resources/checks';
import { Domains } from './resources/domains';
import { Feedback } from './resources/feedback';
import { Integrations } from './resources/integrations';
import { Lists } from './resources/lists';
import { Notices } from './resources/notices';
import { Suppressions } from './resources/suppressions';
import { Webhooks } from './resources/webhooks';
import type { PendingCheck, Result } from './types';
import { VERSION } from './version';

const USER_AGENT = `verifyinboxes-js/${VERSION}`;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** The `fetch` this library calls. Any implementation of the standard will do. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /**
   * An API key (`bv_…`) or a personal access token (`vi_at_…`). Default: the `VERIFYINBOXES_API_KEY` environment
   * variable.
   */
  apiKey?: string | undefined;
  /** Default: the `VERIFYINBOXES_BASE_URL` environment variable, else `https://api.verifyinboxes.com`. */
  baseURL?: string | undefined;
  /** Milliseconds one attempt of one request may take (uploads and downloads: at least 600 000). Default 60 000. */
  timeout?: number | undefined;
  /** How many times a request that failed in a way worth retrying is sent again. Default 2; `0` never. */
  maxRetries?: number | undefined;
  /** The `fetch` to use. Default: the global one. */
  fetch?: Fetch | undefined;
  /**
   * Your product's token, such as `my-app/1.2`, put in front of the library's own in the `User-Agent`:
   * `my-app/1.2 verifyinboxes-js/0.1.0`. Visible ASCII with no space; an empty one adds nothing.
   */
  userAgent?: string | undefined;
  /**
   * The client refuses to run in a web page, where its key would be shown to every visitor. Set this only for a page
   * no stranger opens, with a credential that may be seen.
   */
  dangerouslyAllowBrowser?: boolean | undefined;
}

/** What every method takes in its options. */
export interface RequestOptions {
  /**
   * Aborts the call, and any waiting in it: it throws {@link APIUserAbortError}. A request that starts a check (or
   * `verifyMany`'s list) and was already sent is let finish, so the job it made is named in `jobIds`.
   */
  signal?: AbortSignal | undefined;
}

export interface VerifyOptions extends RequestOptions {
  /** Check again rather than answer from the cache. */
  forceRecheck?: boolean | undefined;
  /** Wait for a check the API is still running (default), or return a {@link PendingCheck} at once. */
  wait?: boolean | undefined;
  /**
   * Milliseconds to wait for the result, from the call; `null` waits as long as it takes. Default 60 000. Past it,
   * {@link WaitTimeoutError} is thrown with the check's job in `jobIds`: the check carries on.
   */
  timeout?: number | null | undefined;
  /** Your own `Idempotency-Key` for the check; default: a new one for the call. */
  idempotencyKey?: string | undefined;
}

export interface VerifyManyOptions extends RequestOptions {
  /** Milliseconds to wait for every result, from the call; `null` waits as long as it takes. Default 600 000. */
  timeout?: number | null | undefined;
}

/** How a request may be sent again after a failed attempt. */
type Retry = 'always' | 'unsent';

/** @internal One request, as the resources describe it to the client's transport. */
export interface Call {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string> | undefined;
  json?: unknown;
  upload?: Upload | undefined;
  idempotencyKey?: string | undefined;
  /**
   * `always`: GET and DELETE, and the POSTs the API answers again from the same `Idempotency-Key`. `unsent`: a POST
   * the API never replays (its answer holds a secret shown once), sent again only when it surely did not arrive (the
   * connection was never made) or was refused before it ran (429).
   */
  retry?: Retry | undefined;
  /** An upload or a download: the longer timeout. */
  long?: boolean | undefined;
  /** A DELETE whose earlier attempt got no answer: a 404 on a retry means the first one did it. */
  goneIsDone?: boolean | undefined;
  accept?: string | undefined;
  signal?: AbortSignal | undefined;
  /**
   * A POST that may make a job (a check, a list): once an attempt is sent, the caller's signal does not cut it off.
   * The attempt finishes (within its timeout), so the job it made is known; the signal stops anything after it.
   */
  finishOnAbort?: boolean | undefined;
}

/** @internal */
export interface Answer {
  status: number;
  requestId: string | null;
  data: unknown;
}

/** An attempt that got no answer, and whether it surely never reached the API. */
class NoAnswer {
  constructor(
    readonly error: APIConnectionError,
    readonly neverSent: boolean,
  ) {}
}

/** The body of an answer stopped coming. */
class BodyCut {
  constructor(readonly cause: unknown) {}
}

/** Errors (in a `cause` chain) that say the connection was never made, so the request never reached the API. */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * The VerifyInboxes API.
 *
 * ```ts
 * import VerifyInboxes from 'verifyinboxes';
 *
 * const client = new VerifyInboxes(); // reads VERIFYINBOXES_API_KEY
 * const result = await client.verify('ann@example.com');
 * console.log(result.verdict, result.safe_to_send);
 * ```
 */
export class VerifyInboxes {
  readonly baseURL: string;
  /** Milliseconds one attempt of one request may take. */
  readonly timeout: number;
  readonly maxRetries: number;

  /** The organisation's name, balance and switches. */
  readonly account: AccountResource;
  /** One check by its job: as it is now, or waited for. */
  readonly checks: Checks;
  /** Lists of addresses: made, waited for, read, downloaded and resolved. */
  readonly lists: Lists;
  /** What is known about a domain. */
  readonly domains: Domains;
  /** Addresses and domains never to check. */
  readonly suppressions: Suppressions;
  /** Where the API sends events, and checking their signatures. */
  readonly webhooks: Webhooks;
  /** Verdicts you bought, overturned since. */
  readonly notices: Notices;
  /** What became of the mail you sent. */
  readonly feedback: Feedback;
  /** Addresses that let Instantly or Smartlead report what became of your mail. */
  readonly integrations: Integrations;

  /** @internal The waits between attempts and polls; replaced by the tests only. */
  _sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleep;
  /** @internal The clock waits are measured on, in milliseconds; replaced by the tests only. */
  _now: () => number = monotonicNow;

  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #userAgent: string;

  constructor(options: ClientOptions = {}) {
    if (inBrowserPage() && !options.dangerouslyAllowBrowser) {
      throw new VerifyInboxesError(
        'This looks like a web page, where an API key is shown to every visitor: call VerifyInboxes from your server. ' +
          'To run it here anyway, with a credential that may be seen, pass dangerouslyAllowBrowser: true.',
      );
    }
    this.#apiKey = resolveApiKey(options.apiKey);
    this.baseURL = resolveBaseURL(options.baseURL);
    this.#userAgent = USER_AGENT;
    const product: unknown = options.userAgent;
    if (product !== undefined && product !== '') {
      if (typeof product !== 'string' || !/^[!-~]+$/.test(product)) {
        throw new TypeError('userAgent must be visible ASCII with no space, such as my-app/1.2');
      }
      this.#userAgent = `${product} ${USER_AGENT}`;
    }
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
    if (typeof this.timeout !== 'number' || !(this.timeout > 0)) {
      throw new TypeError('timeout must be a number of milliseconds above 0');
    }
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new TypeError('maxRetries must be a whole number, 0 or more');
    }
    if (options.fetch !== undefined) {
      if (typeof options.fetch !== 'function') throw new TypeError('fetch must be a function');
      this.#fetch = options.fetch;
    } else if (typeof globalThis.fetch === 'function') {
      this.#fetch = (input, init) => globalThis.fetch(input, init);
    } else {
      throw new VerifyInboxesError('There is no global fetch here: use Node 18 or later, or pass one: new VerifyInboxes({ fetch }).');
    }

    this.account = new AccountResource(this);
    this.checks = new Checks(this);
    this.lists = new Lists(this);
    this.domains = new Domains(this);
    this.suppressions = new Suppressions(this);
    this.webhooks = new Webhooks(this);
    this.notices = new Notices(this);
    this.feedback = new Feedback(this);
    this.integrations = new Integrations(this);
  }

  // --- checks ------------------------------------------------------------------------------------------------------

  /**
   * Check one address and return its result (`job_id` names the check's job).
   *
   * The API answers within about 5 seconds, or says the check is still running: then it is asked every 2 seconds
   * until done. After `timeout` milliseconds (default 60 000; `null`: no limit) {@link WaitTimeoutError} is thrown
   * with the job's id in `jobIds`: the check carries on, and `client.checks.wait(jobId)` picks it up. `wait: false`
   * returns a {@link PendingCheck} instead of waiting. `forceRecheck` skips the cache.
   *
   * For many addresses use {@link VerifyInboxes.verifyMany} or a list, never a loop of `verify`.
   */
  verify(email: string, options?: VerifyOptions & { wait?: true | undefined }): Promise<Result>;
  verify(email: string, options: VerifyOptions & { wait: boolean }): Promise<Result | PendingCheck>;
  async verify(email: string, options: VerifyOptions = {}): Promise<Result | PendingCheck> {
    const timeout = checkDuration('timeout', options.timeout, CHECK_TIMEOUT);
    const deadline = timeout === null ? null : this._now() + timeout;
    return this.checks._verify(email, {
      forceRecheck: options.forceRecheck ?? false,
      wait: options.wait ?? true,
      deadline,
      timeout,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });
  }

  /**
   * Check several addresses and return their results in the same order.
   *
   * Up to 10 are checked one by one, together. More go as one list (one `POST /v1/jobs`), waited for and read back:
   * each result's `job_id` is then the list's. A few hundred addresses take minutes, Microsoft-hosted ones longer;
   * raise `timeout` (milliseconds, default 600 000) to match. An error, your `signal`'s abort included, names every
   * job the call made in `jobIds`, so nothing is lost: wait for them with `checks.wait` or `lists.wait`.
   */
  async verifyMany(emails: readonly string[], options: VerifyManyOptions = {}): Promise<Result[]> {
    return this.checks._many(emails, checkDuration('timeout', options.timeout, MANY_TIMEOUT), options.signal);
  }

  // --- transport ---------------------------------------------------------------------------------------------------

  /** @internal Sends a request, retrying as the call allows, and answers its JSON body. */
  async _request(call: Call): Promise<Answer> {
    let attempt = 0;
    let unanswered = false;
    for (;;) {
      throwIfAborted(call.signal);
      let error: VerifyInboxesError;
      let neverSent = false;
      try {
        const { response, bytes } = await this.#attempt(call, false, async (response) => ({
          response,
          bytes: await readBody(response),
        }));
        const requestId = response.headers.get('x-request-id');
        if (response.ok) return { status: response.status, requestId, data: parseBody(response.status, requestId, bytes) };
        if (call.goneIsDone && unanswered && response.status === 404) return { status: 404, requestId, data: null };
        error = errorFromAnswer(response.status, response.headers, bytes);
      } catch (caught) {
        if (!(caught instanceof NoAnswer)) throw caught;
        error = caught.error;
        neverSent = caught.neverSent;
        unanswered = true;
      }
      const delay = this.#retryDelay(call, error, attempt, neverSent);
      if (delay === undefined) throw error;
      await this._sleep(delay, call.signal);
      attempt++;
    }
  }

  /** @internal Sends a download, retried until its answer starts, and hands its body over as it comes. */
  async _downloadStream(call: Call): Promise<ReadableStream<Uint8Array>> {
    let attempt = 0;
    for (;;) {
      throwIfAborted(call.signal);
      let error: VerifyInboxesError;
      let neverSent = false;
      try {
        const outcome = await this.#attempt(call, true, async (response, release) =>
          response.ok
            ? { ok: true as const, body: handOver(response, call.signal, release) }
            : { ok: false as const, response, bytes: await readBody(response) },
        );
        if (outcome.ok) return outcome.body;
        error = errorFromAnswer(outcome.response.status, outcome.response.headers, outcome.bytes);
      } catch (caught) {
        if (!(caught instanceof NoAnswer)) throw caught;
        error = caught.error;
        neverSent = caught.neverSent;
      }
      const delay = this.#retryDelay(call, error, attempt, neverSent);
      if (delay === undefined) throw error;
      await this._sleep(delay, call.signal);
      attempt++;
    }
  }

  /**
   * @internal Sends a download and writes it to `path` through a part file, put in place once the whole body came;
   * a failed attempt removes its part file and is made again from the start.
   */
  async _downloadToFile(call: Call, path: string): Promise<number> {
    let attempt = 0;
    for (;;) {
      throwIfAborted(call.signal);
      let error: VerifyInboxesError;
      let neverSent = false;
      const state: { part?: PartFile; committed?: boolean } = {};
      try {
        const outcome = await this.#attempt(call, false, async (response) => {
          if (!response.ok) return { ok: false as const, response, bytes: await readBody(response) };
          const part = await PartFile.open(path);
          state.part = part;
          const reader = response.body?.getReader();
          for (;;) {
            let chunk: ReadableStreamReadResult<Uint8Array> | undefined;
            try {
              chunk = await reader?.read();
            } catch (cause) {
              throw new BodyCut(cause);
            }
            if (chunk === undefined || chunk.done) break;
            await part.write(chunk.value);
          }
          const length = response.headers.get('content-length');
          const encoded = (response.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity';
          if (length !== null && !encoded && Number(length) !== part.written) {
            throw new BodyCut(new Error(`the answer ended after ${part.written} of its ${length} bytes`));
          }
          const written = await part.commit();
          state.committed = true;
          return { ok: true as const, written };
        });
        if (outcome.ok) return outcome.written;
        error = errorFromAnswer(outcome.response.status, outcome.response.headers, outcome.bytes);
      } catch (caught) {
        if (!state.committed) await state.part?.abort();
        if (!(caught instanceof NoAnswer)) throw caught;
        error = caught.error;
        neverSent = caught.neverSent;
      }
      const delay = this.#retryDelay(call, error, attempt, neverSent);
      if (delay === undefined) throw error;
      await this._sleep(delay, call.signal);
      attempt++;
    }
  }

  /**
   * One attempt: `read` is given the answer and runs before the attempt's timer stops. Throws {@link NoAnswer} when
   * nothing (or not all of the body) came, and {@link APIUserAbortError} when the caller's signal aborted.
   */
  async #attempt<T>(
    call: Call,
    handsOver: boolean,
    read: (response: Response, release: () => void) => Promise<T>,
  ): Promise<T> {
    const prepared = await this.#prepare(call);
    const timeout = call.long ? Math.max(this.timeout, LONG_TIMEOUT) : this.timeout;
    const controller = new AbortController();
    let timedOut = false;
    const delay = timerDelay(timeout);
    const timer =
      delay === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, delay);
    const onAbort = (): void => controller.abort();
    // The caller's signal stops the attempt, unless it is one to let finish; either way, an attempt not yet sent when
    // the signal aborted (while its body was being made ready) is not sent.
    const linked = !call.finishOnAbort ? call.signal : undefined;
    linked?.addEventListener('abort', onAbort, { once: true });
    const release = (): void => linked?.removeEventListener('abort', onAbort);
    if (call.signal?.aborted) {
      if (timer !== undefined) clearTimeout(timer);
      release();
      throw new APIUserAbortError(undefined, { cause: call.signal.reason });
    }
    let handedOver = false;
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#url(call), { ...prepared, signal: controller.signal } as RequestInit);
      } catch (cause) {
        throw this.#noAnswer(call, cause, timedOut, timeout, true);
      }
      try {
        const value = await read(response, release);
        handedOver = handsOver && response.ok;
        return value;
      } catch (caught) {
        controller.abort(); // what is left of the body is not read
        if (caught instanceof BodyCut) throw this.#noAnswer(call, caught.cause, timedOut, timeout, false);
        if (call.signal?.aborted) throw new APIUserAbortError(undefined, { cause: caught });
        throw caught;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // A body handed over stays tied to the caller's signal until it ends: aborting it stops the body.
      if (!handedOver) release();
    }
  }

  async #prepare(call: Call): Promise<RequestInit & { duplex?: 'half' }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: call.accept ?? 'application/json',
      'user-agent': this.#userAgent,
    };
    if (call.idempotencyKey !== undefined) headers['idempotency-key'] = call.idempotencyKey;
    const init: RequestInit & { duplex?: 'half' } = { method: call.method, headers, redirect: 'manual' };
    if (call.upload !== undefined) {
      const { body, contentType } = await call.upload.build();
      headers['content-type'] = contentType;
      init.body = body;
      if (!(body instanceof Blob)) init.duplex = 'half'; // a stream: sent as it is read
    } else if (call.json !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(call.json);
    }
    return init;
  }

  #url(call: Call): string {
    const search = call.query && Object.keys(call.query).length > 0 ? `?${new URLSearchParams(call.query).toString()}` : '';
    return `${this.baseURL}${call.path}${search}`;
  }

  #noAnswer(call: Call, cause: unknown, timedOut: boolean, timeout: number, beforeAnswer: boolean): NoAnswer | APIUserAbortError {
    if (call.signal?.aborted) return new APIUserAbortError(undefined, { cause });
    if (timedOut) {
      return new NoAnswer(new APIConnectionTimeoutError(`The VerifyInboxes API did not answer within ${timeout} ms.`, { cause }), false);
    }
    const detail = innermostMessage(cause);
    const message = `Could not reach the VerifyInboxes API${detail ? `: ${detail}` : '.'}`;
    return new NoAnswer(new APIConnectionError(message, { cause }), beforeAnswer && neverConnected(cause));
  }

  /** Milliseconds to wait before sending `call` again, or `undefined` to throw `error`. */
  #retryDelay(call: Call, error: VerifyInboxesError, attempt: number, neverSent: boolean): number | undefined {
    if (attempt >= this.maxRetries) return undefined;
    if (call.upload !== undefined && !call.upload.resendable) return undefined;
    if (error instanceof APIConnectionError) {
      if (call.retry === 'unsent' && !neverSent) return undefined;
      return backoff(attempt);
    }
    if (!(error instanceof APIError)) return undefined;
    const inProgress = error.status === 409 && error.code === 'idempotency_in_progress';
    if (!(error.status === 429 || error.status >= 500 || inProgress)) return undefined;
    if (call.retry === 'unsent' && error.status !== 429) return undefined;
    if (error.retryAfter !== null) {
      const ms = error.retryAfter * 1000;
      return ms <= MAX_RETRY_AFTER ? ms : undefined;
    }
    return backoff(attempt);
  }

  /** @internal What `console.log` and `util.inspect` show: never the key, only its first 6 characters. */
  [INSPECT](): string {
    return `VerifyInboxes { baseURL: '${this.baseURL}', apiKey: '${this.#apiKey.slice(0, 6)}...' }`;
  }
}

/** The n-th retry's wait (n from 0), in milliseconds: uniform between half of `min(8 s, 0.5 s × 2^n)` and all of it. */
function backoff(attempt: number): number {
  const ceiling = Math.min(MAX_RETRY_DELAY, INITIAL_RETRY_DELAY * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

async function readBody(response: Response): Promise<Uint8Array> {
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw new BodyCut(cause);
  }
}

function parseBody(status: number, requestId: string | null, bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new VerifyInboxesError(
      `The API answered ${status} with something that is not JSON${requestId ? ` (request id ${requestId})` : ''}`,
    );
  }
}

/** A download's body for the caller, its failures as this library's errors; `release` once it has ended. */
function handOver(response: Response, signal: AbortSignal | undefined, release: () => void): ReadableStream<Uint8Array> {
  const reader = response.body?.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (cause) {
        release();
        controller.error(
          signal?.aborted
            ? new APIUserAbortError(undefined, { cause })
            : new APIConnectionError('The download stopped before its end.', { cause }),
        );
      }
    },
    async cancel(reason) {
      release();
      await reader?.cancel(reason).catch(() => undefined);
    },
  });
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let at: unknown = error;
  while (at !== undefined && at !== null && chain.length < 10 && !chain.includes(at)) {
    chain.push(at);
    at = (at as { cause?: unknown }).cause;
  }
  return chain;
}

function neverConnected(error: unknown): boolean {
  return causes(error).some((e) => NEVER_CONNECTED.has(String((e as { code?: unknown })?.code ?? '')));
}

function innermostMessage(error: unknown): string {
  const chain = causes(error);
  for (let i = chain.length - 1; i >= 0; i--) {
    const message = (chain[i] as { message?: unknown })?.message;
    if (typeof message === 'string' && message.trim() !== '') return message.trim();
  }
  return '';
}
