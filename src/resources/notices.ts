import type { RequestOptions, VerifyInboxes } from '../client';
import type { NoticePage } from '../types';

export interface NoticesListOptions extends RequestOptions {
  /** The `next_after` of the page before: only notices after it. */
  after?: string | undefined;
  /** At most this many, 1 to 500. Default 100. */
  limit?: number | undefined;
}

/** Contradiction notices: verdicts you bought, overturned by what became of mail sent to the address. */
export class Notices {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /**
   * `GET /v1/notices`: contradiction notices, oldest first. Keep the page's `next_after` and send it as `after` next
   * time; a page shorter than `limit` means you have caught up.
   */
  async list(options: NoticesListOptions = {}): Promise<NoticePage> {
    const query: Record<string, string> = {};
    if (options.after !== undefined && options.after !== null) {
      if (typeof options.after !== 'string') throw new TypeError('after must be a notice id');
      query['after'] = options.after;
    }
    if (options.limit !== undefined && options.limit !== null) {
      if (!Number.isInteger(options.limit)) throw new TypeError('limit must be a whole number');
      query['limit'] = String(options.limit);
    }
    return (await this.#client._request({ method: 'GET', path: '/v1/notices', query, signal: options.signal })).data as NoticePage;
  }
}
