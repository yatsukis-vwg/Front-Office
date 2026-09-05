import type { ChannelId } from '../types.js';

/**
 * THE MESSAGING ABSTRACTION
 * =========================
 *
 * Everything above this layer — the agent, the safety checks, booking, the
 * dashboard — deals only in `InboundMessage` and `OutboundMessage`. No module
 * outside `messaging/channels/` knows that Telegram exists.
 *
 * Adding a channel means writing one file that implements `ChannelAdapter` and
 * registering it. WhatsApp Business API is already stubbed in
 * `channels/whatsapp.ts` with the exact shape it will need — see docs/MESSAGING.md.
 */

/** A message that arrived from a patient, normalised across channels. */
export interface InboundMessage {
  channel: ChannelId;
  /** Channel-native conversation key: Telegram chat id, webchat session id, WhatsApp wa_id. */
  threadId: string;
  /** Channel-native message id, used for idempotency when a webhook is redelivered. */
  externalMessageId: string;
  text: string;
  sender: {
    externalId: string;
    displayName?: string | null;
    /** Present on channels that carry a verified phone number (WhatsApp does). */
    phone?: string | null;
  };
  receivedAt: Date;
  /** Original payload, kept only in memory for debugging. Never persisted. */
  raw?: unknown;
}

/** A message the system wants to deliver to a patient. */
export interface OutboundMessage {
  text: string;
  /** Rendered as a keyboard on Telegram, as chips in the widget, ignored elsewhere. */
  quickReplies?: string[];
  /** Marks the message so channels can style or route it differently. */
  kind?: 'reply' | 'reminder' | 'confirmation' | 'system';
}

export interface SendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
  query: Record<string, string | undefined>;
  /** Raw body bytes, needed by channels that sign payloads (WhatsApp does). */
  rawBody?: string;
}

/**
 * The contract every channel implements.
 *
 * Channels are stateless: they translate between the wire format and the two
 * types above, and they never touch the database or the agent.
 */
export interface ChannelAdapter {
  readonly id: ChannelId;
  readonly displayName: string;

  /**
   * Verifies the request really came from the platform. Return false and the
   * pipeline drops the payload without processing it.
   */
  verify(request: WebhookRequest, credentials: ChannelCredentials): boolean;

  /**
   * Handles a platform's webhook-registration handshake (Meta's hub.challenge,
   * for example). Return null when the channel has no such handshake.
   */
  handleVerificationChallenge?(request: WebhookRequest, credentials: ChannelCredentials): string | null;

  /** Turns one webhook payload into zero or more normalised inbound messages. */
  parseInbound(request: WebhookRequest): InboundMessage[];

  /** Delivers a message. Must not throw — return `{ok:false, error}` instead. */
  send(threadId: string, message: OutboundMessage, credentials: ChannelCredentials): Promise<SendResult>;

  /** Optional typing indicator; the pipeline calls it best-effort and ignores failures. */
  indicateTyping?(threadId: string, credentials: ChannelCredentials): Promise<void>;
}

/** Per-clinic channel credentials, read from the clinic's `settings` column. */
export interface ChannelCredentials {
  clinicId: string;
  clinicSlug: string;
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
  whatsappAccessToken?: string;
  whatsappPhoneNumberId?: string;
  whatsappAppSecret?: string;
  whatsappVerifyToken?: string;
}
