/**
 * Receive VerifyInboxes webhooks: check the signature before anything else, then read the event.
 *
 *   export VERIFYINBOXES_WEBHOOK_SECRET="..."      # the secret webhooks.create returned
 *   node webhook-receiver.ts 8000                  # Node 22.18 or later runs TypeScript as it is
 *
 * Put it behind HTTPS (the API calls only https:// addresses), and register its address with
 * client.webhooks.create('https://example.com/webhooks/verifyinboxes').
 */
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';

import { verifySignature } from 'verifyinboxes';

const SECRET = process.env['VERIFYINBOXES_WEBHOOK_SECRET'] ?? '';

/** The body exactly as it came: the signature is over these bytes, not over JSON parsed and written again. */
async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  const body = await rawBody(request);
  const signature = request.headers['x-boxverifier-signature'];
  if (typeof signature !== 'string' || !(await verifySignature(body, signature, SECRET))) {
    response.writeHead(400).end(); // not from VerifyInboxes, changed on the way, or older than 5 minutes
    return;
  }
  const event = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  if (event['event'] === 'job.completed') {
    console.log(`list ${String(event['job_id'])} is ${String(event['status'])}: ${JSON.stringify(event['counts'])}`);
  } else if (event['event'] === 'address.contradicted') {
    console.log(`${String(event['email'])}: ${String(event['message'])}`);
  }
  // Deliveries come at least once: X-Boxverifier-Delivery is the same on every retry of one.
  response.writeHead(204).end();
});

if (SECRET === '') {
  console.error("set VERIFYINBOXES_WEBHOOK_SECRET to the webhook's secret");
  process.exitCode = 2;
} else {
  server.listen(Number(process.argv[2] ?? 8000));
}
