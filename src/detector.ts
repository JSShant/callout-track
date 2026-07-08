import type { PumpfunClient } from './pumpfunClient.js';
import type { Callout } from './models.js';
import type { Notifier } from './notifier.js';
import type { Store } from './state.js';

// Structural subset of PumpfunClient's public API that detection actually
// needs - lets tests supply a plain fake object instead of a real client.
export type DetectorClient = Pick<
  PumpfunClient,
  'getRecentCallouts' | 'getCallerHistory' | 'getProfile' | 'getCoins'
>;

export interface FirstCalloutAlert {
  calloutId: string;
  callerProfileId: string;
  callerDisplayName: string | null;
  coinMint: string;
  coinSymbol: string | null;
  marketCapAtCall: number;
  xLinked: boolean | null;
  xHandle: string | null;
}

export interface XLinkedAlert {
  profileId: string;
  displayName: string | null;
  xHandle: string;
}

export interface DetectionResult {
  firstCalloutAlertsSent: number;
  xLinkedAlertsSent: number;
}

const FEED_PAGE_SIZE = 25;
const MAX_FEED_PAGES = 20; // safety valve if seen-set is somehow empty/stale

async function fetchNewCallouts(client: DetectorClient, store: Store): Promise<Callout[]> {
  const newCallouts: Callout[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const response = await client.getRecentCallouts({ limit: FEED_PAGE_SIZE, pageToken });

    let hitSeen = false;
    for (const callout of response.callouts) {
      if (store.hasSeenCallout(callout.calloutId)) {
        hitSeen = true;
        break;
      }
      newCallouts.push(callout);
    }

    if (hitSeen || !response.nextPageToken) break;
    pageToken = response.nextPageToken;
  }

  return newCallouts;
}

// Sends and persists each alert the instant it's confirmed, rather than
// collecting them for delivery after the whole cycle finishes - so a later
// failure elsewhere in the same run can never retroactively erase an alert
// that was already correctly identified.
async function processNewCallouts(
  client: DetectorClient,
  store: Store,
  notifier: Notifier,
  newCallouts: Callout[],
): Promise<number> {
  let sentCount = 0;

  for (const callout of newCallouts) {
    store.markCalloutSeen(callout);

    const known = store.getKnownCaller(callout.userId);
    if (known) continue;

    const history = await client.getCallerHistory(callout.userId, { limit: 5 });
    const foundSelf = history.callouts.some((c) => c.calloutId === callout.calloutId);
    const otherCallouts = history.callouts.filter((c) => c.calloutId !== callout.calloutId);

    if (!foundSelf) {
      // Fail closed: the callout hasn't propagated to the caller's own
      // history endpoint yet (consistency lag). Don't guess - it'll resolve
      // on a later poll once it's visible there too.
      console.warn(
        `[detector] callout ${callout.calloutId} (caller ${callout.userId}) not yet visible in caller history - deferring`,
      );
      continue;
    }

    if (otherCallouts.length > 0) {
      // Prior history we simply hadn't observed yet - not a first-timer.
      store.confirmCallerHasHistory(callout.userId, null, 'history>1');
      continue;
    }

    const [profile, coins] = await Promise.all([
      client.getProfile(callout.userId),
      client.getCoins([callout.coinMint]),
    ]);
    const coin = coins[0];

    const alert: FirstCalloutAlert = {
      calloutId: callout.calloutId,
      callerProfileId: callout.userId,
      callerDisplayName: profile.username,
      coinMint: callout.coinMint,
      coinSymbol: coin?.symbol ?? null,
      marketCapAtCall: callout.marketCap,
      xLinked: profile.x_username !== null,
      xHandle: profile.x_username,
    };

    const sent = await notifier.sendFirstCalloutAlert(alert);
    store.recordFirstCalloutAlert({
      calloutId: alert.calloutId,
      callerProfileId: alert.callerProfileId,
      callerDisplayName: alert.callerDisplayName,
      coinMint: alert.coinMint,
      coinSymbol: alert.coinSymbol,
      marketCapAtCall: alert.marketCapAtCall,
      xLinkedAtCallTime: alert.xLinked,
      xHandleAtCallTime: alert.xHandle,
      notifyStatus: sent ? 'sent' : 'failed',
    });
    store.confirmCallerHasHistory(callout.userId, profile.username, 'was_first_timer_we_alerted');
    sentCount++;
  }

  return sentCount;
}

async function processXLinkTransitions(
  client: DetectorClient,
  store: Store,
  notifier: Notifier,
  batchSize: number,
): Promise<number> {
  let sentCount = 0;
  const candidates = store.getCallersForXLinkRecheck(batchSize);

  for (const caller of candidates) {
    const profile = await client.getProfile(caller.profile_id);
    const isLinked = profile.x_username !== null;
    const wasLinked = caller.x_linked === 1;
    const hasPriorCheck = caller.x_last_checked_at !== null;

    // Only a genuine not-linked -> linked transition counts. A caller we're
    // checking for the first time who already has X linked has no prior
    // "false" baseline to transition from, so it's not an alert-worthy event.
    if (hasPriorCheck && !wasLinked && isLinked && profile.x_username) {
      const alert: XLinkedAlert = {
        profileId: caller.profile_id,
        displayName: profile.username,
        xHandle: profile.x_username,
      };
      const sent = await notifier.sendXLinkedAlert(alert);
      store.recordXLinkedAlert({
        profileId: alert.profileId,
        displayName: alert.displayName,
        xHandle: alert.xHandle,
        notifyStatus: sent ? 'sent' : 'failed',
      });
      sentCount++;
    }

    store.updateXLinkStatus(caller.profile_id, isLinked, profile.x_username);
  }

  return sentCount;
}

export async function runDetectionCycle(
  client: DetectorClient,
  store: Store,
  notifier: Notifier,
  config: { xLinkRecheckBatchSize: number },
): Promise<DetectionResult> {
  const newCallouts = await fetchNewCallouts(client, store);
  const firstCalloutAlertsSent = await processNewCallouts(client, store, notifier, newCallouts);
  const xLinkedAlertsSent = await processXLinkTransitions(
    client,
    store,
    notifier,
    config.xLinkRecheckBatchSize,
  );

  return { firstCalloutAlertsSent, xLinkedAlertsSent };
}
