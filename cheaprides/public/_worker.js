/* 406CheapRides - Cloudflare Pages worker (advanced mode).
   Routes /api/* here and serves everything else through the ASSETS binding.
   Stripe REST calls use fetch with form-encoded bodies. Webhook signatures
   use WebCrypto HMAC-SHA256. Every outbound email goes through sendEmail. */

const PLANS = {
  monthly: 'cheaprides_monthly',
  yearly: 'cheaprides_yearly',
  sms: 'cheaprides_sms_monthly',
};

const LOOKUP_TO_PLAN = {
  cheaprides_monthly: 'monthly',
  cheaprides_yearly: 'yearly',
  cheaprides_sms_monthly: 'sms',
};

const CATEGORIES = [
  'beater_commuter',
  'winter_beater',
  'first_car',
  'mechanics_special',
  'fun_cheap',
];

const CATEGORY_SET = new Set(CATEGORIES);
const SESSION_COOKIE = 'cr_session';
const SESSION_DAYS = 30;
const LOGIN_MINUTES = 30;
const CONFIRM_DAYS = 7;
const SIGNATURE_TOLERANCE_SEC = 300;
const INGEST_BATCH_LIMIT = 50;
const LISTING_DELAY_MS = 24 * 60 * 60 * 1000;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const te = new TextEncoder();
const str = (s) => te.encode(s);

function isoNow() {
  return new Date().toISOString();
}

function unixToIso(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

function appUrl(env) {
  const raw = env.APP_URL && String(env.APP_URL).trim().replace(/\/+$/, '');
  if (!raw) {
    const err = new Error('APP_URL is not set');
    err.status = 500;
    throw err;
  }
  return raw;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function base64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function bytesToHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', str(text));
  return bytesToHex(buf);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    str(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, str(message));
  return bytesToHex(sig);
}

/* Constant-time string compare. Length mismatch still walks the longer input. */
function safeEqualStr(a, b) {
  const left = String(a);
  const right = String(b);
  const len = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function formEncode(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return parts.join('&');
}

function json(data, status = 200, extraHeaders) {
  const headers = { 'cache-control': 'no-store' };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers[k] = v;
  }
  return Response.json(data, { status, headers });
}

function htmlPage(title, message) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const body =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + safeTitle + '</title><link rel="stylesheet" href="/styles.css"></head>' +
    '<body><main class="wrap page"><h1>' + safeTitle + '</h1><p>' + safeMessage + '</p>' +
    '<p><a class="btn" href="/">Back home</a></p></main></body></html>';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readJson(request) {
  try {
    const value = await request.json();
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const parts = header.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

/* Stripe-Signature: t=<unix>,v1=<hex hmac>. Signed payload is `${t}.${rawBody}`. */
export async function verifyStripeSignature(payload, header, secret, nowMs = Date.now()) {
  if (!payload && payload !== '') return false;
  if (!header || !secret) return false;
  const v1 = [];
  let timestamp = null;
  for (const piece of String(header).split(',')) {
    const eq = piece.indexOf('=');
    if (eq === -1) continue;
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) v1.push(value);
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !v1.length) return false;
  const ts = Number(timestamp);
  const nowSec = Math.floor(nowMs / 1000);
  if (Math.abs(nowSec - ts) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = await hmacHex(secret, timestamp + '.' + payload);
  for (const sig of v1) {
    if (safeEqualStr(expected, sig.toLowerCase())) return true;
  }
  return false;
}

export function parseAllowlist(value) {
  if (!value || typeof value !== 'string') return new Set();
  const set = new Set();
  for (const part of value.split(',')) {
    const email = part.trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

/* Exact address match. Plus-aliases are different mailboxes. */
export function isAdminEmail(env, email) {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return parseAllowlist(env && env.ADMIN_EMAILS).has(normalized);
}

/* The only outbound email path. Allowlist-only unless ALLOW_REAL_SENDS === "true". */
export async function sendEmail(env, message) {
  const to = normalizeEmail(message && message.to);
  const subject = message && typeof message.subject === 'string' ? message.subject : '';
  const text = message && typeof message.text === 'string' ? message.text : '';
  if (!to || !subject || !text) {
    return { ok: false, skipped: true, reason: 'bad_message' };
  }
  const allowReal = env.ALLOW_REAL_SENDS === 'true';
  if (!allowReal) {
    const allow = parseAllowlist(env.EMAIL_ALLOWLIST);
    if (!allow.has(to)) {
      console.log('[cheaprides email] skipped allowlist to=' + to + ' subject=' + subject);
      return { ok: false, skipped: true, reason: 'allowlist' };
    }
  }
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    console.log('[cheaprides email] skipped not_configured to=' + to + ' subject=' + subject);
    return { ok: false, skipped: true, reason: 'not_configured' };
  }
  const payload = {
    from: env.EMAIL_FROM,
    to: [to],
    subject,
    text,
  };
  if (message.html && typeof message.html === 'string') payload.html = message.html;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.log('[cheaprides email] resend failed status=' + res.status + ' to=' + to);
    return { ok: false, skipped: false, reason: 'resend', status: res.status };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, id: data.id || null };
}

async function deliverEmail(env, message) {
  const result = await sendEmail(env, message);
  if (result.skipped && result.reason === 'allowlist') return { ok: true, delivered: false };
  if (!result.ok) return { ok: false, delivered: false };
  return { ok: true, delivered: true };
}

const SUBSCRIBER_FIELDS = new Set([
  'email_confirmed',
  'plan',
  'status',
  'paid_until',
  'trial_end',
  'stripe_customer_id',
  'stripe_subscription_id',
  'sms_phone',
  'categories',
  'confirm_token_hash',
  'confirm_token_expires_at',
  'unsubscribe_token_hash',
  'alert_opt_out',
  'updated_at',
]);

async function updateSubscriberByEmail(db, email, fields) {
  const keys = Object.keys(fields).filter((key) => SUBSCRIBER_FIELDS.has(key) && fields[key] !== undefined);
  if (!keys.length) return;
  const sets = keys.map((key) => key + ' = ?').join(', ');
  const params = keys.map((key) => (fields[key] === undefined ? null : fields[key]));
  params.push(email);
  await db.prepare('UPDATE subscribers SET ' + sets + ' WHERE email = ?').bind(...params).run();
}

async function insertSubscriber(db, email, extra) {
  const now = isoNow();
  const row = Object.assign(
    {
      email_confirmed: 0,
      plan: 'free',
      status: 'pending',
      paid_until: null,
      trial_end: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      sms_phone: null,
      categories: '[]',
      confirm_token_hash: null,
      confirm_token_expires_at: null,
      unsubscribe_token_hash: null,
      alert_opt_out: 0,
    },
    extra || {}
  );
  await db
    .prepare(
      'INSERT INTO subscribers (' +
        'email, email_confirmed, plan, status, paid_until, trial_end, ' +
        'stripe_customer_id, stripe_subscription_id, sms_phone, categories, ' +
        'confirm_token_hash, confirm_token_expires_at, unsubscribe_token_hash, ' +
        'alert_opt_out, created_at, updated_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(
      email,
      row.email_confirmed,
      row.plan,
      row.status,
      row.paid_until,
      row.trial_end,
      row.stripe_customer_id,
      row.stripe_subscription_id,
      row.sms_phone,
      row.categories,
      row.confirm_token_hash,
      row.confirm_token_expires_at,
      row.unsubscribe_token_hash,
      row.alert_opt_out,
      now,
      now
    )
    .run();
}

async function findSubscriber(db, hints) {
  const customerId = hints && hints.customerId;
  const subscriptionId = hints && hints.subscriptionId;
  const email = hints && hints.email;
  if (customerId) {
    const row = await db
      .prepare('SELECT * FROM subscribers WHERE stripe_customer_id = ?')
      .bind(customerId)
      .first();
    if (row) return row;
  }
  if (subscriptionId) {
    const row = await db
      .prepare('SELECT * FROM subscribers WHERE stripe_subscription_id = ?')
      .bind(subscriptionId)
      .first();
    if (row) return row;
  }
  if (email) {
    return db.prepare('SELECT * FROM subscribers WHERE email = ?').bind(email).first();
  }
  return null;
}

export function planFromSubscription(sub) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const price = item && item.price;
  const lookup = price && typeof price === 'object' ? price.lookup_key : null;
  if (lookup && LOOKUP_TO_PLAN[lookup]) return LOOKUP_TO_PLAN[lookup];
  const meta = sub && sub.metadata && sub.metadata.plan;
  if (meta === 'monthly' || meta === 'yearly' || meta === 'sms') return meta;
  return null;
}

/* During a trial, access lasts until trial_end. After that, use the period end.
   Newer Stripe API versions put current_period_end on the subscription item. */
export function paidUntilFromSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const trialEnd = typeof sub.trial_end === 'number' ? sub.trial_end : null;
  const item = sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const periodEnd =
    (typeof sub.current_period_end === 'number' && sub.current_period_end) ||
    (item && typeof item.current_period_end === 'number' && item.current_period_end) ||
    null;
  if (sub.status === 'trialing' && trialEnd) return unixToIso(trialEnd);
  if (periodEnd) return unixToIso(periodEnd);
  if (trialEnd) return unixToIso(trialEnd);
  return null;
}

function customerIdFrom(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value.id === 'string') return value.id;
  return null;
}

function subscriptionIdFromInvoice(invoice) {
  if (!invoice) return null;
  if (typeof invoice.subscription === 'string') return invoice.subscription;
  const parent = invoice.parent;
  const nested = parent && parent.subscription_details && parent.subscription_details.subscription;
  if (typeof nested === 'string') return nested;
  return null;
}

async function applySubscriptionState(db, sub, fallbackEmail) {
  const customerId = customerIdFrom(sub.customer);
  const metaEmail = normalizeEmail(sub.metadata && sub.metadata.email);
  const emailHint = metaEmail || normalizeEmail(fallbackEmail);
  const existing = await findSubscriber(db, {
    email: emailHint,
    customerId,
    subscriptionId: sub.id,
  });
  const ended =
    sub.status === 'canceled' || sub.status === 'incomplete_expired' || sub.status === 'unpaid';
  if (ended) {
    if (!existing) return;
    await updateSubscriberByEmail(db, existing.email, {
      plan: 'free',
      status: 'active',
      paid_until: null,
      trial_end: null,
      stripe_subscription_id: null,
      stripe_customer_id: customerId || existing.stripe_customer_id,
      email_confirmed: 1,
      updated_at: isoNow(),
    });
    return;
  }

  const email = (existing && existing.email) || emailHint;
  if (!email) throw new Error('no subscriber email on subscription ' + (sub.id || ''));
  const plan = planFromSubscription(sub);
  if (!plan) throw new Error('unknown price on subscription ' + (sub.id || ''));
  if (!existing) await insertSubscriber(db, email, { email_confirmed: 1, status: 'active' });

  let status = 'active';
  if (sub.status === 'past_due') status = 'past_due';
  else if (sub.status === 'incomplete' || sub.status === 'paused') status = 'pending';

  await updateSubscriberByEmail(db, email, {
    plan,
    status,
    paid_until: paidUntilFromSubscription(sub),
    trial_end: typeof sub.trial_end === 'number' ? unixToIso(sub.trial_end) : null,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id || null,
    email_confirmed: 1,
    updated_at: isoNow(),
  });
}

async function stripeGet(env, path) {
  if (!env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not set');
    err.status = 500;
    throw err;
  }
  const res = await fetch('https://api.stripe.com' + path, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw stripeRequestError(data, res.status);
  return data;
}

async function stripePost(env, path, params) {
  if (!env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not set');
    err.status = 500;
    throw err;
  }
  const res = await fetch('https://api.stripe.com' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formEncode(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw stripeRequestError(data, res.status);
  return data;
}

function stripeRequestError(data, status) {
  const stripeError = data && data.error && typeof data.error === 'object' ? data.error : {};
  const err = new Error(stripeError.message || 'stripe request failed');
  err.status = status;
  if (typeof stripeError.type === 'string') err.stripeType = stripeError.type;
  if (typeof stripeError.code === 'string') err.stripeCode = stripeError.code;
  return err;
}

function smsEnabled(env) {
  return !!(env && env.SMS_ENABLED === 'true');
}

function checkoutErrorMessage(message) {
  const text = typeof message === 'string' ? message : '';
  if (!text || /sk_|rk_|whsec_|Bearer/i.test(text)) {
    return 'Checkout could not be started. Try again in a minute.';
  }
  return text;
}

function logCheckoutError(err) {
  const stripeType = err && typeof err.stripeType === 'string' ? err.stripeType : '';
  const stripeCode = err && typeof err.stripeCode === 'string' ? err.stripeCode : '';
  const status = err && err.status ? err.status : '';
  const raw = err && err.message ? err.message : '';
  console.error(
    '[cheaprides checkout]',
    'type=' + stripeType,
    'code=' + stripeCode,
    'status=' + status,
    'message=' + checkoutErrorMessage(raw)
  );
}

async function fetchSubscription(env, id) {
  return stripeGet(env, '/v1/subscriptions/' + encodeURIComponent(id));
}

async function lookupPriceId(env, lookupKey) {
  const q = new URLSearchParams();
  q.append('lookup_keys[]', lookupKey);
  q.set('active', 'true');
  q.set('limit', '1');
  const data = await stripeGet(env, '/v1/prices?' + q.toString());
  const price = data.data && data.data[0];
  if (!price || !price.id) {
    const err = new Error('price not configured for ' + lookupKey);
    err.status = 500;
    throw err;
  }
  return price.id;
}

async function findStripeCustomerId(env, email) {
  const local = await env.DB.prepare('SELECT stripe_customer_id FROM subscribers WHERE email = ?')
    .bind(email)
    .first();
  if (local && local.stripe_customer_id) return local.stripe_customer_id;
  const q = new URLSearchParams();
  q.set('email', email);
  q.set('limit', '1');
  const data = await stripeGet(env, '/v1/customers?' + q.toString());
  const found = data.data && data.data[0];
  return found && found.id ? found.id : null;
}

async function handleStripeEvent(env, event) {
  const obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    if (obj.mode && obj.mode !== 'subscription') return;
    const subId = typeof obj.subscription === 'string' ? obj.subscription : null;
    if (!subId) throw new Error('checkout session missing subscription');
    const email =
      (obj.customer_details && obj.customer_details.email) ||
      obj.customer_email ||
      (obj.metadata && obj.metadata.email);
    const sub = await fetchSubscription(env, subId);
    if (!sub.metadata) sub.metadata = {};
    if (!sub.metadata.email && email) sub.metadata.email = email;
    if (!sub.metadata.plan && obj.metadata && obj.metadata.plan) sub.metadata.plan = obj.metadata.plan;
    await applySubscriptionState(env.DB, sub, email);
    return;
  }
  if (event.type === 'invoice.paid') {
    const subId = subscriptionIdFromInvoice(obj);
    if (!subId) throw new Error('invoice missing subscription');
    const sub = await fetchSubscription(env, subId);
    if (!sub.metadata) sub.metadata = {};
    if (!sub.metadata.email && obj.customer_email) sub.metadata.email = obj.customer_email;
    await applySubscriptionState(env.DB, sub, obj.customer_email);
    return;
  }
  if (event.type === 'invoice.payment_failed') {
    const existing = await findSubscriber(env.DB, {
      email: normalizeEmail(obj.customer_email),
      customerId: customerIdFrom(obj.customer),
      subscriptionId: subscriptionIdFromInvoice(obj),
    });
    if (!existing) throw new Error('subscriber not found for payment failure');
    await updateSubscriberByEmail(env.DB, existing.email, {
      status: 'past_due',
      updated_at: isoNow(),
    });
    return;
  }
  if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
    await applySubscriptionState(env.DB, obj, obj.metadata && obj.metadata.email);
    return;
  }
}

async function stripeWebhookPost({ request, env }) {
  const payload = await request.text();
  const header = request.headers.get('Stripe-Signature');
  const ok = await verifyStripeSignature(payload, header, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return json({ error: 'invalid signature' }, 400);
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data || !event.data.object) {
    return json({ error: 'invalid event' }, 400);
  }
  const inserted = await env.DB.prepare(
    'INSERT INTO stripe_events (event_id, type) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING'
  )
    .bind(event.id, event.type)
    .run();
  const changes = inserted && inserted.meta ? inserted.meta.changes : 0;
  if (!changes) return json({ received: true, duplicate: true });
  try {
    await handleStripeEvent(env, event);
  } catch (err) {
    await env.DB.prepare('DELETE FROM stripe_events WHERE event_id = ?').bind(event.id).run();
    console.error('[cheaprides webhook]', event.type, err && err.message ? err.message : err);
    return json({ error: 'webhook handler failed' }, 500);
  }
  return json({ received: true });
}

async function checkoutPost({ request, env }) {
  const body = await readJson(request);
  if (!body.ok || !body.value || typeof body.value !== 'object') {
    return json({ error: 'invalid JSON' }, 400);
  }
  const email = normalizeEmail(body.value.email);
  const plan = body.value.plan;
  if (!email) return json({ error: 'enter a valid email' }, 400);
  if (!PLANS[plan]) return json({ error: 'plan must be monthly, yearly, or sms' }, 400);
  if (plan === 'sms' && !smsEnabled(env)) return json({ error: 'SMS is not available yet' }, 400);
  if (isAdminEmail(env, email)) return json({ error: 'admin accounts do not need a subscription' }, 400);
  const existing = await env.DB.prepare('SELECT plan, status, paid_until FROM subscribers WHERE email = ?')
    .bind(email)
    .first();
  if (blocksDuplicateCheckout(existing)) {
    return json({ error: 'You already have a subscription. Manage billing at /account.' }, 409);
  }
  try {
    const priceId = await lookupPriceId(env, PLANS[plan]);
    const customerId = await findStripeCustomerId(env, email);
    const base = appUrl(env);
    const params = {
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'subscription_data[trial_period_days]': '7',
      'subscription_data[metadata][plan]': plan,
      'subscription_data[metadata][email]': email,
      payment_method_collection: 'always',
      success_url: base + '/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: base + '/checkout/cancel',
      client_reference_id: email,
      'metadata[plan]': plan,
      'metadata[email]': email,
    };
    if (customerId) params.customer = customerId;
    else params.customer_email = email;
    const session = await stripePost(env, '/v1/checkout/sessions', params);
    if (!session.url || !String(session.url).startsWith('https://')) {
      return json({ error: 'checkout failed' }, 502);
    }
    return json({ url: session.url });
  } catch (err) {
    logCheckoutError(err);
    const status = err && err.status && err.status >= 400 && err.status < 500 ? 400 : 502;
    return json({ error: checkoutErrorMessage(err && err.message) }, status);
  }
}

function configGet({ env }) {
  return json({ sms_enabled: smsEnabled(env) });
}

/* A live paid row should not open a second Checkout session.
   Free accounts stay eligible. Trialing is stored as active plus a future paid_until. */
function blocksDuplicateCheckout(row, nowMs = Date.now()) {
  if (!row) return false;
  const paidPlan = row.plan === 'monthly' || row.plan === 'yearly' || row.plan === 'sms';
  const until = row.paid_until ? Date.parse(row.paid_until) : NaN;
  const paidAhead = Number.isFinite(until) && until > nowMs;
  if (paidAhead && paidPlan) return true;
  if (paidPlan && (row.status === 'active' || row.status === 'trialing')) return true;
  return false;
}

function isInstantAccess(row, env, nowMs = Date.now()) {
  if (isAdminEmail(env, row && row.email)) return true;
  if (!row) return false;
  if (row.plan !== 'monthly' && row.plan !== 'yearly' && row.plan !== 'sms') return false;
  if (row.status !== 'active') return false;
  if (!row.paid_until) return false;
  const until = Date.parse(row.paid_until);
  return Number.isFinite(until) && until > nowMs;
}

function publicSubscriber(row, email, env) {
  const admin = isAdminEmail(env, (row && row.email) || email);
  if (!row) {
    return {
      email,
      plan: 'free',
      status: 'none',
      email_confirmed: false,
      paid_until: null,
      trial_end: null,
      sms_phone: null,
      alert_opt_out: false,
      has_billing: false,
      admin,
      instant: admin,
    };
  }
  return {
    email: row.email,
    plan: row.plan,
    status: row.status,
    email_confirmed: !!row.email_confirmed,
    paid_until: row.paid_until || null,
    trial_end: row.trial_end || null,
    sms_phone: row.sms_phone || null,
    alert_opt_out: !!row.alert_opt_out,
    has_billing: !!row.stripe_customer_id,
    admin,
    instant: admin || isInstantAccess(row, env),
  };
}

async function sessionCookie(request, env, sessionId) {
  const sig = await hmacHex(env.SESSION_SECRET, sessionId);
  const secure = new URL(request.url).protocol === 'https:';
  const parts = [
    SESSION_COOKIE + '=' + sessionId + '.' + sig,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=' + String(SESSION_DAYS * 24 * 60 * 60),
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:';
  const parts = [SESSION_COOKIE + '=', 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function readSession(request, env) {
  if (!env.SESSION_SECRET || !env.DB) return null;
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmacHex(env.SESSION_SECRET, id);
  if (!safeEqualStr(sig.toLowerCase(), expected)) return null;
  const row = await env.DB.prepare('SELECT id, email, expires_at FROM sessions WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

async function loginPost({ request, env }) {
  const body = await readJson(request);
  if (!body.ok || !body.value || typeof body.value !== 'object') {
    return json({ error: 'invalid JSON' }, 400);
  }
  const email = normalizeEmail(body.value.email);
  if (!email) return json({ error: 'enter a valid email' }, 400);
  if (!env.SESSION_SECRET) return json({ error: 'sign-in is not configured' }, 500);
  const token = randomToken();
  const hash = await sha256Hex(token);
  const expires = new Date(Date.now() + LOGIN_MINUTES * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
    .bind(hash, email, expires)
    .run();
  const link = appUrl(env) + '/api/auth?token=' + encodeURIComponent(token);
  const sent = await deliverEmail(env, {
    to: email,
    subject: 'Your 406CheapRides sign-in link',
    text:
      'Use this link to sign in to 406CheapRides. It expires in 30 minutes and works once.\n\n' +
      link +
      '\n\nIf you did not ask for this, ignore this email.\n',
  });
  if (!sent.ok) return json({ error: 'could not send email' }, 502);
  return json({ ok: true });
}

async function authGet({ request, env }) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  if (!token || token.length > 200 || !env.SESSION_SECRET) return htmlPage('Link expired', 'That sign-in link is invalid or expired.');
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT email, expires_at, used_at FROM login_tokens WHERE token_hash = ?')
    .bind(hash)
    .first();
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
    return htmlPage('Link expired', 'That sign-in link is invalid or expired.');
  }
  const used = await env.DB.prepare(
    'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'
  )
    .bind(isoNow(), hash)
    .run();
  if (!used.meta || !used.meta.changes) return htmlPage('Link expired', 'That sign-in link is invalid or expired.');
  const sessionId = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, email, expires_at) VALUES (?, ?, ?)')
    .bind(sessionId, row.email, expires)
    .run();
  if (isAdminEmail(env, row.email)) {
    await env.DB.prepare(
      'INSERT INTO subscribers (email, email_confirmed) VALUES (?, 1) ' +
        'ON CONFLICT(email) DO UPDATE SET email_confirmed = 1'
    )
      .bind(row.email)
      .run();
  }
  const cookie = await sessionCookie(request, env, sessionId);
  return new Response(null, {
    status: 302,
    headers: {
      Location: appUrl(env) + '/account',
      'Set-Cookie': cookie,
      'cache-control': 'no-store',
    },
  });
}

async function endSession(request, env) {
  const session = await readSession(request, env);
  if (session) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.id).run();
  }
  return clearSessionCookie(request);
}

async function logoutPost({ request, env }) {
  const cookie = await endSession(request, env);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function logoutGet({ request, env }) {
  const cookie = await endSession(request, env);
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/',
      'Set-Cookie': cookie,
      'cache-control': 'no-store',
    },
  });
}

async function meGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ error: 'sign in required' }, 401);
  const row = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?').bind(session.email).first();
  return json(publicSubscriber(row, session.email, env));
}

async function portalGet({ request, env }) {
  const session = await readSession(request, env);
  if (!session) return json({ error: 'sign in required' }, 401);
  const row = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?').bind(session.email).first();
  let customerId = row && row.stripe_customer_id;
  try {
    if (!customerId) customerId = await findStripeCustomerId(env, session.email);
    if (!customerId) return json({ error: 'no billing account yet' }, 400);
    const portal = await stripePost(env, '/v1/billing_portal/sessions', {
      customer: customerId,
      return_url: appUrl(env) + '/account',
    });
    if (!portal.url || !String(portal.url).startsWith('https://')) {
      return json({ error: 'billing portal failed' }, 502);
    }
    return new Response(null, {
      status: 303,
      headers: { Location: portal.url, 'cache-control': 'no-store' },
    });
  } catch (err) {
    console.error('[cheaprides portal]', err && err.message ? err.message : err);
    return json({ error: 'billing portal failed' }, 502);
  }
}

async function subscribePost({ request, env }) {
  const body = await readJson(request);
  if (!body.ok || !body.value || typeof body.value !== 'object') {
    return json({ error: 'invalid JSON' }, 400);
  }
  const email = normalizeEmail(body.value.email);
  if (!email) return json({ error: 'enter a valid email' }, 400);
  let row = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?').bind(email).first();
  if (row && row.email_confirmed && !row.alert_opt_out) {
    return json({ ok: true, already: true });
  }
  const confirmToken = randomToken();
  const confirmHash = await sha256Hex(confirmToken);
  const confirmExpires = new Date(Date.now() + CONFIRM_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let unsubToken = null;
  if (!row) {
    unsubToken = randomToken();
    const unsubHash = await sha256Hex(unsubToken);
    await insertSubscriber(env.DB, email, {
      confirm_token_hash: confirmHash,
      confirm_token_expires_at: confirmExpires,
      unsubscribe_token_hash: unsubHash,
    });
  } else {
    const fields = {
      confirm_token_hash: confirmHash,
      confirm_token_expires_at: confirmExpires,
      alert_opt_out: 0,
      updated_at: isoNow(),
    };
    if (!row.unsubscribe_token_hash) {
      unsubToken = randomToken();
      fields.unsubscribe_token_hash = await sha256Hex(unsubToken);
    }
    await updateSubscriberByEmail(env.DB, email, fields);
    if (!unsubToken) {
      /* Existing unsubscribe links keep working. We cannot recover the raw token.
         Issue a fresh one so this email still contains a working link. */
      unsubToken = randomToken();
      const unsubHash = await sha256Hex(unsubToken);
      await updateSubscriberByEmail(env.DB, email, {
        unsubscribe_token_hash: unsubHash,
        updated_at: isoNow(),
      });
    }
  }
  const base = appUrl(env);
  const confirmUrl = base + '/api/confirm?token=' + encodeURIComponent(confirmToken);
  const unsubUrl = base + '/api/unsubscribe?token=' + encodeURIComponent(unsubToken);
  const sent = await deliverEmail(env, {
    to: email,
    subject: 'Confirm your 406CheapRides email',
    text:
      'Confirm your email to get free cheap-car alerts.\n\n' +
      confirmUrl +
      '\n\nFree alerts are delayed 24 hours. Paid members see deals right away.\n\n' +
      'Unsubscribe:\n' +
      unsubUrl +
      '\n',
  });
  if (!sent.ok) return json({ error: 'could not send email' }, 502);
  return json({ ok: true });
}

async function confirmGet({ request, env }) {
  const token = new URL(request.url).searchParams.get('token') || '';
  if (!token || token.length > 200) return htmlPage('Link expired', 'That confirm link is invalid or expired.');
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT * FROM subscribers WHERE confirm_token_hash = ?')
    .bind(hash)
    .first();
  if (!row) return htmlPage('Link expired', 'That confirm link is invalid or expired.');
  if (row.confirm_token_expires_at && Date.parse(row.confirm_token_expires_at) <= Date.now()) {
    return htmlPage('Link expired', 'That confirm link is invalid or expired.');
  }
  const fields = {
    email_confirmed: 1,
    alert_opt_out: 0,
    confirm_token_hash: null,
    confirm_token_expires_at: null,
    updated_at: isoNow(),
  };
  if (row.status === 'pending') fields.status = 'active';
  await updateSubscriberByEmail(env.DB, row.email, fields);
  return htmlPage(
    'Email confirmed',
    'You are on the free plan. Deals show up 24 hours after paid members see them.'
  );
}

async function unsubscribeSignature(env, email) {
  if (!env.SESSION_SECRET) return '';
  return hmacHex(env.SESSION_SECRET, 'unsub:' + email);
}

async function unsubscribeUrlFor(env, email) {
  const normalized = normalizeEmail(email) || String(email || '').trim().toLowerCase();
  const sig = await unsubscribeSignature(env, normalized);
  return appUrl(env) + '/api/unsubscribe?email=' + encodeURIComponent(normalized) + '&sig=' + sig;
}

async function unsubscribeGet({ request, env }) {
  const url = new URL(request.url);
  const emailParam = url.searchParams.get('email') || '';
  const sig = url.searchParams.get('sig') || '';
  if (emailParam || sig) {
    const email = normalizeEmail(emailParam);
    if (!email || !sig || !env.SESSION_SECRET) {
      return htmlPage('Unsubscribe', 'That unsubscribe link is invalid.');
    }
    const expected = await unsubscribeSignature(env, email);
    if (!safeEqualStr(expected, sig.toLowerCase())) {
      return htmlPage('Unsubscribe', 'That unsubscribe link is invalid.');
    }
    const row = await env.DB.prepare('SELECT email FROM subscribers WHERE email = ?').bind(email).first();
    if (!row) return htmlPage('Unsubscribe', 'That unsubscribe link is invalid.');
    await updateSubscriberByEmail(env.DB, row.email, { alert_opt_out: 1, updated_at: isoNow() });
    return htmlPage('Unsubscribed', 'You will not get Cheap Rides alert emails. Billing is unchanged.');
  }
  const token = url.searchParams.get('token') || '';
  if (!token || token.length > 200) return htmlPage('Unsubscribe', 'That unsubscribe link is invalid.');
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT email FROM subscribers WHERE unsubscribe_token_hash = ?')
    .bind(hash)
    .first();
  if (!row) return htmlPage('Unsubscribe', 'That unsubscribe link is invalid.');
  await updateSubscriberByEmail(env.DB, row.email, { alert_opt_out: 1, updated_at: isoNow() });
  return htmlPage('Unsubscribed', 'You will not get Cheap Rides alert emails. Billing is unchanged.');
}

function validHttpUrl(value, max) {
  if (typeof value !== 'string' || !value || value.length > (max || 2000)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function requireKey(body, key, fields) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) {
    fields.push({ field: key, message: 'is required' });
    return false;
  }
  return true;
}

export function validateIngestItem(body) {
  const fields = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, fields: [{ field: 'body', message: 'must be an object' }] };
  }
  const event = body.event;
  if (event !== 'new' && event !== 'price_drop' && event !== 'inactive') {
    fields.push({ field: 'event', message: 'must be new, price_drop, or inactive' });
  }
  let listingId = '';
  if (requireKey(body, 'listing_id', fields)) {
    if (typeof body.listing_id !== 'string' || !body.listing_id.trim() || body.listing_id.trim().length > 200) {
      fields.push({ field: 'listing_id', message: 'must be a non-empty string up to 200 characters' });
    } else {
      listingId = body.listing_id.trim();
    }
  }
  if (event === 'inactive') {
    return fields.length ? { ok: false, fields } : { ok: true, value: { event: 'inactive', listing_id: listingId } };
  }

  const fullKeys = [
    'url',
    'title',
    'year',
    'make',
    'model',
    'price',
    'previous_price',
    'drop_flag',
    'categories',
    'deal_score_text',
    'deal_delta_usd',
    'city',
    'state',
    'mileage',
    'hero_photo_url',
    'seen_at',
  ];
  for (const key of fullKeys) requireKey(body, key, fields);
  const present = (key) => Object.prototype.hasOwnProperty.call(body, key);

  if (present('url') && !validHttpUrl(body.url, 2000)) {
    fields.push({ field: 'url', message: 'must be an http or https URL' });
  }
  if (present('title') && (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200)) {
    fields.push({ field: 'title', message: 'must be a non-empty string up to 200 characters' });
  }
  if (present('year') && (!Number.isInteger(body.year) || body.year < 1950 || body.year > 2035)) {
    fields.push({ field: 'year', message: 'must be an integer from 1950 to 2035' });
  }
  if (present('make') && (typeof body.make !== 'string' || !body.make.trim() || body.make.trim().length > 80)) {
    fields.push({ field: 'make', message: 'must be a non-empty string up to 80 characters' });
  }
  if (present('model') && (typeof body.model !== 'string' || !body.model.trim() || body.model.trim().length > 80)) {
    fields.push({ field: 'model', message: 'must be a non-empty string up to 80 characters' });
  }
  if (present('price') && (!Number.isInteger(body.price) || body.price < 0 || body.price > 500000)) {
    fields.push({ field: 'price', message: 'must be an integer USD amount from 0 to 500000' });
  }
  if (
    present('previous_price') &&
    body.previous_price !== null &&
    (!Number.isInteger(body.previous_price) || body.previous_price < 0 || body.previous_price > 500000)
  ) {
    fields.push({ field: 'previous_price', message: 'must be an integer USD amount or null' });
  }
  if (present('drop_flag') && typeof body.drop_flag !== 'boolean') {
    fields.push({ field: 'drop_flag', message: 'must be a boolean' });
  }
  let categories = [];
  if (present('categories')) {
    if (!Array.isArray(body.categories)) {
      fields.push({ field: 'categories', message: 'must be an array' });
    } else {
      const bad = body.categories.filter((item) => typeof item !== 'string' || !CATEGORY_SET.has(item));
      if (bad.length) {
        fields.push({ field: 'categories', message: 'unknown category: ' + bad.join(', ') });
      } else {
        categories = [...new Set(body.categories)];
      }
    }
  }
  if (
    present('deal_score_text') &&
    (typeof body.deal_score_text !== 'string' || !body.deal_score_text.trim() || body.deal_score_text.trim().length > 500)
  ) {
    fields.push({ field: 'deal_score_text', message: 'must be a non-empty string up to 500 characters' });
  }
  if (
    present('deal_delta_usd') &&
    body.deal_delta_usd !== null &&
    (!Number.isInteger(body.deal_delta_usd) || body.deal_delta_usd < -1000000 || body.deal_delta_usd > 1000000)
  ) {
    fields.push({ field: 'deal_delta_usd', message: 'must be an integer or null' });
  }
  if (present('city') && (typeof body.city !== 'string' || !body.city.trim() || body.city.trim().length > 80)) {
    fields.push({ field: 'city', message: 'must be a non-empty string up to 80 characters' });
  }
  if (present('state') && (typeof body.state !== 'string' || !/^[A-Za-z]{2}$/.test(body.state))) {
    fields.push({ field: 'state', message: 'must be a 2-letter state code' });
  }
  if (
    present('mileage') &&
    body.mileage !== null &&
    (!Number.isInteger(body.mileage) || body.mileage < 0 || body.mileage > 2000000)
  ) {
    fields.push({ field: 'mileage', message: 'must be an integer or null' });
  }
  if (present('hero_photo_url') && body.hero_photo_url !== null && body.hero_photo_url !== '' && !validHttpUrl(body.hero_photo_url, 2000)) {
    fields.push({ field: 'hero_photo_url', message: 'must be an http or https URL or null' });
  }
  const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  if (present('seen_at') && (typeof body.seen_at !== 'string' || !isoUtc.test(body.seen_at) || Number.isNaN(Date.parse(body.seen_at)))) {
    fields.push({ field: 'seen_at', message: 'must be an ISO 8601 UTC timestamp ending in Z' });
  }
  if (fields.length || !listingId || (event !== 'new' && event !== 'price_drop')) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    value: {
      event,
      listing_id: listingId,
      url: body.url,
      title: body.title.trim(),
      year: body.year,
      make: body.make.trim(),
      model: body.model.trim(),
      price: body.price,
      previous_price: body.previous_price,
      drop_flag: event === 'price_drop' ? true : body.drop_flag,
      categories,
      deal_score_text: body.deal_score_text.trim(),
      deal_delta_usd: body.deal_delta_usd,
      city: body.city.trim(),
      state: body.state.toUpperCase(),
      mileage: body.mileage,
      hero_photo_url: body.hero_photo_url ? body.hero_photo_url : null,
      seen_at: new Date(body.seen_at).toISOString(),
    },
  };
}

function subscriberWantsListing(categoriesRaw, listingCategories) {
  const prefs = parseCategories(categoriesRaw);
  if (!prefs.length) return true;
  const have = new Set(Array.isArray(listingCategories) ? listingCategories : []);
  return prefs.some((cat) => have.has(cat));
}

function absolutePhotoUrl(env, raw) {
  if (typeof raw !== 'string' || !raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/photos/')) {
    try {
      const url = new URL(raw, appUrl(env) + '/');
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      return '';
    }
  }
  return '';
}

function alertText(env, listing, unsubUrl) {
  const score = listing.deal_score_text || listing.title || 'New cheap ride';
  const lines = [score];
  if (listing.title && listing.title !== score) lines.push(listing.title);
  if (Number.isInteger(listing.price)) lines.push('Price: $' + listing.price.toLocaleString('en-US'));
  const place = [listing.city, listing.state].filter(Boolean).join(', ');
  if (place) lines.push(place);
  const photo = absolutePhotoUrl(env, listing.hero_photo_url);
  if (photo) lines.push('Photo: ' + photo);
  if (listing.url) lines.push(listing.url);
  lines.push('');
  lines.push('Unsubscribe:');
  lines.push(unsubUrl);
  return lines.join('\n');
}

function alertHtml(env, listing, unsubUrl) {
  const score = escapeHtml(listing.deal_score_text || listing.title || 'New cheap ride');
  const title = escapeHtml(listing.title || '');
  const url = typeof listing.url === 'string' && /^https?:\/\//i.test(listing.url) ? listing.url : '';
  const photo = absolutePhotoUrl(env, listing.hero_photo_url);
  const place = [listing.city, listing.state].filter(Boolean).join(', ');
  const price = Number.isInteger(listing.price) ? '$' + listing.price.toLocaleString('en-US') : '';
  const facts = [price, place].filter(Boolean).join(', ');
  let html = '<p>' + score + '</p>';
  if (title) {
    html += url ? '<p><a href="' + escapeHtml(url) + '">' + title + '</a></p>' : '<p>' + title + '</p>';
  }
  if (facts) html += '<p>' + escapeHtml(facts) + '</p>';
  if (photo) html += '<p><img src="' + escapeHtml(photo) + '" alt="' + (title || 'Listing photo') + '" /></p>';
  if (url && !title) html += '<p><a href="' + escapeHtml(url) + '">View listing</a></p>';
  html += '<p><a href="' + escapeHtml(unsubUrl) + '">Unsubscribe</a></p>';
  return html;
}

async function releaseAlertClaim(db, subscriberId, listingId, eventName) {
  await db
    .prepare('DELETE FROM alert_sends WHERE subscriber_id = ? AND listing_id = ? AND event = ?')
    .bind(subscriberId, listingId, eventName)
    .run();
}

async function loadAlertRecipients(env, now) {
  const paid = await env.DB.prepare(
    'SELECT id, email, categories FROM subscribers ' +
      'WHERE email_confirmed = 1 AND alert_opt_out = 0 AND status = ? ' +
      "AND plan IN ('monthly', 'yearly', 'sms') " +
      'AND paid_until IS NOT NULL AND paid_until > ?'
  )
    .bind('active', now)
    .all();
  const byId = new Map();
  for (const row of paid.results || []) byId.set(row.id, row);
  const admins = [...parseAllowlist(env.ADMIN_EMAILS)];
  if (admins.length) {
    const marks = admins.map(() => '?').join(', ');
    const extra = await env.DB.prepare(
      'SELECT id, email, categories FROM subscribers WHERE alert_opt_out = 0 AND lower(email) IN (' + marks + ')'
    )
      .bind(...admins)
      .all();
    for (const row of extra.results || []) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

/* Emails active paid subscribers, and admins who have not opted out, when a
   listing is new or the price drops. Admins do not need paid_until or a
   confirmed flag. One row in alert_sends per subscriber, listing, and event.
   A successful send keeps the row so a retry does not mail twice. A skip or
   failure deletes the row so a later ingest can try again. Mail goes through sendEmail. */
export async function fanOutInstantPaidAlerts(env, listing, eventName) {
  if (!env || !env.DB) return { sent: 0, skipped: 0 };
  if (eventName !== 'new' && eventName !== 'price_drop') return { sent: 0, skipped: 0 };
  if (!listing || !listing.listing_id) return { sent: 0, skipped: 0 };
  const now = isoNow();
  const results = await loadAlertRecipients(env, now);
  let sent = 0;
  let skipped = 0;
  for (const row of results || []) {
    if (!subscriberWantsListing(row.categories, listing.categories)) {
      skipped += 1;
      continue;
    }
    const claim = await env.DB.prepare(
      'INSERT INTO alert_sends (subscriber_id, listing_id, event, created_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(subscriber_id, listing_id, event) DO NOTHING'
    )
      .bind(row.id, listing.listing_id, eventName, now)
      .run();
    const changes = claim && claim.meta ? claim.meta.changes : 0;
    if (!changes) {
      skipped += 1;
      continue;
    }
    try {
      const unsubUrl = await unsubscribeUrlFor(env, row.email);
      const result = await sendEmail(env, {
        to: row.email,
        subject: listing.deal_score_text,
        text: alertText(env, listing, unsubUrl),
        html: alertHtml(env, listing, unsubUrl),
      });
      if (!result.ok) {
        await releaseAlertClaim(env.DB, row.id, listing.listing_id, eventName);
        skipped += 1;
        continue;
      }
      sent += 1;
    } catch (err) {
      await releaseAlertClaim(env.DB, row.id, listing.listing_id, eventName);
      console.error('[cheaprides alerts]', err && err.message ? err.message : err);
      skipped += 1;
    }
  }
  return { sent, skipped, event: eventName, listing_id: listing.listing_id };
}

function scheduleAlertFanOut(ctx, env, listing, eventName) {
  const task = fanOutInstantPaidAlerts(env, listing, eventName).catch((err) => {
    console.error('[cheaprides alerts]', err && err.message ? err.message : err);
    return { sent: 0, skipped: 0, error: true };
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(task);
    return null;
  }
  return task;
}

async function recordPriceHistory(db, item) {
  const existing = await db
    .prepare(
      'SELECT id FROM price_history WHERE listing_id = ? AND price = ? AND seen_at = ? AND ' +
        '((previous_price IS NULL AND ? IS NULL) OR previous_price = ?)'
    )
    .bind(item.listing_id, item.price, item.seen_at, item.previous_price, item.previous_price)
    .first();
  if (existing) return false;
  await db
    .prepare(
      'INSERT INTO price_history (listing_id, price, previous_price, seen_at, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(item.listing_id, item.price, item.previous_price, item.seen_at, isoNow())
    .run();
  return true;
}

async function upsertListing(db, item) {
  const now = isoNow();
  const existing = await db
    .prepare('SELECT listing_id, drop_flag, price, hero_photo_url FROM listings WHERE listing_id = ?')
    .bind(item.listing_id)
    .first();
  const keepDrop = Boolean(item.drop_flag || (existing && existing.drop_flag));
  const dropFlag = keepDrop ? 1 : 0;
  const categories = JSON.stringify(item.categories);
  if (!existing) {
    await db
      .prepare(
        'INSERT INTO listings (' +
          'listing_id, url, title, year, make, model, price, previous_price, drop_flag, ' +
          'categories, deal_score_text, deal_delta_usd, city, state, mileage, hero_photo_url, ' +
          'active, seen_at, created_at, updated_at' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)'
      )
      .bind(
        item.listing_id,
        item.url,
        item.title,
        item.year,
        item.make,
        item.model,
        item.price,
        item.previous_price,
        dropFlag,
        categories,
        item.deal_score_text,
        item.deal_delta_usd,
        item.city,
        item.state,
        item.mileage,
        item.hero_photo_url,
        item.seen_at,
        now,
        now
      )
      .run();
    return { action: 'created', storedPrice: null, hero_photo_url: item.hero_photo_url };
  }
  await db
    .prepare(
      'UPDATE listings SET url = ?, title = ?, year = ?, make = ?, model = ?, price = ?, ' +
        'previous_price = ?, drop_flag = ?, categories = ?, deal_score_text = ?, deal_delta_usd = ?, ' +
        'city = ?, state = ?, mileage = ?, hero_photo_url = COALESCE(?, hero_photo_url), active = 1, seen_at = ?, updated_at = ? ' +
        'WHERE listing_id = ?'
    )
    .bind(
      item.url,
      item.title,
      item.year,
      item.make,
      item.model,
      item.price,
      item.previous_price,
      dropFlag,
      categories,
      item.deal_score_text,
      item.deal_delta_usd,
      item.city,
      item.state,
      item.mileage,
      item.hero_photo_url,
      item.seen_at,
      now,
      item.listing_id
    )
    .run();
  return {
    action: 'updated',
    storedPrice: existing.price,
    hero_photo_url: item.hero_photo_url || existing.hero_photo_url || null,
  };
}

function shouldAlertOnIngest(eventName, saved, nextPrice) {
  if (!saved) return false;
  if (eventName === 'new') return saved.action === 'created';
  if (eventName !== 'price_drop') return false;
  const previous = saved.storedPrice;
  return (
    saved.action === 'updated' &&
    Number.isInteger(previous) &&
    Number.isInteger(nextPrice) &&
    nextPrice < previous
  );
}

async function applyIngestItem(env, item, ctx) {
  if (item.event === 'inactive') {
    const updated = await env.DB.prepare('UPDATE listings SET active = 0, updated_at = ? WHERE listing_id = ?')
      .bind(isoNow(), item.listing_id)
      .run();
    const changes = updated && updated.meta ? updated.meta.changes : 0;
    return {
      ok: true,
      listing_id: item.listing_id,
      action: changes ? 'inactive' : 'inactive_missing',
      price_history: false,
    };
  }
  const saved = await upsertListing(env.DB, item);
  let priceHistory = false;
  if (item.event === 'price_drop') priceHistory = await recordPriceHistory(env.DB, item);
  const stored = {
    listing_id: item.listing_id,
    price: item.price,
    previous_price: item.previous_price,
    categories: item.categories,
    deal_score_text: item.deal_score_text,
    url: item.url,
    title: item.title,
    city: item.city,
    state: item.state,
    hero_photo_url: saved.hero_photo_url,
  };
  let pending = null;
  if (shouldAlertOnIngest(item.event, saved, item.price)) {
    pending = scheduleAlertFanOut(ctx, env, stored, item.event);
  }
  if (pending) await pending;
  return {
    ok: true,
    listing_id: item.listing_id,
    action: saved.action,
    price_history: priceHistory,
  };
}

function ingestAuthorized(request, env) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)\s*$/);
  const token = match ? match[1] : '';
  if (!env.INGEST_TOKEN || !token || !safeEqualStr(token, env.INGEST_TOKEN)) return false;
  return true;
}

async function ingestPost({ request, env, ctx }) {
  if (!ingestAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const body = await readJson(request);
  if (!body.ok) return json({ error: 'invalid JSON' }, 400);
  const payload = body.value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ error: 'expected a JSON object' }, 400);
  }
  const isBatch = Object.prototype.hasOwnProperty.call(payload, 'listings');
  let items;
  if (isBatch) {
    if (!Array.isArray(payload.listings)) return json({ error: 'listings must be an array' }, 400);
    if (payload.listings.length > INGEST_BATCH_LIMIT) {
      return json({ error: 'batch limit is 50' }, 400);
    }
    items = payload.listings;
  } else {
    items = [payload];
  }
  const validated = items.map((item, index) => {
    const result = validateIngestItem(item);
    const listingId = item && typeof item.listing_id === 'string' ? item.listing_id : null;
    return { index, result, listing_id: listingId };
  });
  if (validated.some((entry) => !entry.result.ok)) {
    const results = validated.map((entry) => ({
      index: entry.index,
      listing_id: entry.listing_id,
      ok: entry.result.ok,
      fields: entry.result.ok ? [] : entry.result.fields,
    }));
    if (!isBatch) return json({ error: 'validation failed', fields: results[0].fields, results }, 400);
    return json({ error: 'validation failed', results }, 400);
  }
  const results = [];
  for (const entry of validated) {
    const saved = await applyIngestItem(env, entry.result.value, ctx);
    results.push({ index: entry.index, ...saved });
  }
  return json({ ok: true, results });
}

function parseCategories(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicListing(row) {
  return {
    listing_id: row.listing_id,
    url: row.url,
    title: row.title,
    year: row.year,
    make: row.make,
    model: row.model,
    price: row.price,
    previous_price: row.previous_price,
    drop_flag: !!row.drop_flag,
    categories: parseCategories(row.categories),
    deal_score_text: row.deal_score_text,
    deal_delta_usd: row.deal_delta_usd,
    city: row.city,
    state: row.state,
    mileage: row.mileage,
    hero_photo_url: row.hero_photo_url,
    seen_at: row.seen_at,
  };
}

async function listingsGet({ request, env }) {
  const url = new URL(request.url);
  const feedParam = url.searchParams.get('feed') || 'latest';
  if (feedParam !== 'latest' && feedParam !== 'price_drops') {
    return json({ error: 'feed must be latest or price_drops' }, 400);
  }
  let limit = Number(url.searchParams.get('limit') || 30);
  if (!Number.isInteger(limit) || limit < 1) limit = 30;
  if (limit > 50) limit = 50;
  const session = await readSession(request, env);
  let subscriber = null;
  if (session) {
    subscriber = await env.DB.prepare('SELECT * FROM subscribers WHERE email = ?').bind(session.email).first();
  }
  const instant = isAdminEmail(env, session && session.email) || isInstantAccess(subscriber, env);
  const cutoff = new Date(Date.now() - LISTING_DELAY_MS).toISOString();
  const priceDrops = feedParam === 'price_drops' ? 1 : 0;
  const { results } = await env.DB.prepare(
    'SELECT * FROM listings WHERE active = 1 AND seen_at IS NOT NULL ' +
      'AND (? = 1 OR seen_at <= ?) AND (? = 0 OR drop_flag = 1) ' +
      'ORDER BY seen_at DESC LIMIT ?'
  )
    .bind(instant ? 1 : 0, cutoff, priceDrops, limit)
    .all();
  return json({
    ok: true,
    delayed: !instant,
    feed: feedParam,
    limit,
    listings: (results || []).map(publicListing),
  });
}

function notFound() {
  return json({ error: 'not found' }, 404);
}

function notFoundPage() {
  const body =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Page not found | 406 Cheap Rides</title>' +
    '<meta name="robots" content="noindex">' +
    '<meta name="theme-color" content="#0A0A0A">' +
    '<link rel="stylesheet" href="/styles.css"></head><body>' +
    '<header class="site-header"><a class="brand" href="/"><span class="brand-text">406 Cheap <span>Rides</span></span></a>' +
    '<nav class="site-nav" aria-label="Primary"><a href="/#deals">Deals</a>' +
    '<a href="/categories">Categories</a><a href="/pricing">Pricing</a>' +
    '<a href="/account" data-nav-auth>Sign in</a><a class="btn btn-nav" data-nav-trial href="/pricing">Start free trial</a></nav></header>' +
    '<main class="page"><p class="eyebrow">404</p><h1>Page not found</h1>' +
    '<p class="lede">That page is not on 406 Cheap Rides.</p>' +
    '<p><a class="btn" href="/">Back home</a></p></main></body></html>';
  return new Response(body, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* Static files (robots, sitemap, llms, icons, pages) are not API routes.
   If the asset response has no useful content type, set one from the path. */
function typedAsset(response, path) {
  if (!response) return response;
  const current = (response.headers.get('content-type') || '').toLowerCase();
  if (current && current.indexOf('octet-stream') === -1) return response;
  const types = [
    ['.webmanifest', 'application/manifest+json'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.ico', 'image/x-icon'],
    ['.xml', 'application/xml; charset=utf-8'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
  ];
  const lower = String(path || '').toLowerCase();
  let type = '';
  for (let i = 0; i < types.length; i++) {
    if (lower.endsWith(types[i][0])) {
      type = types[i][1];
      break;
    }
  }
  if (!type) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', type);
  return new Response(response.body, { status: response.status, headers });
}

function isJpegContentType(header) {
  if (!header || typeof header !== 'string') return false;
  const media = header.split(';')[0].trim().toLowerCase();
  return media === 'image/jpeg';
}

/* Ingest listing ids, plus a ban on slashes and dots so the photo key cannot escape the bucket prefix. */
function listingIdForPhoto(raw) {
  if (typeof raw !== 'string') return '';
  const id = raw.trim();
  if (!id || id.length > 200) return '';
  if (id.includes('/') || id.includes('\\') || id.includes('.')) return '';
  return id;
}

function photoNotFound() {
  return new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function photoPost({ request, env }) {
  if (!ingestAuthorized(request, env)) return json({ error: 'unauthorized' }, 401);
  const listingId = listingIdForPhoto(new URL(request.url).searchParams.get('listing_id') || '');
  if (!listingId) return json({ error: 'listing not found' }, 404);
  const row = await env.DB.prepare('SELECT listing_id FROM listings WHERE listing_id = ?').bind(listingId).first();
  if (!row) return json({ error: 'listing not found' }, 404);
  if (!isJpegContentType(request.headers.get('content-type'))) {
    return json({ error: 'content-type must be image/jpeg' }, 400);
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && declared !== '' && Number(declared) > PHOTO_MAX_BYTES) {
    return json({ error: 'payload too large' }, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > PHOTO_MAX_BYTES) return json({ error: 'payload too large' }, 413);
  if (!env.PHOTOS || typeof env.PHOTOS.put !== 'function') {
    return json({ error: 'photo storage is not configured' }, 500);
  }
  await env.PHOTOS.put(listingId + '.jpg', bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare('UPDATE listings SET hero_photo_url = ?, updated_at = ? WHERE listing_id = ?')
    .bind('/photos/' + encodeURIComponent(listingId) + '.jpg', isoNow(), listingId)
    .run();
  return json({ ok: true });
}

async function photoGet(path, env) {
  const match = path.match(/^\/photos\/(.+)\.jpg$/);
  if (!match) return photoNotFound();
  const listingId = listingIdForPhoto(match[1]);
  if (!listingId) return photoNotFound();
  if (!env.PHOTOS || typeof env.PHOTOS.get !== 'function') return photoNotFound();
  const object = await env.PHOTOS.get(listingId + '.jpg');
  if (!object || object.body == null) return photoNotFound();
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=86400',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    try {
      if (path === '/api/config' && request.method === 'GET') return configGet({ env });
      if (path === '/api/checkout' && request.method === 'POST') return await checkoutPost({ request, env });
      if (path === '/api/stripe-webhook' && request.method === 'POST') return await stripeWebhookPost({ request, env });
      if (path === '/api/portal' && request.method === 'GET') return await portalGet({ request, env });
      if (path === '/api/login' && request.method === 'POST') return await loginPost({ request, env });
      if (path === '/api/auth' && request.method === 'GET') return await authGet({ request, env });
      if (path === '/api/logout' && request.method === 'POST') return await logoutPost({ request, env });
      if (path === '/api/logout' && request.method === 'GET') return await logoutGet({ request, env });
      if (path === '/api/me' && request.method === 'GET') return await meGet({ request, env });
      if (path === '/api/subscribe' && request.method === 'POST') return await subscribePost({ request, env });
      if (path === '/api/confirm' && request.method === 'GET') return await confirmGet({ request, env });
      if (path === '/api/unsubscribe' && request.method === 'GET') return await unsubscribeGet({ request, env });
      if (path === '/api/ingest' && request.method === 'POST') return await ingestPost({ request, env, ctx });
      if (path === '/api/photo' && request.method === 'POST') return await photoPost({ request, env });
      if (path === '/api/listings' && request.method === 'GET') return await listingsGet({ request, env });
      if (path.startsWith('/api/')) return notFound();
      if (path.startsWith('/photos/') && request.method === 'GET') return await photoGet(path, env);
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        const asset = await env.ASSETS.fetch(request);
        if (asset && asset.status !== 404) return typedAsset(asset, path);
      }
      return notFoundPage();
    } catch (err) {
      console.error('[cheaprides]', err && err.message ? err.message : err);
      return json({ error: 'internal error' }, 500);
    }
  },
};
