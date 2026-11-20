/**
 * The official JavaScript and TypeScript library for the VerifyInboxes API.
 *
 * ```ts
 * import VerifyInboxes from 'verifyinboxes';
 *
 * const client = new VerifyInboxes(); // reads VERIFYINBOXES_API_KEY
 * const result = await client.verify('ann@example.com');
 * console.log(result.verdict, result.safe_to_send);
 * ```
 */
import { VerifyInboxes } from './client';

export default VerifyInboxes;
export { VerifyInboxes } from './client';
export type { ClientOptions, Fetch, RequestOptions, VerifyManyOptions, VerifyOptions } from './client';

export {
  VerifyInboxesError,
  MissingAPIKeyError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  APIError,
  InvalidRequestError,
  AuthenticationError,
  InsufficientCreditsError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServerError,
  WaitTimeoutError,
} from './errors';
export type { APIErrorInit } from './errors';

export { DEFAULT_BASE_URL } from './internal';
export type { FileSource, FilterOptions } from './internal';
export { ResultsIterable } from './pagination';
export { DEFAULT_TOLERANCE_SECONDS, DELIVERY_HEADER, SIGNATURE_HEADER, verifySignature } from './webhooks';
export type { VerifySignatureOptions } from './webhooks';

export { AccountResource } from './resources/account';
export { Checks } from './resources/checks';
export type { CheckWaitOptions } from './resources/checks';
export { Domains } from './resources/domains';
export { Feedback } from './resources/feedback';
export type { FeedbackReportOptions } from './resources/feedback';
export { Integrations } from './resources/integrations';
export type { IntegrationCreateOptions } from './resources/integrations';
export { Lists } from './resources/lists';
export type {
  CreateListOptions,
  DownloadOptions,
  ListWaitOptions,
  ResolveOptions,
  ResultsOptions,
  ResultsPageOptions,
} from './resources/lists';
export { Notices } from './resources/notices';
export type { NoticesListOptions } from './resources/notices';
export { Suppressions } from './resources/suppressions';
export type { SuppressionChange } from './resources/suppressions';
export { Webhooks } from './resources/webhooks';
export type { WebhookCreateOptions } from './resources/webhooks';

export type * from './types';

export { VERSION } from './version';
