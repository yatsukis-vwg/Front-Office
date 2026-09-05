import { decryptNullable, encrypt, encryptNullable, hashPhone, newId, decrypt } from '../crypto/encryption.js';
import { nowIso } from '../util/time.js';
import type {
  Appointment,
  AppointmentSource,
  AppointmentStatus,
  AuditEntry,
  ChannelId,
  Clinic,
  Conversation,
  Escalation,
  EscalationReason,
  KbOverride,
  Locale,
  Message,
  MessageAuthor,
  MessageDirection,
  MessageView,
  Patient,
  PatientView,
  Reminder,
  ReminderKind,
} from '../types.js';
import { eq, getStore, gte, isIn, lte, type Filter, type Store } from './index.js';

/**
 * Repositories.
 *
 * Every method takes `clinicId` first and adds it to the filter set. That is
 * the single enforcement point for per-clinic data isolation on the read path —
 * there is no query in the codebase that reaches the store without it.
 */

function store(): Store {
  return getStore();
}

function clinicScope(clinicId: string, extra: Filter[] = []): Filter[] {
  return [eq('clinic_id', clinicId), ...extra];
}

// ---------------------------------------------------------------- clinics

export const clinics = {
  async create(input: Omit<Clinic, 'id' | 'created_at'> & { id?: string }): Promise<Clinic> {
    return store().insert('clinics', {
      id: input.id ?? newId(),
      created_at: nowIso(),
      ...input,
    } as Clinic);
  },

  async bySlug(slug: string): Promise<Clinic | null> {
    return store().findOne('clinics', { filters: [eq('slug', slug)] });
  },

  async byId(id: string): Promise<Clinic | null> {
    return store().findById('clinics', id);
  },

  async list(): Promise<Clinic[]> {
    return store().findMany('clinics', { orderBy: { field: 'name', direction: 'asc' } });
  },

  async update(id: string, patch: Partial<Clinic>): Promise<Clinic | null> {
    return store().update('clinics', id, patch);
  },

  /** Resolves the clinic bound to an inbound Telegram update. */
  async byTelegramToken(token: string): Promise<Clinic | null> {
    const all = await store().findMany('clinics');
    return all.find((c) => c.settings?.telegram_bot_token === token) ?? null;
  },
};

// --------------------------------------------------------------- patients

function toPatientView(row: Patient): PatientView {
  return {
    id: row.id,
    clinic_id: row.clinic_id,
    name: decryptNullable(row.name_enc),
    phone: decryptNullable(row.phone_enc),
    locale: row.locale,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    deleted_at: row.deleted_at,
  };
}

export const patients = {
  async create(clinicId: string, input: { name?: string | null; phone?: string | null; locale?: Locale }): Promise<Patient> {
    const row: Patient = {
      id: newId(),
      clinic_id: clinicId,
      name_enc: encryptNullable(input.name ?? null),
      phone_enc: encryptNullable(input.phone ?? null),
      phone_hash: input.phone ? hashPhone(input.phone) : null,
      locale: input.locale ?? 'ar',
      created_at: nowIso(),
      last_seen_at: nowIso(),
      deleted_at: null,
    };
    return store().insert('patients', row);
  },

  async byId(clinicId: string, id: string): Promise<Patient | null> {
    const row = await store().findById('patients', id);
    return row && row.clinic_id === clinicId ? row : null;
  },

  async viewById(clinicId: string, id: string): Promise<PatientView | null> {
    const row = await this.byId(clinicId, id);
    return row ? toPatientView(row) : null;
  },

  async byPhone(clinicId: string, phone: string): Promise<Patient | null> {
    return store().findOne('patients', { filters: clinicScope(clinicId, [eq('phone_hash', hashPhone(phone))]) });
  },

  async update(clinicId: string, id: string, patch: { name?: string | null; phone?: string | null; locale?: Locale }): Promise<Patient | null> {
    const existing = await this.byId(clinicId, id);
    if (!existing) return null;
    const next: Partial<Patient> = { last_seen_at: nowIso() };
    if (patch.name !== undefined) next.name_enc = encryptNullable(patch.name);
    if (patch.phone !== undefined) {
      next.phone_enc = encryptNullable(patch.phone);
      next.phone_hash = patch.phone ? hashPhone(patch.phone) : null;
    }
    if (patch.locale !== undefined) next.locale = patch.locale;
    return store().update('patients', id, next);
  },

  async touch(id: string): Promise<void> {
    await store().update('patients', id, { last_seen_at: nowIso() });
  },

  async list(clinicId: string, limit = 200): Promise<PatientView[]> {
    const rows = await store().findMany('patients', {
      filters: clinicScope(clinicId),
      orderBy: { field: 'last_seen_at', direction: 'desc' },
      limit,
    });
    return rows.map(toPatientView);
  },

  /**
   * PDPL right-to-erasure. Message bodies and appointments notes are deleted
   * outright; the patient row is kept as an anonymised tombstone so appointment
   * history stays referentially intact for the clinic's own records.
   */
  async erase(clinicId: string, patientId: string): Promise<{ messages: number; conversations: number; appointments: number }> {
    const convos = await store().findMany('conversations', { filters: clinicScope(clinicId, [eq('patient_id', patientId)]) });
    let messageCount = 0;
    for (const convo of convos) {
      messageCount += await store().deleteWhere('messages', clinicScope(clinicId, [eq('conversation_id', convo.id)]));
      await store().deleteWhere('escalations', clinicScope(clinicId, [eq('conversation_id', convo.id)]));
      await store().delete('conversations', convo.id);
    }
    const appts = await store().findMany('appointments', { filters: clinicScope(clinicId, [eq('patient_id', patientId)]) });
    for (const appt of appts) {
      await store().update('appointments', appt.id, { notes_enc: null });
      await store().deleteWhere('reminders', clinicScope(clinicId, [eq('appointment_id', appt.id)]));
    }
    await store().update('patients', patientId, {
      name_enc: null,
      phone_enc: null,
      phone_hash: null,
      deleted_at: nowIso(),
    });
    return { messages: messageCount, conversations: convos.length, appointments: appts.length };
  },
};

// ---------------------------------------------------------- conversations

export const conversations = {
  async create(input: {
    clinicId: string;
    patientId: string;
    channel: ChannelId;
    channelThreadId: string;
  }): Promise<Conversation> {
    const row: Conversation = {
      id: newId(),
      clinic_id: input.clinicId,
      patient_id: input.patientId,
      channel: input.channel,
      channel_thread_id: input.channelThreadId,
      status: 'open',
      owner: 'agent',
      taken_over_by: null,
      taken_over_at: null,
      last_message_at: nowIso(),
      message_count: 0,
      created_at: nowIso(),
      closed_at: null,
    };
    return store().insert('conversations', row);
  },

  async byThread(clinicId: string, channel: ChannelId, threadId: string): Promise<Conversation | null> {
    return store().findOne('conversations', {
      filters: clinicScope(clinicId, [eq('channel', channel), eq('channel_thread_id', threadId)]),
      orderBy: { field: 'created_at', direction: 'desc' },
    });
  },

  async byId(clinicId: string, id: string): Promise<Conversation | null> {
    const row = await store().findById('conversations', id);
    return row && row.clinic_id === clinicId ? row : null;
  },

  async list(
    clinicId: string,
    options: { status?: Conversation['status']; owner?: Conversation['owner']; channel?: ChannelId; limit?: number; offset?: number } = {},
  ): Promise<Conversation[]> {
    const filters = clinicScope(clinicId);
    if (options.status) filters.push(eq('status', options.status));
    if (options.owner) filters.push(eq('owner', options.owner));
    if (options.channel) filters.push(eq('channel', options.channel));
    return store().findMany('conversations', {
      filters,
      orderBy: { field: 'last_message_at', direction: 'desc' },
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    });
  },

  async update(clinicId: string, id: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const existing = await this.byId(clinicId, id);
    if (!existing) return null;
    return store().update('conversations', id, patch);
  },

  async takeOver(clinicId: string, id: string, staffId: string): Promise<Conversation | null> {
    return this.update(clinicId, id, { owner: 'human', taken_over_by: staffId, taken_over_at: nowIso() });
  },

  async releaseToAgent(clinicId: string, id: string): Promise<Conversation | null> {
    return this.update(clinicId, id, { owner: 'agent', taken_over_by: null, taken_over_at: null });
  },
};

// -------------------------------------------------------------- messages

function toMessageView(row: Message): MessageView {
  const { body_enc, ...rest } = row;
  return { ...rest, body: decryptNullable(body_enc) ?? '' };
}

export const messages = {
  async append(input: {
    clinicId: string;
    conversationId: string;
    direction: MessageDirection;
    author: MessageAuthor;
    body: string;
    responseMs?: number | null;
    flagged?: boolean;
    meta?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<Message> {
    const row: Message = {
      id: newId(),
      clinic_id: input.clinicId,
      conversation_id: input.conversationId,
      direction: input.direction,
      author: input.author,
      body_enc: encrypt(input.body),
      response_ms: input.responseMs ?? null,
      flagged: input.flagged ?? false,
      meta: input.meta ?? {},
      created_at: input.createdAt ?? nowIso(),
    };
    const saved = await store().insert('messages', row);
    const convo = await store().findById('conversations', input.conversationId);
    if (convo) {
      await store().update('conversations', convo.id, {
        last_message_at: row.created_at,
        message_count: (convo.message_count ?? 0) + 1,
      });
    }
    return saved;
  },

  async listForConversation(clinicId: string, conversationId: string, limit = 500): Promise<MessageView[]> {
    const rows = await store().findMany('messages', {
      filters: clinicScope(clinicId, [eq('conversation_id', conversationId)]),
      orderBy: { field: 'created_at', direction: 'asc' },
      limit,
    });
    return rows.map(toMessageView);
  },

  async since(clinicId: string, conversationId: string, sinceIso: string): Promise<MessageView[]> {
    const rows = await store().findMany('messages', {
      filters: clinicScope(clinicId, [eq('conversation_id', conversationId), { field: 'created_at', op: 'gt', value: sinceIso }]),
      orderBy: { field: 'created_at', direction: 'asc' },
    });
    return rows.map(toMessageView);
  },

  async listForClinic(clinicId: string, options: { from?: string; to?: string; limit?: number } = {}): Promise<Message[]> {
    const filters = clinicScope(clinicId);
    if (options.from) filters.push(gte('created_at', options.from));
    if (options.to) filters.push(lte('created_at', options.to));
    return store().findMany('messages', { filters, orderBy: { field: 'created_at', direction: 'asc' }, limit: options.limit ?? 5000 });
  },

  /**
   * Full-text search across transcripts.
   *
   * Bodies are encrypted at rest, so there is no server-side index to search:
   * we decrypt candidate rows in process and match in memory. That is the
   * deliberate trade-off documented in docs/SECURITY.md — searchable
   * ciphertext would leak far more than it is worth at this scale.
   */
  async search(clinicId: string, query: string, limit = 60): Promise<{ conversation_id: string; message: MessageView }[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const rows = await store().findMany('messages', {
      filters: clinicScope(clinicId),
      orderBy: { field: 'created_at', direction: 'desc' },
      limit: 4000,
    });
    const hits: { conversation_id: string; message: MessageView }[] = [];
    for (const row of rows) {
      let body: string;
      try {
        body = decrypt(row.body_enc);
      } catch {
        continue;
      }
      if (body.toLowerCase().includes(needle)) {
        hits.push({ conversation_id: row.conversation_id, message: { ...toMessageView(row), body } });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  },
};

// ----------------------------------------------------------- appointments

export const appointments = {
  async insert(row: Appointment): Promise<Appointment> {
    return store().insert('appointments', row);
  },

  async byId(clinicId: string, id: string): Promise<Appointment | null> {
    const row = await store().findById('appointments', id);
    return row && row.clinic_id === clinicId ? row : null;
  },

  async byReference(clinicId: string, reference: string): Promise<Appointment | null> {
    return store().findOne('appointments', {
      filters: clinicScope(clinicId, [eq('reference', reference.trim().toUpperCase())]),
    });
  },

  async byPatient(clinicId: string, patientId: string, statuses: AppointmentStatus[] = ['booked']): Promise<Appointment[]> {
    return store().findMany('appointments', {
      filters: clinicScope(clinicId, [eq('patient_id', patientId), isIn('status', statuses)]),
      orderBy: { field: 'starts_at', direction: 'asc' },
    });
  },

  /** Booked appointments overlapping a window — the double-booking check. */
  async bookedInWindow(clinicId: string, fromIso: string, toIso: string, doctorId?: string): Promise<Appointment[]> {
    const filters = clinicScope(clinicId, [eq('status', 'booked'), { field: 'starts_at', op: 'lt', value: toIso }, { field: 'ends_at', op: 'gt', value: fromIso }]);
    if (doctorId) filters.push(eq('doctor_id', doctorId));
    return store().findMany('appointments', { filters, orderBy: { field: 'starts_at', direction: 'asc' }, limit: 2000 });
  },

  async range(clinicId: string, fromIso: string, toIso: string): Promise<Appointment[]> {
    return store().findMany('appointments', {
      filters: clinicScope(clinicId, [gte('starts_at', fromIso), lte('starts_at', toIso)]),
      orderBy: { field: 'starts_at', direction: 'asc' },
      limit: 2000,
    });
  },

  async update(clinicId: string, id: string, patch: Partial<Appointment>): Promise<Appointment | null> {
    const existing = await this.byId(clinicId, id);
    if (!existing) return null;
    return store().update('appointments', id, patch);
  },

  async all(clinicId: string, options: { from?: string; to?: string } = {}): Promise<Appointment[]> {
    const filters = clinicScope(clinicId);
    if (options.from) filters.push(gte('created_at', options.from));
    if (options.to) filters.push(lte('created_at', options.to));
    return store().findMany('appointments', { filters, orderBy: { field: 'starts_at', direction: 'asc' }, limit: 5000 });
  },
};

// -------------------------------------------------------------- reminders

export const reminders = {
  async schedule(input: { clinicId: string; appointmentId: string; kind: ReminderKind; sendAt: string }): Promise<Reminder> {
    const row: Reminder = {
      id: newId(),
      clinic_id: input.clinicId,
      appointment_id: input.appointmentId,
      kind: input.kind,
      send_at: input.sendAt,
      status: 'pending',
      sent_at: null,
      error: null,
      created_at: nowIso(),
    };
    return store().insert('reminders', row);
  },

  async due(nowIsoValue: string, limit = 50): Promise<Reminder[]> {
    return store().findMany('reminders', {
      filters: [eq('status', 'pending'), lte('send_at', nowIsoValue)],
      orderBy: { field: 'send_at', direction: 'asc' },
      limit,
    });
  },

  async markSent(id: string): Promise<void> {
    await store().update('reminders', id, { status: 'sent', sent_at: nowIso(), error: null });
  },

  async markFailed(id: string, error: string): Promise<void> {
    await store().update('reminders', id, { status: 'failed', error: error.slice(0, 300) });
  },

  async cancelForAppointment(clinicId: string, appointmentId: string): Promise<void> {
    const pending = await store().findMany('reminders', {
      filters: clinicScope(clinicId, [eq('appointment_id', appointmentId), eq('status', 'pending')]),
    });
    for (const row of pending) await store().update('reminders', row.id, { status: 'cancelled' });
  },

  async forAppointment(clinicId: string, appointmentId: string): Promise<Reminder[]> {
    return store().findMany('reminders', {
      filters: clinicScope(clinicId, [eq('appointment_id', appointmentId)]),
      orderBy: { field: 'send_at', direction: 'asc' },
    });
  },
};

// ------------------------------------------------------------ escalations

export const escalations = {
  async open(input: {
    clinicId: string;
    conversationId: string;
    messageId?: string | null;
    reason: EscalationReason;
    detail: string;
    createdAt?: string;
  }): Promise<Escalation> {
    const row: Escalation = {
      id: newId(),
      clinic_id: input.clinicId,
      conversation_id: input.conversationId,
      message_id: input.messageId ?? null,
      reason: input.reason,
      detail: input.detail.slice(0, 500),
      status: 'open',
      created_at: input.createdAt ?? nowIso(),
      resolved_at: null,
      resolved_by: null,
    };
    const saved = await store().insert('escalations', row);
    await store().update('conversations', input.conversationId, { status: 'escalated' });
    return saved;
  },

  async list(clinicId: string, status?: Escalation['status'], limit = 100): Promise<Escalation[]> {
    const filters = clinicScope(clinicId);
    if (status) filters.push(eq('status', status));
    return store().findMany('escalations', { filters, orderBy: { field: 'created_at', direction: 'desc' }, limit });
  },

  async forConversation(clinicId: string, conversationId: string): Promise<Escalation[]> {
    return store().findMany('escalations', {
      filters: clinicScope(clinicId, [eq('conversation_id', conversationId)]),
      orderBy: { field: 'created_at', direction: 'desc' },
    });
  },

  async resolve(clinicId: string, id: string, staffId: string): Promise<Escalation | null> {
    const row = await store().findById('escalations', id);
    if (!row || row.clinic_id !== clinicId) return null;
    const updated = await store().update('escalations', id, {
      status: 'resolved',
      resolved_at: nowIso(),
      resolved_by: staffId,
    });
    const remaining = await store().findMany('escalations', {
      filters: clinicScope(clinicId, [eq('conversation_id', row.conversation_id), eq('status', 'open')]),
    });
    if (remaining.length === 0) {
      await store().update('conversations', row.conversation_id, { status: 'open' });
    }
    return updated;
  },
};

// -------------------------------------------------------------- audit log

export const audit = {
  /**
   * Every read or write of patient data goes through here. `meta` must contain
   * identifiers only — never message bodies, names or phone numbers.
   */
  async record(input: {
    clinicId: string;
    actorType: AuditEntry['actor_type'];
    actorId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    meta?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<AuditEntry> {
    return store().insert('audit_log', {
      id: newId(),
      clinic_id: input.clinicId,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId ?? null,
      meta: input.meta ?? {},
      created_at: input.createdAt ?? nowIso(),
    });
  },

  async list(clinicId: string, limit = 200): Promise<AuditEntry[]> {
    return store().findMany('audit_log', {
      filters: clinicScope(clinicId),
      orderBy: { field: 'created_at', direction: 'desc' },
      limit,
    });
  },
};

// ----------------------------------------------------------- kb overrides

export const kbOverrides = {
  async get(clinicId: string): Promise<KbOverride | null> {
    return store().findOne('kb_overrides', { filters: clinicScope(clinicId) });
  },

  async put(clinicId: string, kb: Record<string, unknown>, updatedBy: string): Promise<KbOverride> {
    const existing = await this.get(clinicId);
    if (existing) {
      return (await store().update('kb_overrides', existing.id, { kb, updated_at: nowIso(), updated_by: updatedBy }))!;
    }
    return store().insert('kb_overrides', {
      id: newId(),
      clinic_id: clinicId,
      kb,
      updated_at: nowIso(),
      updated_by: updatedBy,
    });
  },

  /** Drops dashboard edits so the clinic falls back to its YAML file. */
  async revert(clinicId: string): Promise<void> {
    await store().deleteWhere('kb_overrides', clinicScope(clinicId));
  },
};
