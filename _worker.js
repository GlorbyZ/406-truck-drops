/* 406 Truck Drops - bundled worker for Cloudflare Pages direct upload.
   Routes /api/* to handlers, serves static assets via ASSETS binding. */
/* Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) using WebCrypto only. */

function b64urlEncode(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const te = new TextEncoder();
const str = (s) => te.encode(s);

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey(
    'raw',
    prk,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  let t = new Uint8Array(0);
  let okm = new Uint8Array(0);
  let i = 0;
  while (okm.length < length) {
    i++;
    const input = concat(t, info, new Uint8Array([i]));
    t = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
    okm = concat(okm, t);
  }
  return okm.slice(0, length);
}

/* Encrypt payload per RFC 8291, aes128gcm content encoding. */
async function encryptPush(p256dhB64, authB64, payloadBytes) {
  const clientPub = b64urlDecode(p256dhB64); // 65-byte uncompressed point
  const authSecret = b64urlDecode(authB64); // 16 bytes
  if (clientPub.length !== 65 || authSecret.length !== 16) {
    throw new Error('bad subscription keys');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, eph.privateKey, 256)
  );

  const prk = await hmacSha256(authSecret, ikm);
  const cekInfo = concat(str('Content-Encoding: aes128gcm'), new Uint8Array([0]), clientPub, ephPub);
  const nonceInfo = concat(str('Content-Encoding: nonce'), new Uint8Array([0]), clientPub, ephPub);
  const cek = await hkdfExpand(prk, cekInfo, 16);
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = concat(new Uint8Array([0, 0]), payloadBytes);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, plaintext)
  );

  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // record size 4096
  const body = concat(salt, rs, new Uint8Array([ephPub.length]), ephPub, ciphertext);
  return { body, salt, ephPub };
}

/* Build the VAPID Authorization header value (RFC 8292).
   privateKeyJwk: JSON string of a JWK {kty:'EC',crv:'P-256',x,y,d}. */
async function vapidAuthorization(endpoint, subject, publicKeyB64, privateKeyJwk) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const unsigned =
    b64urlEncode(str(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) +
    '.' +
    b64urlEncode(str(JSON.stringify({ aud, exp, sub: subject })));
  const key = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(privateKeyJwk),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, str(unsigned));
  const jwt = unsigned + '.' + b64urlEncode(new Uint8Array(sig));
  return 'vapid t=' + jwt + ', k=' + publicKeyB64;
}

/* Send one encrypted push. Returns the HTTP status. */
async function sendPush(subscription, payloadObj, vapid) {
  const payloadBytes = str(JSON.stringify(payloadObj));
  const { body, salt, ephPub } = await encryptPush(
    subscription.p256dh,
    subscription.auth,
    payloadBytes
  );
  const authorization = await vapidAuthorization(
    subscription.endpoint,
    vapid.subject,
    vapid.publicKey,
    vapid.privateKey
  );
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      Encryption: 'salt=' + b64urlEncode(salt),
      'Crypto-Key': 'dh=' + b64urlEncode(ephPub) + ';p256ecdsa=' + vapid.publicKey,
      Authorization: authorization,
      TTL: '86400',
    },
    body,
  });
  return res.status;
}

async function dropsGet({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT listing_id, title, price, location, listed_at, url, take ' +
      'FROM drops ORDER BY created_at DESC LIMIT 100'
  ).all();
  return Response.json(results || []);
}

async function subscribePost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  const keys = body && body.keys;
  const p256dh = keys && typeof keys.p256dh === 'string' ? keys.p256dh : '';
  const auth = keys && typeof keys.auth === 'string' ? keys.auth : '';
  if (!endpoint || !p256dh || !auth) {
    return Response.json({ error: 'endpoint and keys.p256dh/auth are required' }, { status: 400 });
  }
  await env.DB.prepare(
    'INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?) ' +
      'ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth'
  )
    .bind(endpoint, p256dh, auth)
    .run();
  return Response.json({ ok: true });
}

async function vapidKeyGet({ env }) {
  if (!env.VAPID_PUBLIC_KEY) {
    return Response.json({ error: 'push not configured' }, { status: 503 });
  }
  return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
}


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

async function ingestPost({ request, env }) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/drops' && request.method === 'GET')
        return await dropsGet({ env });
      if (path === '/api/drops/ingest' && request.method === 'POST')
        return await ingestPost({ request, env });
      if (path === '/api/push/subscribe' && request.method === 'POST')
        return await subscribePost({ request, env });
      if (path === '/api/push/vapid-public-key' && request.method === 'GET')
        return await vapidKeyGet({ env });
      if (path.startsWith('/api/'))
        return Response.json({ error: 'not found' }, { status: 404 });
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return Response.json({ error: 'internal error' }, { status: 500 });
    }
  }
};
