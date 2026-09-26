import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../public/_worker.js';

export function loadFixture(name) {
  const raw = readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
  return JSON.parse(raw);
}

export function createTestDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  sqlite.exec(schema);
  return { sqlite, db: createD1(sqlite) };
}

function createD1(sqlite) {
  return {
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        async first() {
          const row = sqlite.prepare(sql).get(...statement.params);
          return row ?? null;
        },
        async all() {
          const results = sqlite.prepare(sql).all(...statement.params);
          return { results, success: true };
        },
        async run() {
          const info = sqlite.prepare(sql).run(...statement.params);
          return {
            success: true,
            meta: {
              changes: info.changes,
              last_row_id: Number(info.lastInsertRowid),
            },
          };
        },
      };
      return statement;
    },
  };
}

export function makeEnv(db, overrides = {}) {
  return {
    DB: db,
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    INGEST_TOKEN: 'ingest-test-token',
    RESEND_API_KEY: 're_test_key',
    SESSION_SECRET: 'session-test-secret',
    APP_URL: 'https://cheaprides.406truckdrops.com',
    EMAIL_FROM: '406CheapRides <alerts@406truckdrops.com>',
    EMAIL_ALLOWLIST: 'allowed@example.com',
    ALLOW_REAL_SENDS: 'false',
    ...overrides,
  };
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), opts };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export async function stripeHeader(payload, secret, timestampSec) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = new TextEncoder().encode(String(timestampSec) + '.' + payload);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 't=' + timestampSec + ',v1=' + hex;
}

export async function postWebhook(env, event, options = {}) {
  const payload = JSON.stringify(event);
  const body = options.tamper ? payload + '\n' : payload;
  const timestamp = Math.floor(Date.now() / 1000) - (options.secondsAgo || 0);
  const header = await stripeHeader(payload, options.secret || env.STRIPE_WEBHOOK_SECRET, timestamp);
  return worker.fetch(
    new Request('https://cheaprides.406truckdrops.com/api/stripe-webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': header,
      },
      body,
    }),
    env
  );
}

export async function seedSubscriber(db, overrides = {}) {
  const row = {
    email: 'ada@example.com',
    email_confirmed: 1,
    plan: 'monthly',
    status: 'active',
    paid_until: '2030-01-01T00:00:00.000Z',
    trial_end: '2030-01-01T00:00:00.000Z',
    stripe_customer_id: 'cus_SxAdaLovelace',
    stripe_subscription_id: 'sub_1SxCheapMonthly',
    sms_phone: null,
    categories: '[]',
    alert_opt_out: 0,
    ...overrides,
  };
  const now = '2026-01-01T00:00:00.000Z';
  await db
    .prepare(
      'INSERT INTO subscribers (' +
        'email, email_confirmed, plan, status, paid_until, trial_end, ' +
        'stripe_customer_id, stripe_subscription_id, sms_phone, categories, ' +
        'alert_opt_out, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      row.email,
      row.email_confirmed,
      row.plan,
      row.status,
      row.paid_until,
      row.trial_end,
      row.stripe_customer_id,
      row.stripe_subscription_id,
      row.sms_phone,
      row.categories,
      row.alert_opt_out,
      now,
      now
    )
    .run();
  return row;
}

export async function getSubscriber(db, email = 'ada@example.com') {
  return db.prepare('SELECT * FROM subscribers WHERE email = ?').bind(email).first();
}

export function countRows(sqlite, table) {
  return sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

export async function signIn(env, email) {
  const stub = stubFetch(async ({ url }) => {
    if (String(url).includes('api.resend.com')) return jsonResponse({ id: 'email_test' });
    throw new Error('unexpected fetch ' + url);
  });
  try {
    const login = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
      env
    );
    assert.equal(login.status, 200);
    const call = stub.calls.find((item) => item.url.includes('api.resend.com'));
    assert.ok(call, 'expected a resend call');
    const sent = JSON.parse(call.opts.body);
    const match = sent.text.match(/token=([A-Za-z0-9_-]+)/);
    assert.ok(match, 'sign-in email should contain a token');
    const auth = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/auth?token=' + match[1]),
      env
    );
    assert.equal(auth.status, 302);
    return auth.headers.get('set-cookie').split(';')[0];
  } finally {
    stub.restore();
  }
}

export { worker };
