import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { countRows, createTestDb, getSubscriber, jsonResponse, makeEnv, seedSubscriber, stubFetch, worker } from './helpers.js';

function listing(overrides = {}) {
  return {
    event: 'new',
    listing_id: 'fb-1001',
    url: 'https://www.facebook.com/marketplace/item/1001',
    title: '2012 Honda Civic',
    year: 2012,
    make: 'Honda',
    model: 'Civic',
    price: 2800,
    previous_price: null,
    drop_flag: false,
    categories: ['first_car', 'beater_commuter'],
    deal_score_text: '2012 Civic, $2,800, about $900 under market.',
    deal_delta_usd: -900,
    city: 'Billings',
    state: 'mt',
    mileage: 168000,
    hero_photo_url: 'https://example.com/civic.jpg',
    seen_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function recordingCtx() {
  const tasks = [];
  return {
    tasks,
    waitUntil(promise) {
      tasks.push(promise);
    },
    drain() {
      return Promise.all(tasks);
    },
  };
}

function ingest(env, body, ctx) {
  return worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + env.INGEST_TOKEN,
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx
  );
}

test('instant alerts email one allowlisted paid subscriber per listing event', async () => {
  const { db, sqlite } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'allowed@example.com', ALLOW_REAL_SENDS: 'false' });
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await seedSubscriber(db, {
    email: 'allowed@example.com',
    paid_until: future,
    categories: '[]',
    stripe_customer_id: 'cus_allowed',
    stripe_subscription_id: 'sub_allowed',
  });
  await seedSubscriber(db, {
    email: 'other@example.com',
    paid_until: future,
    categories: '[]',
    stripe_customer_id: 'cus_other',
    stripe_subscription_id: 'sub_other',
  });
  await seedSubscriber(db, {
    email: 'winter@example.com',
    paid_until: future,
    categories: '["winter_beater"]',
    stripe_customer_id: 'cus_winter',
    stripe_subscription_id: 'sub_winter',
  });
  await seedSubscriber(db, {
    email: 'free@example.com',
    plan: 'free',
    paid_until: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
  });
  await seedSubscriber(db, {
    email: 'lapsed@example.com',
    paid_until: past,
    stripe_customer_id: 'cus_lapsed',
    stripe_subscription_id: 'sub_lapsed',
  });
  await seedSubscriber(db, {
    email: 'quiet@example.com',
    paid_until: future,
    alert_opt_out: 1,
    stripe_customer_id: 'cus_quiet',
    stripe_subscription_id: 'sub_quiet',
  });
  await seedSubscriber(db, {
    email: 'pending@example.com',
    paid_until: future,
    email_confirmed: 0,
    stripe_customer_id: 'cus_pending',
    stripe_subscription_id: 'sub_pending',
  });

  const ctx = recordingCtx();
  const stub = stubFetch(async () => jsonResponse({ id: 'email_alert' }));
  try {
    const res = await ingest(env, listing(), ctx);
    assert.equal(res.status, 200);
    assert.ok(ctx.tasks.length >= 1);
    await ctx.drain();
    const sends = stub.calls.filter((call) => String(call.url).includes('api.resend.com'));
    assert.equal(sends.length, 1);
    const body = JSON.parse(sends[0].opts.body);
    assert.deepEqual(body.to, ['allowed@example.com']);
    assert.equal(body.subject, '2012 Civic, $2,800, about $900 under market.');
    assert.ok(body.text.startsWith('2012 Civic, $2,800, about $900 under market.'));
    assert.match(body.text, /2012 Honda Civic/);
    assert.match(body.text, /Billings, MT/);
    assert.match(body.text, /Photo: https:\/\/example.com\/civic.jpg/);
    assert.match(body.text, /https:\/\/www\.facebook\.com\/marketplace\/item\/1001/);
    assert.match(body.text, /\/api\/unsubscribe\?email=allowed%40example\.com&sig=[a-f0-9]+/);
    assert.match(body.html, /<img src="https:\/\/example.com\/civic.jpg"/);
    assert.match(body.html, />Unsubscribe</);
    assert.equal(countRows(sqlite, 'alert_sends'), 1);
    const owners = sqlite
      .prepare(
        'SELECT s.email FROM alert_sends a JOIN subscribers s ON s.id = a.subscriber_id ORDER BY s.email'
      )
      .all();
    assert.deepEqual(
      owners.map((row) => row.email),
      ['allowed@example.com']
    );

    const again = recordingCtx();
    const replay = await ingest(env, listing(), again);
    assert.equal(replay.status, 200);
    assert.ok(again.tasks.length >= 1);
    await again.drain();
    assert.equal(stub.calls.filter((call) => String(call.url).includes('api.resend.com')).length, 1);
    assert.equal(countRows(sqlite, 'alert_sends'), 1);

    const dropCtx = recordingCtx();
    const drop = await ingest(
      env,
      listing({
        event: 'price_drop',
        price: 2500,
        previous_price: 2800,
        drop_flag: true,
        deal_score_text: '2012 Civic, $2,500, about $1,200 under market.',
      }),
      dropCtx
    );
    assert.equal(drop.status, 200);
    await dropCtx.drain();
    const afterDrop = stub.calls.filter((call) => String(call.url).includes('api.resend.com'));
    assert.equal(afterDrop.length, 2);
    assert.equal(JSON.parse(afterDrop[1].opts.body).subject, '2012 Civic, $2,500, about $1,200 under market.');
    assert.equal(countRows(sqlite, 'alert_sends'), 2);

    const link = body.text.match(/https:\/\/cheaprides\.406truckdrops\.com\/api\/unsubscribe\?email=[^&\s]+&sig=[a-f0-9]+/);
    assert.ok(link);
    const unsub = await worker.fetch(new Request(link[0]), env);
    assert.equal(unsub.status, 200);
    assert.match(await unsub.text(), /Unsubscribed/);
    const row = await getSubscriber(db, 'allowed@example.com');
    assert.equal(row.alert_opt_out, 1);
    assert.equal(row.plan, 'monthly');
    assert.equal(row.stripe_customer_id, 'cus_allowed');
  } finally {
    stub.restore();
  }
});

test('a failed alert send drops the claim so a retry can mail once', async () => {
  const { db, sqlite } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'allowed@example.com' });
  await seedSubscriber(db, {
    email: 'allowed@example.com',
    paid_until: new Date(Date.now() + 86400000).toISOString(),
    stripe_customer_id: 'cus_retry',
    stripe_subscription_id: 'sub_retry',
  });
  const failCtx = recordingCtx();
  const failing = stubFetch(async () => jsonResponse({ error: 'nope' }, 500));
  try {
    const res = await ingest(env, listing({ listing_id: 'fb-retry' }), failCtx);
    assert.equal(res.status, 200);
    await failCtx.drain();
    assert.equal(countRows(sqlite, 'alert_sends'), 0);
  } finally {
    failing.restore();
  }
  const okCtx = recordingCtx();
  const stub = stubFetch(async () => jsonResponse({ id: 'email_retry' }));
  try {
    const res = await ingest(env, listing({ listing_id: 'fb-retry' }), okCtx);
    assert.equal(res.status, 200);
    await okCtx.drain();
    assert.equal(stub.calls.filter((call) => String(call.url).includes('api.resend.com')).length, 1);
    assert.equal(countRows(sqlite, 'alert_sends'), 1);
  } finally {
    stub.restore();
  }
});

test('unknown pages return html 404 and unknown api routes stay json', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  const page = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/no-such-page'), env);
  assert.equal(page.status, 404);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Page not found/);

  const api = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/api/nope'), env);
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /application\/json/);
  assert.equal((await api.json()).error, 'not found');

  env.ASSETS = {
    async fetch() {
      return new Response('ok-asset', { status: 200, headers: { 'content-type': 'text/html' } });
    },
  };
  const asset = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/pricing'), env);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'ok-asset');

  env.ASSETS = {
    async fetch() {
      return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    },
  };
  const missing = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/gone'), env);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /text\/html/);
  assert.match(await missing.text(), /Page not found/);
});

test('terms and privacy drafts stay off the visible page and pricing drops coming soon', () => {
  const terms = readFileSync(new URL('../public/terms/index.html', import.meta.url), 'utf8');
  const privacy = readFileSync(new URL('../public/privacy/index.html', import.meta.url), 'utf8');
  const pricing = readFileSync(new URL('../public/pricing/index.html', import.meta.url), 'utf8');
  for (const html of [terms, privacy]) {
    assert.match(html, /\[OPERATOR LEGAL NAME\]/);
    assert.match(html, /\[CONTACT EMAIL\]/);
    assert.match(html, /<!-- Draft, pending review -->/);
    const visible = html.replace(/<!--[\s\S]*?-->/g, '');
    assert.equal(visible.includes('Draft, pending review'), false);
    assert.equal(/coming soon/i.test(visible), false);
  }
  assert.match(terms, /\$7 per month/);
  assert.match(terms, /\$49 per year/);
  assert.match(terms, /7-day free trial/);
  assert.match(terms, /card is collected up front/);
  assert.match(terms, /auto-bills/);
  assert.match(terms, /account page/);
  assert.match(terms, /Stripe billing portal/);
  assert.match(terms, /until the period ends/);
  assert.match(terms, /do not refund partial periods/);
  assert.match(terms, /24-hour delayed digest/);
  assert.match(terms, /public third-party marketplaces/);
  assert.match(terms, /not a party to any vehicle sale/);
  assert.match(terms, /Montana/);
  assert.match(privacy, /email address/);
  assert.match(privacy, /optional phone number/);
  assert.match(privacy, /Stripe customer id/);
  assert.match(privacy, /Category preferences/);
  assert.match(privacy, /Payments are handled by Stripe/);
  assert.match(privacy, /Email is handled by Resend/);
  assert.match(privacy, /do not sell your data/i);
  assert.match(privacy, /unsubscribe link/i);
  assert.match(pricing, /id="sms-plan" hidden/);
  assert.equal(/coming soon/i.test(pricing), false);
});
