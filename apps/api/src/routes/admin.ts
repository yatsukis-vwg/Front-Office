import { Router } from 'express';
import {
  appointments,
  audit,
  bookAppointment,
  cancelAppointment,
  clinics,
  computeMetrics,
  conversations,
  deletePatientRecord,
  escalations,
  exportPatientRecord,
  getAvailability,
  invalidateKnowledgeBaseCache,
  kbOverrides,
  loadKnowledgeBase,
  loadKnowledgeBaseFile,
  logger,
  messages,
  patients,
  rescheduleAppointment,
  sendStaffReply,
  validateKnowledgeBase,
  windowForDays,
  type Clinic,
} from '@front-office/core';
import { defaultClinic, resolveClinic, syncClinicsFromFiles } from '../context.js';
import { staffId } from '../middleware/auth.js';

/**
 * Admin API — everything the dashboard renders.
 *
 * Two invariants hold across every route:
 *   1. the clinic is resolved once, up front, and every query is scoped to it
 *      (per-clinic isolation);
 *   2. any route that reads or writes patient data writes an audit entry.
 */
export const adminRouter: Router = Router();

async function clinicFrom(req: { query: Record<string, unknown>; body?: Record<string, unknown> }): Promise<Clinic | null> {
  const slug = (req.query.clinic ?? req.body?.clinic) as string | undefined;
  return slug ? resolveClinic(String(slug)) : defaultClinic();
}

adminRouter.use(async (req, res, next) => {
  const clinic = await clinicFrom(req as never);
  if (!clinic) {
    res.status(404).json({ error: 'unknown_clinic' });
    return;
  }
  res.locals.clinic = clinic;
  next();
});

function currentClinic(res: { locals: Record<string, unknown> }): Clinic {
  return res.locals.clinic as Clinic;
}

// ------------------------------------------------------------- clinics

adminRouter.get('/clinics', async (_req, res) => {
  const all = await clinics.list();
  res.json({
    clinics: all.map((c) => ({ id: c.id, slug: c.slug, name: c.name, timezone: c.timezone, avg_ticket_sar: c.avg_ticket_sar })),
  });
});

adminRouter.post('/clinics/sync', async (_req, res) => {
  const synced = await syncClinicsFromFiles();
  invalidateKnowledgeBaseCache();
  res.json({ synced: synced.map((c) => c.slug) });
});

adminRouter.patch('/clinic', async (req, res) => {
  const clinic = currentClinic(res);
  const patch: Partial<Clinic> = {};
  if (typeof req.body.avg_ticket_sar === 'number') patch.avg_ticket_sar = req.body.avg_ticket_sar;
  if (typeof req.body.retention_days === 'number') patch.retention_days = req.body.retention_days;
  if (req.body.settings && typeof req.body.settings === 'object') {
    patch.settings = { ...clinic.settings, ...req.body.settings };
  }
  const updated = await clinics.update(clinic.id, patch);
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'clinic.update',
    entity: 'clinic',
    entityId: clinic.id,
    meta: { fields: Object.keys(patch) },
  });
  res.json({ clinic: updated });
});

// ------------------------------------------------------- conversations

adminRouter.get('/conversations', async (req, res) => {
  const clinic = currentClinic(res);
  const search = req.query.q ? String(req.query.q) : '';

  let rows = await conversations.list(clinic.id, {
    status: req.query.status as never,
    owner: req.query.owner as never,
    channel: req.query.channel as never,
    limit: Number(req.query.limit ?? 60),
    offset: Number(req.query.offset ?? 0),
  });

  // Search decrypts candidate rows in-process; see docs/SECURITY.md for why
  // there is no server-side index over message bodies.
  if (search) {
    const hits = await messages.search(clinic.id, search);
    const matchingIds = new Set(hits.map((hit) => hit.conversation_id));
    const candidates = await conversations.list(clinic.id, { limit: 400 });
    const needle = search.toLowerCase();
    const byName = await Promise.all(
      candidates.map(async (candidate) => {
        if (matchingIds.has(candidate.id)) return candidate;
        const patient = await patients.viewById(clinic.id, candidate.patient_id);
        const haystack = `${patient?.name ?? ''} ${patient?.phone ?? ''}`.toLowerCase();
        return haystack.includes(needle) ? candidate : null;
      }),
    );
    rows = byName.filter((candidate): candidate is (typeof candidates)[number] => candidate !== null);
  }

  const enriched = await Promise.all(rows.map((row) => enrichConversation(clinic, row)));
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'conversation.list',
    entity: 'conversation',
    meta: { count: enriched.length, searched: Boolean(search) },
  });
  res.json({ conversations: enriched });
});

adminRouter.get('/conversations/:id', async (req, res) => {
  const clinic = currentClinic(res);
  const conversation = await conversations.byId(clinic.id, req.params.id);
  if (!conversation) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const [transcript, patient, openEscalations, bookings] = await Promise.all([
    messages.listForConversation(clinic.id, conversation.id),
    patients.viewById(clinic.id, conversation.patient_id),
    escalations.forConversation(clinic.id, conversation.id),
    appointments.byPatient(clinic.id, conversation.patient_id, ['booked', 'completed', 'cancelled']),
  ]);

  // Reading a transcript is access to sensitive personal data — always audited.
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'conversation.read_transcript',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { message_count: transcript.length, patient_id: conversation.patient_id },
  });

  res.json({
    conversation,
    patient,
    escalations: openEscalations,
    appointments: bookings,
    messages: transcript.map((m) => ({
      id: m.id,
      author: m.author,
      direction: m.direction,
      body: m.body,
      flagged: m.flagged,
      response_ms: m.response_ms,
      meta: m.meta,
      created_at: m.created_at,
    })),
  });
});

adminRouter.post('/conversations/:id/takeover', async (req, res) => {
  const clinic = currentClinic(res);
  const staff = staffId(req);
  const updated = await conversations.takeOver(clinic.id, req.params.id, staff);
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staff,
    action: 'conversation.takeover',
    entity: 'conversation',
    entityId: req.params.id,
  });
  res.json({ conversation: updated });
});

adminRouter.post('/conversations/:id/release', async (req, res) => {
  const clinic = currentClinic(res);
  const updated = await conversations.releaseToAgent(clinic.id, req.params.id);
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'conversation.release_to_agent',
    entity: 'conversation',
    entityId: req.params.id,
  });
  res.json({ conversation: updated });
});

adminRouter.post('/conversations/:id/reply', async (req, res) => {
  const clinic = currentClinic(res);
  const text = String(req.body.text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: 'text_required' });
    return;
  }
  const result = await sendStaffReply(clinic.id, req.params.id, text, staffId(req));
  if (result.status === 'error') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ ok: true });
});

// --------------------------------------------------------- escalations

adminRouter.get('/escalations', async (req, res) => {
  const clinic = currentClinic(res);
  const status = (req.query.status as 'open' | 'resolved' | undefined) ?? 'open';
  const rows = await escalations.list(clinic.id, status);
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const conversation = await conversations.byId(clinic.id, row.conversation_id);
      const patient = conversation ? await patients.viewById(clinic.id, conversation.patient_id) : null;
      const transcript = conversation ? await messages.listForConversation(clinic.id, conversation.id, 4) : [];
      return {
        ...row,
        channel: conversation?.channel ?? null,
        owner: conversation?.owner ?? null,
        patient_name: patient?.name ?? null,
        last_patient_message: [...transcript].reverse().find((m) => m.author === 'patient')?.body ?? null,
      };
    }),
  );
  res.json({ escalations: enriched });
});

adminRouter.post('/escalations/:id/resolve', async (req, res) => {
  const clinic = currentClinic(res);
  const resolved = await escalations.resolve(clinic.id, req.params.id, staffId(req));
  if (!resolved) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ escalation: resolved });
});

// -------------------------------------------------------- appointments

adminRouter.get('/appointments', async (req, res) => {
  const clinic = currentClinic(res);
  const from = String(req.query.from ?? new Date(Date.now() - 7 * 86400000).toISOString());
  const to = String(req.query.to ?? new Date(Date.now() + 30 * 86400000).toISOString());
  const rows = await appointments.range(clinic.id, from, to);
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const patient = await patients.viewById(clinic.id, row.patient_id);
      return { ...row, patient_name: patient?.name ?? null, patient_phone: patient?.phone ?? null };
    }),
  );
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'appointment.list',
    entity: 'appointment',
    meta: { count: enriched.length },
  });
  res.json({ appointments: enriched });
});

adminRouter.get('/availability', async (req, res) => {
  const clinic = currentClinic(res);
  const kb = await loadKnowledgeBase(clinic.slug, clinic.id);
  const result = await getAvailability({
    kb,
    clinicId: clinic.id,
    serviceId: String(req.query.service_id ?? ''),
    fromDate: String(req.query.from ?? new Date().toISOString().slice(0, 10)),
    toDate: String(req.query.to ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)),
    doctorId: req.query.doctor_id ? String(req.query.doctor_id) : undefined,
    locale: 'ar',
    limit: Number(req.query.limit ?? 40),
  });
  if (!result.ok) {
    res.status(400).json({ error: result.code, message: result.message });
    return;
  }
  res.json({ slots: result.slots });
});

/** Manual entry: reception taking a booking over the phone. */
adminRouter.post('/appointments', async (req, res) => {
  const clinic = currentClinic(res);
  const kb = await loadKnowledgeBase(clinic.slug, clinic.id);
  const name = String(req.body.patient_name ?? '').trim();
  const phone = String(req.body.patient_phone ?? '').trim();
  if (!name || !phone) {
    res.status(400).json({ error: 'patient_name_and_phone_required' });
    return;
  }

  const existing = await patients.byPhone(clinic.id, phone);
  const patient = existing ?? (await patients.create(clinic.id, { name, phone, locale: 'ar' }));
  if (existing) await patients.update(clinic.id, existing.id, { name });

  const result = await bookAppointment({
    kb,
    clinicId: clinic.id,
    patientId: patient.id,
    serviceId: String(req.body.service_id ?? ''),
    doctorId: req.body.doctor_id ? String(req.body.doctor_id) : undefined,
    startsAt: String(req.body.starts_at ?? ''),
    notes: req.body.notes ? String(req.body.notes) : null,
    locale: 'ar',
    source: 'staff',
    actorId: staffId(req),
    // Reception can override the notice window and book into a break.
    allowOutOfPolicy: req.body.force === true,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.code, message: result.message, ...(result.code === 'slot_taken' ? { alternatives: result.alternatives } : {}) });
    return;
  }
  res.json({ appointment: result.appointment, reference: result.reference, when: result.label });
});

adminRouter.post('/appointments/:reference/cancel', async (req, res) => {
  const clinic = currentClinic(res);
  const result = await cancelAppointment({
    clinicId: clinic.id,
    reference: req.params.reference,
    reason: req.body?.reason ? String(req.body.reason) : 'cancelled by clinic',
    actorType: 'staff',
    actorId: staffId(req),
  });
  if (!result.ok) {
    res.status(404).json({ error: result.code, message: result.message });
    return;
  }
  res.json({ appointment: result.appointment });
});

adminRouter.post('/appointments/:reference/reschedule', async (req, res) => {
  const clinic = currentClinic(res);
  const kb = await loadKnowledgeBase(clinic.slug, clinic.id);
  const result = await rescheduleAppointment({
    kb,
    clinicId: clinic.id,
    reference: req.params.reference,
    newStartsAt: String(req.body.starts_at ?? ''),
    newDoctorId: req.body.doctor_id ? String(req.body.doctor_id) : undefined,
    locale: 'ar',
    actorType: 'staff',
    actorId: staffId(req),
  });
  if (!result.ok) {
    res.status(400).json({ error: result.code, message: result.message });
    return;
  }
  res.json({ appointment: result.appointment, reference: result.reference, when: result.label });
});

// ------------------------------------------------------------- metrics

adminRouter.get('/metrics', async (req, res) => {
  const clinic = currentClinic(res);
  const kb = await loadKnowledgeBase(clinic.slug, clinic.id);
  const days = Number(req.query.days ?? 30);
  const metrics = await computeMetrics(clinic, kb, windowForDays(days));
  res.json({ metrics });
});

// ------------------------------------------------------ knowledge base

adminRouter.get('/kb', async (_req, res) => {
  const clinic = currentClinic(res);
  const override = await kbOverrides.get(clinic.id);
  const kb = await loadKnowledgeBase(clinic.slug, clinic.id);
  res.json({ kb, source: override ? 'dashboard' : 'file', updated_at: override?.updated_at ?? null });
});

/**
 * Saves a knowledge base edit. The document is validated first — an invalid
 * save is rejected outright so the agent can never run on a broken KB.
 */
adminRouter.put('/kb', async (req, res) => {
  const clinic = currentClinic(res);
  const result = validateKnowledgeBase(req.body?.kb);
  if (!result.ok) {
    res.status(400).json({ error: 'invalid_kb', issues: result.issues });
    return;
  }
  if (result.kb.clinic.slug !== clinic.slug) {
    res.status(400).json({ error: 'slug_mismatch', message: 'The knowledge base slug must match the clinic.' });
    return;
  }
  await kbOverrides.put(clinic.id, result.kb as unknown as Record<string, unknown>, staffId(req));
  invalidateKnowledgeBaseCache(clinic.slug);
  await clinics.update(clinic.id, {
    avg_ticket_sar: result.kb.clinic.avg_ticket_sar,
    retention_days: result.kb.clinic.retention_days,
  });
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'kb.update',
    entity: 'clinic',
    entityId: clinic.id,
    meta: { faqs: result.kb.faqs.length, services: result.kb.services.length },
  });
  logger.info('kb.updated', { clinic_id: clinic.id, faqs: result.kb.faqs.length });
  res.json({ ok: true });
});

/** Discards dashboard edits and falls back to the YAML file. */
adminRouter.post('/kb/revert', async (req, res) => {
  const clinic = currentClinic(res);
  await kbOverrides.revert(clinic.id);
  invalidateKnowledgeBaseCache(clinic.slug);
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'kb.revert_to_file',
    entity: 'clinic',
    entityId: clinic.id,
  });
  res.json({ kb: loadKnowledgeBaseFile(clinic.slug), source: 'file' });
});

// -------------------------------------------------- PDPL: patient data

adminRouter.get('/patients', async (req, res) => {
  const clinic = currentClinic(res);
  const rows = await patients.list(clinic.id, Number(req.query.limit ?? 100));
  await audit.record({
    clinicId: clinic.id,
    actorType: 'staff',
    actorId: staffId(req),
    action: 'patient.list',
    entity: 'patient',
    meta: { count: rows.length },
  });
  res.json({ patients: rows });
});

adminRouter.get('/patients/:id/export', async (req, res) => {
  const clinic = currentClinic(res);
  const record = await exportPatientRecord(clinic.id, req.params.id, staffId(req));
  if (!record) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('content-disposition', `attachment; filename="patient-${req.params.id}.json"`);
  res.json(record);
});

adminRouter.delete('/patients/:id', async (req, res) => {
  const clinic = currentClinic(res);
  const result = await deletePatientRecord(clinic.id, req.params.id, staffId(req));
  res.json({ ok: true, ...result });
});

adminRouter.get('/audit', async (req, res) => {
  const clinic = currentClinic(res);
  const rows = await audit.list(clinic.id, Number(req.query.limit ?? 200));
  res.json({ audit: rows });
});

// ------------------------------------------------------------- helpers

async function enrichConversation(clinic: Clinic, conversation: Awaited<ReturnType<typeof conversations.list>>[number]) {
  const [patient, transcript, open] = await Promise.all([
    patients.viewById(clinic.id, conversation.patient_id),
    messages.listForConversation(clinic.id, conversation.id, 400),
    escalations.forConversation(clinic.id, conversation.id),
  ]);
  const last = transcript[transcript.length - 1];
  return {
    ...conversation,
    patient_name: patient?.name ?? null,
    patient_phone: patient?.phone ?? null,
    last_message: last ? { author: last.author, body: last.body.slice(0, 160), created_at: last.created_at } : null,
    open_escalations: open.filter((e) => e.status === 'open').length,
    escalation_reasons: [...new Set(open.filter((e) => e.status === 'open').map((e) => e.reason))],
  };
}
