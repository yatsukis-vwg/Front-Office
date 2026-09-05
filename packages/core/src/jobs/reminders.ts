import { appointments, audit, clinics, conversations, patients, reminders } from '../db/repos.js';
import { loadKnowledgeBase } from '../kb/loader.js';
import type { KnowledgeBase } from '../kb/schema.js';
import { logger } from '../logger.js';
import { deliver } from '../messaging/pipeline.js';
import type { Locale, Reminder } from '../types.js';
import { describeSlot, nowIso } from '../util/time.js';

/**
 * Reminder worker.
 *
 * Reminders are rows, not timers: `runDueReminders` is idempotent and safe to
 * call from a Vercel cron, a Railway cron, or the in-process scheduler. A
 * restart never loses a queued reminder.
 */

export interface ReminderRunSummary {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

export async function runDueReminders(limit = 50, now: Date = new Date()): Promise<ReminderRunSummary> {
  const due = await reminders.due(now.toISOString(), limit);
  const summary: ReminderRunSummary = { processed: due.length, sent: 0, failed: 0, skipped: 0 };
  const kbCache = new Map<string, KnowledgeBase>();

  for (const reminder of due) {
    try {
      const appointment = await appointments.byId(reminder.clinic_id, reminder.appointment_id);
      // The appointment was cancelled or moved after the reminder was queued.
      if (!appointment || appointment.status !== 'booked') {
        await reminders.markSent(reminder.id);
        summary.skipped++;
        continue;
      }
      const clinic = await clinics.byId(reminder.clinic_id);
      if (!clinic) {
        await reminders.markFailed(reminder.id, 'clinic not found');
        summary.failed++;
        continue;
      }
      let kb = kbCache.get(clinic.slug);
      if (!kb) {
        kb = await loadKnowledgeBase(clinic.slug, clinic.id);
        kbCache.set(clinic.slug, kb);
      }

      // Reminders go to the thread the patient actually used.
      const patientConversations = await conversations.list(clinic.id, { limit: 200 });
      const conversation =
        (appointment.conversation_id
          ? patientConversations.find((c) => c.id === appointment.conversation_id)
          : undefined) ?? patientConversations.find((c) => c.patient_id === appointment.patient_id);

      if (!conversation) {
        await reminders.markFailed(reminder.id, 'no reachable conversation for patient');
        summary.failed++;
        continue;
      }

      const patient = await patients.viewById(clinic.id, appointment.patient_id);
      const locale: Locale = patient?.locale ?? 'ar';
      const text = renderReminder(reminder, kb, appointment.starts_at, appointment.reference, appointment.service_id, locale);

      await deliver(clinic, conversation, { text, kind: reminder.kind === 'confirmation' ? 'confirmation' : 'reminder' }, {
        author: 'system',
        meta: { reminder_kind: reminder.kind, appointment_id: appointment.id },
      });
      await reminders.markSent(reminder.id);
      await audit.record({
        clinicId: clinic.id,
        actorType: 'system',
        action: `reminder.${reminder.kind}`,
        entity: 'appointment',
        entityId: appointment.id,
        meta: { channel: conversation.channel },
      });
      summary.sent++;
    } catch (error) {
      logger.error('reminder.failed', { reminder_id: reminder.id, error });
      await reminders.markFailed(reminder.id, (error as Error).message);
      summary.failed++;
    }
  }

  if (summary.processed > 0) logger.info('reminder.run', { ...summary });
  return summary;
}

/**
 * Reminder copy comes from the knowledge base's voice, not the model — these
 * go out unattended, so they must be deterministic and pre-approved.
 */
function renderReminder(
  reminder: Reminder,
  kb: KnowledgeBase,
  startsAt: string,
  reference: string,
  serviceId: string,
  locale: Locale,
): string {
  const when = describeSlot(new Date(startsAt), kb.clinic.timezone, locale);
  const service = kb.services.find((s) => s.id === serviceId);
  const serviceName = (locale === 'en' ? service?.name_en : service?.name_ar) ?? serviceId;
  const clinicName = locale === 'en' ? kb.clinic.name_en : kb.clinic.name_ar;

  if (locale === 'en') {
    switch (reminder.kind) {
      case 'confirmation':
        return `Your appointment at ${clinicName} is confirmed ✅\n${serviceName} — ${when}\nBooking reference: ${reference}\n${kb.clinic.address.map_url}`;
      case 'reminder_24h':
        return `Reminder: you have ${serviceName} at ${clinicName} tomorrow — ${when}. Reference ${reference}. Reply here if you need to reschedule.`;
      case 'reminder_2h':
        return `See you in about 2 hours — ${serviceName}, ${when}. ${kb.clinic.address.landmark_ar ?? ''}\n${kb.clinic.address.map_url}`;
    }
  }
  switch (reminder.kind) {
    case 'confirmation':
      return `تم تأكيد موعدك في ${clinicName} ✅\n${serviceName} — ${when}\nرقم الحجز: ${reference}\nاللوكيشن: ${kb.clinic.address.map_url}`;
    case 'reminder_24h':
      return `تذكير: عندك ${serviceName} بكرة — ${when}. رقم الحجز ${reference}. لو تبي تأجل أو تلغي رد علي هنا وأساعدك.`;
    case 'reminder_2h':
      return `نشوفك بعد ساعتين تقريبًا — ${serviceName}، ${when}.\n${kb.clinic.address.landmark_ar ?? ''}\n${kb.clinic.address.map_url}`;
  }
}

/** Marks past `booked` appointments as completed so metrics stay honest. */
export async function closeOutPastAppointments(clinicId: string, now: Date = new Date()): Promise<number> {
  const rows = await appointments.range(clinicId, new Date(now.getTime() - 90 * 86400000).toISOString(), now.toISOString());
  let closed = 0;
  for (const row of rows) {
    if (row.status !== 'booked') continue;
    if (Date.parse(row.ends_at) >= now.getTime()) continue;
    await appointments.update(clinicId, row.id, { status: 'completed' });
    closed++;
  }
  if (closed > 0) logger.info('appointments.closed_out', { clinic_id: clinicId, count: closed, at: nowIso() });
  return closed;
}
