import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyStripeSignature } from '../public/_worker.js';
import {
  countRows,
  createTestDb,
  getSubscriber,
  jsonResponse,
  loadFixture,
  makeEnv,
  postWebhook,
  seedSubscriber,
  stubFetch,
  stripeHeader,
} from './helpers.js';

const TRIAL_END = 1893456000;

function subscriptionStub(subscription) {
  return stubFetch(async ({ url }) => {
    const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
    if (new URL(url).pathname.startsWith('/v1/subscriptions/') && id === subscription.id) {
      return jsonResponse(subscription);
    }
    throw new Error('unexpected fetch ' + url);
  });
}

test('stripe signature accepts a valid header', async () => {
  const payload = JSON.stringify({ id: 'evt_valid' });
  const secret = 'whsec_test_secret';
  const timestamp = Math.floor(Date.now() / 1000);
  const header = await stripeHeader(payload, secret, timestamp);
  assert.equal(await verifyStripeSignature(payload, header, secret), true);
});

test('stripe signature rejects a tampered body', async () => {
  const payload = JSON.stringify({ id: 'evt_valid' });
  const secret = 'whsec_test_secret';
  const timestamp = Math.floor(Date.now() / 1000);
  const header = await stripeHeader(payload, secret, timestamp);
  assert.equal(await verifyStripeSignature(payload + '\n', header, secret), false);
});

test('stripe signature rejects an expired timestamp', async () => {
  const payload = JSON.stringify({ id: 'evt_old' });
  const secret = 'whsec_test_secret';
  const timestamp = Math.floor(Date.now() / 1000) - 301;
  const header = await stripeHeader(payload, secret, timestamp);
  assert.equal(await verifyStripeSignature(payload, header, secret), false);
});

test('stripe signature rejects a timestamp too far in the future', async () => {
  const payload = JSON.stringify({ id: 'evt_future' });
  const secret = 'whsec_test_secret';
  const timestamp = Math.floor(Date.now() / 1000) + 301;
  const header = await stripeHeader(payload, secret, timestamp);
  assert.equal(await verifyStripeSignature(payload, header, secret), false);
});

test('webhook HTTP rejects tampered and expired signatures without writing', async () => {
  const { sqlite, db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db, { plan: 'free', status: 'pending', email_confirmed: 0, paid_until: null, trial_end: null, stripe_customer_id: null, stripe_subscription_id: null });
  const event = loadFixture('checkout.session.completed.json');

  const tampered = await postWebhook(env, event, { tamper: true });
  assert.equal(tampered.status, 400);
  const expired = await postWebhook(env, event, { secondsAgo: 301 });
  assert.equal(expired.status, 400);
  const missing = await postWebhook(env, event, { secret: 'whsec_other' });
  assert.equal(missing.status, 400);

  assert.equal(countRows(sqlite, 'stripe_events'), 0);
  const row = await getSubscriber(db);
  assert.equal(row.plan, 'free');
  assert.equal(row.stripe_customer_id, null);
});

test('checkout.session.completed starts a trial on the subscriber', async () => {
  const { sqlite, db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db, {
    plan: 'free',
    status: 'pending',
    email_confirmed: 0,
    paid_until: null,
    trial_end: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
  });
  const stub = subscriptionStub(loadFixture('subscription-trialing.json'));
  try {
    const res = await postWebhook(env, loadFixture('checkout.session.completed.json'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.received, true);
    assert.equal(countRows(sqlite, 'subscribers'), 1);
    const row = await getSubscriber(db);
    assert.equal(row.plan, 'monthly');
    assert.equal(row.status, 'active');
    assert.equal(row.email_confirmed, 1);
    assert.equal(row.stripe_customer_id, 'cus_SxAdaLovelace');
    assert.equal(row.stripe_subscription_id, 'sub_1SxCheapMonthly');
    const trialIso = new Date(TRIAL_END * 1000).toISOString();
    assert.equal(row.paid_until, trialIso);
    assert.equal(row.trial_end, trialIso);
    assert.notEqual(row.paid_until, new Date(1894060800 * 1000).toISOString());
  } finally {
    stub.restore();
  }
});

test('invoice.paid moves paid_until to the subscription period end', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db);
  const subscription = loadFixture('subscription-active.json');
  const stub = subscriptionStub(subscription);
  try {
    const res = await postWebhook(env, loadFixture('invoice.paid.json'));
    assert.equal(res.status, 200);
    const row = await getSubscriber(db);
    const periodEnd = subscription.items.data[0].current_period_end;
    assert.equal(row.paid_until, new Date(periodEnd * 1000).toISOString());
    assert.equal(row.trial_end, null);
    assert.equal(row.status, 'active');
    assert.equal(row.plan, 'monthly');
  } finally {
    stub.restore();
  }
});

test('invoice.payment_failed marks the subscriber past_due', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db);
  const stub = stubFetch(async ({ url }) => {
    throw new Error('payment_failed should not call ' + url);
  });
  try {
    const res = await postWebhook(env, loadFixture('invoice.payment_failed.json'));
    assert.equal(res.status, 200);
    const row = await getSubscriber(db);
    assert.equal(row.status, 'past_due');
    assert.equal(row.plan, 'monthly');
    assert.equal(row.paid_until, '2030-01-01T00:00:00.000Z');
    assert.equal(row.stripe_subscription_id, 'sub_1SxCheapMonthly');
  } finally {
    stub.restore();
  }
});

test('customer.subscription.deleted drops the subscriber to the free plan', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db);
  const stub = stubFetch(async ({ url }) => {
    throw new Error('deleted should not call ' + url);
  });
  try {
    const res = await postWebhook(env, loadFixture('customer.subscription.deleted.json'));
    assert.equal(res.status, 200);
    const row = await getSubscriber(db);
    assert.equal(row.plan, 'free');
    assert.equal(row.status, 'active');
    assert.equal(row.paid_until, null);
    assert.equal(row.trial_end, null);
    assert.equal(row.stripe_subscription_id, null);
    assert.equal(row.stripe_customer_id, 'cus_SxAdaLovelace');
    assert.equal(row.email_confirmed, 1);
  } finally {
    stub.restore();
  }
});

test('customer.subscription.updated refreshes plan and paid_until from the price', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db);
  const event = loadFixture('customer.subscription.updated.json');
  const stub = stubFetch(async ({ url }) => {
    throw new Error('updated should not call ' + url);
  });
  try {
    const res = await postWebhook(env, event);
    assert.equal(res.status, 200);
    const row = await getSubscriber(db);
    const periodEnd = event.data.object.items.data[0].current_period_end;
    assert.equal(row.plan, 'yearly');
    assert.equal(row.status, 'active');
    assert.equal(row.paid_until, new Date(periodEnd * 1000).toISOString());
    assert.equal(row.trial_end, null);
    assert.equal(row.stripe_subscription_id, 'sub_1SxCheapMonthly');
  } finally {
    stub.restore();
  }
});

test('webhook delivery is idempotent by event id', async () => {
  const { sqlite, db } = createTestDb();
  const env = makeEnv(db);
  await seedSubscriber(db, {
    plan: 'free',
    status: 'pending',
    email_confirmed: 0,
    paid_until: null,
    trial_end: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
  });
  const event = loadFixture('checkout.session.completed.json');
  const stub = subscriptionStub(loadFixture('subscription-trialing.json'));
  try {
    const first = await postWebhook(env, event);
    assert.equal(first.status, 200);
    await db.prepare("UPDATE subscribers SET plan = 'yearly', paid_until = '1999-01-01T00:00:00.000Z' WHERE email = ?")
      .bind('ada@example.com')
      .run();
    const second = await postWebhook(env, event);
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.duplicate, true);
    assert.equal(countRows(sqlite, 'stripe_events'), 1);
    const row = await getSubscriber(db);
    assert.equal(row.plan, 'yearly');
    assert.equal(row.paid_until, '1999-01-01T00:00:00.000Z');
  } finally {
    stub.restore();
  }
});
