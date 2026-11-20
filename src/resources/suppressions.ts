import type { RequestOptions, VerifyInboxes } from '../client';
import { VerifyInboxesError } from '../errors';
import { checkList, randomUUID } from '../internal';
import type { SuppressionList } from '../types';

export interface SuppressionChange extends RequestOptions {
  /** Addresses. */
  emails?: readonly string[] | undefined;
  /** Domains: every address on them. */
  domains?: readonly string[] | undefined;
}

/** Addresses and domains never to check: a check of one is answered `invalid` (`suppressed`), free. */
export class Suppressions {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /** `GET /v1/suppressions`: the domains on the list, and how many addresses (kept only as a hash). */
  async list(options: RequestOptions = {}): Promise<SuppressionList> {
    return (await this.#client._request({ method: 'GET', path: '/v1/suppressions', signal: options.signal })).data as SuppressionList;
  }

  /** `POST /v1/suppressions`: never check these addresses and domains again. Returns how many were added. */
  async add(change: SuppressionChange): Promise<number> {
    const answer = await this.#client._request({
      method: 'POST',
      path: '/v1/suppressions',
      json: body(change),
      idempotencyKey: await randomUUID(),
      signal: change.signal,
    });
    return count(answer.data, 'added');
  }

  /** `DELETE /v1/suppressions`. Returns how many were removed. */
  async remove(change: SuppressionChange): Promise<number> {
    const answer = await this.#client._request({ method: 'DELETE', path: '/v1/suppressions', json: body(change), signal: change.signal });
    return count(answer.data, 'removed');
  }
}

function body(change: SuppressionChange): Record<string, string[]> {
  const emails = checkList(change?.emails, 'emails');
  const domains = checkList(change?.domains, 'domains');
  const out: Record<string, string[]> = {};
  if (emails.length > 0) out['emails'] = emails;
  if (domains.length > 0) out['domains'] = domains;
  if (Object.keys(out).length === 0) throw new TypeError('give emails, domains or both');
  return out;
}

function count(data: unknown, name: string): number {
  const value = (data as Record<string, unknown> | null)?.[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new VerifyInboxesError(`The API answered without ${name}.`);
  return value;
}
