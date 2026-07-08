import Database from 'better-sqlite3';
import type { Callout } from './models.js';

export interface KnownCaller {
  profile_id: string;
  display_name: string | null;
  first_confirmed_at: string;
  confirmation_reason: string;
  x_linked: number | null; // 0/1/null
  x_handle: string | null;
  x_last_checked_at: string | null;
}

export interface FirstCalloutAlertRecord {
  calloutId: string;
  callerProfileId: string;
  callerDisplayName: string | null;
  coinMint: string;
  coinSymbol: string | null;
  marketCapAtCall: number;
  xLinkedAtCallTime: boolean | null;
  xHandleAtCallTime: string | null;
  notifyStatus: 'sent' | 'failed';
}

export interface XLinkedAlertRecord {
  profileId: string;
  displayName: string | null;
  xHandle: string;
  notifyStatus: 'sent' | 'failed';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen_callouts (
    callout_id          TEXT PRIMARY KEY,
    caller_profile_id   TEXT NOT NULL,
    observed_at         TEXT NOT NULL,
    callout_created_at  TEXT,
    processed_ok        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_seen_callouts_observed_at ON seen_callouts(observed_at);

CREATE TABLE IF NOT EXISTS known_callers (
    profile_id            TEXT PRIMARY KEY,
    display_name          TEXT,
    first_confirmed_at    TEXT NOT NULL,
    confirmation_reason   TEXT NOT NULL,
    x_linked              INTEGER,
    x_handle              TEXT,
    x_last_checked_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_known_callers_x_last_checked ON known_callers(x_last_checked_at);

CREATE TABLE IF NOT EXISTS first_callout_alerts (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    callout_id             TEXT NOT NULL,
    caller_profile_id      TEXT NOT NULL,
    caller_display_name    TEXT,
    coin_mint              TEXT,
    coin_symbol            TEXT,
    market_cap_at_call     REAL,
    x_linked_at_call_time  INTEGER,
    x_handle_at_call_time  TEXT,
    alert_sent_at          TEXT NOT NULL,
    notify_status          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS x_linked_alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id      TEXT NOT NULL,
    display_name    TEXT,
    x_handle        TEXT,
    detected_at     TEXT NOT NULL,
    alert_sent_at   TEXT NOT NULL,
    notify_status   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
`;

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  hasSeenCallout(calloutId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM seen_callouts WHERE callout_id = ?')
      .get(calloutId);
    return row !== undefined;
  }

  markCalloutSeen(callout: Callout): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO seen_callouts
         (callout_id, caller_profile_id, observed_at, callout_created_at, processed_ok)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(
        callout.calloutId,
        callout.userId,
        new Date().toISOString(),
        new Date(callout.createdAt).toISOString(),
      );
  }

  pruneOldSeenCallouts(olderThanDays: number): void {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM seen_callouts WHERE observed_at < ?').run(cutoff);
  }

  getKnownCaller(profileId: string): KnownCaller | undefined {
    return this.db
      .prepare('SELECT * FROM known_callers WHERE profile_id = ?')
      .get(profileId) as KnownCaller | undefined;
  }

  confirmCallerHasHistory(
    profileId: string,
    displayName: string | null,
    reason: 'history>1' | 'was_first_timer_we_alerted' | 'bootstrap_seed',
  ): void {
    this.db
      .prepare(
        `INSERT INTO known_callers (profile_id, display_name, first_confirmed_at, confirmation_reason)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id) DO NOTHING`,
      )
      .run(profileId, displayName, new Date().toISOString(), reason);
  }

  getCallersForXLinkRecheck(batchSize: number): KnownCaller[] {
    return this.db
      .prepare(
        `SELECT * FROM known_callers
         ORDER BY x_last_checked_at IS NOT NULL, x_last_checked_at ASC
         LIMIT ?`,
      )
      .all(batchSize) as KnownCaller[];
  }

  updateXLinkStatus(
    profileId: string,
    xLinked: boolean,
    xHandle: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE known_callers
         SET x_linked = ?, x_handle = ?, x_last_checked_at = ?
         WHERE profile_id = ?`,
      )
      .run(xLinked ? 1 : 0, xHandle, new Date().toISOString(), profileId);
  }

  recordFirstCalloutAlert(alert: FirstCalloutAlertRecord): void {
    this.db
      .prepare(
        `INSERT INTO first_callout_alerts
         (callout_id, caller_profile_id, caller_display_name, coin_mint, coin_symbol,
          market_cap_at_call, x_linked_at_call_time, x_handle_at_call_time,
          alert_sent_at, notify_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.calloutId,
        alert.callerProfileId,
        alert.callerDisplayName,
        alert.coinMint,
        alert.coinSymbol,
        alert.marketCapAtCall,
        alert.xLinkedAtCallTime === null ? null : alert.xLinkedAtCallTime ? 1 : 0,
        alert.xHandleAtCallTime,
        new Date().toISOString(),
        alert.notifyStatus,
      );
  }

  recordXLinkedAlert(alert: XLinkedAlertRecord): void {
    this.db
      .prepare(
        `INSERT INTO x_linked_alerts
         (profile_id, display_name, x_handle, detected_at, alert_sent_at, notify_status)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.profileId,
        alert.displayName,
        alert.xHandle,
        new Date().toISOString(),
        new Date().toISOString(),
        alert.notifyStatus,
      );
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  isBootstrapped(): boolean {
    return this.getMeta('bootstrapped') === 'true';
  }

  setBootstrapped(): void {
    this.setMeta('bootstrapped', 'true');
  }
}
