# Pump.fun API notes (empirical discovery)

Confirmed by live testing (2026-07-08) against `frontend-api-v3.pump.fun`,
using a real burner-account session. This supersedes the original
reverse-engineered spec (community capture dated 2026-06-17), which turned
out to be stale/incomplete for the social/callout feature surface — that spec
assumed a different host (`advanced-api-v2.pump.fun`) and a Bearer-header auth
scheme, neither of which matched reality.

Discovery is complete: all four endpoints needed for both Event A (first
callout ever) and Event B (X newly linked) are confirmed working, with real
response shapes and pagination behavior verified.

## Host & auth

- Host: `https://frontend-api-v3.pump.fun`
- Auth: **cookie**, not a Bearer header — `Cookie: auth_token=<JWT>`.
- Confirmed working with **only** `auth_token` — no `cf_clearance` / `_cf_bm`
  (Cloudflare bot-challenge cookies) needed. Tested from a residential IP so
  far; still needs confirming from an actual GitHub Actions runner (datacenter
  IP) before fully trusting this for production hosting — that's the real
  test of the edge-blocking risk flagged in the plan.
- Identifier scheme: the **Solana wallet address** is the user/caller id
  throughout (not a separate opaque profile id).
- `pump.fun/callouts?_rsc=...` requests are Next.js RSC framework noise
  (component-tree bootstrapping), not data — confirmed by fetching a fresh,
  uncached copy directly (142KB, zero occurrences of any callout field).
  Ignore these entirely.

## Endpoints

### `GET /auth/my-profile`

Echoes the JWT's own claims — not a rich profile:

```json
{ "address": "...", "roles": ["user"], "iat": 1783477542, "exp": 1786069542 }
```

Use for the token-expiry warning: read `exp` (Unix seconds) directly, no JWT
decoding needed.

### `GET /callout/recent?limit=N&sortBy=TIMESTAMP&sortOrder=DESC` — the global feed (Event A discovery source)

**This is the answer to "how do we discover new callouts as they happen,
before they've performed well."** Chronological, not performance-filtered —
confirmed by seeing entries with `multiple: 1` (zero price movement since the
call) and no `peakTimestamp` field yet (only appears once real time/movement
has passed). Cursor-paginated via `nextPageToken` → pass back as `pageToken`
on the next request; verified the cursor advances correctly with no gaps or
duplicate overlap between pages.

```json
{
  "callouts": [
    {
      "calloutId": "cb3b4e69-100c-477c-8c52-9719e2f6b501",
      "userId": "FHMUdL1ib65cCmHMK4URsqadwUCyTjHzkWE8CN1pQ21m",
      "coinMint": "4oSjoQiCyp3odQuuk3MsLcpWAYMk3VGm6FrCD4topump",
      "marketCap": 8239.43628321469,
      "calloutPrice": 1.0392179851307236e-7,
      "multiple": 1,
      "createdAt": 1783479951233,
      "maxPriceSol": 1.0392179851307236e-7,
      "thesis": "BULLISH AF 🔥 ape a bag and call it out",
      "user_uuid": ""
    }
  ],
  "nextPageToken": "eyJz...=="
}
```

Fields beyond the leaderboard shape:
- `thesis` — the caller's own written rationale for the call. Optional
  enrichment for alerts (not required, but nice context).
- `peakTimestamp` — **absent** on very fresh callouts (no peak established
  yet), present once some time/movement has occurred.

`nextPageToken` decodes (base64) to `{"score": <createdAt of last item>,
"member": "<userId>|<createdAt>|<calloutId>"}` — a Redis-sorted-set-style
cursor. Treat as opaque; just pass it straight through as `pageToken`, no
need to construct it manually.

**Poll loop design:** each cycle, page through `/callout/recent` (sorted
DESC, newest first) until reaching a `calloutId` already in `seen_callouts`,
not a fixed page count — matches the plan's original pagination design.

### `GET /callout/list/{userId}?limit=N&sortBy=TIMESTAMP&sortOrder=DESC` — per-caller history (Event A confirmation)

Same shape and pagination pattern as `/callout/recent`, scoped to one caller.
This is the authoritative "does this account have any callout other than the
current one" check.

Confirmed against two real cases:
- A burner account with zero callouts: `{"callouts": [], "nextPageToken": ""}`
  — this is what "genuinely no history" looks like.
- `iitachi` (the account from the original inspiration screenshot, profile
  page shows "CALLOUTS 1"): returns exactly one item, matching the profile
  page's own displayed count exactly.

### `GET /users/{address}` — profile detail (Event B signal)

```json
{
  "address": "HYHsXtHf2UDxe6oXaysdRm8w3ZNvC37QVBNsLgZeobpX",
  "likes_received": 0,
  "mentions_received": 0,
  "username": "solarsalmon0835",
  "profile_image": "https://ipfs.io/ipfs/...",
  "last_username_update_timestamp": 0,
  "following": 0,
  "followers": 0,
  "bio": null,
  "x_username": null,
  "x_id": null
}
```

**`x_username` / `x_id` are the Event B signal** — both `null` when unlinked,
presumably populated once a real X account is linked. This is the singular
per-user lookup; the plural `POST /users/batch` (lighter, for hydrating many
avatars/usernames at once in a list) does **not** include these two fields —
use the singular endpoint specifically for X-link checks.

## Explicitly not needed (ruled out / superseded)

- `POST /coins-v2/mints` has a `twitter` field, but it's the **coin's** own
  X link/community (e.g. an announcement tweet), not the caller's — do not
  conflate with Event B.
- `/callout/leaderboard?limit=N` — performance-ranked (avgMultiple,
  totalCallouts, etc.), confirmed to silently ignore a `userId` filter param.
  Not used for discovery (can't catch a first-timer before they've
  performed), not used for per-caller history (that's `/callout/list/{userId}`
  instead). May still be worth surfacing on alerts as a "how does this
  compare to top callers" stat, but not load-bearing for either event.
- A WebSocket/NATS-based real-time channel exists on the `/callouts` page
  (`prod-v2.nats.realtime.pump.fun`, `unified-prod.nats.realtime.pump.fun`,
  plus a Socket.IO connection) — but since `/callout/recent` fully solves the
  discovery problem via clean REST polling, there's no need to reverse-engineer
  this. Noting its existence in case it's ever worth revisiting (e.g. if
  polling latency ever becomes a real problem), but it's explicitly out of
  scope for now.
- Confirmed 404 (dead ends, don't re-try): `/profile/{address}`,
  `/x/connection`, `/x/public-handles` (as a GET), `/callout/user/{address}`,
  `/callout/history/{address}`, `/callout/feed`, `/callout/list` (bare),
  `/callout/global`, `/callout/new`, `/callout/leaderboard/recent`,
  `/users/{address}/callouts`, `/callouts` (plural, bare).

## Still open (minor, not blocking)

- Exact request shape (query params vs POST body) for `POST /users/batch` —
  have the response shape, not the full request detail. Not needed for the
  core build (the singular `/users/{address}` covers what we need).
- Whether `cf_clearance`/Cloudflare edge behavior differs when requests come
  from a GitHub Actions runner (datacenter IP) rather than a residential IP —
  still needs a real test from within an actual Actions run before fully
  trusting the hosting plan.
