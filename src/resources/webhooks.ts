import type { RequestOptions, VerifyInboxes } from '../client';
import { hideSecret, pathSegment, randomUUID } from '../internal';
import type { Webhook, WebhookCreated, WebhookEvent } from '../types';
import { verifySignature } from '../webhooks';
import type { VerifySignatureOptions } from '../webhooks';

export interface WebhookCreateOptions extends RequestOptions {
  /** `job.completed`, `address.contradicted`; default both. */
  events?: readonly WebhookEvent[] | undefined;
}

/** Where the API sends events: a list finished, a verdict you bought was overturned. */
export class Webhooks {
  readonly #client: VerifyInboxes;

  /** @internal */
  constructor(client: VerifyInboxes) {
    this.#client = client;
  }

  /**
   * `POST /v1/webhooks`: `url` gets the events. The answer's `secret` is shown only once: store it.
   *
   * Not sent again once it may have arrived (a second webhook would be made): after an {@link APIConnectionError},
   * look at `webhooks.list()` before making another.
   */
  async create(url: string, options: WebhookCreateOptions = {}): Promise<WebhookCreated> {
    if (typeof url !== 'string' || url === '') throw new TypeError('url must be an https:// address');
    const json: Record<string, unknown> = { url };
    if (options.events !== undefined && options.events !== null) {
      if (!Array.isArray(options.events)) throw new TypeError('events must be a list of events');
      json['events'] = [...options.events];
    }
    const answer = await this.#client._request({
      method: 'POST',
      path: '/v1/webhooks',
      json,
      idempotencyKey: await randomUUID(),
      retry: 'unsent',
      signal: options.signal,
    });
    return hideSecret(answer.data as WebhookCreated, 'secret');
  }

  /** `GET /v1/webhooks` (never the secrets). */
  async list(options: RequestOptions = {}): Promise<Webhook[]> {
    const { data } = await this.#client._request({ method: 'GET', path: '/v1/webhooks', signal: options.signal });
    return Array.isArray(data) ? (data as Webhook[]) : [];
  }

  /** `DELETE /v1/webhooks/{id}`. */
  async delete(id: string, options: RequestOptions = {}): Promise<void> {
    await this.#client._request({ method: 'DELETE', path: `/v1/webhooks/${pathSegment(id)}`, goneIsDone: true, signal: options.signal });
  }

  /** {@link verifySignature}, here too. */
  verifySignature(
    rawBody: string | Uint8Array | ArrayBuffer,
    header: string,
    secret: string,
    options: VerifySignatureOptions = {},
  ): Promise<boolean> {
    return verifySignature(rawBody, header, secret, options);
  }
}
