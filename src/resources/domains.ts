import type { RequestOptions, VerifyInboxes } from '../client';
import { pathSegment } from '../internal';
import type { Domain } from '../types';

/** What is known about a domain. */
export class Domains {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /** `GET /v1/domains/{domain}`: its provider, mail servers, catch-all and address pattern (1 credit). */
  async get(domain: string, options: RequestOptions = {}): Promise<Domain> {
    const path = `/v1/domains/${pathSegment(domain, 'domain')}`;
    return (await this.#client._request({ method: 'GET', path, signal: options.signal })).data as Domain;
  }
}
