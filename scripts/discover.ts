// Discovery spike (Stage 3): probe real pump.fun endpoints with a real session
// cookie to confirm response shapes before the real client/models get built.
// Deliberately sends ONLY the auth_token cookie (no cf_clearance / _cf_bm) to
// test whether Cloudflare's bot-challenge cookies are actually required.

process.loadEnvFile('.env');

const token = process.env.PUMPFUN_SESSION_TOKEN;
if (!token) {
  console.error('Missing PUMPFUN_SESSION_TOKEN in .env');
  process.exit(1);
}

const BASE = 'https://frontend-api-v3.pump.fun';

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Cookie: `auth_token=${token}`,
      Accept: '*/*',
    },
  });
  console.log(`\n=== ${init.method ?? 'GET'} ${path} -> ${res.status} ${res.statusText} ===`);
  // Surface a couple of headers that would indicate a Cloudflare challenge page
  // instead of a real API response, without dumping everything.
  const cfRay = res.headers.get('cf-ray');
  const contentType = res.headers.get('content-type');
  console.log(`content-type: ${contentType}, cf-ray: ${cfRay}`);

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.log('(non-JSON response, first 500 chars below)');
    console.log(text.slice(0, 500));
    return null;
  }
}

const myProfile = await call('/auth/my-profile');
console.log(JSON.stringify(myProfile, null, 2));

const leaderboard = await call('/callout/leaderboard?limit=3');
console.log(JSON.stringify(leaderboard, null, 2)?.slice(0, 800));

// Educated-guess probes for: rich profile detail (X-link should live here),
// a per-user callout history endpoint, and the main global callout feed.
const myAddress = (myProfile as { address?: string } | null)?.address;
const first = (await call(
  `/callout/recent?limit=5&sortBy=TIMESTAMP&sortOrder=DESC`,
)) as { callouts: unknown[]; nextPageToken: string } | null;

if (first?.nextPageToken) {
  const second = await call(
    `/callout/recent?limit=5&sortBy=TIMESTAMP&sortOrder=DESC&pageToken=${encodeURIComponent(first.nextPageToken)}`,
  );
  console.log(JSON.stringify(second, null, 2));
}
