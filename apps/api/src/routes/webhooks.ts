import { Router } from 'express';
import {
  credentialsForClinic,
  handleInbound,
  logger,
  tryGetChannel,
  type ChannelId,
  type WebhookRequest,
} from '@front-office/core';
import { resolveClinic } from '../context.js';

/**
 * Channel webhooks.
 *
 * One generic handler serves every channel — the adapter does all the
 * channel-specific work. Adding WhatsApp adds no code here.
 */
export const webhookRouter: Router = Router();

const SUPPORTED: ChannelId[] = ['telegram', 'whatsapp'];

/** Meta's registration handshake (GET). Telegram has no equivalent. */
webhookRouter.get('/:channel/:clinicSlug', async (req, res) => {
  const channelId = req.params.channel as ChannelId;
  const adapter = SUPPORTED.includes(channelId) ? tryGetChannel(channelId) : undefined;
  if (!adapter?.handleVerificationChallenge) {
    res.status(404).send('not found');
    return;
  }
  const clinic = await resolveClinic(req.params.clinicSlug);
  if (!clinic) {
    res.status(404).send('unknown clinic');
    return;
  }
  const challenge = adapter.handleVerificationChallenge(toWebhookRequest(req), credentialsForClinic(clinic));
  if (challenge === null) {
    res.status(403).send('verification failed');
    return;
  }
  res.status(200).send(challenge);
});

webhookRouter.post('/:channel/:clinicSlug', async (req, res) => {
  const channelId = req.params.channel as ChannelId;
  if (!SUPPORTED.includes(channelId)) {
    res.status(404).json({ error: 'unsupported_channel' });
    return;
  }
  const adapter = tryGetChannel(channelId);
  if (!adapter) {
    res.status(503).json({ error: 'channel_not_enabled' });
    return;
  }
  const clinic = await resolveClinic(req.params.clinicSlug);
  if (!clinic) {
    res.status(404).json({ error: 'unknown_clinic' });
    return;
  }

  const request = toWebhookRequest(req);
  if (!adapter.verify(request, credentialsForClinic(clinic))) {
    logger.warn('webhook.verification_failed', { channel: channelId, clinic_id: clinic.id });
    res.status(401).json({ error: 'verification_failed' });
    return;
  }

  // Acknowledge immediately: Telegram and Meta both retry on a slow response,
  // and the agent turn can take several seconds.
  res.status(200).json({ ok: true });

  const inbounds = adapter.parseInbound(request);
  for (const inbound of inbounds) {
    try {
      const result = await handleInbound(clinic, inbound);
      logger.info('webhook.handled', {
        channel: channelId,
        clinic_id: clinic.id,
        status: result.status,
        conversation_id: result.conversationId,
      });
    } catch (error) {
      logger.error('webhook.handler_failed', { channel: channelId, clinic_id: clinic.id, error });
    }
  }
});

function toWebhookRequest(req: {
  headers: Record<string, unknown>;
  body: unknown;
  query: Record<string, unknown>;
  rawBody?: string;
}): WebhookRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : (value as string | undefined);
  }
  const query: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.query)) {
    query[key] = Array.isArray(value) ? String(value[0]) : value === undefined ? undefined : String(value);
  }
  return { headers, body: req.body, query, rawBody: req.rawBody };
}
