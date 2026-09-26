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

test('checkout rejects a second subscription for a live paid email', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  async function post(email) {
    return worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, plan: 'monthly' }),
      }),
      env
    );
  }
  const stub = stubFetch(async () => {
    throw new Error('stripe should not be called');
  });
  try {
    await seedSubscriber(db, {
      email: 'live@example.com',
      plan: 'monthly',
      status: 'active',
      paid_until: future,
      stripe_customer_id: 'cus_live',
      stripe_subscription_id: 'sub_live',
    });
    const live = await post('Live@Example.com');
    assert.equal(live.status, 409);
    assert.equal((await live.json()).error, 'You already have a subscription. Manage billing at /account.');

    await seedSubscriber(db, {
      email: 'lapsed-active@example.com',
      plan: 'yearly',
      status: 'active',
      paid_until: past,
      stripe_customer_id: 'cus_lapsed_active',
      stripe_subscription_id: 'sub_lapsed_active',
    });
    const stillActive = await post('lapsed-active@example.com');
    assert.equal(stillActive.status, 409);

    await seedSubscriber(db, {
      email: 'ahead@example.com',
      plan: 'monthly',
      status: 'past_due',
      paid_until: future,
      stripe_customer_id: 'cus_ahead',
      stripe_subscription_id: 'sub_ahead',
    });
    const ahead = await post('ahead@example.com');
    assert.equal(ahead.status, 409);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }

  await seedSubscriber(db, {
    email: 'expired@example.com',
    plan: 'monthly',
    status: 'past_due',
    paid_until: past,
    stripe_customer_id: 'cus_expired',
    stripe_subscription_id: 'sub_expired',
  });
  const open = stubFetch(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/prices') {
      return jsonResponse({ data: [{ id: 'price_1SxMonthly', lookup_key: 'cheaprides_monthly' }] });
    }
    if (parsed.pathname === '/v1/customers') return jsonResponse({ data: [] });
    if (parsed.pathname === '/v1/checkout/sessions') {
      return jsonResponse({ id: 'cs_ok', url: 'https://checkout.stripe.com/c/pay/cs_ok' });
    }
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = await post('expired@example.com');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_ok');
  } finally {
    open.restore();
  }
});

test('sms checkout is rejected unless SMS_ENABLED is exactly true', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  const blocked = stubFetch(async () => {
    throw new Error('stripe should not be called');
  });
  try {
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
      if (flag === undefined) delete env.SMS_ENABLED;
      else env.SMS_ENABLED = flag;
      const res = await worker.fetch(
        new Request('https://cheaprides.406truckdrops.com/api/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'ada@example.com', plan: 'sms' }),
        }),
        env
      );
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'SMS is not available yet');
    }
    assert.equal(blocked.calls.length, 0);
    const config = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/api/config'), env);
    assert.equal(config.status, 200);
    assert.equal((await config.json()).sms_enabled, false);
  } finally {
    blocked.restore();
  }

  env.SMS_ENABLED = 'true';
  const stub = stubFetch(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/prices') {
      assert.equal(parsed.searchParams.get('lookup_keys[]'), 'cheaprides_sms_monthly');
      return jsonResponse({ data: [{ id: 'price_sms', lookup_key: 'cheaprides_sms_monthly' }] });
    }
    if (parsed.pathname === '/v1/customers') return jsonResponse({ data: [] });
    if (parsed.pathname === '/v1/checkout/sessions') {
      return jsonResponse({ id: 'cs_sms', url: 'https://checkout.stripe.com/c/pay/cs_sms' });
    }
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com', plan: 'sms' }),
      }),
      env
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_sms');
    const params = new URLSearchParams(formCalls(stub, '/v1/checkout/sessions')[0].opts.body);
    assert.equal(params.get('line_items[0][price]'), 'price_sms');
    assert.equal(params.get('metadata[plan]'), 'sms');
    const config = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/api/config'), env);
    assert.equal((await config.json()).sms_enabled, true);
  } finally {
    stub.restore();
  }
});

test('checkout logs the stripe error type and code without secrets', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.join(' '));
  };
  const stub = stubFetch(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/prices') {
      return jsonResponse(
        {
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            message: 'No such price: cheaprides_monthly',
          },
        },
        400
      );
    }
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com', plan: 'monthly' }),
      }),
      env
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'No such price: cheaprides_monthly');
    const log = lines.join('\n');
    assert.match(log, /\[cheaprides checkout\]/);
    assert.match(log, /type=invalid_request_error/);
    assert.match(log, /code=resource_missing/);
    assert.doesNotMatch(log, /sk_test|whsec_|Bearer/);
  } finally {
    stub.restore();
    console.error = original;
  }
});

test('checkout replaces a stripe message that contains a secret', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  const lines = [];
  const original = console.error;
  console.error = (...args) => {
    lines.push(args.join(' '));
  };
  const stub = stubFetch(async () =>
    jsonResponse(
      {
        error: {
          type: 'api_error',
          code: 'secret_leaked',
          message: 'refused key sk_test_123',
        },
      },
      400
    )
  );
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com', plan: 'yearly' }),
      }),
      env
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'Checkout could not be started. Try again in a minute.');
    assert.doesNotMatch(body.error, /sk_test/);
    const log = lines.join('\n');
    assert.match(log, /type=api_error/);
    assert.match(log, /code=secret_leaked/);
    assert.doesNotMatch(log, /sk_test/);
  } finally {
    stub.restore();
    console.error = original;
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
