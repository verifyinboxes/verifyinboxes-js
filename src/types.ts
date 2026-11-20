/**
 * What the VerifyInboxes API returns, named after the schemas of its description.
 *
 * Field names are the API's own (`snake_case`), so what you read here is what the API reference shows. Timestamps
 * are ISO 8601 strings. The API adds fields and values without a new version: a field this version does not know is
 * kept on the object as it came, and a value it does not know (a new verdict, reason or flag) is kept as the plain
 * string it is, never an error. The types of such values say so: `Verdict | (string & {})`.
 */

/** An open set of strings: the ones named, and any the API adds later. */
export type Open<T extends string> = T | (string & {});

/**
 * `valid`: the mailbox exists. `invalid`: it does not, or the address or domain cannot receive mail. `catch_all`:
 * the domain accepts mail for any address, so whether this mailbox exists cannot be confirmed (see `score`). `risky`:
 * it may receive mail, but that could not be confirmed. `unknown`: it could not be checked (free).
 */
export type Verdict = Open<'valid' | 'invalid' | 'catch_all' | 'risky' | 'unknown'>;

/** `disposable`, `role` (`info@`, `sales@`), `free_provider` (a consumer provider), `gateway` (a security gateway). */
export type Flag = Open<'disposable' | 'role' | 'free_provider' | 'gateway'>;

/** The domain's mail provider, from its MX hosts. */
export type Provider = Open<'google' | 'microsoft' | 'proofpoint' | 'mimecast' | 'other'>;

/** `smtp`: our live check. `burner`: a catch-all resolution's test email. `cache`: an earlier result. */
export type Source = Open<'smtp' | 'burner' | 'cache'>;

/** Why the verdict is what it is. */
export type Reason = Open<
  | 'syntax'
  | 'typo'
  | 'no_mail_server'
  | 'dns_error'
  | 'mailbox_exists'
  | 'mailbox_not_found'
  | 'accept_all'
  | 'catch_all_untested'
  | 'mailbox_unconfirmed'
  | 'greylisted'
  | 'unreachable'
  | 'blocked'
  | 'inconclusive'
  | 'no_bounce'
  | 'auto_reply'
  | 'replied'
  | 'bounced'
  | 'known_outcome'
  | 'unresolved'
  | 'domain_swallows'
  | 'suppressed'
>;

/** `running` until every address has a result, then `done`. */
export type JobStatus = Open<'queued' | 'running' | 'done' | 'failed'>;

export type WebhookEvent = Open<'job.completed' | 'address.contradicted'>;

/** The providers an integration reports from. */
export type FeedbackProvider = Open<'instantly' | 'smartlead'>;

/** What became of mail sent to an address. */
export type FeedbackType = Open<'sent' | 'delivered' | 'reply' | 'auto_reply' | 'hard_bounce' | 'soft_bounce' | 'bounce'>;

// --- the account ---------------------------------------------------------------------------------------------------

/** `GET /v1/account`. */
export interface Account {
  name: string;
  /** Credits left; below zero after a refund of credits already spent. */
  balance: number;
  /** Whether what the account reports as feedback counts toward everyone's results. */
  reviewed: boolean;
  /** Whether the account may resolve catch-all addresses (`lists.resolve`). */
  test_emails: boolean;
  safe_to_send_threshold: number;
}

// --- checks --------------------------------------------------------------------------------------------------------

/**
 * One address's result. `job_id` names the job that holds it: the single check of `verify`, or the list of
 * `verifyMany` (11 addresses or more).
 */
export interface Result {
  email: string;
  verdict: Verdict;
  /** For a `catch_all` verdict, the probability that the mailbox exists (0 to 1); else `null`. */
  score: number | null;
  /** Whether to send to it: `valid`, or a `catch_all` whose score reaches your organisation's threshold. */
  safe_to_send: boolean;
  flags: Flag[];
  provider: Provider | null;
  catch_all_domain: boolean | null;
  verified_at: string;
  source: Source;
  reason: Reason;
  /** For a `typo`: the address it probably is. */
  did_you_mean?: string;
  job_id?: string;
}

/** One row of a list's results: the result of its address, and `row`, its number in the CSV (1: the first under the header). */
export interface ResultRow extends Omit<Result, 'job_id'> {
  row: number;
}

/** What `verify(email, { wait: false })` returns for a check still running: wait for it with `checks.wait`. */
export interface PendingCheck {
  /** `pending`. */
  status: Open<'pending'>;
  job_id: string;
}

/** How many rows have each verdict. */
export interface VerdictCounts {
  valid?: number;
  invalid?: number;
  catch_all?: number;
  risky?: number;
  unknown?: number;
}

/** A check, a list or a catch-all resolution (`kind` `single`, `bulk` or `resolve`), as it is now. */
export interface Job {
  id: string;
  kind: Open<'single' | 'bulk' | 'resolve'>;
  status: JobStatus;
  total: number;
  done: number;
  created_at: string;
  finished_at: string | null;
  counts: VerdictCounts | null;
  purged: boolean;
  /** A single check's result, once it is done. */
  result?: Result;
  parent_job_id?: string | null;
  resolve_job_ids?: string[];
  download_url?: string;
}

/** A list, just made. */
export interface JobCreated {
  id: string;
  status: string;
  /** The number of addresses in it. */
  total: number;
}

/** One page of a list's results. */
export interface ResultsPage {
  data: ResultRow[];
  /** The next page's cursor; `null` on the last page. A page may hold fewer rows than asked, even none, before it. */
  next_cursor: string | null;
  complete: boolean;
}

// --- catch-all resolution ------------------------------------------------------------------------------------------

export interface ResolveSkipped {
  ineligible: number;
  excluded: number;
  already_requested: number;
  duplicate: number;
}

/** A resolution, just made: a job of its own (`id`). */
export interface ResolveCreated {
  id: string;
  status: Open<'running' | 'done'>;
  total: number;
  skipped: ResolveSkipped;
}

// --- domains, suppressions -----------------------------------------------------------------------------------------

export interface MxHost {
  host: string;
  preference: number;
}

/** What is known about a domain. */
export interface Domain {
  domain: string;
  provider: Provider | null;
  gateway: boolean;
  accepts_mail: boolean;
  mx_hosts: MxHost[];
  catch_all: boolean | null;
  catch_all_checked_at: string | null;
  email_pattern: string | null;
  pattern_confidence: number | null;
  registered_at: string | null;
}

/** The account's suppression list. Addresses are kept only as a hash, so only their number is told. */
export interface SuppressionList {
  domains: string[];
  address_count: number;
}

// --- webhooks, notices ---------------------------------------------------------------------------------------------

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  created_at: string;
}

/**
 * A webhook, just made. `secret` signs its deliveries and is shown only here: store it. It is left out of what
 * `console.log` and `util.inspect` show, and kept in `JSON.stringify`.
 */
export interface WebhookCreated extends Webhook {
  secret: string;
}

/** The verdict you bought. */
export interface NoticePrevious {
  verdict: Verdict;
  reason: Reason;
  score: number | null;
  safe_to_send: boolean;
  verified_at: string;
}

/** The verdict the address was verified again to; `verified_at` is when that finished. */
export interface NoticeCurrent {
  verdict: Open<'valid' | 'invalid'>;
  reason: Reason;
  verified_at: string;
}

/** What contradicted it. Never whose outreach it was, unless your own (`reported_by_you`). */
export interface NoticeEvidence {
  kind: Open<'hard_bounce' | 'bounce' | 'reply' | 'delivered'>;
  /** The bounce's status code, such as `5.1.1`. */
  dsn_code: string | null;
  /** The UTC day it happened (`YYYY-MM-DD`). */
  observed_at: string;
  reported_by_you: boolean;
}

/** A verdict you bought, overturned by what became of mail sent to the address. */
export interface Notice {
  notice_id: string;
  email: string;
  job_ids: string[];
  previous: NoticePrevious;
  current: NoticeCurrent;
  evidence: NoticeEvidence;
  message: string;
  created_at: string;
}

export interface NoticePage {
  notices: Notice[];
  /** Send it as `after` next time. */
  next_after: string | null;
}

// --- feedback, integrations ----------------------------------------------------------------------------------------

/** What became of mail you sent to an address. */
export interface FeedbackEvent {
  email: string;
  type: FeedbackType;
  /** When it happened, ISO 8601. */
  observed_at: string;
  /** Your own id of the event: the same id sent again counts once. */
  event_id?: string | null;
  dsn_code?: string;
  diagnostic?: string;
}

export interface FeedbackRejection {
  /** The event's position in what you sent, from 0. */
  index: number;
  error: string;
}

export interface FeedbackResult {
  accepted: number;
  duplicates: number;
  ignored: number;
  rejected: FeedbackRejection[];
}

export interface Integration {
  id: string;
  provider: FeedbackProvider;
  label: string | null;
  token_prefix: string;
  created_at: string;
  last_event_at: string | null;
  last_bounce_at: string | null;
  last_error: Open<
    'malformed' | 'no_lead_email' | 'invalid_email' | 'ambiguous_lead' | 'bad_event_id' | 'missing_signature' | 'bad_signature'
  > | null;
  last_error_at: string | null;
  signed: boolean;
}

/**
 * An integration, just made. `url` holds its token and is shown only here: paste it into the provider. It is left out
 * of what `console.log` and `util.inspect` show, and kept in `JSON.stringify`.
 */
export interface IntegrationCreated {
  id: string;
  provider: FeedbackProvider;
  label: string | null;
  url: string;
  created_at: string;
}
