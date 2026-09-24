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
export async function encryptPush(p256dhB64, authB64, payloadBytes) {
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
export async function vapidAuthorization(endpoint, subject, publicKeyB64, privateKeyJwk) {
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
export async function sendPush(subscription, payloadObj, vapid) {
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
