export interface Config {
  pumpfunSessionToken: string;
  telegramBotToken: string;
  telegramChatId: string;
  stateDbPath: string;
  xLinkRecheckBatchSize: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    pumpfunSessionToken: requireEnv('PUMPFUN_SESSION_TOKEN'),
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    telegramChatId: requireEnv('TELEGRAM_CHAT_ID'),
    stateDbPath: process.env.STATE_DB_PATH || './state/callouts.db',
    xLinkRecheckBatchSize: Number(process.env.X_LINK_RECHECK_BATCH_SIZE) || 10,
  };
}
