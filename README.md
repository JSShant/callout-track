# Pump.fun Callout Monitor

Polls pump.fun's callout feed and sends a Telegram alert for two events:

- **First callout ever** — an account's genuine first-ever callout (not just the first one this tool has observed).
- **X newly linked** — any previously-tracked caller linking an X (Twitter) account to their pump.fun profile for the first time.

Runs on a GitHub Actions schedule, so it works even when your own machine is off. See `../.claude/plans` (or ask Claude) for the full design rationale — this file only covers setup and day-to-day operation.

## ⚠️ Before you start: read this

Pump.fun's Terms of Service prohibit automated/bot access. This tool talks to unofficial, reverse-engineered endpoints, not a sanctioned API. Practical risk for a low-volume personal monitor is account-level (token revocation, possible suspension), not legal — but it's real, not hypothetical. **Use a burner pump.fun account for this, never your main one.**

## One-time setup

### 1. Burner wallet + pump.fun account

1. Install a Solana wallet browser extension if you don't already have one that supports multiple accounts (Phantom or Solflare are the most common).
2. Create a **brand-new** wallet/account inside it — don't reuse your main wallet. It never needs any SOL; it only logs in and reads data.
3. Go to pump.fun, click "connect wallet," pick the new burner wallet, and approve the sign-in prompt (a free signature, not a paid transaction).

### 2. Telegram bot

1. In Telegram, message **@BotFather** and send `/newbot`. Follow the prompts (display name, then a username ending in "bot").
2. BotFather gives you an API token like `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ` — save it, you'll need it in step 4.
3. Send your new bot any message (bots can't message you first).
4. Message **@userinfobot** — it replies with your numeric user id. That's your chat id.

### 3. GitHub repo + secrets

1. Create a new **private** GitHub repository and push this project to it.
2. In the repo, go to **Settings → Secrets and variables → Actions** and add three repository secrets:
   - `PUMPFUN_SESSION_TOKEN` — see below for how to get this.
   - `TELEGRAM_BOT_TOKEN` — from step 2.
   - `TELEGRAM_CHAT_ID` — from step 2.

### Getting your session token

1. Log into pump.fun as the **burner account**.
2. Open DevTools (F12) → **Network** tab.
3. Browse to the callouts page (or your profile).
4. Click any request going to `advanced-api-v2.pump.fun`.
5. In **Request Headers**, find `Authorization: Bearer <long string>` and copy everything after `Bearer `.

(If discovery testing finds the token is actually stored somewhere else, e.g. a cookie, this section will be updated to match.)

This token will expire periodically. The bot proactively warns you in Telegram a couple of days before expiry, and reactively if it ever gets a 401/403 — when either happens, repeat these steps to grab a fresh token and update the `PUMPFUN_SESSION_TOKEN` secret.

## Local development

```
npm install
cp .env.example .env   # fill in real values — never commit .env
npm run discover        # empirical API discovery spike
npm test                 # unit tests against saved fixtures
npm start                # one full poll cycle, locally
```

## Hosting notes

- Default: **private repo, 30-minute polling cadence.** Private repos get 2,000 free GitHub Actions minutes/month; at 30-minute cadence this uses about 1,440 minutes/month — comfortably inside the free tier.
- Faster alternative: make the repo **public** and drop to a 5-minute cadence — Actions minutes are unlimited/free on public repos regardless of cadence. Tradeoff: workflow run logs become world-readable, so this matters more if that log ever accidentally contains anything sensitive (it shouldn't — secrets are always masked by GitHub — but it's a lower-margin-for-error setup).
- State (which callouts/callers have already been seen) lives in a SQLite file committed to a separate `state` branch, amended and force-pushed each run — this keeps `main` free of noise and keeps the repo "active" so GitHub doesn't auto-disable the schedule after 60 days of inactivity.
