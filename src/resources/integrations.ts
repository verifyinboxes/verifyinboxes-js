import type { RequestOptions, VerifyInboxes } from '../client';
import { hideSecret, pathSegment, randomUUID } from '../internal';
import type { FeedbackProvider, Integration, IntegrationCreated } from '../types';

export interface IntegrationCreateOptions extends RequestOptions {
  /** Your name for it. */
  label?: string | undefined;
  /** The provider's webhook signing secret, when it signs what it sends. */
  signingSecret?: string | undefined;
}

/** Addresses to paste into Instantly or Smartlead, which then report what became of your mail. */
export class Integrations {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /**
   * `POST /v1/integrations`: an address (`url`, shown only once) to paste into the provider. Not sent again once it
   * may have arrived: after an {@link APIConnectionError}, look at `integrations.list()` before making another.
   */
  async create(provider: FeedbackProvider, options: IntegrationCreateOptions = {}): Promise<IntegrationCreated> {
    if (typeof provider !== 'string' || provider === '') throw new TypeError('provider must be instantly or smartlead');
    const json: Record<string, unknown> = { provider };
    if (options.label !== undefined && options.label !== null) json['label'] = options.label;
    if (options.signingSecret !== undefined && options.signingSecret !== null) json['signing_secret'] = options.signingSecret;
    const answer = await this.#client._request({
      method: 'POST',
      path: '/v1/integrations',
      json,
      idempotencyKey: await randomUUID(),
      retry: 'unsent',
      signal: options.signal,
    });
    return hideSecret(answer.data as IntegrationCreated, 'url');
  }

  /** `GET /v1/integrations`. */
  async list(options: RequestOptions = {}): Promise<Integration[]> {
    const { data } = await this.#client._request({ method: 'GET', path: '/v1/integrations', signal: options.signal });
    return Array.isArray(data) ? (data as Integration[]) : [];
  }

  /** `DELETE /v1/integrations/{id}`. */
  async delete(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#client._request({ method: 'DELETE', path: `/v1/integrations/${pathSegment(id)}`, goneIsDone: true, signal: options.signal });
  }
}
