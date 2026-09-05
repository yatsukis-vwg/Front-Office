import type { ChannelAdapter, ChannelCredentials, InboundMessage, OutboundMessage, SendResult, WebhookRequest } from '../types.js';

/**
 * Embeddable web chat widget adapter.
 *
 * The widget has no push transport of its own: it posts a message and then
 * polls `/api/chat/messages`. "Sending" therefore means persisting the message,
 * which the pipeline already does before calling `send`. This adapter also
 * keeps a short-lived in-memory buffer so the widget can pick up replies
 * immediately even before its next poll lands.
 */

interface BufferedMessage {
  text: string;
  quickReplies?: string[];
  at: number;
}

const BUFFER_TTL_MS = 5 * 60_000;
const buffers = new Map<string, BufferedMessage[]>();

export class WebChatChannel implements ChannelAdapter {
  readonly id = 'webchat' as const;
  readonly displayName = 'Web chat widget';

  /**
   * Authenticity is established by the session token the API route validates
   * before it ever reaches the adapter, so there is nothing to verify here.
   */
  verify(): boolean {
    return true;
  }

  parseInbound(request: WebhookRequest): InboundMessage[] {
    const body = request.body as
      | { session_id?: string; text?: string; message_id?: string; display_name?: string; phone?: string }
      | undefined;
    if (!body?.session_id || !body.text?.trim()) return [];
    return [
      {
        channel: 'webchat',
        threadId: String(body.session_id),
        externalMessageId: body.message_id ?? `${body.session_id}:${Date.now()}`,
        text: body.text.trim(),
        sender: {
          externalId: String(body.session_id),
          displayName: body.display_name ?? null,
          phone: body.phone ?? null,
        },
        receivedAt: new Date(),
      },
    ];
  }

  async send(threadId: string, message: OutboundMessage, _credentials: ChannelCredentials): Promise<SendResult> {
    const bucket = buffers.get(threadId) ?? [];
    bucket.push({ text: message.text, quickReplies: message.quickReplies, at: Date.now() });
    buffers.set(threadId, bucket);
    pruneBuffers();
    return { ok: true };
  }
}

/** Drained by the widget's polling endpoint. */
export function drainWebchatBuffer(threadId: string): BufferedMessage[] {
  const bucket = buffers.get(threadId) ?? [];
  buffers.delete(threadId);
  return bucket;
}

function pruneBuffers(): void {
  const cutoff = Date.now() - BUFFER_TTL_MS;
  for (const [threadId, bucket] of buffers) {
    const fresh = bucket.filter((entry) => entry.at > cutoff);
    if (fresh.length === 0) buffers.delete(threadId);
    else buffers.set(threadId, fresh);
  }
}
