export async function onRequestPost({ request, env }) {
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
