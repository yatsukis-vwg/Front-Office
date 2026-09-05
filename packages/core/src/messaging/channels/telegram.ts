import { constantTimeEquals } from '../../crypto/encryption.js';
import { logger } from '../../logger.js';
import type { ChannelAdapter, ChannelCredentials, InboundMessage, OutboundMessage, SendResult, WebhookRequest } from '../types.js';

/**
 * Telegram Bot API adapter.
 *
 * Registration is a single call — see README "Telegram setup". Telegram echoes
 * the secret we set at registration time in `X-Telegram-Bot-Api-Secret-Token`,
 * which is what `verify` checks.
 */

const API_BASE = 'https://api.telegram.org';

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: { id: string; data?: string; message?: TelegramMessage; from?: TelegramUser };
}

interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat: { id: number | string; type: string };
  from?: TelegramUser;
  contact?: { phone_number?: string };
}

interface TelegramUser {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export class TelegramChannel implements ChannelAdapter {
  readonly id = 'telegram' as const;
  readonly displayName = 'Telegram';

  verify(request: WebhookRequest, credentials: ChannelCredentials): boolean {
    const expected = credentials.telegramWebhookSecret;
    // A clinic with no configured secret accepts unauthenticated updates; that
    // is only ever the case in local development.
    if (!expected) return true;
    const provided = request.headers['x-telegram-bot-api-secret-token'];
    return typeof provided === 'string' && constantTimeEquals(provided, expected);
  }

  parseInbound(request: WebhookRequest): InboundMessage[] {
    const update = request.body as TelegramUpdate | undefined;
    if (!update || typeof update !== 'object') return [];

    // A tapped quick-reply button arrives as a callback query, not a message.
    if (update.callback_query?.data && update.callback_query.message) {
      const source = update.callback_query.message;
      return [
        this.toInbound(source, update.callback_query.data, update.callback_query.from, `cb:${update.callback_query.id}`),
      ];
    }

    const message = update.message ?? update.edited_message;
    if (!message) return [];

    if (message.contact?.phone_number) {
      // Patient shared their contact card — surface it as text the agent reads.
      return [this.toInbound(message, `رقمي: ${message.contact.phone_number}`, message.from)];
    }
    if (!message.text) return [];
    return [this.toInbound(message, message.text, message.from)];
  }

  private toInbound(message: TelegramMessage, text: string, from?: TelegramUser, idOverride?: string): InboundMessage {
    const displayName = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || null;
    return {
      channel: 'telegram',
      threadId: String(message.chat.id),
      externalMessageId: idOverride ?? `${message.chat.id}:${message.message_id}`,
      text: text.trim(),
      sender: { externalId: String(from?.id ?? message.chat.id), displayName },
      receivedAt: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000),
    };
  }

  async send(threadId: string, message: OutboundMessage, credentials: ChannelCredentials): Promise<SendResult> {
    const token = credentials.telegramBotToken;
    if (!token) return { ok: false, error: 'telegram_bot_token_not_configured' };

    const payload: Record<string, unknown> = {
      chat_id: threadId,
      text: message.text,
      // Plain text: patient names and Arabic punctuation break Markdown parsing.
      disable_web_page_preview: true,
    };
    if (message.quickReplies?.length) {
      payload.reply_markup = {
        keyboard: message.quickReplies.slice(0, 6).map((label) => [{ text: label }]),
        resize_keyboard: true,
        one_time_keyboard: true,
      };
    }

    try {
      const response = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { ok?: boolean; description?: string; result?: { message_id?: number } };
      if (!response.ok || !data.ok) {
        logger.warn('telegram.send_failed', { status: response.status, description: data.description });
        return { ok: false, error: data.description ?? `http_${response.status}` };
      }
      return { ok: true, externalMessageId: data.result?.message_id ? String(data.result.message_id) : undefined };
    } catch (error) {
      logger.error('telegram.send_error', { error });
      return { ok: false, error: (error as Error).message };
    }
  }

  async indicateTyping(threadId: string, credentials: ChannelCredentials): Promise<void> {
    const token = credentials.telegramBotToken;
    if (!token) return;
    try {
      await fetch(`${API_BASE}/bot${token}/sendChatAction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: threadId, action: 'typing' }),
      });
    } catch {
      // Best-effort only.
    }
  }
}

/** Convenience used by scripts/register-telegram-webhook.ts. */
export async function setTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken: string,
): Promise<{ ok: boolean; description?: string }> {
  const response = await fetch(`${API_BASE}/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true,
    }),
  });
  return (await response.json()) as { ok: boolean; description?: string };
}
