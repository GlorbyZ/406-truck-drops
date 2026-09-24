import { sendPush } from '../../_lib/webpush.js';

const FROM_EMAIL = 'alerts@406truckdrops.com';
const FROM_NAME = '406 Truck Drops';

function priceLabel(price) {
  return price === null || price === undefined || price === ''
    ? 'price on listing'
    : '$' + Number(price).toLocaleString('en-US');
}

async function sendEmail(env, drop) {
  const body =
    drop.title +
    '\n' +
    priceLabel(drop.price) +
    (drop.location ? ' in ' + drop.location : '') +
    '\n' +
    'Listed: ' +
    (drop.listed_at || 'unknown') +
    '\n' +
    (drop.url || '') +
    '\n\n' +
    (drop.take || '');
  const res = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: env.NOTIFY_EMAIL }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: 'New 4x4 drop: ' + drop.title + ' - ' + priceLabel(drop.price),
      content: [{ type: 'text/plain', value: body }],
    }),
  });
  if (!res.ok) {
    throw new Error('mailchannels ' + res.status);
  }
}

async function sendPushes(env, drop) {
  const { results } = await env.DB.prepare(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions'
  ).all();
  const subs = results || [];
  if (!subs.length) return 0;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return 0;

  const payload = {
    title: 'New 4x4 drop',
    body: drop.title + ' - ' + priceLabel(drop.price) + ' in ' + (drop.location || 'Billings area'),
    url: '/',
  };
  const vapid = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
  let sent = 0;
  for (const sub of subs) {
    try {
      const status = await sendPush(sub, payload, vapid);
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
          .bind(sub.endpoint)
          .run();
      } else if (status >= 200 && status < 300) {
        sent++;
      }
    } catch {
      // one bad subscription must not block the rest
    }
  }
  return sent;
}

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const listing_id = typeof body.listing_id === 'string' ? body.listing_id.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!listing_id || !title) {
    return Response.json({ error: 'listing_id and title are required' }, { status: 400 });
  }
  const price =
    body.price === null || body.price === undefined || body.price === ''
      ? null
      : Number(body.price);
  if (price !== null && !Number.isFinite(price)) {
    return Response.json({ error: 'price must be a number or null' }, { status: 400 });
  }
  const drop = {
    listing_id,
    title,
    price,
    location: typeof body.location === 'string' ? body.location : null,
    listed_at: typeof body.listed_at === 'string' ? body.listed_at : null,
    url: typeof body.url === 'string' ? body.url : null,
    take: typeof body.take === 'string' ? body.take : null,
  };

  const existing = await env.DB.prepare('SELECT listing_id FROM drops WHERE listing_id = ?')
    .bind(listing_id)
    .first();

  if (existing) {
    await env.DB.prepare(
      'UPDATE drops SET title = ?, price = ?, location = ?, listed_at = ?, url = ?, take = ? ' +
        'WHERE listing_id = ?'
    )
      .bind(drop.title, drop.price, drop.location, drop.listed_at, drop.url, drop.take, listing_id)
      .run();
    return Response.json({ ok: true, created: false });
  }

  await env.DB.prepare(
    'INSERT INTO drops (listing_id, title, price, location, listed_at, url, take) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(
      drop.listing_id,
      drop.title,
      drop.price,
      drop.location,
      drop.listed_at,
      drop.url,
      drop.take
    )
    .run();

  // First insert only: notify. Alerts are best-effort; the drop is already stored.
  try {
    if (env.NOTIFY_EMAIL) await sendEmail(env, drop);
  } catch {
    // keep going; push still attempted
  }
  let pushed = 0;
  try {
    pushed = await sendPushes(env, drop);
  } catch {
    // ignore
  }

  return Response.json({ ok: true, created: true, pushed });
}
