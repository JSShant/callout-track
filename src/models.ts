// Shapes confirmed empirically against live frontend-api-v3.pump.fun
// responses — see docs/api-notes.md for the discovery notes these are
// derived from.

export interface Callout {
  calloutId: string;
  userId: string; // caller's wallet address
  coinMint: string;
  marketCap: number;
  calloutPrice: number;
  multiple: number;
  createdAt: number; // unix ms
  maxPriceSol: number;
  peakTimestamp?: number; // absent until some time/movement has passed
  thesis?: string; // caller's own written rationale, not always present
}

export interface CalloutListResponse {
  callouts: Callout[];
  nextPageToken: string; // empty string = no more pages
}

export interface Profile {
  address: string;
  username: string;
  profile_image: string;
  followers: number;
  following: number;
  bio: string | null;
  x_username: string | null;
  x_id: string | null;
}

export interface AuthProfile {
  address: string;
  roles: string[];
  iat: number;
  exp: number; // unix seconds
}

export interface CoinInfo {
  mint: string;
  name: string;
  symbol: string;
}
