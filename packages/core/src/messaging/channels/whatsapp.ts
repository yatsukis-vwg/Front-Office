import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../../logger.js';
import type { ChannelAdapter, ChannelCredentials, InboundMessage, OutboundMessage, SendResult, WebhookRequest } from '../types.js';

/**
 * WhatsApp Business Cloud API adapter — WIRED BUT NOT ENABLED.
 *
 * The full request/response shape is implemented here. It is not registered at
 * start-up because the clinic does not yet have Meta Business verification.
 * Turning it on is three steps, no code changes above this file:
 *
 *   1. Set WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET
 *      and WHATSAPP_VERIFY_TOKEN.
 *   2. Set ENABLE_WHATSAPP=true so apps/api registers this adapter.
 *   3. Point the Meta webhook at POST /webhooks/whatsapp/:clinicSlug.
 *
 * Everything above the adapter — agent, safety checks, booking, dashboard,
 * metrics, reminders — already treats WhatsApp as just another `ChannelId`.
 * See docs/MESSAGING.md for the full checklist.
 */

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

interface WhatsAppWebhookBody {
  object?: string;
  entry?: {
    id?: string;
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id?: string; profile?: { name?: string } }[];
        messages?: {
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: {
            button_reply?: { title?: string };
            list_reply?: { title?: string };
          };
        }[];
      };
    }[];
  }[];
}

export class WhatsAppChannel implements ChannelAdapter {
  readonly id = 'whatsapp' as const;
  readonly displayName = 'WhatsApp Business';

  /** Meta signs every webhook body with the app secret (SHA-256 HMAC). */
  verify(request: WebhookRequest, credentials: ChannelCredentials): boolean {
    const secret = credentials.whatsappAppSecret;
    if (!secret) {
      logger.warn('whatsapp.no_app_secret_configured');
      return false;
    }
    const header = request.headers['x-hub-signature-256'];
    if (typeof header !== 'string' || !header.startsWith('sha256=') || !request.rawBody) return false;
    const expected = createHmac('sha256', secret).update(request.rawBody, 'utf8').digest('hex');
    const provided = header.slice('sha256='.length);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Meta's one-time GET handshake when the webhook URL is registered. */
  handleVerificationChallenge(request: WebhookRequest, credentials: ChannelCredentials): string | null {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === credentials.whatsappVerifyToken && challenge) return challenge;
    return null;
  }

  parseInbound(request: WebhookRequest): InboundMessage[] {
    const body = request.body as WhatsAppWebhookBody | undefined;
    if (body?.object !== 'whatsapp_business_account') return [];

    const out: InboundMessage[] = [];
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value?.messages) continue;
        const profileName = value.contacts?.[0]?.profile?.name ?? null;
        for (const message of value.messages) {
          const text =
            message.text?.body ??
            message.interactive?.button_reply?.title ??
            message.interactive?.list_reply?.title ??
            message.button?.text;
          if (!text || !message.from) continue;
          out.push({
            channel: 'whatsapp',
            threadId: message.from,
            externalMessageId: message.id ?? `${message.from}:${message.timestamp ?? Date.now()}`,
            text: text.trim(),
            sender: {
              externalId: message.from,
              displayName: profileName,
              // WhatsApp gives us a verified E.164 number for free — the agent
              // will not need to ask for it.
              phone: `+${message.from}`,
            },
            receivedAt: new Date(Number(message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
          });
        }
      }
    }
    return out;
  }

  async send(threadId: string, message: OutboundMessage, credentials: ChannelCredentials): Promise<SendResult> {
    const { whatsappAccessToken: token, whatsappPhoneNumberId: phoneNumberId } = credentials;
    if (!token || !phoneNumberId) return { ok: false, error: 'whatsapp_not_configured' };

    // Note for go-live: outside the 24h customer-service window Meta only
    // accepts pre-approved template messages. Reminders will need a template;
    // replies inside an active conversation use this free-form path.
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: threadId,
      type: 'text',
      text: { preview_url: false, body: message.text },
    };

    try {
      const response = await fetch(`${GRAPH_BASE}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { messages?: { id?: string }[]; error?: { message?: string } };
      if (!response.ok) {
        logger.warn('whatsapp.send_failed', { status: response.status, description: data.error?.message });
        return { ok: false, error: data.error?.message ?? `http_${response.status}` };
      }
      return { ok: true, externalMessageId: data.messages?.[0]?.id };
    } catch (error) {
      logger.error('whatsapp.send_error', { error });
      return { ok: false, error: (error as Error).message };
    }
  }
}
