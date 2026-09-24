import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAccountUsage, formatAccountUsage, formatReset, startUpgrade, startCreditTopUp,
  redeemCreditCode, savedKeyIsActive,
} from '../src/services/account/accountClient.js';
import { openUrl } from '../src/utils/openUrl.js';

// Shaped like the Worker's GET /account response (getAccountProfile in
// api-proxy-cf/src/index.js).
const ACCOUNT_BODY = {
  plan: 'free',
  credits: { balance_microdollars: 1_250_000, balance_usd: 1.25 },
  usage: {
    weekly_included_percent_used: 40,
    weekly_reset_at: '2026-09-30T12:00:00.000Z',
    window_included_percent_used: 12,
    window_reset_at: '2026-09-24T15:00:00.000Z',
    window_hours: 5,
    weekly_included_used_usd: 0.025,
  },
};

function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test('fetchAccountUsage maps /account the same way Desktop does, with the session token', async () => {
  const calls = [];
  const { usage, error } = await fetchAccountUsage('session-tok', fakeFetch(200, ACCOUNT_BODY, calls));
  assert.equal(error, null);
  assert.equal(calls[0].url, 'https://api.sennoric.com/account');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer session-tok');
  assert.deepEqual(usage, {
    plan: 'free', creditBalanceUsd: 1.25,
    weeklyPercentUsed: 40, weeklyResetAt: '2026-09-30T12:00:00.000Z',
    windowPercentUsed: 12, windowHours: 5, windowResetAt: '2026-09-24T15:00:00.000Z',
  });
});

test('a 401 from /account reports an expired sign-in', async () => {
  const result = await fetchAccountUsage('old', fakeFetch(401, { error: 'Not authenticated' }));
  assert.equal(result.usage, null);
  assert.equal(result.expired, true);
  assert.match(result.error, /\/login/);
});

test('no session token never touches the network', async () => {
  const result = await fetchAccountUsage(null, () => { throw new Error('should not fetch'); });
  assert.match(result.error, /Not signed in/);
});

test('the usage summary shows percentages and resets, and never the metered dollar allowance', async () => {
  const { usage } = await fetchAccountUsage('t', fakeFetch(200, ACCOUNT_BODY));
  const text = formatAccountUsage(usage, { email: 'a@b.c', now: Date.parse('2026-09-24T12:00:00.000Z') });
  assert.match(text, /a@b\.c/);
  assert.match(text, /plan\s+Free/);
  assert.match(text, /credits\s+\$1\.25/);
  assert.match(text, /5-hour .* 12%\s+resets in 3 hours/);
  assert.match(text, /weekly .* 40%\s+resets on Sep 30/);
  assert.doesNotMatch(text, /0\.025/);
  assert.match(text, /\/upgrade/);
});

test('formatReset handles past, near and far timestamps', () => {
  const now = Date.parse('2026-09-24T12:00:00.000Z');
  assert.equal(formatReset(null, now), null);
  assert.equal(formatReset('2026-09-24T11:00:00.000Z', now), 'soon');
  assert.equal(formatReset('2026-09-24T12:30:00.000Z', now), 'in 30 minutes');
  assert.equal(formatReset('2026-09-24T13:00:00.000Z', now), 'in 1 hour');
});

test('billing actions POST to the Worker and return its checkout URL, or its error text', async () => {
  const calls = [];
  const ok = await startUpgrade('t', fakeFetch(200, { url: 'https://checkout.stripe.com/c/pay/x' }, calls));
  assert.equal(calls[0].url, 'https://api.sennoric.com/billing/checkout');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual([ok.ok, ok.url], [true, 'https://checkout.stripe.com/c/pay/x']);

  const already = await startUpgrade('t', fakeFetch(400, { error: 'Already on Pro' }));
  assert.deepEqual([already.ok, already.error], [false, 'Already on Pro']);
});

test('credit top-up validates the amount range before calling the Worker', async () => {
  const bad = await startCreditTopUp('t', 2, () => { throw new Error('should not fetch'); });
  assert.match(bad.error, /between \$5 and \$500/);
  const calls = [];
  await startCreditTopUp('t', '20', fakeFetch(200, { url: 'https://checkout.stripe.com/x' }, calls));
  assert.equal(calls[0].url, 'https://api.sennoric.com/billing/credits/checkout');
  assert.deepEqual(JSON.parse(calls[0].init.body), { amount_usd: 20 });
});

test('redeeming a code reports the granted amount and new balance', async () => {
  const r = await redeemCreditCode('t', ' SENNORIC-ABC ', fakeFetch(200, { ok: true, granted_usd: 5, balance_usd: 6.25 }));
  assert.deepEqual([r.ok, r.grantedUsd, r.balanceUsd], [true, 5, 6.25]);
  const bad = await redeemCreditCode('t', 'X', fakeFetch(400, { error: 'This code is not valid.' }));
  assert.equal(bad.error, 'This code is not valid.');
});

test('savedKeyIsActive matches the Worker masked key format', () => {
  const key = 'sennoric-sk-0123456789abcdef';
  const masked = `${key.slice(0, 10)}...${key.slice(-4)}`;
  assert.equal(savedKeyIsActive(key, [{ key_value: masked }]), true);
  assert.equal(savedKeyIsActive(key, [{ key_value: 'sennoric-s...zzzz' }]), false);
  assert.equal(savedKeyIsActive(null, [{ key_value: masked }]), false);
});

test('openUrl refuses non-http(s) URLs and never goes through a shell', () => {
  const spawned = [];
  const fakeSpawn = (cmd, args) => { spawned.push([cmd, args]); return { unref() {}, on() {} }; };
  assert.equal(openUrl('javascript:alert(1)', fakeSpawn), false);
  assert.equal(openUrl('file:///etc/passwd', fakeSpawn), false);
  assert.equal(spawned.length, 0);
  assert.equal(openUrl('https://checkout.stripe.com/pay?a=1&b=2', fakeSpawn), true);
  assert.notEqual(spawned[0][0], 'cmd');
  assert.ok(spawned[0][1].includes('https://checkout.stripe.com/pay?a=1&b=2'));
});
