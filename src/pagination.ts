/**
 * Reading a list's results page after page.
 *
 * A page holds at most the rows asked for, and may hold fewer, even none, before the last one: the iterator follows
 * `next_cursor` until it is `null`, whatever a page holds, so every row comes once and in order. A page that fails is
 * asked again with the same cursor (the client's retries). An API that answers the cursor it was just sent would make
 * this go round forever, or repeat rows: that is an error.
 */
import { VerifyInboxesError } from './errors';
import type { ResultRow, ResultsPage } from './types';

/**
 * Every row of a list's results, read a page at a time as you iterate. Nothing is asked until then.
 *
 * ```ts
 * for await (const row of client.lists.results(listId)) console.log(row.email, row.verdict);
 * const rows = await client.lists.results(listId).toArray();
 * ```
 */
export class ResultsIterable implements AsyncIterable<ResultRow> {
  readonly #jobId: string;
  readonly #fetchPage: (cursor: string | null) => Promise<ResultsPage>;

  /** @internal */
  constructor(jobId: string, fetchPage: (cursor: string | null) => Promise<ResultsPage>) {
    this.#jobId = jobId;
    this.#fetchPage = fetchPage;
  }

  /** Every page, from the first to the one whose `next_cursor` is `null`. Stop early with `break`. */
  async *pages(): AsyncGenerator<ResultsPage, void, undefined> {
    let cursor: string | null = null;
    for (;;) {
      const page = await this.#fetchPage(cursor);
      yield page;
      if (page.next_cursor === null || page.next_cursor === undefined) return;
      if (page.next_cursor === cursor) {
        throw new VerifyInboxesError(
          `the API returned the same cursor twice (${JSON.stringify(cursor)}) while listing the results of ${this.#jobId}`,
          { jobIds: [this.#jobId] },
        );
      }
      cursor = page.next_cursor;
    }
  }

  /** Every row, in order. Stop early with `break`: no further page is asked for. */
  async *[Symbol.asyncIterator](): AsyncGenerator<ResultRow, void, undefined> {
    for await (const page of this.pages()) yield* page.data;
  }

  /** Every row, in order, in one array. */
  async toArray(): Promise<ResultRow[]> {
    const rows: ResultRow[] = [];
    for await (const row of this) rows.push(row);
    return rows;
  }
}
