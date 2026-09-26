import assert from 'node:assert/strict';
import test from 'node:test';
import { countRows, createTestDb, makeEnv, seedSubscriber, signIn, worker } from './helpers.js';

function sampleListing(overrides = {}) {
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

function ingest(env, body, { token = env.INGEST_TOKEN, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = 'Bearer ' + token;
  return worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/ingest', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env
  );
}

test('ingest rejects a missing token and a wrong token', async () => {
  const { sqlite, db } = createTestDb();
  const env = makeEnv(db);
  const missing = await ingest(env, '{', { auth: false });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, 'unauthorized');

  const wrong = await ingest(env, sampleListing(), { token: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(countRows(sqlite, 'listings'), 0);
});

test('ingest validation lists the bad fields and writes nothing', async () => {
  const { sqlite, db } = createTestDb();
  const env = makeEnv(db);
  const bad = sampleListing({
    price: '2800',
    categories: ['truck'],
    drop_flag: 1,
    seen_at: '2026-08-01T00:00:00+00:00',
  });
  const res = await ingest(env, bad);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'validation failed');
  const names = body.fields.map((field) => field.field);
  assert.ok(names.includes('price'));
  assert.ok(names.includes('categories'));
  assert.ok(names.includes('drop_flag'));
  assert.ok(names.includes('seen_at'));
  assert.equal(countRows(sqlite, 'listings'), 0);

  const batch = await ingest(env, { listings: [sampleListing(), sampleListing({ listing_id: 'fb-2', price: 12.5 })] });
  assert.equal(batch.status, 400);
  const batchBody = await batch.json();
  assert.equal(batchBody.results[0].ok, true);
  assert.equal(batchBody.results[1].ok, false);
  assert.ok(batchBody.results[1].fields.some((field) => field.field === 'price'));
  assert.equal(countRows(sqlite, 'listings'), 0);

  const tooMany = await ingest(env, {
    listings: Array.from({ length: 51 }, (_, index) => sampleListing({ listing_id: 'id-' + index })),
  });
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).error, 'batch limit is 50');
  assert.equal(countRows(sqlite, 'listings'), 0);
});

test('ingest upserts listings and records price-drop history once', async () => {
  const { sqlite, db } = createTestDb();
  const env = makeEnv(db);

  const created = await ingest(env, sampleListing());
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.results[0].action, 'created');
  assert.equal(createdBody.results[0].price_history, false);

  const updated = await ingest(env, sampleListing({ title: '2012 Honda Civic LX', price: 2700 }));
  assert.equal((await updated.json()).results[0].action, 'updated');
  assert.equal(countRows(sqlite, 'listings'), 1);
  assert.equal(countRows(sqlite, 'price_history'), 0);
  const row = sqlite.prepare('SELECT title, price, state, categories FROM listings WHERE listing_id = ?').get('fb-1001');
  assert.equal(row.title, '2012 Honda Civic LX');
  assert.equal(row.price, 2700);
  assert.equal(row.state, 'MT');
  assert.deepEqual(JSON.parse(row.categories), ['first_car', 'beater_commuter']);

  const drop = sampleListing({
    event: 'price_drop',
    price: 2500,
    previous_price: 2700,
    drop_flag: true,
    seen_at: '2026-08-02T00:00:00Z',
    deal_score_text: '2012 Civic, $2,500, about $1,200 under market.',
    deal_delta_usd: -1200,
  });
  const firstDrop = await ingest(env, drop);
  assert.equal((await firstDrop.json()).results[0].price_history, true);
  const replay = await ingest(env, drop);
  assert.equal((await replay.json()).results[0].price_history, false);
  assert.equal(countRows(sqlite, 'price_history'), 1);

  const secondDrop = await ingest(env, {
    ...drop,
    price: 2400,
    previous_price: 2500,
    seen_at: '2026-08-03T00:00:00Z',
  });
  assert.equal((await secondDrop.json()).results[0].price_history, true);
  assert.equal(countRows(sqlite, 'price_history'), 2);
  const history = sqlite.prepare('SELECT price, previous_price FROM price_history ORDER BY seen_at').all();
  assert.deepEqual(
    history.map((item) => [item.price, item.previous_price]),
    [
      [2500, 2700],
      [2400, 2500],
    ]
  );

  const inactive = await ingest(env, { event: 'inactive', listing_id: 'fb-1001' });
  assert.equal((await inactive.json()).results[0].action, 'inactive');
  assert.equal(sqlite.prepare('SELECT active FROM listings WHERE listing_id = ?').get('fb-1001').active, 0);

  const missing = await ingest(env, { event: 'inactive', listing_id: 'does-not-exist' });
  assert.equal((await missing.json()).results[0].action, 'inactive_missing');
});

test('public listings are delayed 24h unless the session is paid', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'ada@example.com' });
  const oldSeen = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const freshSeen = new Date().toISOString();
  await ingest(env, sampleListing({ listing_id: 'old-car', seen_at: oldSeen, drop_flag: false, event: 'new' }));
  await ingest(
    env,
    sampleListing({
      listing_id: 'fresh-drop',
      event: 'price_drop',
      seen_at: freshSeen,
      price: 1900,
      previous_price: 2600,
      drop_flag: true,
    })
  );

  const anon = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/api/listings'), env);
  const anonBody = await anon.json();
  assert.equal(anonBody.delayed, true);
  assert.deepEqual(
    anonBody.listings.map((item) => item.listing_id),
    ['old-car']
  );

  const anonDrops = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/listings?feed=price_drops'),
    env
  );
  const anonDropsBody = await anonDrops.json();
  assert.deepEqual(anonDropsBody.listings, []);

  await seedSubscriber(db, { paid_until: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
  const cookie = await signIn(env, 'ada@example.com');
  const paid = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/listings', { headers: { cookie } }),
    env
  );
  const paidBody = await paid.json();
  assert.equal(paidBody.delayed, false);
  assert.deepEqual(
    paidBody.listings.map((item) => item.listing_id),
    ['fresh-drop', 'old-car']
  );
  const paidDrops = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/listings?feed=price_drops', { headers: { cookie } }),
    env
  );
  const paidDropsBody = await paidDrops.json();
  assert.deepEqual(
    paidDropsBody.listings.map((item) => item.listing_id),
    ['fresh-drop']
  );
});
