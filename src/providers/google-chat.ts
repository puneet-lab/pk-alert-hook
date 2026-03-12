import { formatGoogleChatCard } from '../formatter.js';
import type { AlertPayload, AlertProvider } from '../types.js';

export class GoogleChatProvider implements AlertProvider {
  readonly name = 'google-chat';
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async send(payload: AlertPayload): Promise<void> {
    const card = formatGoogleChatCard(payload);

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(card),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      throw new Error(
        `Google Chat webhook failed: ${response.status} ${response.statusText} — ${body}`,
      );
    }
  }
}
