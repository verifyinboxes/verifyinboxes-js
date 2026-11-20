/**
 * Check one address, then several at once.
 *
 *   export VERIFYINBOXES_API_KEY="bv_..."
 *   node quickstart.ts ann@example.com bob@example.com      # Node 22.18 or later runs TypeScript as it is
 */
import VerifyInboxes, { VerifyInboxesError } from 'verifyinboxes';

async function main(addresses: string[]): Promise<number> {
  const [first, ...rest] = addresses;
  if (first === undefined) {
    console.error('usage: node quickstart.ts ADDRESS [ADDRESS ...]');
    return 2;
  }
  const client = new VerifyInboxes(); // reads VERIFYINBOXES_API_KEY
  try {
    const result = await client.verify(first);
    console.log(`${result.email}: ${result.verdict} (${result.reason}), safe to send: ${result.safe_to_send}`);

    // Several addresses: verifyMany, never a loop of verify. Up to 10 are checked together; more go as one list.
    if (rest.length > 0) {
      for (const each of await client.verifyMany(rest)) {
        console.log(`${each.email}: ${each.verdict}`);
      }
    }
  } catch (error) {
    if (!(error instanceof VerifyInboxesError)) throw error;
    console.error(error.message); // an API error's message has its status and code, and ends with its request id
    if (error.jobIds.length > 0) {
      // Each job carries on and its credits are held: wait for it again with client.checks.wait(jobId)
      // (a list's with client.lists.wait).
      console.error(`jobs made: ${error.jobIds.join(', ')}`);
    }
    return 1;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
