import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createTestDb,
  getSubscriber,
  jsonResponse,
  makeEnv,
  seedSubscriber,
  signIn,
  stubFetch,
  worker,
} from './helpers.js';

const ADMIN = 'zaylynbyoung@gmail.com';
const PLUS = 'zaylynbyoung+crtest@gmail.com';

function adminEnv(db, overrides = {}) {
  return makeEnv(db, {
    ADMIN_EMAILS: ADMIN,
    EMAIL_ALLOWLIST: ADMIN + ',' + PLUS,
    ...overrides,
  });
}

function sampleListing(overrides = {}) {
  return {
    event: 'new',
    listing_id: 'fb-admin',
    url: 'https://www.facebook.com/marketplace/item/9001',
    title: '2004 Ford Focus',
    year: 2004,
    make: 'Ford',
    model: 'Focus',
    price: 1500,
    previous_price: null,
    drop_flag: false,
    categories: ['beater_commuter'],
    deal_score_text: '2004 Focus, $1,500, about $400 under market.',
    deal_delta_usd: -400,
    city: 'Billings',
    state: 'MT',
    mileage: 210000,
    hero_photo_url: null,
    seen_at: new Date().toISOString(),
    ...overrides,
  };
}

async function checkout(env, email) {
  return worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, plan: 'monthly' }),
    }),
    env
  );
}

test('an admin is permanent and a plus-alias trial is unchanged', async () => {
  const { db, sqlite } = createTestDb();
  const env = adminEnv(db);
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await seedSubscriber(db, {
    email: PLUS,
    plan: 'monthly',
    status: 'active',
    paid_until: future,
    trial_end: future,
    stripe_customer_id: 'cus_crtest',
    stripe_subscription_id: 'sub_crtest',
  });

  const stub = stubFetch(async () => {
    throw new Error('checkout should not call Stripe');
  });
  try {
    const refused = await checkout(env, ' ZaylynByoung@gmail.com ');
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'admin accounts do not need a subscription' });

    const plus = await checkout(env, PLUS);
    assert.equal(plus.status, 409);
    assert.match((await plus.json()).error, /\/account/);
  } finally {
    stub.restore();
  }

  const adminCookie = await signIn(env, ADMIN);
  const adminRow = await getSubscriber(db, ADMIN);
  assert.equal(adminRow.email_confirmed, 1);
  assert.equal(adminRow.plan, 'free');
  assert.equal(adminRow.status, 'pending');
  assert.equal(adminRow.stripe_customer_id, null);
  assert.equal(adminRow.paid_until, null);

  const me = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/api/me', { headers: { cookie: adminCookie } }), env);
  const meBody = await me.json();
  assert.equal(meBody.admin, true);
  assert.equal(meBody.instant, true);
  assert.equal(meBody.has_billing, false);
  assert.equal(meBody.plan, 'free');

  await db
    .prepare(
      'UPDATE subscribers SET plan = ?, status = ?, stripe_customer_id = ?, stripe_subscription_id = ?, paid_until = ? WHERE email = ?'
    )
    .bind('yearly', 'active', 'cus_kept', 'sub_kept', future, ADMIN)
    .run();
  await signIn(env, ADMIN);
  const kept = await getSubscriber(db, ADMIN);
  assert.equal(kept.plan, 'yearly');
  assert.equal(kept.status, 'active');
  assert.equal(kept.stripe_customer_id, 'cus_kept');
  assert.equal(kept.stripe_subscription_id, 'sub_kept');
  assert.equal(kept.email_confirmed, 1);

  const plusCookie = await signIn(env, PLUS);
  const plusMe = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/me', { headers: { cookie: plusCookie } }),
    env
  );
  const plusBody = await plusMe.json();
  assert.equal(plusBody.admin, false);
  assert.equal(plusBody.plan, 'monthly');
  assert.equal(plusBody.instant, true);
  assert.equal(plusBody.has_billing, true);
  const plusRow = await getSubscriber(db, PLUS);
  assert.equal(plusRow.plan, 'monthly');
  assert.equal(plusRow.stripe_customer_id, 'cus_crtest');

  const mail = stubFetch(async () => jsonResponse({ id: 'email_admin_feed' }));
  try {
    const ingested = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + env.INGEST_TOKEN,
        },
        body: JSON.stringify(sampleListing()),
      }),
      env
    );
    assert.equal(ingested.status, 200);
  } finally {
    mail.restore();
  }
  const anon = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/api/listings'), env);
  const anonBody = await anon.json();
  assert.equal(anonBody.delayed, true);
  assert.deepEqual(anonBody.listings, []);

  const adminFeed = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/listings', { headers: { cookie: adminCookie } }),
    env
  );
  const adminFeedBody = await adminFeed.json();
  assert.equal(adminFeedBody.delayed, false);
  assert.deepEqual(
    adminFeedBody.listings.map((item) => item.listing_id),
    ['fb-admin']
  );

  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE email = ?').get(ADMIN).n, 1);
});

test('admins receive instant alerts without a paid plan and opted-out admins do not', async () => {
  const { db } = createTestDb();
  const env = adminEnv(db, { EMAIL_ALLOWLIST: ADMIN + ',paid@example.com' });
  await seedSubscriber(db, {
    email: ADMIN,
    plan: 'free',
    status: 'pending',
    paid_until: null,
    trial_end: null,
    email_confirmed: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    alert_opt_out: 0,
  });
  await seedSubscriber(db, {
    email: 'quiet-admin@example.com',
    plan: 'free',
    status: 'pending',
    paid_until: null,
    email_confirmed: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    alert_opt_out: 1,
  });
  const quietEnv = adminEnv(db, {
    ADMIN_EMAILS: ADMIN + ',quiet-admin@example.com',
    EMAIL_ALLOWLIST: ADMIN + ',paid@example.com',
  });
  await seedSubscriber(db, {
    email: 'paid@example.com',
    paid_until: new Date(Date.now() + 86400000).toISOString(),
    stripe_customer_id: 'cus_paid',
    stripe_subscription_id: 'sub_paid',
  });

  const stub = stubFetch(async () => jsonResponse({ id: 'email_admin' }));
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + env.INGEST_TOKEN,
        },
        body: JSON.stringify(sampleListing({ listing_id: 'fb-admin-mail' })),
      }),
      quietEnv
    );
    assert.equal(res.status, 200);
    const sends = stub.calls.filter((call) => String(call.url).includes('api.resend.com'));
    const tos = sends.map((call) => JSON.parse(call.opts.body).to[0]).sort();
    assert.deepEqual(tos, ['paid@example.com', ADMIN]);
  } finally {
    stub.restore();
  }
});

test('an admin who is also paid is emailed once', async () => {
  const { db, sqlite } = createTestDb();
  const env = adminEnv(db, { EMAIL_ALLOWLIST: ADMIN });
  await seedSubscriber(db, {
    email: ADMIN,
    plan: 'monthly',
    status: 'active',
    paid_until: new Date(Date.now() + 86400000).toISOString(),
    email_confirmed: 1,
    stripe_customer_id: 'cus_both',
    stripe_subscription_id: 'sub_both',
  });
  const stub = stubFetch(async () => jsonResponse({ id: 'email_once' }));
  try {
    const res = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + env.INGEST_TOKEN,
        },
        body: JSON.stringify(sampleListing({ listing_id: 'fb-once' })),
      }),
      env
    );
    assert.equal(res.status, 200);
    const sends = stub.calls.filter((call) => String(call.url).includes('api.resend.com'));
    assert.equal(sends.length, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM alert_sends').get().n, 1);
  } finally {
    stub.restore();
  }
});

test('the account page labels an admin and hides billing nudges', async () => {
  const html = readFileSync(new URL('../public/account/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="change-plan"/);
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8');
  const nodes = {};
  const document = {
    documentElement: { classList: { add() {} } },
    body: { classList: { toggle() {} } },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return nodes[id] || null;
    },
  };
  const location = { origin: 'https://cheaprides.406truckdrops.com', search: '' };
  const { fillAccount, initAccount } = new Function(
    'document',
    'location',
    'fetch',
    src + '\nreturn { fillAccount, initAccount };'
  )(document, location, async (url) => {
    if (url === '/api/me') {
      return {
        ok: true,
        json: async () => ({
          email: ADMIN,
          plan: 'free',
          status: 'pending',
          admin: true,
          has_billing: false,
          paid_until: null,
          trial_end: null,
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  });
  for (const id of ['acct-email', 'acct-plan', 'acct-status', 'acct-until', 'acct-until-label', 'billing-link', 'change-plan', 'past-due-note', 'signed-out', 'signed-in', 'account-banner']) {
    nodes[id] = { textContent: '', hidden: false };
  }
  location.search = '?billing=none';
  await initAccount();
  assert.equal(nodes['account-banner'].hidden, true);
  assert.equal(nodes['account-banner'].textContent, '');
  assert.equal(nodes['acct-plan'].textContent, 'Admin (permanent)');
  fillAccount({
    email: ADMIN,
    plan: 'free',
    status: 'pending',
    admin: true,
    has_billing: false,
    paid_until: null,
    trial_end: null,
  });
  assert.equal(nodes['acct-plan'].textContent, 'Admin (permanent)');
  assert.equal(nodes['acct-until'].textContent, 'Permanent');
  assert.equal(nodes['acct-until'].textContent.includes('Not active'), false);
  assert.equal(nodes['billing-link'].hidden, true);
  assert.equal(nodes['change-plan'].hidden, true);

  fillAccount({
    email: ADMIN,
    plan: 'free',
    status: 'pending',
    admin: true,
    has_billing: true,
    paid_until: null,
    trial_end: null,
  });
  assert.equal(nodes['billing-link'].hidden, false);
  assert.equal(nodes['change-plan'].hidden, true);

  fillAccount({
    email: PLUS,
    plan: 'monthly',
    status: 'active',
    admin: false,
    has_billing: true,
    paid_until: null,
    trial_end: null,
  });
  assert.equal(nodes['acct-plan'].textContent, 'Monthly');
  assert.equal(nodes['acct-until'].textContent, 'Not active');
  assert.equal(nodes['change-plan'].hidden, false);
});
