/** The examples, run against the fake API: what they print is what a reader copies. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeAPI, KEY, REQUEST_ID, answerWith, apiError, exchange, resultJSON, singleJobId } from './fakeapi';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('the quickstart', () => {
  it('checks each address once, and names the jobs an error leaves', async () => {
    const check = (email: string, n: number) =>
      exchange('POST', '/v1/verify', answerWith(200, { ...resultJSON(email), job_id: singleJobId(n) }), { json: { email } });
    const api = await FakeAPI.start(
      [
        check('ann@example.com', 1),
        check('bob@example.com', 2),
        exchange('POST', '/v1/verify', answerWith(402, apiError('insufficient_credits', 'the balance is 0')), {
          json: { email: 'cat@example.com' },
        }),
      ],
      { unordered: true },
    );
    cleanups.push(() => api.close());
    vi.stubEnv('VERIFYINBOXES_API_KEY', KEY);
    vi.stubEnv('VERIFYINBOXES_BASE_URL', api.url);
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const argv = process.argv;
    process.argv = [argv[0]!, 'quickstart.ts', 'ann@example.com', 'bob@example.com', 'cat@example.com'];
    try {
      await import('../examples/quickstart');
    } finally {
      process.argv = argv;
    }
    const code = process.exitCode;
    process.exitCode = undefined;

    expect(code).toBe(1);
    // ann is checked once (by verify), not again by verifyMany.
    expect(api.requests.map((r) => (r.json as { email: string }).email)).toEqual([
      'ann@example.com',
      'bob@example.com',
      'cat@example.com',
    ]);
    expect(String(printed.mock.calls[0]?.[0])).toMatch(/^ann@example.com: invalid/);
    const said = errors.mock.calls.map((call) => call.join(' '));
    // The message alone, which ends with the request id: the status and code once.
    expect(said[0]).toBe(`402 insufficient_credits: the balance is 0 (request id ${REQUEST_ID})`);
    // bob's check carries on, its credit held: the error names it.
    expect(said).toContain(`jobs made: ${singleJobId(2)}`);
  });
});
