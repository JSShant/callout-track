import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DetectorClient } from '../src/detector.js';
import { runDetectionCycle } from '../src/detector.js';
import type { CalloutListResponse, CoinInfo, Profile } from '../src/models.js';
import { Store } from '../src/state.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(dirname, 'fixtures', name), 'utf8')) as T;
}

const recentFeed = fixture<CalloutListResponse>('callout-recent.json');
const emptyHistory = fixture<CalloutListResponse>('caller-history-empty.json');
const singleHistory = fixture<CalloutListResponse>('caller-history-single.json');
const unlinkedProfile = fixture<Profile>('profile-unlinked.json');
const linkedProfile = fixture<Profile>('profile-linked.json');

function fakeClient(overrides: Partial<DetectorClient> = {}): DetectorClient {
  return {
    getRecentCallouts: async () => ({ callouts: [], nextPageToken: '' }),
    getCallerHistory: async () => emptyHistory,
    getProfile: async () => unlinkedProfile,
    getCoins: async (mints: string[]): Promise<CoinInfo[]> =>
      mints.map((mint) => ({ mint, name: 'Test Coin', symbol: 'TEST' })),
    ...overrides,
  };
}

test('genuine first-timer callout triggers an alert and caches the caller as known', async () => {
  const store = new Store(':memory:');
  const callout = singleHistory.callouts[0]!;
  const client = fakeClient({
    getRecentCallouts: async () => ({ callouts: [callout], nextPageToken: '' }),
    getCallerHistory: async () => singleHistory,
  });

  const result = await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(result.firstCalloutAlerts.length, 1);
  assert.equal(result.firstCalloutAlerts[0]!.calloutId, callout.calloutId);
  assert.equal(store.getKnownCaller(callout.userId)?.confirmation_reason, 'was_first_timer_we_alerted');
  store.close();
});

test('caller with prior history is not flagged as a first-timer', async () => {
  const store = new Store(':memory:');
  const callout = recentFeed.callouts[0]!;
  const priorCallout = { ...recentFeed.callouts[1]!, userId: callout.userId };
  const client = fakeClient({
    getRecentCallouts: async () => ({ callouts: [callout], nextPageToken: '' }),
    getCallerHistory: async () => ({ callouts: [callout, priorCallout], nextPageToken: '' }),
  });

  const result = await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(result.firstCalloutAlerts.length, 0);
  assert.equal(store.getKnownCaller(callout.userId)?.confirmation_reason, 'history>1');
  store.close();
});

test('already-known caller is skipped without an extra history lookup', async () => {
  const store = new Store(':memory:');
  const callout = recentFeed.callouts[0]!;
  store.confirmCallerHasHistory(callout.userId, 'existing-caller', 'bootstrap_seed');

  let historyCalls = 0;
  const client = fakeClient({
    getRecentCallouts: async () => ({ callouts: [callout], nextPageToken: '' }),
    getCallerHistory: async () => {
      historyCalls++;
      return emptyHistory;
    },
  });

  const result = await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(result.firstCalloutAlerts.length, 0);
  assert.equal(historyCalls, 0);
  store.close();
});

test('ambiguous history (callout not yet visible in caller history) fails closed', async () => {
  const store = new Store(':memory:');
  const callout = recentFeed.callouts[0]!;
  const client = fakeClient({
    getRecentCallouts: async () => ({ callouts: [callout], nextPageToken: '' }),
    getCallerHistory: async () => emptyHistory, // doesn't even contain this callout yet
  });

  const result = await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(result.firstCalloutAlerts.length, 0);
  assert.equal(store.getKnownCaller(callout.userId), undefined);
  store.close();
});

test('feed pagination stops once an already-seen callout id is reached', async () => {
  const store = new Store(':memory:');
  const [first, second, third] = recentFeed.callouts;
  store.markCalloutSeen(second!);

  let pageRequests = 0;
  const client = fakeClient({
    getRecentCallouts: async () => {
      pageRequests++;
      return { callouts: [first!, second!, third!], nextPageToken: '' };
    },
    getCallerHistory: async () => emptyHistory,
  });

  await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(pageRequests, 1);
  assert.equal(store.hasSeenCallout(first!.calloutId), true);
  assert.equal(store.hasSeenCallout(third!.calloutId), false);
  store.close();
});

test('x-link transition fires only on a genuine not-linked -> linked change', async () => {
  const store = new Store(':memory:');
  store.confirmCallerHasHistory('addr1', 'user1', 'bootstrap_seed');
  store.updateXLinkStatus('addr1', false, null); // establishes a prior "not linked" baseline

  const client = fakeClient({
    getProfile: async () => ({ ...linkedProfile, address: 'addr1' }),
  });

  const result = await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(result.xLinkedAlerts.length, 1);
  assert.equal(result.xLinkedAlerts[0]!.profileId, 'addr1');
  assert.equal(result.xLinkedAlerts[0]!.xHandle, linkedProfile.x_username);
  store.close();
});

test('x-link already true on the very first check does not fire (no prior baseline)', async () => {
  const store = new Store(':memory:');
  store.confirmCallerHasHistory('addr2', 'user2', 'bootstrap_seed');
  // no prior updateXLinkStatus call - x_last_checked_at stays null

  const client = fakeClient({
    getProfile: async () => ({ ...linkedProfile, address: 'addr2' }),
  });

  const result = await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(result.xLinkedAlerts.length, 0);
  assert.equal(store.getKnownCaller('addr2')?.x_linked, 1);
  store.close();
});

test('x-link still false on recheck does not fire, but refreshes the checked-at timestamp', async () => {
  const store = new Store(':memory:');
  store.confirmCallerHasHistory('addr3', 'user3', 'bootstrap_seed');
  store.updateXLinkStatus('addr3', false, null);
  const before = store.getKnownCaller('addr3')!.x_last_checked_at;

  const client = fakeClient({
    getProfile: async () => ({ ...unlinkedProfile, address: 'addr3' }),
  });

  const result = await runDetectionCycle(client, store, { xLinkRecheckBatchSize: 10 });

  assert.equal(result.xLinkedAlerts.length, 0);
  const after = store.getKnownCaller('addr3')!;
  assert.equal(after.x_linked, 0);
  assert.ok(after.x_last_checked_at! >= before!);
  store.close();
});
