import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DetectorClient } from '../src/detector.js';
import type { CalloutListResponse } from '../src/models.js';
import { bootstrap } from '../src/main.js';
import { Store } from '../src/state.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const recentFeed = JSON.parse(
  readFileSync(path.join(dirname, 'fixtures', 'callout-recent.json'), 'utf8'),
) as CalloutListResponse;

test('bootstrap seeds every currently-visible callout as seen without alerting', async () => {
  const store = new Store(':memory:');
  const client: DetectorClient = {
    getRecentCallouts: async () => recentFeed,
    getCallerHistory: async () => ({ callouts: [], nextPageToken: '' }),
    getProfile: async () => {
      throw new Error('not expected during bootstrap');
    },
    getCoins: async () => [],
  };

  assert.equal(store.isBootstrapped(), false);

  await bootstrap(client, store);

  for (const callout of recentFeed.callouts) {
    assert.equal(store.hasSeenCallout(callout.calloutId), true);
  }
  assert.equal(store.isBootstrapped(), true);
  // Bootstrap only seeds the dedup ledger - it deliberately does not touch
  // known_callers, since a caller's veteran status is confirmed lazily the
  // next time they show up in the feed (see detector.ts).
  assert.equal(store.getKnownCaller(recentFeed.callouts[0]!.userId), undefined);
  store.close();
});
