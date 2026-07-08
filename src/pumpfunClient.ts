import { AuthExpiredError, TransientAPIError } from './errors.js';
import type {
  AuthProfile,
  CalloutListResponse,
  CoinInfo,
  Profile,
} from './models.js';

const BASE_URL = 'https://frontend-api-v3.pump.fun';
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 1000;
const RATE_LIMIT_FALLBACK_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(header);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

export class PumpfunClient {
  constructor(private readonly sessionToken: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }

      const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          Cookie: `auth_token=${this.sessionToken}`,
          Accept: 'application/json',
        },
      });

      if (res.status === 401 || res.status === 403) {
        throw new AuthExpiredError(`Auth failed (${res.status}) for ${path}`);
      }

      if (res.status === 429 || res.status >= 500) {
        lastErr = new TransientAPIError(`Transient error (${res.status}) for ${path}`);
        // Rate limits get their own wait, honoring Retry-After if pump.fun
        // sends one, since guessing with exponential backoff alone is what
        // burned us here - a 429 usually means "not yet", not "try harder".
        if (res.status === 429) {
          await sleep(retryAfterMs(res) ?? RATE_LIMIT_FALLBACK_DELAY_MS);
        }
        continue;
      }

      if (!res.ok) {
        throw new Error(`Unexpected status ${res.status} for ${path}`);
      }

      return (await res.json()) as T;
    }
    throw lastErr;
  }

  async getMyProfile(): Promise<AuthProfile> {
    return this.request<AuthProfile>('/auth/my-profile');
  }

  async getProfile(address: string): Promise<Profile> {
    return this.request<Profile>(`/users/${address}`);
  }

  async getRecentCallouts(opts: {
    limit: number;
    pageToken?: string;
  }): Promise<CalloutListResponse> {
    const qs = new URLSearchParams({
      limit: String(opts.limit),
      sortBy: 'TIMESTAMP',
      sortOrder: 'DESC',
    });
    if (opts.pageToken) qs.set('pageToken', opts.pageToken);
    return this.request<CalloutListResponse>(`/callout/recent?${qs}`);
  }

  async getCallerHistory(
    userId: string,
    opts: { limit: number; pageToken?: string },
  ): Promise<CalloutListResponse> {
    const qs = new URLSearchParams({
      limit: String(opts.limit),
      sortBy: 'TIMESTAMP',
      sortOrder: 'DESC',
    });
    if (opts.pageToken) qs.set('pageToken', opts.pageToken);
    return this.request<CalloutListResponse>(`/callout/list/${userId}?${qs}`);
  }

  async getCoins(mints: string[]): Promise<CoinInfo[]> {
    if (mints.length === 0) return [];
    return this.request<CoinInfo[]>('/coins-v2/mints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mints),
    });
  }
}
