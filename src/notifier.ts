import type { FirstCalloutAlert, XLinkedAlert } from './detector.js';

export interface Notifier {
  sendFirstCalloutAlert(alert: FirstCalloutAlert): Promise<boolean>;
  sendXLinkedAlert(alert: XLinkedAlert): Promise<boolean>;
  sendSystemMessage(text: string): Promise<boolean>;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMarketCap(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  private async send(text: string): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        console.error(`[notifier] Telegram sendMessage failed: ${res.status} ${await res.text()}`);
      }
      return res.ok;
    } catch (err) {
      console.error('[notifier] Telegram sendMessage threw', err);
      return false;
    }
  }

  async sendFirstCalloutAlert(alert: FirstCalloutAlert): Promise<boolean> {
    const callerName = alert.callerDisplayName ?? alert.callerProfileId;
    const coinLabel = alert.coinSymbol ? `$${escapeHtml(alert.coinSymbol)}` : alert.coinMint;
    const xLine = alert.xLinked && alert.xHandle
      ? `X linked: @${escapeHtml(alert.xHandle)}`
      : 'X linked: no';
    const profilePath = alert.callerDisplayName ?? alert.callerProfileId;

    const text = [
      '🆕 <b>First callout ever</b>',
      `${escapeHtml(callerName)} called ${coinLabel}`,
      `Market cap at call: ${formatMarketCap(alert.marketCapAtCall)}`,
      xLine,
      `https://pump.fun/profile/${profilePath}?tab=callouts`,
    ].join('\n');

    return this.send(text);
  }

  async sendXLinkedAlert(alert: XLinkedAlert): Promise<boolean> {
    const callerName = alert.displayName ?? alert.profileId;
    const profilePath = alert.displayName ?? alert.profileId;

    const text = [
      '🔗 <b>X account linked</b>',
      `${escapeHtml(callerName)} just linked @${escapeHtml(alert.xHandle)}`,
      `https://pump.fun/profile/${profilePath}`,
    ].join('\n');

    return this.send(text);
  }

  async sendSystemMessage(text: string): Promise<boolean> {
    return this.send(`⚠️ ${escapeHtml(text)}`);
  }
}
