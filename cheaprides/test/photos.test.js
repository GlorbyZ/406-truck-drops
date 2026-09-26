import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestDb, jsonResponse, makeEnv, seedSubscriber, stubFetch, worker } from './helpers.js';

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
    categories: ['first_car'],
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

function memoryPhotos() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
      objects.set(key, { bytes, options });
    },
    async get(key) {
      const found = objects.get(key);
      if (!found) return null;
      return { body: found.bytes, httpMetadata: found.options && found.options.httpMetadata };
    },
  };
}

function ingest(env, body) {
  return worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + env.INGEST_TOKEN,
      },
      body: JSON.stringify(body),
    }),
    env
  );
}

function photoPost(env, listingId, body, headers = {}) {
  return worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/photo?listing_id=' + encodeURIComponent(listingId), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.INGEST_TOKEN,
        'content-type': 'image/jpeg',
        ...headers,
      },
      body,
    }),
    env
  );
}

test('photo upload stores a jpeg and a later null ingest keeps it', async () => {
  const { db, sqlite } = createTestDb();
  const env = makeEnv(db);
  env.PHOTOS = memoryPhotos();
  const created = await ingest(env, sampleListing());
  assert.equal(created.status, 200);

  const missingAuth = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/photo?listing_id=fb-1001', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: new Uint8Array([1, 2, 3]),
    }),
    env
  );
  assert.equal(missingAuth.status, 401);
  assert.equal((await missingAuth.json()).error, 'unauthorized');

  const missingListing = await photoPost(env, 'no-such-car', new Uint8Array([1, 2, 3, 4]));
  assert.equal(missingListing.status, 404);
  assert.equal((await missingListing.json()).error, 'listing not found');

  const png = await photoPost(env, 'fb-1001', new Uint8Array([1]), { 'content-type': 'image/png' });
  assert.equal(png.status, 400);
  assert.equal((await png.json()).error, 'content-type must be image/jpeg');

  const dotted = await photoPost(env, 'fb.1001', new Uint8Array([1, 2]));
  assert.equal(dotted.status, 404);

  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const uploaded = await photoPost(env, 'fb-1001', bytes, { 'content-type': 'image/jpeg; charset=binary' });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await uploaded.json(), { ok: true });
  assert.equal(env.PHOTOS.objects.get('fb-1001.jpg').options.httpMetadata.contentType, 'image/jpeg');
  assert.equal(
    sqlite.prepare('SELECT hero_photo_url FROM listings WHERE listing_id = ?').get('fb-1001').hero_photo_url,
    '/photos/fb-1001.jpg'
  );

  const kept = await ingest(env, sampleListing({ title: '2012 Honda Civic LX', hero_photo_url: null, price: 2700 }));
  assert.equal(kept.status, 200);
  assert.equal(
    sqlite.prepare('SELECT hero_photo_url, price FROM listings WHERE listing_id = ?').get('fb-1001').hero_photo_url,
    '/photos/fb-1001.jpg'
  );

  const replaced = await ingest(env, sampleListing({ hero_photo_url: 'https://example.com/new.jpg', price: 2600 }));
  assert.equal(replaced.status, 200);
  assert.equal(
    sqlite.prepare('SELECT hero_photo_url FROM listings WHERE listing_id = ?').get('fb-1001').hero_photo_url,
    'https://example.com/new.jpg'
  );

  const photo = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/photos/fb-1001.jpg'), env);
  assert.equal(photo.status, 200);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal(photo.headers.get('cache-control'), 'public, max-age=86400');
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), bytes);

  const gone = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/photos/missing.jpg'), env);
  assert.equal(gone.status, 404);
  assert.match(gone.headers.get('content-type'), /text\/plain/);

  const dottedGet = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/photos/a.b.jpg'), env);
  assert.equal(dottedGet.status, 404);
  const slashed = await worker.fetch(new Request('https://cheaprides.406truckdrops.com/photos/a/b.jpg'), env);
  assert.equal(slashed.status, 404);
});

test('photo upload rejects a body over 5 MB', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db);
  env.PHOTOS = memoryPhotos();
  await ingest(env, sampleListing());
  const tooBig = new Uint8Array(5 * 1024 * 1024 + 1);
  const res = await photoPost(env, 'fb-1001', tooBig);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'payload too large');
  assert.equal(env.PHOTOS.objects.has('fb-1001.jpg'), false);
});

test('alert mail turns a stored /photos path into an absolute URL', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'allowed@example.com' });
  await seedSubscriber(db, {
    email: 'allowed@example.com',
    paid_until: new Date(Date.now() + 86400000).toISOString(),
    stripe_customer_id: 'cus_photo',
    stripe_subscription_id: 'sub_photo',
  });
  const stub = stubFetch(async () => jsonResponse({ id: 'email_photo' }));
  try {
    await ingest(env, sampleListing({ listing_id: 'fb-photo', hero_photo_url: 'https://example.com/civic.jpg' }));
    await db
      .prepare('UPDATE listings SET hero_photo_url = ? WHERE listing_id = ?')
      .bind('/photos/fb-photo.jpg', 'fb-photo')
      .run();
    const res = await ingest(
      env,
      sampleListing({
        listing_id: 'fb-photo',
        event: 'price_drop',
        price: 2500,
        previous_price: 2800,
        drop_flag: true,
        hero_photo_url: null,
        deal_score_text: '2012 Civic, $2,500, about $1,200 under market.',
        seen_at: '2026-08-02T00:00:00Z',
      })
    );
    assert.equal(res.status, 200);
    const sends = stub.calls.filter((call) => String(call.url).includes('api.resend.com'));
    assert.equal(sends.length, 2);
    const body = JSON.parse(sends[1].opts.body);
    assert.match(body.text, /Photo: https:\/\/cheaprides\.406truckdrops\.com\/photos\/fb-photo\.jpg/);
    assert.match(body.html, /src="https:\/\/cheaprides\.406truckdrops\.com\/photos\/fb-photo\.jpg"/);
  } finally {
    stub.restore();
  }
});

test('listing cards accept same-origin /photos paths', () => {
  const src = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8');
  const document = {
    documentElement: { classList: { add() {} } },
    body: { classList: { toggle() {} } },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const location = { origin: 'https://cheaprides.406truckdrops.com', search: '' };
  const safeUrl = new Function('document', 'location', 'fetch', src + '\nreturn safeUrl;')(
    document,
    location,
    async () => ({})
  );
  assert.equal(safeUrl('/photos/fb-1001.jpg'), '/photos/fb-1001.jpg');
  assert.equal(safeUrl('https://example.com/civic.jpg'), 'https://example.com/civic.jpg');
  assert.equal(safeUrl('/account'), '');
  assert.equal(safeUrl('javascript:alert(1)'), '');
});
