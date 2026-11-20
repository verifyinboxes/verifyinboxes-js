import type { RequestOptions, VerifyInboxes } from '../client';
import { idempotencyKey } from '../internal';
import type { FeedbackEvent, FeedbackResult } from '../types';

export interface FeedbackReportOptions extends RequestOptions {
  /** Your own `Idempotency-Key`; default: a new one for the call. */
  idempotencyKey?: string | undefined;
}

/** What became of the mail you sent: bounces, deliveries, replies. */
export class Feedback {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /**
   * `POST /v1/feedback`: what became of mail you sent.
   *
   * ```ts
   * await client.feedback.report([
   *   { email: 'ann@example.com', type: 'hard_bounce', observed_at: '2026-11-04T10:00:00Z', dsn_code: '5.1.1', event_id: 'b-1' },
   * ]);
   * ```
   */
  async report(events: readonly FeedbackEvent[], options: FeedbackReportOptions = {}): Promise<FeedbackResult> {
    if (!Array.isArray(events) || events.some((e) => typeof e !== 'object' || e === null || Array.isArray(e))) {
      throw new TypeError('events must be a list of events');
    }
    const answer = await this.#client._request({
      method: 'POST',
      path: '/v1/feedback',
      json: { events: events.map((e) => ({ ...e })) },
      idempotencyKey: await idempotencyKey(options.idempotencyKey),
      signal: options.signal,
    });
    return answer.data as FeedbackResult;
  }
}
