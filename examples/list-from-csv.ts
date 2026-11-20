/**
 * Verify a CSV of addresses as a list: start it, wait for it, read the results, download the CSV with them.
 *
 *   export VERIFYINBOXES_API_KEY="bv_..."
 *   node list-from-csv.ts prospects.csv email      # Node 22.18 or later runs TypeScript as it is
 */
import VerifyInboxes from 'verifyinboxes';

async function main(args: string[]): Promise<number> {
  const [path, column = 'email'] = args;
  if (path === undefined) {
    console.error('usage: node list-from-csv.ts FILE.csv [EMAIL_COLUMN]');
    return 2;
  }
  const client = new VerifyInboxes();

  const created = await client.lists.create({ file: path, emailColumn: column });
  console.log(`list ${created.id}: ${created.total} addresses`);

  // A few hundred addresses take minutes, Microsoft-hosted ones longer. If this stops, the list carries on: wait for
  // it again with client.lists.wait(created.id).
  const job = await client.lists.wait(created.id);
  console.log(`${job.status}: ${JSON.stringify(job.counts ?? {})}`);

  const verdicts = new Map<string, number>();
  const safe: string[] = [];
  for await (const row of client.lists.results(created.id)) {
    verdicts.set(row.verdict, (verdicts.get(row.verdict) ?? 0) + 1);
    if (row.safe_to_send) safe.push(row.email);
  }
  console.log(`${safe.length} safe to send; by verdict: ${JSON.stringify(Object.fromEntries(verdicts))}`);

  const written = await client.lists.downloadToFile(created.id, 'results.csv');
  console.log(`saved results.csv (${written} bytes)`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
