/**
 * A smoke test against the real API, run weekly by `.github/workflows/smoke.yml`.
 *
 * Skipped unless `VERIFYINBOXES_SMOKE_API_KEY` holds a key (it spends a few credits). `VERIFYINBOXES_BASE_URL` points
 * it elsewhere than production.
 */
import { expect, it } from 'vitest';

import { VerifyInboxes } from '../src';

const KEY = process.env['VERIFYINBOXES_SMOKE_API_KEY'] ?? '';
const ADDRESSES = ['verify@verifyinboxes.com', 'support@verifyinboxes.com'];

it.skipIf(!KEY)('works against the real API', async () => {
  const client = new VerifyInboxes({ apiKey: KEY });

  const account = await client.account.get();
  expect(account.name).toBeTruthy();

  const result = await client.verify('verify@verifyinboxes.com');
  expect(result.verdict).not.toBe('invalid');
  expect(result.job_id).toBeTruthy();

  const created = await client.lists.create({ emails: ADDRESSES });
  const job = await client.lists.wait(created.id, { timeout: 15 * 60_000 });
  expect(job.status).toBe('done');
  const rows = await client.lists.results(created.id).toArray();
  expect(rows.map((row) => row.email).sort()).toEqual([...ADDRESSES].sort());
}, 20 * 60_000);
