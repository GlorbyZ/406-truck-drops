export async function onRequestGet({ env }) {
  if (!env.VAPID_PUBLIC_KEY) {
    return Response.json({ error: 'push not configured' }, { status: 503 });
  }
  return Response.json({ publicKey: env.VAPID_PUBLIC_KEY });
}
