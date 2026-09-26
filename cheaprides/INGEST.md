# 406 Cheap Rides ingest contract

The scanner POSTs listings here. This endpoint stores them. A successful `new` or `price_drop` also emails active paid subscribers from `fanOutInstantPaidAlerts` in `public/_worker.js`. That work runs in `ctx.waitUntil` so the ingest response does not wait on mail. Every message goes through `sendEmail`, so the allowlist guard still applies unless `ALLOW_REAL_SENDS` is exactly `true`. One row in `alert_sends` (unique on subscriber, listing, and event) stops a retry from sending the same alert twice. This endpoint does not send SMS.

## Request

`POST /api/ingest`

Current test URL: `https://406-cheap-rides.pages.dev/api/ingest`

Planned custom domain: `https://cheaprides.406truckdrops.com/api/ingest`

Header:

```http
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json
```

`INGEST_TOKEN` is a Pages secret. A missing header, a wrong token, or an empty server token returns:

```json
{ "error": "unauthorized" }
```

HTTP 401. The body is not validated in that case.

Send one listing object, or a batch:

```json
{ "listings": [ { "...": "..." }, { "...": "..." } ] }
```

Batch cap is 50. Over that, HTTP 400:

```json
{ "error": "batch limit is 50" }
```

Invalid JSON is HTTP 400 `{ "error": "invalid JSON" }`. A JSON array or any non-object is `{ "error": "expected a JSON object" }`.

## Events

`event` is `new`, `price_drop`, or `inactive`.

`inactive` only requires `event` and `listing_id`. Other fields are ignored. The row is marked inactive and drops off the public feed. If the id is unknown, the result action is `inactive_missing` and nothing is inserted.

`new` and `price_drop` require every field below. Unknown extra fields are ignored. Types are strict: a numeric string is rejected, and `drop_flag` must be a JSON boolean.

| Field | Type | Rules |
| --- | --- | --- |
| `event` | string | `new`, `price_drop`, or `inactive` |
| `listing_id` | string | Required, 1 to 200 chars. Idempotency key. |
| `url` | string | `http` or `https` URL |
| `title` | string | 1 to 200 chars |
| `year` | integer | 1950 through 2035 |
| `make` | string | 1 to 80 chars |
| `model` | string | 1 to 80 chars |
| `price` | integer | USD dollars, 0 through 500000. Not cents. |
| `previous_price` | integer or null | Same range, or null |
| `drop_flag` | boolean | `price_drop` is stored with this forced to true |
| `categories` | string array | Each value must be one of `beater_commuter`, `winter_beater`, `first_car`, `mechanics_special`, `fun_cheap`. Empty array is allowed. Duplicates are collapsed. |
| `deal_score_text` | string | 1 to 500 chars. Example: `2012 Civic, $2,800, about $900 under market.` |
| `deal_delta_usd` | integer or null | About how far under (negative) or over (positive) market, -1000000 through 1000000 |
| `city` | string | 1 to 80 chars |
| `state` | string | Two letters. Stored uppercase. |
| `mileage` | integer or null | 0 through 2000000, or null |
| `hero_photo_url` | string or null | `http` or `https` URL, or null |
| `seen_at` | string | ISO 8601 UTC ending in `Z`, such as `2026-09-26T18:04:00Z` or `2026-09-26T18:04:00.123Z`. Offsets like `+00:00` are rejected. |

Upserts are idempotent on `listing_id`. A later `new` or `price_drop` updates the same row and marks it active again.

Price history is written only for `event: "price_drop"`. A repeat of the same `listing_id`, `price`, `previous_price`, and `seen_at` does not insert another history row. `price_history` in the result is true only when a new history row was stored.

If any item in a batch fails validation, nothing in that request is written.

## Success

HTTP 200:

```json
{
  "ok": true,
  "results": [
    {
      "index": 0,
      "ok": true,
      "listing_id": "fb-1001",
      "action": "created",
      "price_history": false
    }
  ]
}
```

`action` is `created`, `updated`, `inactive`, or `inactive_missing`.

## Validation error

Single object, HTTP 400:

```json
{
  "error": "validation failed",
  "fields": [
    { "field": "price", "message": "must be an integer USD amount from 0 to 500000" }
  ],
  "results": [
    {
      "index": 0,
      "listing_id": "fb-1001",
      "ok": false,
      "fields": [
        { "field": "price", "message": "must be an integer USD amount from 0 to 500000" }
      ]
    }
  ]
}
```

Batch, HTTP 400, same `results` array with one entry per item. Items that were valid are `"ok": true` with `"fields": []`, but they are not saved when any sibling failed.

## Examples

### new

```bash
curl -sS -X POST "$APP_URL/api/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "new",
    "listing_id": "fb-1001",
    "url": "https://www.facebook.com/marketplace/item/1001",
    "title": "2012 Honda Civic",
    "year": 2012,
    "make": "Honda",
    "model": "Civic",
    "price": 2800,
    "previous_price": null,
    "drop_flag": false,
    "categories": ["first_car", "beater_commuter"],
    "deal_score_text": "2012 Civic, $2,800, about $900 under market.",
    "deal_delta_usd": -900,
    "city": "Billings",
    "state": "MT",
    "mileage": 168000,
    "hero_photo_url": "https://example.com/civic.jpg",
    "seen_at": "2026-09-26T18:04:00Z"
  }'
```

### price_drop

```json
{
  "event": "price_drop",
  "listing_id": "fb-1001",
  "url": "https://www.facebook.com/marketplace/item/1001",
  "title": "2012 Honda Civic",
  "year": 2012,
  "make": "Honda",
  "model": "Civic",
  "price": 2500,
  "previous_price": 2800,
  "drop_flag": true,
  "categories": ["first_car"],
  "deal_score_text": "2012 Civic, $2,500, about $1,200 under market.",
  "deal_delta_usd": -1200,
  "city": "Billings",
  "state": "MT",
  "mileage": 168000,
  "hero_photo_url": null,
  "seen_at": "2026-09-26T20:15:00Z"
}
```

### inactive

```json
{ "event": "inactive", "listing_id": "fb-1001" }
```

### batch

```json
{
  "listings": [
    { "event": "new", "listing_id": "fb-1001" },
    { "event": "inactive", "listing_id": "fb-1002" }
  ]
}
```

The `new` object in that snippet is incomplete on purpose: the whole batch would 400 and list the missing fields, and `fb-1002` would not be marked inactive.

## Public read model

Ingest does not return the feed. Readers use `GET /api/listings`. Anonymous and free accounts only see rows with `seen_at` at least 24 hours old. Paid subscribers with `paid_until` in the future, a confirmed email, and alerts still on get the instant email from `fanOutInstantPaidAlerts` instead of waiting on that delay. An empty category list means every deal. Any other list only matches listings in those categories.
