import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDb, jsonResponse, makeEnv, seedSubscriber, signIn, stubFetch, worker } from './helpers.js';

function formCalls(stub, path) {
  return stub.calls.filter((call) => new URL(call.url).pathname === path);
}

test('checkout creates a trial subscription session and reuses a known customer', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db, { stripe_customer_id: 'cus_existing', plan: 'free', status: 'active' });
  const stub = stubFetch(async ({ url, opts }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/prices') {
      assert.equal(parsed.searchParams.get('lookup_keys[]'), 'cheaprides_yearly');
      return jsonResponse({ data: [{ id: 'price_1SxYearly', lookup_key: 'cheaprides_yearly' }] });
    }
    if (parsed.pathname === '/v1/checkout/sessions') {
      assert.equal(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.equal(opts.headers.Authorization, 'Bearer sk_test_123');
      return jsonResponse({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    }
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Ada@Example.com', plan: 'yearly' }),
      }),
      env
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_test_1');
    const params = new URLSearchParams(formCalls(stub, '/v1/checkout/sessions')[0].opts.body);
    assert.equal(params.get('mode'), 'subscription');
    assert.equal(params.get('customer'), 'cus_existing');
    assert.equal(params.get('customer_email'), null);
    assert.equal(params.get('line_items[0][price]'), 'price_1SxYearly');
    assert.equal(params.get('line_items[0][quantity]'), '1');
    assert.equal(params.get('subscription_data[trial_period_days]'), '7');
    assert.equal(params.get('payment_method_collection'), 'always');
    assert.equal(params.get('metadata[plan]'), 'yearly');
    assert.equal(params.get('metadata[email]'), 'ada@example.com');
    assert.equal(
      params.get('success_url'),
      'https://cheaprides.406truckdrops.com/checkout/success?session_id={CHECKOUT_SESSION_ID}'
    );
    assert.equal(params.get('cancel_url'), 'https://cheaprides.406truckdrops.com/checkout/cancel');
  } finally {
    stub.restore();
  }
});

test('checkout uses customer_email when Stripe has no customer yet', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  const stub = stubFetch(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/prices') {
      return jsonResponse({ data: [{ id: 'price_1SxMonthly', lookup_key: 'cheaprides_monthly' }] });
    }
    if (parsed.pathname === '/v1/customers') {
      return jsonResponse({ data: [] });
    }
    if (parsed.pathname === '/v1/checkout/sessions') {
      return jsonResponse({ id: 'cs_test_2', url: 'https://checkout.stripe.com/c/pay/cs_test_2' });
    }
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com', plan: 'monthly' }),
      }),
      env
    );
    assert.equal(res.status, 200);
    const params = new URLSearchParams(formCalls(stub, '/v1/checkout/sessions')[0].opts.body);
    assert.equal(params.get('customer'), null);
    assert.equal(params.get('customer_email'), 'new@example.com');
    assert.equal(params.get('line_items[0][price]'), 'price_1SxMonthly');
  } finally {
    stub.restore();
  }
});

test('portal requires a session and redirects to Stripe', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'ada@example.com' });
  const anonymous = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/api/portal'), env);
  assert.equal(anonymous.status, 401);

  await seedSubscriber(db, { stripe_customer_id: 'cus_portal' });
  const cookie = await signIn(env, 'ada@example.com');
  const stub = stubFetch(async ({ url, opts }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/billing_portal/sessions') {
      assert.equal(opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const params = new URLSearchParams(opts.body);
      assert.equal(params.get('customer'), 'cus_portal');
      assert.equal(params.get('return_url'), 'https://cheaprides.406truckdrops.com/account');
      return jsonResponse({ url: 'https://billing.stripe.com/p/session/test_123' });
    }
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/portal', { headers: { cookie } }),
      env
    );
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), 'https://billing.stripe.com/p/session/test_123');
  } finally {
    stub.restore();
  }
});
