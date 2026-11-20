import { afterEach, expect, it } from 'vitest';

import { VERSION } from '../src';
import pkg from '../package.json';
import { FakeAPI, answerWith, clientOf, exchange } from './fakeapi';

let api: FakeAPI | undefined;
afterEach(async () => {
  await api?.close();
});

it('is the version of the package', () => {
  expect(VERSION).toBe(pkg.version);
  expect(VERSION).toBe('0.1.0');
});

it('names the library and its version in the User-Agent', async () => {
  const account = { name: 'acme', balance: 1, reviewed: false, test_emails: false, safe_to_send_threshold: 0.8 };
  api = await FakeAPI.start([exchange('GET', '/v1/account', answerWith(200, account))]);
  await clientOf(api).account.get();
  expect(api.requests[0]!.headers['user-agent']).toBe(`verifyinboxes-js/${pkg.version}`);
});
