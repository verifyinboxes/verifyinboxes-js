/**
 * A scripted fake of the VerifyInboxes API on 127.0.0.1, for the tests, and what the tests share with it.
 *
 * It serves the exchanges of one conformance scenario (the format is described in `tests/conformance.test.ts`): in
 * order, or, when `unordered`, each request matched to the first unused exchange with the same method, path and body.
 * It records every request, and can drop a connection (`"drop": true`) or cut an answer short (`"cut_after": <bytes>`).
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { APIUserAbortError, VerifyInboxes } from '../src';
import type { ClientOptions } from '../src';

// --- JSON, told apart by type ------------------------------------------------------------------------------------------

/** A JSON number as it was written: `1` is a whole number, `1.0` and `1e3` are not, as JSON's own types say. */
export class StrictNumber {
  constructor(
    readonly value: number,
    readonly whole: boolean,
  ) {}
}

/**
 * JSON parsed so that `true`, `1` and `1.0` stay three different things (`JSON.parse` makes the last two one number).
 * Numbers become {@link StrictNumber}s; everything else is as `JSON.parse` gives it.
 */
export function parseStrict(text: string): unknown {
  let at = 0;
  const fail = (): never => {
    throw new SyntaxError(`not JSON at ${at}: ${text.slice(at, at + 20)}`);
  };
  const space = (): void => {
    while (at < text.length && ' \t\r\n'.includes(text[at]!)) at++;
  };
  const value = (): unknown => {
    space();
    const c = text[at];
    if (c === '{') {
      at++;
      const out: Record<string, unknown> = {};
      space();
      if (text[at] === '}') {
        at++;
        return out;
      }
      for (;;) {
        space();
        if (text[at] !== '"') fail();
        const key = string();
        space();
        if (text[at++] !== ':') fail();
        out[key] = value();
        space();
        if (text[at] === ',') {
          at++;
          continue;
        }
        if (text[at++] !== '}') fail();
        return out;
      }
    }
    if (c === '[') {
      at++;
      const out: unknown[] = [];
      space();
      if (text[at] === ']') {
        at++;
        return out;
      }
      for (;;) {
        out.push(value());
        space();
        if (text[at] === ',') {
          at++;
          continue;
        }
        if (text[at++] !== ']') fail();
        return out;
      }
    }
    if (c === '"') return string();
    for (const [word, meant] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, at)) {
        at += word.length;
        return meant;
      }
    }
    const found = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(at));
    if (found === null) return fail();
    at += found[0].length;
    return new StrictNumber(Number(found[0]), found[2] === undefined && found[3] === undefined);
  };
  const string = (): string => {
    const found = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(at));
    if (found === null) return fail();
    at += found[0].length;
    return JSON.parse(found[0]) as string;
  };
  const out = value();
  space();
  if (at !== text.length) fail();
  return out;
}

/** Equality of two values read by {@link parseStrict}: a whole number never equals a boolean or a fractional one. */
export function strictEqual(got: unknown, want: unknown): boolean {
  if (got instanceof StrictNumber || want instanceof StrictNumber) {
    return (
      got instanceof StrictNumber && want instanceof StrictNumber && got.whole === want.whole && got.value === want.value
    );
  }
  if (Array.isArray(got) || Array.isArray(want)) {
    return (
      Array.isArray(got) &&
      Array.isArray(want) &&
      got.length === want.length &&
      got.every((item, index) => strictEqual(item, want[index]))
    );
  }
  if (isObject(got) || isObject(want)) {
    if (!isObject(got) || !isObject(want)) return false;
    const keys = Object.keys(got);
    return (
      keys.length === Object.keys(want).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(want, key) && strictEqual(got[key], want[key]))
    );
  }
  return got === want;
}

/** A value read by {@link parseStrict} as `JSON.parse` would have read it. */
export function plain(value: unknown): unknown {
  if (value instanceof StrictNumber) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof StrictNumber);
}

// --- the scenario format -----------------------------------------------------------------------------------------------

export interface Part {
  name: string;
  value: string;
  filename?: string;
  content_type?: string;
}

/** What the server expects of one request. `json` and `multipart` are read with {@link parseStrict}. */
export interface ExpectedRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  multipart?: Part[];
  headers?: Record<string, string>;
  idempotency_key?: 'new' | 'same' | { equals: string };
}

/** What the server answers. */
export interface ScriptedResponse {
  operation?: string | null;
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  drop?: boolean;
  cut_after?: number;
}

export interface Exchange {
  request: ExpectedRequest;
  response: ScriptedResponse;
}

// --- the server --------------------------------------------------------------------------------------------------------

/** What the server answers to a request the scenario does not have: a status no API gives. */
export const UNEXPECTED_STATUS = 599;

/** One request as the fake server read it. */
export interface Recorded {
  method: string;
  /** The path as it was sent, still escaped, without the query. */
  path: string;
  rawQuery: string;
  /** The decoded query: a string per name, or a list when a name came more than once. */
  query: Record<string, string | string[]>;
  /** Names in lower case. */
  headers: Record<string, string>;
  body: Buffer;
  /** The body read by {@link parseStrict}, when it was sent as JSON. */
  json: unknown;
  multipart: Part[] | undefined;
}

/** Whether `got` is the request `want` describes: its method, path and body (how `unordered` matches). */
export function sameRequest(got: Recorded, want: ExpectedRequest): boolean {
  if (got.method !== want.method || got.path !== want.path) return false;
  if (want.json !== undefined) return strictEqual(got.json, want.json);
  if (want.multipart !== undefined) return strictEqual(got.multipart, want.multipart);
  return got.body.length === 0;
}

export interface FakeAPIOptions {
  unordered?: boolean;
  /** Hold every answer until this many requests are in flight at once (or 10 seconds pass). */
  holdUntil?: number;
  /** Hold every answer, the requests read whole, until `release()` (or 10 seconds pass). */
  gated?: boolean;
}

/** `const api = await FakeAPI.start(exchanges)`: serves them on `api.url` until `api.close()`. */
export class FakeAPI {
  readonly requests: Recorded[] = [];
  /** The request each exchange was used for (`undefined`: never). */
  readonly matched: (Recorded | undefined)[];
  /** The requests no exchange was left for; each was answered 599. */
  readonly unexpected: Recorded[] = [];
  maxInFlight = 0;
  /** Whether `holdUntil` gave up waiting (fewer requests came at once than it asked for). */
  heldOut = false;

  private inFlight = 0;
  private waiting: (() => void)[] = [];
  private server: Server | undefined;
  private opened: (() => void) | undefined;
  private readonly gate: Promise<void> = new Promise((resolve) => {
    this.opened = resolve;
    setTimeout(resolve, 10_000).unref();
  });

  private constructor(
    readonly exchanges: Exchange[],
    private readonly options: FakeAPIOptions,
  ) {
    this.matched = exchanges.map(() => undefined);
  }

  static async start(exchanges: Exchange[], options: FakeAPIOptions = {}): Promise<FakeAPI> {
    const api = new FakeAPI(exchanges, options);
    const server = createServer((req, res) => {
      void api.serve(req, res);
    });
    api.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return api;
  }

  /** Lets the answers held by `gated` go, and every later one straight away. */
  release(): void {
    this.opened?.();
  }

  get url(): string {
    const address = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async record(req: IncomingMessage): Promise<Recorded> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const [path = '', rawQuery = ''] = splitOnce(req.url ?? '', '?');
    const query: Record<string, string | string[]> = {};
    for (const [name, value] of new URLSearchParams(rawQuery)) {
      const had = query[name];
      query[name] = had === undefined ? value : Array.isArray(had) ? [...had, value] : [had, value];
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
    const contentType = headers['content-type'] ?? '';
    let json: unknown;
    if (body.length > 0 && contentType.toLowerCase().startsWith('application/json')) {
      try {
        json = parseStrict(body.toString('utf8'));
      } catch {
        json = undefined;
      }
    }
    return {
      method: req.method ?? '',
      path,
      rawQuery,
      query,
      headers,
      body,
      json,
      multipart: parseMultipart(body, contentType),
    };
  }

  private take(request: Recorded): Exchange | undefined {
    this.requests.push(request);
    let index: number | undefined;
    if (this.options.unordered) {
      const found = this.exchanges.findIndex((e, i) => this.matched[i] === undefined && sameRequest(request, e.request));
      if (found >= 0) index = found;
    } else {
      const used = this.matched.filter((m) => m !== undefined).length;
      if (used < this.exchanges.length) index = used;
    }
    if (index === undefined) {
      this.unexpected.push(request);
      return undefined;
    }
    this.matched[index] = request;
    return this.exchanges[index];
  }

  private async hold(): Promise<void> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const holdUntil = this.options.holdUntil ?? 0;
    if (this.maxInFlight >= holdUntil) {
      for (const release of this.waiting.splice(0)) release();
      return;
    }
    if (this.heldOut) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.heldOut = true;
        for (const release of this.waiting.splice(0)) release();
      }, 10_000);
      this.waiting.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = await this.record(req);
    const exchange = this.take(request);
    await this.hold();
    if (this.options.gated) await this.gate;
    try {
      if (exchange === undefined) {
        answer(res, UNEXPECTED_STATUS, { 'content-type': 'application/json' },
          Buffer.from(JSON.stringify({ error: { code: 'unexpected_request', message: 'not in the scenario' } })));
        return;
      }
      const response = exchange.response;
      if (response.drop) {
        // The request was read whole; the connection closes with no answer.
        req.socket.destroy();
        return;
      }
      const headers: Record<string, string> = { ...(response.headers ?? {}) };
      let data = Buffer.alloc(0);
      if (response.json !== undefined) {
        data = Buffer.from(JSON.stringify(plain(response.json)), 'utf8');
        headers['content-type'] ??= 'application/json; charset=utf-8';
      } else if (response.text !== undefined) {
        data = Buffer.from(response.text, 'utf8');
      }
      if (response.cut_after !== undefined) {
        res.writeHead(response.status ?? 200, { ...headers, 'content-length': String(data.length) });
        res.write(data.subarray(0, response.cut_after), () => req.socket.destroy());
        return;
      }
      answer(res, response.status ?? 200, headers, data);
    } finally {
      this.inFlight--;
    }
  }
}

function answer(res: ServerResponse, status: number, headers: Record<string, string>, data: Buffer): void {
  const out: Record<string, string> = { ...headers };
  if (status !== 204 && status !== 304) out['content-length'] = String(data.length);
  res.writeHead(status, out);
  res.end(status === 204 ? undefined : data);
}

function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return at < 0 ? [value, ''] : [value.slice(0, at), value.slice(at + separator.length)];
}

/**
 * The parts of a `multipart/form-data` body, in order: `{name, value}`, or `{name, filename, content_type, value}` for
 * a file. `undefined` when the body is not multipart.
 */
export function parseMultipart(body: Buffer, contentType: string): Part[] | undefined {
  const found = /boundary="?([^";]+)"?/.exec(contentType);
  if (!contentType.toLowerCase().startsWith('multipart/form-data') || found === null) return undefined;
  const text = body.toString('latin1');
  const parts: Part[] = [];
  for (let segment of text.split(`--${found[1]}`).slice(1)) {
    if (segment.startsWith('--')) break;
    if (segment.startsWith('\r\n')) segment = segment.slice(2);
    const [head = '', content = ''] = splitOnce(segment, '\r\n\r\n');
    const value = content.endsWith('\r\n') ? content.slice(0, -2) : content;
    const headers: Record<string, string> = {};
    for (const line of Buffer.from(head, 'latin1').toString('utf8').split('\r\n')) {
      const [name = '', rest = ''] = splitOnce(line, ':');
      headers[name.trim().toLowerCase()] = rest.trim();
    }
    const disposition = headers['content-disposition'] ?? '';
    const name = /\bname="([^"]*)"/.exec(disposition);
    const filename = /\bfilename="([^"]*)"/.exec(disposition);
    const part: Part = { name: name?.[1] ?? '', value: '' };
    if (filename !== null) {
      part.filename = filename[1]!;
      part.content_type = headers['content-type'] ?? '';
    }
    part.value = Buffer.from(value, 'latin1').toString('utf8');
    parts.push(part);
  }
  return parts;
}

// --- what the tests share ----------------------------------------------------------------------------------------------

/** Made up: the API refuses it. */
export const KEY = 'bv_testtesttesttesttesttesttesttest';
export const JOB_ID = '019a3b71-3c4d-7e5f-8a6b-7c8d9e0f1a2b';
export const REQUEST_ID = '019a7e00-0000-7000-8000-0000000000aa';

/** A scripted answer, in the scenario format. */
export function answerWith(
  status = 200,
  json?: unknown,
  extra: Omit<ScriptedResponse, 'status' | 'json'> & { requestId?: string } = {},
): ScriptedResponse {
  const { requestId = REQUEST_ID, headers, ...rest } = extra;
  const response: ScriptedResponse = { operation: null, status, headers: { 'x-request-id': requestId, ...headers }, ...rest };
  if (json !== undefined) response.json = json;
  return response;
}

export const dropped: ScriptedResponse = { operation: null, drop: true };

export function exchange(method: string, path: string, response: ScriptedResponse, request: Partial<ExpectedRequest> = {}): Exchange {
  return { request: { method, path, ...request }, response };
}

export function apiError(code: string, message = 'no'): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function resultJSON(email = 'ann@example.com', verdict = 'invalid', over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email,
    verdict,
    score: null,
    safe_to_send: false,
    flags: [],
    provider: 'google',
    catch_all_domain: false,
    verified_at: '2026-11-18T10:12:00.123Z',
    source: 'smtp',
    reason: 'mailbox_not_found',
    ...over,
  };
}

export function singleJobId(n: number): string {
  return `019a3b6e-8f0c-7d2e-9a41-5c3e2f1b0b${String(n).padStart(2, '0')}`;
}

export function runningJob(jobId: string, kind = 'single'): Record<string, unknown> {
  return {
    id: jobId,
    kind,
    status: 'running',
    total: 1,
    done: 0,
    created_at: '2026-11-18T10:00:00Z',
    finished_at: null,
    counts: null,
    purged: false,
  };
}

/** The client's sleep and clock for a test: each sleep is written down and moves the clock, and nothing waits. */
export class PaperClock {
  now = 1_000_000_000;
  /** Every sleep, in milliseconds, in the order they began. */
  readonly slept: number[] = [];

  sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new APIUserAbortError();
    this.slept.push(ms);
    this.now += ms;
    await new Promise((resolve) => setImmediate(resolve));
  };

  clock = (): number => this.now;
}

/** A client of `api`, with the made-up key; with `clock`, its sleeps and clock are the paper ones. */
export function clientOf(api: FakeAPI, clock?: PaperClock, options: ClientOptions = {}): VerifyInboxes {
  const client = new VerifyInboxes({ apiKey: KEY, baseURL: api.url, ...options });
  if (clock !== undefined) {
    client._sleep = clock.sleep;
    client._now = clock.clock;
  }
  return client;
}
