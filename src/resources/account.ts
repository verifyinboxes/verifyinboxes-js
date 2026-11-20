import type { RequestOptions, VerifyInboxes } from '../client';
import type { Account } from '../types';

/** The organisation the key belongs to. */
export class AccountResource {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /** `GET /v1/account`: the organisation's name, balance and switches. */
  async get(options: RequestOptions = {}): Promise<Account> {
    return (await this.#client._request({ method: 'GET', path: '/v1/account', signal: options.signal })).data as Account;
  }
}
