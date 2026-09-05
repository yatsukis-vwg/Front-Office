import { runAgent } from '../agent/runner.js';
import { normalizePhone } from '../crypto/encryption.js';
import { appointments, audit, clinics, conversations, escalations, messages, patients } from '../db/repos.js';
import { loadKnowledgeBase } from '../kb/loader.js';
import type { KnowledgeBase } from '../kb/schema.js';
import { logger } from '../logger.js';
import { checkOutgoing, emergencyDirective, holdingReply } from '../safety/presend.js';
import { detectConversationLocale, detectLocale } from '../safety/language.js';
import { scanInbound } from '../safety/tripwires.js';
import type { Clinic, Conversation, EscalationReason, Locale } from '../types.js';
import { describeSlot } from '../util/time.js';
import { credentialsForClinic, getChannel } from './registry.js';
import type { InboundMessage, OutboundMessage } from './types.js';

/**
 * THE INGEST PIPELINE
 *
 * Single entry point for every inbound patient message on every channel.
 *
 *   inbound → tripwire scan → [emergency? hard-coded directive + escalate]
 *           → [human has taken over? store only]
 *           → agent → PRE-SEND SAFETY CHECK → [blocked? holding reply + escalate]
 *           → send
 *
 * There is no path from the model to a channel that skips `checkOutgoing`.
 */

export interface HandleResult {
  status: 'replied' | 'escalated' | 'emergency' | 'handed_over' | 'ignored' | 'error';
  conversationId?: string;
  reply?: string;
  escalationReason?: EscalationReason;
}

/** In-memory idempotency guard: webhook redeliveries must not double-answer. */
const seenExternalIds = new Map<string, number>();
const SEEN_TTL_MS = 10 * 60_000;

function alreadySeen(key: string): boolean {
  const now = Date.now();
  for (const [id, at] of seenExternalIds) {
    if (now - at > SEEN_TTL_MS) seenExternalIds.delete(id);
  }
  if (seenExternalIds.has(key)) return true;
  seenExternalIds.set(key, now);
  return false;
}

export async function handleInbound(clinic: Clinic, inbound: InboundMessage): Promise<HandleResult> {
  const dedupeKey = `${clinic.id}:${inbound.channel}:${inbound.externalMessageId}`;
  if (alreadySeen(dedupeKey)) {
    logger.debug('pipeline.duplicate_ignored', { clinic_id: clinic.id, channel: inbound.channel });
    return { status: 'ignored' };
  }
  if (!inbound.text.trim()) return { status: 'ignored' };

  const kb = await loadKnowledgeBase(clinic.slug, clinic.id);
  const receivedAt = inbound.receivedAt ?? new Date();

  const { conversation, isNew } = await resolveConversation(clinic, inbound);

  await messages.append({
    clinicId: clinic.id,
    conversationId: conversation.id,
    direction: 'inbound',
    author: 'patient',
    body: inbound.text,
    meta: { channel: inbound.channel, external_id: inbound.externalMessageId },
  });
  await patients.touch(conversation.patient_id);

  const history = await messages.listForConversation(clinic.id, conversation.id);
  const patientTurns = history.filter((m) => m.author === 'patient').map((m) => m.body);
  const locale: Locale = detectConversationLocale(patientTurns, detectLocale(inbound.text));

  // ---- 1. Tripwires run before the model is ever called.
  const tripwire = scanInbound(inbound.text);

  if (tripwire.emergency) {
    const directive = emergencyDirective(kb, locale);
    await escalations.open({
      clinicId: clinic.id,
      conversationId: conversation.id,
      reason: 'emergency_language',
      detail: `Emergency tripwire: ${tripwire.hits.map((h) => h.matched).join(', ')}`,
    });
    await deliver(clinic, conversation, { text: directive, kind: 'system' }, {
      author: 'system',
      flagged: true,
      responseMs: Date.now() - receivedAt.getTime(),
      meta: { safety: 'emergency_directive', rules: tripwire.hits.map((h) => h.matched) },
    });
    logger.warn('pipeline.emergency', { clinic_id: clinic.id, conversation_id: conversation.id, rules: tripwire.hits.map((h) => h.matched) });
    return { status: 'emergency', conversationId: conversation.id, reply: directive, escalationReason: 'emergency_language' };
  }

  // ---- 2. A human holds this thread: store the message and stay silent.
  if (conversation.owner === 'human') {
    logger.info('pipeline.human_owned', { clinic_id: clinic.id, conversation_id: conversation.id });
    return { status: 'handed_over', conversationId: conversation.id };
  }

  if (tripwire.clinical) {
    await escalations.open({
      clinicId: clinic.id,
      conversationId: conversation.id,
      reason: 'symptom_description',
      detail: `Clinical tripwire: ${tripwire.hits.filter((h) => h.severity === 'clinical').map((h) => h.matched).join(', ')}`,
    });
  }

  // Greet a brand-new thread from the knowledge base rather than the model.
  if (isNew && history.length === 1 && inbound.text.trim().length <= 3) {
    const greeting = locale === 'en' ? kb.agent.greeting_en : kb.agent.greeting_ar;
    await deliver(clinic, conversation, { text: greeting }, {
      author: 'agent',
      responseMs: Date.now() - receivedAt.getTime(),
      meta: { source: 'kb_greeting' },
    });
    return { status: 'replied', conversationId: conversation.id, reply: greeting };
  }

  // ---- 3. Run the agent.
  const patient = await patients.viewById(clinic.id, conversation.patient_id);
  const openBookings = await upcomingBookings(clinic.id, conversation.patient_id, kb, locale);

  let agentResult;
  try {
    agentResult = await runAgent({
      kb,
      clinicId: clinic.id,
      conversationId: conversation.id,
      patientId: conversation.patient_id,
      locale,
      history,
      clinicalFlag: tripwire.clinical,
      patientName: patient?.name ?? inbound.sender.displayName ?? null,
      patientPhone: patient?.phone ?? (inbound.sender.phone ? normalizePhone(inbound.sender.phone) : null),
      openBookings,
    });
  } catch (error) {
    logger.error('pipeline.agent_failed', { clinic_id: clinic.id, conversation_id: conversation.id, error });
    return escalateWithHolding(clinic, conversation, kb, locale, 'agent_error', 'Agent call failed', receivedAt);
  }

  if (agentResult.escalation && !agentResult.text.trim()) {
    return escalateWithHolding(clinic, conversation, kb, locale, agentResult.escalation.reason, agentResult.escalation.detail, receivedAt);
  }
  if (!agentResult.text.trim()) {
    return escalateWithHolding(clinic, conversation, kb, locale, 'agent_error', 'Agent produced an empty reply', receivedAt);
  }

  // ---- 4. PRE-SEND SAFETY CHECK — the hard gate. Nothing bypasses this.
  const verdict = checkOutgoing(agentResult.text, { kb, locale, allowedNumbers: agentResult.allowedNumbers });

  if (!verdict.allowed) {
    logger.warn('pipeline.blocked_by_presend', {
      clinic_id: clinic.id,
      conversation_id: conversation.id,
      violations: verdict.violations.map((v) => v.rule),
    });
    await audit.record({
      clinicId: clinic.id,
      actorType: 'system',
      action: 'safety.block_outgoing',
      entity: 'conversation',
      entityId: conversation.id,
      meta: { violations: verdict.violations.map((v) => ({ code: v.code, rule: v.rule })) },
    });
    return escalateWithHolding(
      clinic,
      conversation,
      kb,
      locale,
      verdict.escalationReason ?? 'agent_error',
      verdict.violations.map((v) => `${v.rule}: ${v.evidence}`).join(' | '),
      receivedAt,
    );
  }

  // The agent asked for a human but still wrote something safe: send it, and
  // the escalation opened by the tool keeps the thread in the queue.
  const escalated = Boolean(agentResult.escalation) || tripwire.clinical;

  await deliver(clinic, conversation, { text: agentResult.text }, {
    author: 'agent',
    responseMs: Date.now() - receivedAt.getTime(),
    meta: {
      tools: agentResult.toolCalls.map((t) => t.name),
      booking_reference: agentResult.bookingReference,
      usage: agentResult.usage,
    },
  });

  return {
    status: escalated ? 'escalated' : 'replied',
    conversationId: conversation.id,
    reply: agentResult.text,
    ...(agentResult.escalation ? { escalationReason: agentResult.escalation.reason } : {}),
  };
}

async function escalateWithHolding(
  clinic: Clinic,
  conversation: Conversation,
  kb: KnowledgeBase,
  locale: Locale,
  reason: EscalationReason,
  detail: string,
  receivedAt: Date,
): Promise<HandleResult> {
  await escalations.open({ clinicId: clinic.id, conversationId: conversation.id, reason, detail });
  const text = holdingReply(kb, locale);
  await deliver(clinic, conversation, { text, kind: 'system' }, {
    author: 'system',
    flagged: true,
    responseMs: Date.now() - receivedAt.getTime(),
    meta: { safety: 'holding_reply', reason },
  });
  return { status: 'escalated', conversationId: conversation.id, reply: text, escalationReason: reason };
}

/**
 * Persists an outgoing message and hands it to the channel.
 *
 * Everything the clinic sends — agent replies, holding replies, emergency
 * directives, staff messages, reminders — goes through here, so the transcript
 * in the dashboard is always the complete record.
 */
export async function deliver(
  clinic: Clinic,
  conversation: Conversation,
  outbound: OutboundMessage,
  options: {
    author: 'agent' | 'staff' | 'system';
    flagged?: boolean;
    responseMs?: number | null;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await messages.append({
    clinicId: clinic.id,
    conversationId: conversation.id,
    direction: 'outbound',
    author: options.author,
    body: outbound.text,
    responseMs: options.responseMs ?? null,
    flagged: options.flagged ?? false,
    meta: { channel: conversation.channel, ...(options.meta ?? {}) },
  });

  const channel = getChannel(conversation.channel);
  const result = await channel.send(conversation.channel_thread_id, outbound, credentialsForClinic(clinic));
  if (!result.ok) {
    logger.warn('pipeline.send_failed', {
      clinic_id: clinic.id,
      conversation_id: conversation.id,
      channel: conversation.channel,
      error: result.error,
    });
  }
}

async function resolveConversation(clinic: Clinic, inbound: InboundMessage): Promise<{ conversation: Conversation; isNew: boolean }> {
  const existing = await conversations.byThread(clinic.id, inbound.channel, inbound.threadId);
  if (existing) return { conversation: existing, isNew: false };

  // Channels that carry a verified phone (WhatsApp) let us re-link a returning
  // patient to their existing record instead of creating a duplicate.
  let patientId: string | null = null;
  if (inbound.sender.phone) {
    const match = await patients.byPhone(clinic.id, inbound.sender.phone);
    if (match) patientId = match.id;
  }
  if (!patientId) {
    const created = await patients.create(clinic.id, {
      name: inbound.sender.displayName ?? null,
      phone: inbound.sender.phone ? normalizePhone(inbound.sender.phone) : null,
      locale: detectLocale(inbound.text),
    });
    patientId = created.id;
  }

  const conversation = await conversations.create({
    clinicId: clinic.id,
    patientId,
    channel: inbound.channel,
    channelThreadId: inbound.threadId,
  });
  await audit.record({
    clinicId: clinic.id,
    actorType: 'patient',
    actorId: patientId,
    action: 'conversation.open',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { channel: inbound.channel },
  });
  return { conversation, isNew: true };
}

async function upcomingBookings(clinicId: string, patientId: string, kb: KnowledgeBase, locale: Locale) {
  const rows = await appointments.byPatient(clinicId, patientId, ['booked']);
  return rows
    .filter((row) => Date.parse(row.starts_at) > Date.now())
    .slice(0, 5)
    .map((row) => ({
      reference: row.reference,
      label: describeSlot(new Date(row.starts_at), kb.clinic.timezone, locale),
      service: kb.services.find((s) => s.id === row.service_id)?.[locale === 'en' ? 'name_en' : 'name_ar'] ?? row.service_id,
    }));
}

/**
 * A staff member replying from the dashboard. Takes the thread over so the
 * agent stops answering, and sends through the same channel the patient used.
 */
export async function sendStaffReply(clinicId: string, conversationId: string, text: string, staffId: string): Promise<HandleResult> {
  const clinic = await clinics.byId(clinicId);
  const conversation = await conversations.byId(clinicId, conversationId);
  if (!clinic || !conversation) return { status: 'error' };

  if (conversation.owner !== 'human') {
    await conversations.takeOver(clinicId, conversationId, staffId);
    conversation.owner = 'human';
  }
  await deliver(clinic, conversation, { text }, { author: 'staff', meta: { staff_id: staffId } });
  await audit.record({
    clinicId,
    actorType: 'staff',
    actorId: staffId,
    action: 'conversation.staff_reply',
    entity: 'conversation',
    entityId: conversationId,
    meta: { channel: conversation.channel },
  });
  return { status: 'replied', conversationId, reply: text };
}
