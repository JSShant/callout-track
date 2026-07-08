import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/state.js';
import type { Callout } from '../src/models.js';

function makeCallout(overrides: Partial<Callout> = {}): Callout {
  return {
    calloutId: 'callout-1',
    userId: 'user-1',
    coinMint: 'mint-1',
    marketCap: 1000,
    calloutPrice: 0.001,
    multiple: 1,
    createdAt: Date.now(),
    maxPriceSol: 0.001,
    ...overrides,
  };
}

test('seen callouts round-trip and dedupe', () => {
  const store = new Store(':memory:');
  const callout = makeCallout();

  assert.equal(store.hasSeenCallout(callout.calloutId), false);
  store.markCalloutSeen(callout);
  assert.equal(store.hasSeenCallout(callout.calloutId), true);

  // Marking the same id again should not throw (INSERT OR IGNORE).
  store.markCalloutSeen(callout);
  assert.equal(store.hasSeenCallout(callout.calloutId), true);
  store.close();
});

test('known callers round-trip and are idempotent on conflict', () => {
  const store = new Store(':memory:');
  assert.equal(store.getKnownCaller('user-1'), undefined);

  store.confirmCallerHasHistory('user-1', 'alice', 'history>1');
  const first = store.getKnownCaller('user-1');
  assert.equal(first?.display_name, 'alice');
  assert.equal(first?.confirmation_reason, 'history>1');

  // Second confirmation for the same profile should not overwrite the first.
  store.confirmCallerHasHistory('user-1', 'alice-renamed', 'was_first_timer_we_alerted');
  const second = store.getKnownCaller('user-1');
  assert.equal(second?.display_name, 'alice');
  assert.equal(second?.confirmation_reason, 'history>1');
  store.close();
});

test('x-link recheck ordering prioritizes never-checked, then oldest-checked', () => {
  const store = new Store(':memory:');
  store.confirmCallerHasHistory('never-checked', null, 'bootstrap_seed');
  store.confirmCallerHasHistory('checked-later', null, 'bootstrap_seed');
  store.confirmCallerHasHistory('checked-earlier', null, 'bootstrap_seed');

  store.updateXLinkStatus('checked-later', false, null);
  store.updateXLinkStatus('checked-earlier', false, null);
  // Force a distinguishable ordering between the two "checked" rows.
  store.updateXLinkStatus('checked-earlier', false, null);

  const batch = store.getCallersForXLinkRecheck(10).map((c) => c.profile_id);
  assert.equal(batch[0], 'never-checked');
  assert.ok(batch.includes('checked-later'));
  assert.ok(batch.includes('checked-earlier'));
  store.close();
});

test('bootstrapped flag defaults to false and can be set', () => {
  const store = new Store(':memory:');
  assert.equal(store.isBootstrapped(), false);
  store.setBootstrapped();
  assert.equal(store.isBootstrapped(), true);
  store.close();
});

test('pruning removes only callouts older than the retention window', () => {
  const store = new Store(':memory:');
  const db = (store as unknown as { db: import('better-sqlite3').Database }).db;

  store.markCalloutSeen(makeCallout({ calloutId: 'recent' }));
  store.markCalloutSeen(makeCallout({ calloutId: 'old' }));

  const oldTimestamp = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE seen_callouts SET observed_at = ? WHERE callout_id = ?').run(
    oldTimestamp,
    'old',
  );

  store.pruneOldSeenCallouts(14);

  assert.equal(store.hasSeenCallout('recent'), true);
  assert.equal(store.hasSeenCallout('old'), false);
  store.close();
});
