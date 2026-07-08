import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import type { DetectorClient } from './detector.js';
import { runDetectionCycle } from './detector.js';
import { AuthExpiredError } from './errors.js';
import { PumpfunClient } from './pumpfunClient.js';
import { TelegramNotifier, type Notifier } from './notifier.js';
import { Store } from './state.js';

const BOOTSTRAP_PAGE_SIZE = 50;
const TOKEN_EXPIRY_WARNING_HOURS = 48;
const TOKEN_EXPIRY_WARNING_THROTTLE_MS = 24 * 60 * 60 * 1000;
const AUTH_EXPIRED_WARNING_THROTTLE_MS = 6 * 60 * 60 * 1000;
const UNEXPECTED_ERROR_WARNING_THROTTLE_MS = 3 * 60 * 60 * 1000;
const SEEN_CALLOUT_RETENTION_DAYS = 14;

export async function bootstrap(client: DetectorClient, store: Store): Promise<void> {
  const response = await client.getRecentCallouts({ limit: BOOTSTRAP_PAGE_SIZE });
  for (const callout of response.callouts) {
    store.markCalloutSeen(callout);
  }
  store.setBootstrapped();
}

function recentlyWarned(store: Store, key: string, throttleMs: number): boolean {
  const lastWarnedAt = store.getMeta(key);
  if (!lastWarnedAt) return false;
  return Date.now() - new Date(lastWarnedAt).getTime() < throttleMs;
}

async function checkTokenExpiry(
  client: PumpfunClient,
  store: Store,
  notifier: Notifier,
): Promise<void> {
  const profile = await client.getMyProfile();
  const hoursRemaining = (profile.exp * 1000 - Date.now()) / (1000 * 60 * 60);

  if (hoursRemaining > TOKEN_EXPIRY_WARNING_HOURS) return;
  if (recentlyWarned(store, 'token_expiry_warning_sent_at', TOKEN_EXPIRY_WARNING_THROTTLE_MS)) return;

  await notifier.sendSystemMessage(
    `Your pump.fun session token expires in about ${Math.max(0, Math.round(hoursRemaining))} hours. ` +
      'Refresh it (see README) and update the PUMPFUN_SESSION_TOKEN secret.',
  );
  store.setMeta('token_expiry_warning_sent_at', new Date().toISOString());
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // No local .env - expected in CI, where secrets come from the environment directly.
  }

  const config = loadConfig();
  const client = new PumpfunClient(config.pumpfunSessionToken);

  fs.mkdirSync(path.dirname(config.stateDbPath), { recursive: true });
  const store = new Store(config.stateDbPath);
  const notifier: Notifier = new TelegramNotifier(config.telegramBotToken, config.telegramChatId);

  try {
    await checkTokenExpiry(client, store, notifier);

    if (!store.isBootstrapped()) {
      await bootstrap(client, store);
      console.log('[main] Bootstrap complete - seeded seen callouts, no alerts sent this run.');
      return;
    }

    const result = await runDetectionCycle(client, store, {
      xLinkRecheckBatchSize: config.xLinkRecheckBatchSize,
    });

    for (const alert of result.firstCalloutAlerts) {
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
    }

    for (const alert of result.xLinkedAlerts) {
      const sent = await notifier.sendXLinkedAlert(alert);
      store.recordXLinkedAlert({
        profileId: alert.profileId,
        displayName: alert.displayName,
        xHandle: alert.xHandle,
        notifyStatus: sent ? 'sent' : 'failed',
      });
    }

    store.pruneOldSeenCallouts(SEEN_CALLOUT_RETENTION_DAYS);

    console.log(
      `[main] Cycle complete: ${result.firstCalloutAlerts.length} first-callout alert(s), ` +
        `${result.xLinkedAlerts.length} x-linked alert(s).`,
    );
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      console.error('[main] Auth expired:', err.message);
      if (!recentlyWarned(store, 'auth_expired_warning_sent_at', AUTH_EXPIRED_WARNING_THROTTLE_MS)) {
        await notifier.sendSystemMessage(
          'Your pump.fun session token appears to be invalid or expired. ' +
            'Please refresh it (see README) and update the PUMPFUN_SESSION_TOKEN secret.',
        );
        store.setMeta('auth_expired_warning_sent_at', new Date().toISOString());
      }
      process.exitCode = 1;
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error('[main] Unexpected error:', err);
    if (!recentlyWarned(store, 'unexpected_error_warning_sent_at', UNEXPECTED_ERROR_WARNING_THROTTLE_MS)) {
      await notifier.sendSystemMessage(
        `The callout monitor hit an unexpected error and this run failed: ${message}. ` +
          'Check the GitHub Actions run log for details.',
      );
      store.setMeta('unexpected_error_warning_sent_at', new Date().toISOString());
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch((err) => {
  console.error('[main] Unhandled error:', err);
  process.exitCode = 1;
});
