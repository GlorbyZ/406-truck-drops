import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTestDb, makeEnv, seedSubscriber, signIn, worker } from './helpers.js';

function cookieHeader(setCookie) {
  assert.ok(setCookie, 'expected a Set-Cookie header');
  assert.match(setCookie, /cr_session=/);
  assert.match(setCookie, /Max-Age=0/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
}

test('POST /api/logout deletes the session and clears the cookie', async () => {
  const { db, sqlite } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'ada@example.com' });
  await seedSubscriber(db);
  const cookie = await signIn(env, 'ada@example.com');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);

  const signedIn = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/me', { headers: { cookie } }),
    env
  );
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.headers.get('cache-control'), /no-store/);

  const res = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/logout', {
      method: 'POST',
      headers: { cookie },
    }),
    env
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  cookieHeader(res.headers.get('set-cookie'));
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

  const me = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/me', { headers: { cookie } }),
    env
  );
  assert.equal(me.status, 401);
  assert.deepEqual(await me.json(), { error: 'sign in required' });
  assert.match(me.headers.get('cache-control'), /no-store/);
});

test('POST /api/logout with no cookie still clears the cookie', async () => {
  const { db, sqlite } = createTestDb();
  const env = makeEnv(db);
  const res = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/logout', { method: 'POST' }),
    env
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  cookieHeader(res.headers.get('set-cookie'));
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('GET /api/logout redirects home and clears the cookie', async () => {
  const { db, sqlite } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'ada@example.com' });
  await seedSubscriber(db);
  const cookie = await signIn(env, 'ada@example.com');
  const res = await worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/logout', { headers: { cookie } }),
    env
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  cookieHeader(res.headers.get('set-cookie'));
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('every nav has an auth slot and site.js renders it', () => {
  const root = fileURLToPath(new URL('../public/', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.html')) files.push(path);
    }
  };
  walk(root);
  let navPages = 0;
  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    if (!html.includes('id="site-nav"')) continue;
    navPages += 1;
    assert.match(html, /data-nav-auth/, file);
    assert.match(html, /data-nav-trial/, file);
  }
  assert.ok(navPages >= 8);
  const js = readFileSync(new URL('../public/site.js', import.meta.url), 'utf8');
  assert.match(js, /function initNavAuth/);
  assert.match(js, /\/api\/logout/);
  assert.equal(js.includes('innerHTML'), false);
});
