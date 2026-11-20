/**
 * Everything this library throws.
 *
 * ```text
 * VerifyInboxesError                    the base of all; also "the API broke its own rules"
 * ├── MissingAPIKeyError                no key given and VERIFYINBOXES_API_KEY not set
 * ├── APIConnectionError                the request got no answer
 * │   └── APIConnectionTimeoutError     ... in time
 * ├── APIUserAbortError                 your AbortSignal aborted the call
 * ├── APIError                          the API answered with an error (any other 4xx)
 * │   ├── InvalidRequestError           400, 413, 414, 415, 422
 * │   ├── AuthenticationError           401
 * │   ├── InsufficientCreditsError      402
 * │   ├── PermissionDeniedError         403
 * │   ├── NotFoundError                 404, 410
 * │   ├── ConflictError                 409
 * │   ├── RateLimitError                429
 * │   └── ServerError                   5xx
 * └── WaitTimeoutError                  a check or a list was still running when the time to wait ran out
 * ```
 *
 * Every error has `jobIds`: the jobs the call had made when it failed, as far as it knows (a check that timed out, a
 * list being waited for, a `verify` or `verifyMany` you aborted), so the credits they hold are not lost: wait for them
 * again with `checks.wait` or `lists.wait`. An aborted `lists.create` or `lists.resolve` may not know its own (see
 * {@link APIUserAbortError}). A wrong argument is a `TypeError`, thrown before anything is sent.
 */

/** The base of every error this library throws; thrown as itself when the API answered something it should not have. */
export class VerifyInboxesError extends Error {
  /** The jobs the call had made when it failed, in the order of its input. */
  jobIds: string[];

  constructor(message: string, options: { jobIds?: readonly string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VerifyInboxesError';
    this.jobIds = [...(options.jobIds ?? [])];
  }
}

/** No API key was given and `VERIFYINBOXES_API_KEY` is not set. */
export class MissingAPIKeyError extends VerifyInboxesError {
  constructor(message: string) {
    super(message);
    this.name = 'MissingAPIKeyError';
  }
}

/**
 * The request got no answer: the connection could not be made, or it was closed or reset before the whole answer
 * came. A request the API may have run is sent again only when that is safe (see the README's "Retries").
 */
export class APIConnectionError extends VerifyInboxesError {
  constructor(message = 'Could not reach the VerifyInboxes API.', options: { jobIds?: readonly string[]; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'APIConnectionError';
  }
}

/** The request got no answer in time. */
export class APIConnectionTimeoutError extends APIConnectionError {
  constructor(message = 'The VerifyInboxes API did not answer in time.', options: { jobIds?: readonly string[]; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'APIConnectionTimeoutError';
  }
}

/**
 * The `signal` you gave aborted the call. Nothing is sent again. A check or a list that `verify` or `verifyMany` had
 * started carries on, and its credits are held: `jobIds` names it, to wait for it again with `checks.wait` or
 * `lists.wait`. `lists.create` and `lists.resolve` stop at once, even when their request has reached the API: send
 * the same call with the same `idempotencyKey` to learn what it made.
 */
export class APIUserAbortError extends VerifyInboxesError {
  constructor(message = 'The call was aborted.', options: { jobIds?: readonly string[]; cause?: unknown } = {}) {
    super(message, options);
    this.name = 'APIUserAbortError';
  }
}

/** What an {@link APIError} is built from. */
export interface APIErrorInit {
  status: number;
  /** The API's error code, or `null` when the answer was not the API's. */
  code?: string | null;
  requestId?: string | null;
  /** Seconds, from the answer's `Retry-After`. */
  retryAfter?: number | null;
  body?: unknown;
  jobIds?: readonly string[];
}

/**
 * The API answered with an error status.
 *
 * `code` is the API's stable error code (`unauthorized`, `not_ready`, `consumer_list`, ...): match on it, and treat one
 * you do not know by its `status`. `message` reads `<status> <code>: <what the API said> (request id <id>)`: show it
 * or log it, never parse it. `requestId` is the answer's `X-Request-Id`: quote it when you write to support.
 */
export class APIError extends VerifyInboxesError {
  /** The HTTP status. */
  readonly status: number;
  /** The API's error code, or `null` when the answer was not the API's (a proxy's error page). */
  readonly code: string | null;
  /** The answer's `X-Request-Id`. After retries, the last answer's. */
  readonly requestId: string | null;
  /** The answer's `Retry-After`, in seconds, when it had one. */
  readonly retryAfter: number | null;
  /** The answer's body: its JSON, or its text when it is not JSON. */
  readonly body: unknown;

  constructor(message: string, init: APIErrorInit) {
    const head = init.code ? `${init.status} ${init.code}` : `${init.status}`;
    super(`${head}: ${message}${init.requestId ? ` (request id ${init.requestId})` : ''}`, { jobIds: init.jobIds ?? [] });
    this.name = 'APIError';
    this.status = init.status;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
    this.retryAfter = init.retryAfter ?? null;
    this.body = init.body;
  }
}

/** 400, 413, 414, 415 or 422: the request does not fit (`invalid_request`, `consumer_list`, `empty_list`, ...). */
export class InvalidRequestError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'InvalidRequestError';
  }
}

/** 401: the key or token is missing, mistyped, revoked, or (a personal access token) past its hour. */
export class AuthenticationError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'AuthenticationError';
  }
}

/** 402 `insufficient_credits`: the balance does not cover the request. Nothing was charged. */
export class InsufficientCreditsError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'InsufficientCreditsError';
  }
}

/** 403: allowed for nobody with this credential (`forbidden`, `review_required`, `account_suspended`, ...). */
export class PermissionDeniedError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'PermissionDeniedError';
  }
}

/** 404 `not_found`, or 410 `gone` (a list whose data was deleted). */
export class NotFoundError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'NotFoundError';
  }
}

/** 409: `not_ready` (the list has not finished), `idempotency_conflict` (the key was used for another request). */
export class ConflictError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'ConflictError';
  }
}

/** 429: too many requests or lists at once. Retried on its own, unless `retryAfter` is over 60 seconds. */
export class RateLimitError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'RateLimitError';
  }
}

/** 5xx: something went wrong on the API's side. Retried on its own; this is the last answer's. */
export class ServerError extends APIError {
  constructor(message: string, init: APIErrorInit) {
    super(message, init);
    this.name = 'ServerError';
  }
}

/**
 * A check or a list was still running when the time given to wait ran out. It carries on, and its credits are held:
 * wait for it again by its id (`jobIds`) with `checks.wait` or `lists.wait`.
 */
export class WaitTimeoutError extends VerifyInboxesError {
  /** The milliseconds that were given to wait; `null` for none. */
  readonly timeout: number | null;

  constructor(message: string, options: { jobIds: readonly string[]; timeout: number | null }) {
    super(message, { jobIds: options.jobIds });
    this.name = 'WaitTimeoutError';
    this.timeout = options.timeout;
  }
}

const BY_STATUS: Record<number, new (message: string, init: APIErrorInit) => APIError> = {
  400: InvalidRequestError,
  413: InvalidRequestError,
  414: InvalidRequestError,
  415: InvalidRequestError,
  422: InvalidRequestError,
  401: AuthenticationError,
  402: InsufficientCreditsError,
  403: PermissionDeniedError,
  404: NotFoundError,
  410: NotFoundError,
  409: ConflictError,
  429: RateLimitError,
};

/**
 * The typed error of an answer of 4xx or 5xx. The API's errors are `{"error": {"code", "message"}}`; a body that is
 * not one (a proxy's HTML page) keeps its status, with no code.
 */
export function errorFromAnswer(status: number, headers: Headers, bytes: Uint8Array, now: number = Date.now()): APIError {
  const text = new TextDecoder().decode(bytes);
  let body: unknown = text === '' ? null : text;
  try {
    if (text !== '') body = JSON.parse(text);
  } catch {
    // not JSON: kept as its text
  }
  const error = isObject(body) && isObject(body['error']) ? body['error'] : undefined;
  const code = typeof error?.['code'] === 'string' ? error['code'] : null;
  const message = typeof error?.['message'] === 'string' && error['message'] ? error['message'] : `The API answered ${status}`;
  const Kind = BY_STATUS[status] ?? (status >= 500 ? ServerError : APIError);
  return new Kind(message, {
    status,
    code,
    requestId: headers.get('x-request-id'),
    retryAfter: retryAfterSeconds(headers.get('retry-after'), now),
    body,
  });
}

/** The seconds a `Retry-After` header asks to wait (seconds, or an HTTP date); `null` when there is none. */
export function retryAfterSeconds(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, (date - now) / 1000);
}

/**
 * Names `jobIds` on an error thrown while a call had jobs running, so that they are never lost. A
 * {@link VerifyInboxesError} that names none yet gets them (`replace`: gets them whatever it named); any other error
 * object gets a `jobIds` property where it takes one.
 */
export function nameJobs(error: unknown, jobIds: readonly string[], replace = false): void {
  if (jobIds.length === 0) return;
  if (error instanceof VerifyInboxesError) {
    if (replace || error.jobIds.length === 0) error.jobIds = [...jobIds];
    return;
  }
  if (typeof error === 'object' && error !== null && Object.isExtensible(error)) {
    try {
      Object.defineProperty(error, 'jobIds', { value: [...jobIds], enumerable: true, configurable: true, writable: true });
    } catch {
      // an object that refuses it: nothing more can be done
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
