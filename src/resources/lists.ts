import type { RequestOptions, VerifyInboxes } from '../client';
import { VerifyInboxesError, WaitTimeoutError, nameJobs } from '../errors';
import {
  ACTIVE,
  LIST_POLL_INTERVALS,
  Upload,
  checkDuration,
  checkPageSize,
  filterQuery,
  idempotencyKey,
  pathSegment,
  waitTimeoutMessage,
} from '../internal';
import type { FileSource, FilterOptions } from '../internal';
import { ResultsIterable } from '../pagination';
import type { Job, JobCreated, ResolveCreated, ResultsPage } from '../types';

export interface CreateListOptions extends RequestOptions {
  /** The addresses, sent as JSON. */
  emails?: readonly string[] | undefined;
  /**
   * A CSV with a header row: a path to a file (Node, Bun, Deno), a `Blob` (a `File` too), bytes, or a
   * `ReadableStream` of bytes (sent as it is read, so never sent again once its sending began).
   */
  file?: FileSource | undefined;
  /** A CSV's text. */
  csv?: string | undefined;
  /** The header of the CSV's column of addresses. Default `email`. */
  emailColumn?: string | undefined;
  /** The name the upload carries. Default: the path's file name, else `list.csv`. */
  filename?: string | undefined;
  /** Your own `Idempotency-Key`; default: a new one for the call. */
  idempotencyKey?: string | undefined;
}

export interface ListWaitOptions extends RequestOptions {
  /** Milliseconds to wait, from the call. Default `null`: as long as it takes. */
  timeout?: number | null | undefined;
}

export interface ResultsOptions extends FilterOptions, RequestOptions {
  /** Rows per page, 1 to 1000. Default 500. */
  pageSize?: number | undefined;
}

export interface ResultsPageOptions extends ResultsOptions {
  /** The `next_cursor` of the page before; none for the first page. */
  cursor?: string | null | undefined;
}

export interface DownloadOptions extends FilterOptions, RequestOptions {}

export interface ResolveOptions extends RequestOptions {
  /** Only these of the job's `catch_all` and `risky` addresses; default all of them. */
  emails?: readonly string[] | undefined;
  /** Your own `Idempotency-Key`; default: a new one for the call. */
  idempotencyKey?: string | undefined;
}

/** Lists of addresses: made from a CSV or a list of addresses, waited for, read, downloaded and resolved. */
export class Lists {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /**
   * `POST /v1/jobs`: start a list from exactly one of `emails`, `file` or `csv`. Wait for it with `lists.wait`.
   *
   * Sent again, with the same `Idempotency-Key`, when the answer is lost: the API answers the retry with the same
   * list, so it is made and charged once.
   *
   * Your `signal` stops it at once, even when the request has already reached the API: the list may then exist
   * without its id in the error's `jobIds`. If you may abort it, pass your own `idempotencyKey`, and after an
   * {@link APIUserAbortError} make the same call with the same key (within 24 hours): the API answers with what the
   * first request answered (the list it made), or, if that one never ran, makes the list now, once.
   */
  async create(options: CreateListOptions): Promise<JobCreated> {
    return this._create(options, false);
  }

  /** @internal `create`; `finishOnAbort`: once sent, the POST is not cut off by the caller's signal. */
  async _create(options: CreateListOptions, finishOnAbort: boolean): Promise<JobCreated> {
    options = options ?? {};
    const { emails, file, csv } = options;
    const given = [emails, file, csv].filter((source) => source !== undefined && source !== null);
    if (given.length !== 1) throw new TypeError('give exactly one of emails, file or csv');
    const key = await idempotencyKey(options.idempotencyKey);
    if (emails !== undefined && emails !== null) {
      if (!Array.isArray(emails)) throw new TypeError('emails must be a list of addresses');
      const answer = await this.#client._request({
        method: 'POST',
        path: '/v1/jobs',
        json: { emails: [...emails] },
        idempotencyKey: key,
        signal: options.signal,
        finishOnAbort,
      });
      return answer.data as JobCreated;
    }
    if (csv !== undefined && csv !== null && typeof csv !== 'string') {
      throw new TypeError("csv must be the CSV's text (for bytes, a Blob or a path, use file)");
    }
    const source = csv !== undefined && csv !== null ? new TextEncoder().encode(csv) : (file as FileSource);
    const upload = await Upload.of(source, options.emailColumn, options.filename);
    const answer = await this.#client._request({
      method: 'POST',
      path: '/v1/jobs',
      upload,
      idempotencyKey: key,
      long: true,
      signal: options.signal,
      finishOnAbort,
    });
    return answer.data as JobCreated;
  }

  /** `GET /v1/jobs/{id}`: the list as it is now. */
  async get(id: string, options: RequestOptions = {}): Promise<Job> {
    return (await this.#client._request({ method: 'GET', path: jobPath(id), signal: options.signal })).data as Job;
  }

  /**
   * Wait for a list to finish and return it. Asks at once, then after 2, 4, 8, 16 and then every 30 seconds. Throws
   * {@link WaitTimeoutError} after `timeout` milliseconds (default: no limit); the list carries on. A few hundred
   * addresses take minutes, Microsoft-hosted ones longer.
   */
  async wait(id: string, options: ListWaitOptions = {}): Promise<Job> {
    pathSegment(id);
    const timeout = checkDuration('timeout', options.timeout, null);
    const deadline = timeout === null ? null : this.#client._now() + timeout;
    return this._wait(id, deadline, timeout, options.signal);
  }

  /** @internal Asks at once, then polls a list, backing off; every error names the list. */
  async _wait(id: string, deadline: number | null, timeout: number | null, signal?: AbortSignal): Promise<Job> {
    try {
      let job = await this.get(id, { signal });
      let asked = 0;
      while (ACTIVE.has(job.status)) {
        const now = this.#client._now();
        if (deadline !== null && now >= deadline) {
          throw new WaitTimeoutError(waitTimeoutMessage('list', id, job.status, timeout, 'client.lists.wait'), {
            jobIds: [id],
            timeout,
          });
        }
        const pause = LIST_POLL_INTERVALS[Math.min(asked, LIST_POLL_INTERVALS.length - 1)]!;
        await this.#client._sleep(deadline === null ? pause : Math.min(pause, deadline - now), signal);
        asked++;
        job = await this.get(id, { signal });
      }
      return job;
    } catch (error) {
      nameJobs(error, [id]);
      throw error;
    }
  }

  /**
   * Every row of a finished list, in order, read a page (`pageSize` rows) at a time as you iterate; nothing is asked
   * until then.
   *
   * `onlySafeToSend` keeps the rows safe to send to; `verdicts` the rows of those verdicts; `partial` reads a list
   * still running, as it stands (read again from the start once it is done).
   */
  results(id: string, options: ResultsOptions = {}): ResultsIterable {
    const path = jobPath(id, '/results');
    const pageSize = checkPageSize(options.pageSize);
    const filters = filterQuery(options);
    return new ResultsIterable(id, (cursor) => this.#page(path, pageSize, cursor, filters, options.signal));
  }

  /**
   * One page of results, for keeping your own cursor: pass the page's `next_cursor` back as `cursor` until it is
   * `null`. A page may hold fewer rows than asked, even none, before the last one.
   */
  async resultsPage(id: string, options: ResultsPageOptions = {}): Promise<ResultsPage> {
    return this.#page(jobPath(id, '/results'), checkPageSize(options.pageSize), options.cursor ?? null, filterQuery(options), options.signal);
  }

  async #page(path: string, pageSize: number, cursor: string | null, filters: Record<string, string>, signal?: AbortSignal): Promise<ResultsPage> {
    const query: Record<string, string> = { limit: String(pageSize) };
    if (cursor !== null) query['cursor'] = cursor;
    Object.assign(query, filters);
    const { data } = await this.#client._request({ method: 'GET', path, query, signal });
    const page = data as ResultsPage | null;
    if (typeof page !== 'object' || page === null || !Array.isArray(page.data)) {
      throw new VerifyInboxesError('The API answered a page of results without its rows.');
    }
    return page;
  }

  /**
   * `GET /v1/jobs/{id}/download`: the CSV you sent, with the results appended, as a stream of bytes. Retried until its
   * answer starts; your `signal` stops it at any time. No timeout applies once the answer has started: to bound the
   * whole download, pass `signal: AbortSignal.timeout(ms)`.
   */
  async download(id: string, options: DownloadOptions = {}): Promise<ReadableStream<Uint8Array>> {
    return this.#client._downloadStream(downloadCall(id, options));
  }

  /**
   * The download of {@link Lists.download}, written to `path`. Returns the bytes written. It is written beside it and
   * renamed over it once whole: a failed download leaves the file there was untouched, and is retried from the start.
   */
  async downloadToFile(id: string, path: string, options: DownloadOptions = {}): Promise<number> {
    if (typeof path !== 'string' || path === '') throw new TypeError('path must be a path to a file');
    return this.#client._downloadToFile(downloadCall(id, options), path);
  }

  /**
   * `POST /v1/jobs/{id}/resolve`: send a finished job's `catch_all` and `risky` addresses (all of them, or those in
   * `emails`) to be settled by a test email. Its own job: wait for it with `lists.wait`.
   *
   * Your `signal` stops it at once, even when the request has already reached the API: as for `lists.create`, pass
   * your own `idempotencyKey` if you may abort it, and make the same call with the same key afterwards.
   */
  async resolve(id: string, options: ResolveOptions = {}): Promise<ResolveCreated> {
    const { emails } = options;
    if (emails !== undefined && emails !== null && !Array.isArray(emails)) throw new TypeError('emails must be a list of addresses');
    const answer = await this.#client._request({
      method: 'POST',
      path: jobPath(id, '/resolve'),
      json: emails === undefined || emails === null ? undefined : { emails: [...emails] },
      idempotencyKey: await idempotencyKey(options.idempotencyKey),
      signal: options.signal,
    });
    return answer.data as ResolveCreated;
  }
}

function jobPath(id: string, tail = ''): string {
  return `/v1/jobs/${pathSegment(id)}${tail}`;
}

function downloadCall(id: string, options: DownloadOptions) {
  return {
    method: 'GET' as const,
    path: jobPath(id, '/download'),
    query: filterQuery(options),
    long: true,
    accept: 'text/csv',
    signal: options.signal,
  };
}
