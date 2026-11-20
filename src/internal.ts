/**
 * What the client and its resources share: defaults, configuration, the runtime's crypto and files, uploads, and the
 * checks of arguments. Nothing here sends a request.
 */
import { APIUserAbortError, MissingAPIKeyError, VerifyInboxesError } from './errors';

export const DEFAULT_BASE_URL = 'https://api.verifyinboxes.com';
export const API_KEY_ENV = 'VERIFYINBOXES_API_KEY';
export const BASE_URL_ENV = 'VERIFYINBOXES_BASE_URL';

/** Milliseconds one attempt of one request may take. */
export const DEFAULT_TIMEOUT = 60_000;
/** An upload or a download: the API's own limit for a whole request. */
export const LONG_TIMEOUT = 600_000;
export const DEFAULT_MAX_RETRIES = 2;
/** A longer `Retry-After` is not waited for: the error is thrown, with `retryAfter` on it. */
export const MAX_RETRY_AFTER = 60_000;
export const INITIAL_RETRY_DELAY = 500;
export const MAX_RETRY_DELAY = 8_000;

/** `verify` and `checks.wait`. */
export const CHECK_TIMEOUT = 60_000;
/** `verifyMany`. */
export const MANY_TIMEOUT = 600_000;
/** A check's job is asked every 2 seconds. */
export const POLL_INTERVAL = 2_000;
/** A list's: then every 30 seconds. */
export const LIST_POLL_INTERVALS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** `verifyMany`: up to this many addresses are checked one by one, together... */
export const SINGLES_AT_MOST = 10;
/** ... started 100 ms apart. */
export const SINGLES_APART = 100;
export const PAGE_SIZE = 500;
export const ACTIVE: ReadonlySet<string> = new Set(['queued', 'running']);

/** The longest delay `setTimeout` takes; a longer one would fire at once. */
const MAX_TIMER = 2_147_483_647;

// --- the runtime ---------------------------------------------------------------------------------------------------

/** An environment variable, from Node's or Bun's `process.env` or Deno's `Deno.env`; `undefined` where none can be read. */
export function readEnv(name: string): string | undefined {
  try {
    const scope = globalThis as {
      process?: { env?: Record<string, string | undefined> };
      Deno?: { env?: { get?: (name: string) => string | undefined } };
    };
    return scope.process?.env?.[name] ?? scope.Deno?.env?.get?.(name) ?? undefined;
  } catch {
    return undefined; // a runtime that does not let the environment be read
  }
}

/** Whether this is a web page, where a key in the code is a key shown to every visitor. */
export function inBrowserPage(): boolean {
  const scope = globalThis as { window?: { document?: unknown }; navigator?: unknown };
  return typeof scope.window !== 'undefined' && typeof scope.window.document !== 'undefined' && typeof scope.navigator !== 'undefined';
}

/** Web Crypto: the global one, or Node 18's, which is not global. */
export async function webCrypto(): Promise<Crypto> {
  const found = (globalThis as { crypto?: Crypto }).crypto;
  if (found?.subtle !== undefined && typeof found.getRandomValues === 'function') return found;
  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.webcrypto as unknown as Crypto;
}

/** A random UUID (version 4). */
export async function randomUUID(): Promise<string> {
  const crypto = await webCrypto();
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A clock that only goes forward, in milliseconds. */
export function monotonicNow(): number {
  const performance = (globalThis as { performance?: { now(): number } }).performance;
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

/** Waits, or throws {@link APIUserAbortError} as soon as the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new APIUserAbortError(undefined, { cause: signal.reason }));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new APIUserAbortError(undefined, { cause: signal?.reason }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.min(Math.max(0, ms), MAX_TIMER));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new APIUserAbortError(undefined, { cause: signal.reason });
}

/** The `setTimeout` delay for a timeout in milliseconds; `undefined` for one too long to have a timer. */
export function timerDelay(ms: number): number | undefined {
  return ms <= MAX_TIMER ? ms : undefined;
}

// --- configuration -------------------------------------------------------------------------------------------------

export function resolveApiKey(given: string | undefined): string {
  const value = given ?? readEnv(API_KEY_ENV);
  if (value !== undefined && typeof value !== 'string') throw new TypeError('apiKey must be a string');
  const key = (value ?? '').trim();
  if (key === '') {
    throw new MissingAPIKeyError(
      `No API key. Pass one, new VerifyInboxes({ apiKey }), or set the ${API_KEY_ENV} environment variable. An ` +
        'organisation admin makes keys in the VerifyInboxes app under Developers -> API keys.',
    );
  }
  if (!/^[!-~]+$/.test(key)) {
    // A key and a token are visible ASCII: anything else (a space, a control or zero-width character, a letter with
    // an accent) is half of a copy and paste, and would fail on the first request instead.
    throw new TypeError(
      'The API key holds a space, a control character or a character that is not ASCII: copy it again, whole.',
    );
  }
  return key;
}

export function resolveBaseURL(given: string | undefined): string {
  const value = given || readEnv(BASE_URL_ENV) || DEFAULT_BASE_URL;
  if (typeof value !== 'string') throw new TypeError('baseURL must be a string');
  let url = value.trim();
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (!/^https?:\/\/[^/\s]+/i.test(url)) throw new TypeError('baseURL must be an http:// or https:// address');
  return url;
}

/** A duration in milliseconds, 0 or more; `null` (or `Infinity`) is no limit, `undefined` the default. */
export function checkDuration(name: string, value: number | null | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null || value === Infinity) return null;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new TypeError(`${name} must be a number of milliseconds, 0 or more (or null for no limit)`);
  }
  return value;
}

// --- requests ------------------------------------------------------------------------------------------------------

/** A value as one segment of a path: an id with a `/` or a `?` in it never reaches another address. */
export function pathSegment(value: string, what = 'id'): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${what} must be a non-empty string`);
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The caller's own `Idempotency-Key`, checked, or a new one. */
export async function idempotencyKey(given: string | undefined): Promise<string> {
  if (given === undefined || given === null) return randomUUID();
  if (typeof given !== 'string' || !/^[!-~]{1,255}$/.test(given)) {
    throw new TypeError('idempotencyKey must be 1 to 255 visible ASCII characters');
  }
  return given;
}

/** Which rows of a list's results or download: `only=safe_to_send`, `verdicts=a,b`, `partial=1`. */
export interface FilterOptions {
  /** Only the rows safe to send to. */
  onlySafeToSend?: boolean;
  /** Only the rows of these verdicts. */
  verdicts?: readonly string[];
  /** A list still running, as it stands. */
  partial?: boolean;
}

export function filterQuery(options: FilterOptions): Record<string, string> {
  const query: Record<string, string> = {};
  const { onlySafeToSend, verdicts, partial } = options;
  if (verdicts !== undefined && verdicts !== null && !Array.isArray(verdicts)) {
    throw new TypeError('verdicts must be a list of verdicts');
  }
  if (onlySafeToSend && verdicts?.length) throw new TypeError('give onlySafeToSend or verdicts, not both');
  if (onlySafeToSend) query['only'] = 'safe_to_send';
  if (verdicts?.length) query['verdicts'] = verdicts.join(',');
  if (partial) query['partial'] = '1';
  return query;
}

export function checkPageSize(value: number | undefined): number {
  const size = value ?? PAGE_SIZE;
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new TypeError('pageSize must be a whole number from 1 to 1000');
  return size;
}

export function checkEmail(email: unknown): string {
  if (typeof email !== 'string' || email.trim() === '') throw new TypeError('email must be an address');
  return email;
}

export function checkEmails(emails: unknown, what = 'emails'): string[] {
  if (!Array.isArray(emails)) throw new TypeError(`${what} must be a list of addresses`);
  if (emails.length === 0) throw new TypeError(`${what} is empty: give one address or more`);
  emails.forEach((email, index) => {
    if (typeof email !== 'string' || email.trim() === '') throw new TypeError(`${what}[${index}] is not an address`);
  });
  return [...(emails as string[])];
}

export function checkList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${what} must be a list`);
  return [...(value as string[])];
}

// --- uploads -------------------------------------------------------------------------------------------------------

/**
 * A CSV to upload: a path to a file (Node, Bun and Deno), a `Blob` (a `File` too), bytes, or a stream of bytes. A
 * stream is sent as it is read, so it is never sent again once its sending began; the others are sent again whole.
 */
export type FileSource = string | Blob | Uint8Array | ReadableStream<Uint8Array>;

const FILE_SOURCE =
  'file must be a path, a Blob, bytes or a web ReadableStream (for a Node.js stream, pass Readable.toWeb(stream))';

const encoder = new TextEncoder();

function formQuote(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** A file's name, from its path. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || 'list.csv';
}

/** What one attempt of an upload sends. */
export interface UploadBody {
  body: Blob | ReadableStream<Uint8Array>;
  contentType: string;
}

/**
 * A CSV sent as `multipart/form-data`: the field `email_column`, then the file, typed `text/csv`. It is built again for
 * every attempt: a path is opened again; a stream that can be read only once is sent once.
 */
export class Upload {
  /** Whether a stream has begun to be read: it cannot be sent again. */
  started = false;
  private readonly head: Uint8Array;
  private readonly tail: Uint8Array;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  private constructor(
    private readonly source: FileSource,
    private readonly boundary: string,
    emailColumn: string,
    filename: string,
  ) {
    this.head = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="email_column"\r\n\r\n${emailColumn}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${formQuote(filename)}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
    );
    this.tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  }

  static async of(source: FileSource, emailColumn: string | undefined, filename: string | undefined): Promise<Upload> {
    const column = emailColumn ?? 'email';
    if (typeof column !== 'string' || column === '') throw new TypeError("emailColumn must be a column's name");
    if (filename !== undefined && typeof filename !== 'string') throw new TypeError('filename must be a string');
    let name = filename ?? 'list.csv';
    if (typeof source === 'string') {
      if (source === '') throw new TypeError(FILE_SOURCE);
      name = filename ?? baseName(source);
      // A missing file is told now, before anything is sent.
      const fs = await import('node:fs');
      if (!(await fs.promises.stat(source)).isFile()) throw new TypeError(`not a file: ${source}`);
    } else if (!(isBlob(source) || source instanceof Uint8Array || isStream(source))) {
      throw new TypeError(FILE_SOURCE);
    }
    const boundary = `verifyinboxes-${(await randomUUID()).replace(/-/g, '')}`;
    return new Upload(source, boundary, column, name);
  }

  /** Whether a failed attempt can be made again: always, but for a stream whose sending began. */
  get resendable(): boolean {
    return !isStream(this.source) || !this.started;
  }

  /** The body of one attempt. */
  async build(): Promise<UploadBody> {
    const contentType = `multipart/form-data; boundary=${this.boundary}`;
    const source = this.source;
    if (isStream(source)) return { body: this.streamBody(source), contentType };
    let file: Blob;
    if (typeof source === 'string') file = await openFile(source);
    else if (source instanceof Uint8Array) file = new Blob([source as Uint8Array<ArrayBuffer>]);
    else file = source;
    const head = this.head as Uint8Array<ArrayBuffer>;
    const tail = this.tail as Uint8Array<ArrayBuffer>;
    let body = new Blob([head, file, tail]);
    if (body.size !== head.byteLength + file.size + tail.byteLength) {
      // A runtime that drops a file's bytes when its Blob is put in another (Bun): the file is read first.
      body = new Blob([head, new Uint8Array(await file.arrayBuffer()), tail]);
    }
    return { body, contentType };
  }

  private streamBody(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const parts: ('head' | 'file' | 'tail' | 'end')[] = ['head', 'file', 'tail', 'end'];
    return new ReadableStream<Uint8Array>({
      // Each pull gives one chunk (or ends the body): an empty chunk of the file is passed over, not given.
      pull: async (controller) => {
        for (;;) {
          const part = parts[0];
          if (part === 'head' || part === 'tail') {
            parts.shift();
            controller.enqueue(part === 'head' ? this.head : this.tail);
            return;
          }
          if (part !== 'file') {
            controller.close();
            return;
          }
          this.started = true;
          this.reader ??= source.getReader();
          const { done, value } = await this.reader.read();
          if (done) {
            parts.shift();
            continue;
          }
          const chunk: unknown = value;
          const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : (chunk as Uint8Array);
          if (bytes.byteLength > 0) {
            controller.enqueue(bytes);
            return;
          }
        }
      },
      cancel: async (reason) => {
        if (this.started) await this.reader?.cancel(reason).catch(() => undefined);
      },
    });
  }
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof (value as { getReader?: unknown } | null)?.getReader === 'function';
}

/** A file on disk as a Blob, read when it is sent: `fs.openAsBlob` where the runtime has it, else read whole. */
async function openFile(path: string): Promise<Blob> {
  const fs = await import('node:fs');
  const openAsBlob = (fs as { openAsBlob?: (path: string) => Promise<Blob> }).openAsBlob;
  if (typeof openAsBlob === 'function') return openAsBlob(path);
  return new Blob([(await fs.promises.readFile(path)) as Uint8Array<ArrayBuffer>]);
}

// --- downloads -----------------------------------------------------------------------------------------------------

/**
 * A download written to a path: to a part file beside it, renamed over it once the whole body arrived, removed on
 * any failure, so the file that was there is untouched.
 */
export class PartFile {
  written = 0;
  private constructor(
    private readonly fs: typeof import('node:fs'),
    private readonly target: string,
    private readonly part: string,
    private readonly handle: import('node:fs/promises').FileHandle,
  ) {}

  static async open(target: string): Promise<PartFile> {
    if (typeof target !== 'string' || target === '') throw new TypeError('path must be a path to a file');
    const fs = await import('node:fs');
    for (let i = 0; i < 10; i++) {
      const part = `${target}.part-${(await randomUUID()).replace(/-/g, '').slice(0, 12)}`;
      try {
        return new PartFile(fs, target, part, await fs.promises.open(part, 'wx'));
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
      }
    }
    throw new VerifyInboxesError(`could not make a part file beside ${target}`);
  }

  async write(chunk: Uint8Array): Promise<void> {
    let at = 0;
    while (at < chunk.byteLength) {
      const { bytesWritten } = await this.handle.write(chunk, at, chunk.byteLength - at);
      at += bytesWritten;
    }
    this.written += chunk.byteLength;
  }

  /** Puts the whole file in place. */
  async commit(): Promise<number> {
    await this.handle.sync();
    await this.handle.close();
    await this.fs.promises.rename(this.part, this.target);
    return this.written;
  }

  /** Removes the part file; the file that was there stays as it was. */
  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await this.fs.promises.unlink(this.part).catch(() => undefined);
  }
}

// --- answers -------------------------------------------------------------------------------------------------------

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const DENO_INSPECT = Symbol.for('Deno.customInspect');

/**
 * Keeps a secret shown once (a webhook's `secret`, an integration's `url`) out of what `console.log` and
 * `util.inspect` show. It stays a plain property: read it, and `JSON.stringify` keeps it.
 */
export function hideSecret<T extends object>(value: T, field: keyof T & string): T {
  if (typeof value !== 'object' || value === null) return value;
  const shown = (): Record<string, unknown> => ({ ...(value as Record<string, unknown>), [field]: '[hidden]' });
  type Inspect = (value: unknown, options: unknown) => string;
  const hidden = { enumerable: false, configurable: true };
  // Node and Bun call it (depth, options, inspect); Deno calls it (inspect, options).
  Object.defineProperty(value, INSPECT, {
    ...hidden,
    value: (_depth: unknown, options: unknown, inspect?: Inspect) => (typeof inspect === 'function' ? inspect(shown(), options) : shown()),
  });
  Object.defineProperty(value, DENO_INSPECT, {
    ...hidden,
    value: (inspect: unknown, options: unknown) =>
      typeof inspect === 'function' ? (inspect as Inspect)(shown(), options) : JSON.stringify(shown()),
  });
  return value;
}

/** What a wait that ran out says. */
export function waitTimeoutMessage(what: string, jobId: string, status: string, timeout: number | null, resume: string): string {
  const after = timeout === null ? '' : ` after ${timeout / 1000} seconds`;
  return (
    `The ${what} ${jobId} was still ${status}${after}. It carries on, and its credits are held: ` +
    `wait for it again with ${resume}('${jobId}').`
  );
}
