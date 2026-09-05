import { Router } from 'express';
import {
  conversations,
  drainWebchatBuffer,
  getChannel,
  handleInbound,
  loadKnowledgeBase,
  logger,
  messages,
  newId,
  type WebhookRequest,
} from '@front-office/core';
import { defaultClinic, resolveClinic } from '../context.js';
import { rateLimit } from '../middleware/rate-limit.js';

/**
 * Web chat widget API.
 *
 * Three endpoints: open a session, post a message, poll for replies. The
 * session id is the channel thread id, so the widget needs no auth of its own —
 * knowing a session id only grants access to that one conversation.
 */
export const chatRouter: Router = Router();

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyFn: (req) => String(req.body?.session_id ?? req.query.session_id ?? req.ip ?? 'anon'),
});

/** Opens a widget session and returns the clinic's greeting. */
chatRouter.post('/session', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  const clinic = req.body?.clinic ? await resolveClinic(String(req.body.clinic)) : await defaultClinic();
  if (!clinic) {
    res.status(404).json({ error: 'unknown_clinic' });
    return;
  }
  const kb = await loadKnowledgeBase(clinic.slug, clinic.id);
  const sessionId = `web_${newId()}`;
  const locale = req.body?.locale === 'en' ? 'en' : 'ar';

  res.json({
    session_id: sessionId,
    clinic: {
      slug: clinic.slug,
      name: locale === 'en' ? kb.clinic.name_en : kb.clinic.name_ar,
      persona: locale === 'en' ? kb.agent.persona_name_en : kb.agent.persona_name_ar,
      locale,
      direction: locale === 'en' ? 'ltr' : 'rtl',
    },
    greeting: locale === 'en' ? kb.agent.greeting_en : kb.agent.greeting_ar,
    quick_replies:
      locale === 'en'
        ? ['Book an appointment', 'Working hours', 'Location', 'Prices']
        : ['أبي أحجز موعد', 'وش دوامكم؟', 'وين موقعكم؟', 'الأسعار'],
  });
});

chatRouter.post('/message', chatLimiter, async (req, res) => {
  const clinic = req.body?.clinic ? await resolveClinic(String(req.body.clinic)) : await defaultClinic();
  if (!clinic) {
    res.status(404).json({ error: 'unknown_clinic' });
    return;
  }
  const request: WebhookRequest = { headers: {}, body: req.body, query: {} };
  const [inbound] = getChannel('webchat').parseInbound(request);
  if (!inbound) {
    res.status(400).json({ error: 'invalid_message' });
    return;
  }

  try {
    const result = await handleInbound(clinic, inbound);
    // The widget polls, but returning the reply inline makes the demo instant.
    const buffered = drainWebchatBuffer(inbound.threadId);
    res.json({
      status: result.status,
      conversation_id: result.conversationId,
      messages: buffered.map((m) => ({ text: m.text, quick_replies: m.quickReplies ?? [], at: new Date(m.at).toISOString() })),
    });
  } catch (error) {
    logger.error('chat.message_failed', { clinic_id: clinic.id, error });
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * Poll for anything the clinic sent since the widget last checked — staff
 * replies from the dashboard and reminders arrive this way.
 */
chatRouter.get('/messages', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
  const sessionId = String(req.query.session_id ?? '');
  if (!sessionId) {
    res.status(400).json({ error: 'session_id_required' });
    return;
  }
  const clinic = req.query.clinic ? await resolveClinic(String(req.query.clinic)) : await defaultClinic();
  if (!clinic) {
    res.status(404).json({ error: 'unknown_clinic' });
    return;
  }
  const conversation = await conversations.byThread(clinic.id, 'webchat', sessionId);
  if (!conversation) {
    res.json({ messages: [] });
    return;
  }
  const since = String(req.query.since ?? new Date(Date.now() - 60_000).toISOString());
  const rows = await messages.since(clinic.id, conversation.id, since);
  res.json({
    conversation_id: conversation.id,
    owner: conversation.owner,
    messages: rows
      .filter((row) => row.direction === 'outbound')
      .map((row) => ({ text: row.body, at: row.created_at, from: row.author })),
    now: new Date().toISOString(),
  });
});
