import type { Answer, RequestOptions, VerifyInboxes } from '../client';
import { APIUserAbortError, VerifyInboxesError, WaitTimeoutError, nameJobs } from '../errors';
import {
  ACTIVE,
  CHECK_TIMEOUT,
  POLL_INTERVAL,
  SINGLES_APART,
  SINGLES_AT_MOST,
  checkDuration,
  checkEmail,
  checkEmails,
  idempotencyKey,
  pathSegment,
  waitTimeoutMessage,
} from '../internal';
import type { Job, PendingCheck, Result, ResultRow } from '../types';

export interface CheckWaitOptions extends RequestOptions {
  /**
   * Milliseconds to wait, from the call; `null` waits as long as it takes. Default 60 000. Past it,
   * {@link WaitTimeoutError} is thrown: the check carries on.
   */
  timeout?: number | null | undefined;
}

/** @internal */
export interface StartCheck {
  forceRecheck: boolean;
  wait: boolean;
  deadline: number | null;
  timeout: number | null;
  idempotencyKey?: string | undefined;
  /** Told the check's job id as soon as the API names it. */
  made?: ((jobId: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** One check by its job: as it is now, or waited for (`client.verify` starts one). */
export class Checks {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /** `GET /v1/jobs/{id}`: a check's job as it is now (`result` once it is done). */
  async get(jobId: string, options: RequestOptions = {}): Promise<Job> {
    const path = `/v1/jobs/${pathSegment(jobId, 'jobId')}`;
    return jobOf((await this.#client._request({ method: 'GET', path, signal: options.signal })).data);
  }

  /**
   * Wait for a check that is still running (a {@link PendingCheck}, or one a {@link WaitTimeoutError} named) and
   * return its result. Asks at once, then every 2 seconds; throws {@link WaitTimeoutError} after `timeout`
   * milliseconds (default 60 000; `null`: no limit).
   */
  async wait(jobId: string, options: CheckWaitOptions = {}): Promise<Result> {
    pathSegment(jobId, 'jobId');
    const timeout = checkDuration('timeout', options.timeout, CHECK_TIMEOUT);
    const deadline = timeout === null ? null : this.#client._now() + timeout;
    return this._wait(jobId, deadline, timeout, true, options.signal);
  }

  /** @internal Polls a check's job until it is done, every 2 seconds; every error names the job. */
  async _wait(jobId: string, deadline: number | null, timeout: number | null, askFirst: boolean, signal?: AbortSignal): Promise<Result> {
    let status = 'pending';
    try {
      if (askFirst) {
        const job = await this.get(jobId, { signal });
        if (!ACTIVE.has(job.status)) return resultOf(job);
        status = job.status;
      }
      for (;;) {
        const now = this.#client._now();
        if (deadline !== null && now >= deadline) {
          throw new WaitTimeoutError(waitTimeoutMessage('check', jobId, status, timeout, 'client.checks.wait'), {
            jobIds: [jobId],
            timeout,
          });
        }
        await this.#client._sleep(deadline === null ? POLL_INTERVAL : Math.min(POLL_INTERVAL, deadline - now), signal);
        const job = await this.get(jobId, { signal });
        if (!ACTIVE.has(job.status)) return resultOf(job);
        status = job.status;
      }
    } catch (error) {
      nameJobs(error, [jobId]);
      throw error;
    }
  }

  /** @internal `POST /v1/verify`, then the wait for a check the API is still running. */
  async _verify(email: string, start: StartCheck): Promise<Result | PendingCheck> {
    const json: Record<string, unknown> = { email: checkEmail(email) };
    if (start.forceRecheck) json['force_recheck'] = true;
    // Once sent, the POST is let finish even if the caller aborts, so the check it made is known and named.
    const answer = await this.#client._request({
      method: 'POST',
      path: '/v1/verify',
      json,
      idempotencyKey: await idempotencyKey(start.idempotencyKey),
      signal: start.signal,
      finishOnAbort: true,
    });
    const started = startedOf(answer);
    const jobIds = typeof started.job_id === 'string' ? [started.job_id] : [];
    if (jobIds[0] !== undefined) start.made?.(jobIds[0]);
    if (start.signal?.aborted) throw new APIUserAbortError(undefined, { jobIds, cause: start.signal.reason });
    if (answer.status !== 202 || !start.wait) return started;
    return this._wait((started as PendingCheck).job_id, start.deadline, start.timeout, false, start.signal);
  }

  /** @internal `verifyMany`: up to 10 checks together, or one list. */
  async _many(emails: readonly string[], timeout: number | null, signal?: AbortSignal): Promise<Result[]> {
    const addresses = checkEmails(emails);
    const deadline = timeout === null ? null : this.#client._now() + timeout;
    if (addresses.length > SINGLES_AT_MOST) return this.#asList(addresses, deadline, timeout, signal);

    const made: (string | undefined)[] = addresses.map(() => undefined);
    const checks: Promise<Result>[] = [];
    let interrupted: { error: unknown } | undefined;
    for (let index = 0; index < addresses.length; index++) {
      if (index > 0) {
        try {
          await this.#client._sleep(SINGLES_APART, signal);
        } catch (error) {
          interrupted = { error };
          break;
        }
      }
      const remaining = deadline === null ? null : Math.max(0, deadline - this.#client._now());
      const check = this._verify(addresses[index]!, {
        forceRecheck: false,
        wait: true,
        deadline,
        timeout: remaining,
        made: (jobId) => {
          made[index] = jobId;
        },
        signal,
      });
      // Handled now: a check that fails while the others are still being started is not an unhandled rejection.
      check.catch(() => undefined);
      checks.push(check as Promise<Result>);
    }
    // Every check started ends (each by its result, its error or the signal) before anything is thrown, so every job
    // id made is known.
    const outcomes = await Promise.allSettled(checks);
    const jobIds = made.filter((jobId): jobId is string => jobId !== undefined);
    if (interrupted !== undefined) {
      nameJobs(interrupted.error, jobIds, true);
      throw interrupted.error;
    }
    const results: Result[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        // The first error in input order, naming every job the call made.
        nameJobs(outcome.reason, jobIds, true);
        throw outcome.reason;
      }
      results.push(outcome.value);
    }
    return results;
  }

  async #asList(emails: string[], deadline: number | null, timeout: number | null, signal?: AbortSignal): Promise<Result[]> {
    const lists = this.#client.lists;
    // As a check's POST, the list's is let finish if the caller aborts, so the list is named.
    const created = await lists._create({ emails, signal }, true);
    try {
      const job = await lists._wait(created.id, deadline, timeout, signal);
      if (job.status !== 'done') throw new VerifyInboxesError(`The list ${created.id} ended ${job.status}.`);
      const rows = new Map<number, ResultRow>();
      for await (const row of lists.results(created.id, { signal })) rows.set(row.row, row);
      // Row i is emails[i - 1].
      return emails.map((email, index) => {
        const row = rows.get(index + 1);
        if (row === undefined) {
          throw new VerifyInboxesError(`The list ${created.id} has no result for row ${index + 1} (${email}).`);
        }
        const { row: _row, ...result } = row;
        return { ...result, job_id: created.id };
      });
    } catch (error) {
      nameJobs(error, [created.id], true);
      throw error;
    }
  }
}

function jobOf(data: unknown): Job {
  if (typeof data !== 'object' || data === null || typeof (data as Job).id !== 'string') {
    throw new VerifyInboxesError('The API answered a job without its id.');
  }
  return data as Job;
}

/** A finished check's result, naming its job. */
function resultOf(job: Job): Result {
  if (typeof job.result !== 'object' || job.result === null) {
    throw new VerifyInboxesError(`The check ${job.id} ended ${job.status} without a result.`, { jobIds: [job.id] });
  }
  return { ...job.result, job_id: job.id };
}

function startedOf(answer: Answer): Result | PendingCheck {
  const data = answer.data as Record<string, unknown> | null;
  if (answer.status === 202) {
    if (typeof data?.['job_id'] !== 'string' || data['job_id'] === '') {
      throw new VerifyInboxesError('The API answered 202 to a check without its job_id.');
    }
    return data as unknown as PendingCheck;
  }
  if (typeof data !== 'object' || data === null) throw new VerifyInboxesError(`The API answered ${answer.status} to a check without its result.`);
  return data as unknown as Result;
}
