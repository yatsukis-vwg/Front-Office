import { getStore } from '../db/index.js';
import { audit, clinics, patients } from '../db/repos.js';
import { logger } from '../logger.js';
import { lte } from '../db/store.js';
import type { Clinic } from '../types.js';

/**
 * PDPL retention worker.
 *
 * Saudi PDPL treats health data as a sensitive category: it may only be kept as
 * long as the purpose requires. Each clinic sets `retention_days`; anything
 * older is purged. Purges are recorded in the audit log — the audit log itself
 * is retained longer, because it holds identifiers only, never content.
 */

export interface PurgeSummary {
  clinicId: string;
  conversationsPurged: number;
  messagesPurged: number;
  patientsAnonymised: number;
  auditEntriesPurged: number;
}

const AUDIT_RETENTION_MULTIPLIER = 2;

export async function purgeExpiredData(clinic: Clinic, now: Date = new Date()): Promise<PurgeSummary> {
  const store = getStore();
  const cutoff = new Date(now.getTime() - clinic.retention_days * 86400_000).toISOString();
  const summary: PurgeSummary = {
    clinicId: clinic.id,
    conversationsPurged: 0,
    messagesPurged: 0,
    patientsAnonymised: 0,
    auditEntriesPurged: 0,
  };

  const staleConversations = await store.findMany('conversations', {
    filters: [{ field: 'clinic_id', op: 'eq', value: clinic.id }, lte('last_message_at', cutoff)],
    limit: 1000,
  });

  for (const conversation of staleConversations) {
    summary.messagesPurged += await store.deleteWhere('messages', [
      { field: 'clinic_id', op: 'eq', value: clinic.id },
      { field: 'conversation_id', op: 'eq', value: conversation.id },
    ]);
    await store.deleteWhere('escalations', [
      { field: 'clinic_id', op: 'eq', value: clinic.id },
      { field: 'conversation_id', op: 'eq', value: conversation.id },
    ]);
    await store.delete('conversations', conversation.id);
    summary.conversationsPurged++;
  }

  // A patient with no activity inside the window keeps only a tombstone row.
  const stalePatients = await store.findMany('patients', {
    filters: [
      { field: 'clinic_id', op: 'eq', value: clinic.id },
      lte('last_seen_at', cutoff),
      { field: 'deleted_at', op: 'is_null' },
    ],
    limit: 1000,
  });
  for (const patient of stalePatients) {
    const futureAppointments = await store.findMany('appointments', {
      filters: [
        { field: 'clinic_id', op: 'eq', value: clinic.id },
        { field: 'patient_id', op: 'eq', value: patient.id },
        { field: 'starts_at', op: 'gt', value: now.toISOString() },
      ],
      limit: 1,
    });
    // Never purge a patient who still has an appointment ahead of them.
    if (futureAppointments.length > 0) continue;
    await patients.erase(clinic.id, patient.id);
    summary.patientsAnonymised++;
  }

  const auditCutoff = new Date(now.getTime() - clinic.retention_days * AUDIT_RETENTION_MULTIPLIER * 86400_000).toISOString();
  summary.auditEntriesPurged = await store.deleteWhere('audit_log', [
    { field: 'clinic_id', op: 'eq', value: clinic.id },
    lte('created_at', auditCutoff),
  ]);

  if (summary.conversationsPurged + summary.patientsAnonymised > 0) {
    await audit.record({
      clinicId: clinic.id,
      actorType: 'system',
      action: 'retention.purge',
      entity: 'clinic',
      entityId: clinic.id,
      meta: {
        retention_days: clinic.retention_days,
        conversations: summary.conversationsPurged,
        messages: summary.messagesPurged,
        patients: summary.patientsAnonymised,
      },
    });
    logger.info('retention.purge', { ...summary });
  }
  return summary;
}

export async function purgeAllClinics(now: Date = new Date()): Promise<PurgeSummary[]> {
  const all = await clinics.list();
  const out: PurgeSummary[] = [];
  for (const clinic of all) out.push(await purgeExpiredData(clinic, now));
  return out;
}

/**
 * PDPL data-portability export for one patient: everything the clinic holds
 * about them, decrypted, in one JSON document. Recorded in the audit log.
 */
export async function exportPatientRecord(clinicId: string, patientId: string, actorId: string): Promise<Record<string, unknown> | null> {
  const store = getStore();
  const patient = await patients.viewById(clinicId, patientId);
  if (!patient) return null;

  const { messages: messagesRepo } = await import('../db/repos.js');
  const patientConversations = await store.findMany('conversations', {
    filters: [{ field: 'clinic_id', op: 'eq', value: clinicId }, { field: 'patient_id', op: 'eq', value: patientId }],
  });
  const transcripts = [];
  for (const conversation of patientConversations) {
    transcripts.push({
      conversation: {
        id: conversation.id,
        channel: conversation.channel,
        created_at: conversation.created_at,
        status: conversation.status,
      },
      messages: (await messagesRepo.listForConversation(clinicId, conversation.id)).map((m) => ({
        at: m.created_at,
        from: m.author,
        text: m.body,
      })),
    });
  }
  const patientAppointments = await store.findMany('appointments', {
    filters: [{ field: 'clinic_id', op: 'eq', value: clinicId }, { field: 'patient_id', op: 'eq', value: patientId }],
  });

  await audit.record({
    clinicId,
    actorType: 'staff',
    actorId,
    action: 'patient.export',
    entity: 'patient',
    entityId: patientId,
    meta: { conversations: patientConversations.length, appointments: patientAppointments.length },
  });

  return {
    exported_at: new Date().toISOString(),
    patient: { id: patient.id, name: patient.name, phone: patient.phone, locale: patient.locale, created_at: patient.created_at },
    appointments: patientAppointments.map((a) => ({
      reference: a.reference,
      service_id: a.service_id,
      doctor_id: a.doctor_id,
      starts_at: a.starts_at,
      status: a.status,
    })),
    conversations: transcripts,
  };
}

/** PDPL right to erasure, invoked from the dashboard. */
export async function deletePatientRecord(clinicId: string, patientId: string, actorId: string) {
  const result = await patients.erase(clinicId, patientId);
  await audit.record({
    clinicId,
    actorType: 'staff',
    actorId,
    action: 'patient.erase',
    entity: 'patient',
    entityId: patientId,
    meta: result,
  });
  logger.info('pdpl.patient_erased', { clinic_id: clinicId, patient_id: patientId, ...result });
  return result;
}
