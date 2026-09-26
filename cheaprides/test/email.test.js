import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sendEmail } from '../public/_worker.js';
import { createTestDb, getSubscriber, jsonResponse, makeEnv, stubFetch, worker } from './helpers.js';

function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

test('allowlist guard skips everyone else and does not call Resend', async () => {
  const env = makeEnv(null, { EMAIL_ALLOWLIST: 'allowed@example.com', ALLOW_REAL_SENDS: 'false' });
  const logs = captureLogs();
  const stub = stubFetch(async () => {
    throw new Error('resend should not be called');
  });
  try {
    const result = await sendEmail(env, {
      to: 'Other@Example.com',
      subject: 'Nope',
      text: 'This must not send.',
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'allowlist');
    assert.equal(stub.calls.length, 0);
    assert.ok(logs.lines.some((line) => line.includes('skipped allowlist') && line.includes('other@example.com')));
  } finally {
    stub.restore();
    logs.restore();
  }
});

test('allowlist match is case-insensitive and sends through Resend', async () => {
  const env = makeEnv(null, {
    EMAIL_ALLOWLIST: ' Allowed@Example.com , second@example.com ',
    ALLOW_REAL_SENDS: 'false',
  });
  const stub = stubFetch(async () => jsonResponse({ id: 'email_1' }));
  try {
    const result = await sendEmail(env, {
      to: 'allowed@example.com',
      subject: 'Hello',
      text: 'Hi there',
    });
    assert.equal(result.ok, true);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, 'https://api.resend.com/emails');
    const body = JSON.parse(stub.calls[0].opts.body);
    assert.deepEqual(body.to, ['allowed@example.com']);
    assert.equal(body.from, env.EMAIL_FROM);
    assert.equal(body.subject, 'Hello');
    assert.equal(stub.calls[0].opts.headers.Authorization, 'Bearer re_test_key');
  } finally {
    stub.restore();
  }
});

test('ALLOW_REAL_SENDS must be the exact string true', async () => {
  const env = makeEnv(null, { EMAIL_ALLOWLIST: '', ALLOW_REAL_SENDS: 'TRUE' });
  const blocked = stubFetch(async () => {
    throw new Error('should not send');
  });
  try {
    const skipped = await sendEmail(env, { to: 'stranger@example.com', subject: 'Hi', text: 'No' });
    assert.equal(skipped.reason, 'allowlist');
    assert.equal(blocked.calls.length, 0);
  } finally {
    blocked.restore();
  }

  env.ALLOW_REAL_SENDS = 'true';
  const stub = stubFetch(async () => jsonResponse({ id: 'email_2' }));
  try {
    const sent = await sendEmail(env, { to: 'stranger@example.com', subject: 'Hi', text: 'Yes' });
    assert.equal(sent.ok, true);
    assert.equal(JSON.parse(stub.calls[0].opts.body).to[0], 'stranger@example.com');
  } finally {
    stub.restore();
  }
});

test('login and subscribe go through the allowlist guard', async () => {
  const { db } = createTestDb();
  const env = makeEnv(db, { EMAIL_ALLOWLIST: 'ada@example.com' });
  const skipped = stubFetch(async () => {
    throw new Error('should not send');
  });
  try {
    const login = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'not-listed@example.com' }),
      }),
      env
    );
    assert.equal(login.status, 200);
    assert.equal((await login.json()).ok, true);
    assert.equal(skipped.calls.length, 0);
  } finally {
    skipped.restore();
  }

  const stub = stubFetch(async () => jsonResponse({ id: 'email_3' }));
  try {
    const sub = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'Ada@Example.com' }),
      }),
      env
    );
    assert.equal(sub.status, 200);
    const sent = JSON.parse(stub.calls[0].opts.body);
    assert.equal(sent.to[0], 'ada@example.com');
    const confirm = sent.text.match(/https:\/\/cheaprides\.406truckdrops\.com\/api\/confirm\?token=([A-Za-z0-9_-]+)/);
    const unsub = sent.text.match(/https:\/\/cheaprides\.406truckdrops\.com\/api\/unsubscribe\?token=([A-Za-z0-9_-]+)/);
    assert.ok(confirm);
    assert.ok(unsub);
    const confirmed = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/confirm?token=' + confirm[1]),
      env
    );
    assert.equal(confirmed.status, 200);
    const row = await getSubscriber(db, 'ada@example.com');
    assert.equal(row.email_confirmed, 1);
    assert.equal(row.status, 'active');
    assert.equal(row.plan, 'free');
    const optedOut = await worker.fetch(
      new Request('https://cheaprides.406truckdrops.com/api/unsubscribe?token=' + unsub[1]),
      env
    );
    assert.equal(optedOut.status, 200);
    const after = await getSubscriber(db, 'ada@example.com');
    assert.equal(after.alert_opt_out, 1);
    assert.equal(after.plan, 'free');
  } finally {
    stub.restore();
  }
});

test('Resend is only referenced from the worker send path', () => {
  const src = readFileSync(new URL('../public/_worker.js', import.meta.url), 'utf8');
  const hits = src.match(/api\.resend\.com/g) || [];
  assert.equal(hits.length, 1);
  assert.match(src, /export async function sendEmail/);
  assert.match(src, /export async function fanOutInstantPaidAlerts/);
});

test('user-facing cheaprides files do not use em dashes', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.wrangler') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  const emDash = String.fromCharCode(0x2014);
  const emEntity = '&' + 'mdash;';
  const bad = [];
  for (const file of files) {
    if (file.includes('/test/')) continue;
    if (!/\.(html|js|css|md|sql|toml|svg|example)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (text.includes(emDash) || text.includes(emEntity)) bad.push(file);
  }
  assert.deepEqual(bad, []);
});
