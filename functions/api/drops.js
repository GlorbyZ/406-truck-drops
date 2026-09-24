export async function onRequestGet({ env }) {
  const { results } = await env.DB.prepare(
    'SELECT listing_id, title, price, location, listed_at, url, take ' +
      'FROM drops ORDER BY created_at DESC LIMIT 100'
  ).all();
  return Response.json(results || []);
}
