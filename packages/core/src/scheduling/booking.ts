import { encryptNullable, newBookingReference, newId } from '../crypto/encryption.js';
import { getStore } from '../db/index.js';
import { appointments, audit, reminders } from '../db/repos.js';
import { findDoctor, findService } from '../kb/loader.js';
import type { KnowledgeBase } from '../kb/schema.js';
import { logger } from '../logger.js';
import type { Appointment, AppointmentSource, Locale } from '../types.js';
import { addMinutes, describeSlot, nowIso, zonedDateKey } from '../util/time.js';
import { conflicts, findAvailableSlots, isHoliday, isWithinWorkingHours, type Slot } from './availability.js';

/**
 * Booking service.
 *
 * The only place appointments are created. Double-booking is prevented in three
 * layers, deliberately redundant:
 *   1. `findAvailableSlots` never offers a colliding slot;
 *   2. this module re-checks conflicts *inside a lock* right before insert
 *      (the offered slot may have been taken while the patient was typing);
 *   3. Postgres holds an exclusion constraint on (doctor_id, time range) for
 *      booked rows, so even a lost lock cannot produce a clash.
 */

export type BookingFailure =
  | { ok: false; code: 'unknown_service'; message: string }
  | { ok: false; code: 'unknown_doctor'; message: string }
  | { ok: false; code: 'service_not_bookable'; message: string }
  | { ok: false; code: 'invalid_time'; message: string }
  | { ok: false; code: 'closed'; message: string }
  | { ok: false; code: 'slot_taken'; message: string; alternatives: SlotSummary[] }
  | { ok: false; code: 'too_soon'; message: string }
  | { ok: false; code: 'too_far'; message: string }
  | { ok: false; code: 'not_found'; message: string };

export interface SlotSummary {
  starts_at: string;
  ends_at: string;
  doctor_id: string;
  doctor_name: string;
  label: string;
}

export interface BookingSuccess {
  ok: true;
  appointment: Appointment;
  reference: string;
  label: string;
  doctorName: string;
  serviceName: string;
}

export type BookingResult = BookingSuccess | BookingFailure;

export function toSlotSummary(slot: Slot, kb: KnowledgeBase, locale: Locale): SlotSummary {
  return {
    starts_at: slot.startsAt.toISOString(),
    ends_at: slot.endsAt.toISOString(),
    doctor_id: slot.doctorId,
    doctor_name: locale === 'en' ? slot.doctorNameEn : slot.doctorNameAr,
    label: describeSlot(slot.startsAt, kb.clinic.timezone, locale),
  };
}

export interface AvailabilityQuery {
  kb: KnowledgeBase;
  clinicId: string;
  serviceId: string;
  fromDate: string;
  toDate: string;
  doctorId?: string;
  locale: Locale;
  now?: Date;
  limit?: number;
}

export async function getAvailability(query: AvailabilityQuery): Promise<{ ok: true; slots: SlotSummary[] } | BookingFailure> {
  const service = findService(query.kb, query.serviceId);
  if (!service) return { ok: false, code: 'unknown_service', message: `No service matching "${query.serviceId}"` };
  if (!service.bookable) return { ok: false, code: 'service_not_bookable', message: `${service.name_en} is not bookable online` };
  if (query.doctorId && !findDoctor(query.kb, query.doctorId)) {
    return { ok: false, code: 'unknown_doctor', message: `No doctor matching "${query.doctorId}"` };
  }

  // Fetch a generous window so buffer-aware conflict checks see neighbours.
  const from = new Date(`${query.fromDate}T00:00:00Z`);
  const to = new Date(`${query.toDate}T23:59:59Z`);
  const existing = await appointments.bookedInWindow(
    query.clinicId,
    new Date(from.getTime() - 86400000).toISOString(),
    new Date(to.getTime() + 86400000).toISOString(),
  );

  const slots = findAvailableSlots({
    kb: query.kb,
    service,
    fromDate: query.fromDate,
    toDate: query.toDate,
    doctorId: query.doctorId ? findDoctor(query.kb, query.doctorId)!.id : undefined,
    existing,
    now: query.now,
    limit: query.limit,
  });

  return { ok: true, slots: slots.map((slot) => toSlotSummary(slot, query.kb, query.locale)) };
}

export interface BookRequest {
  kb: KnowledgeBase;
  clinicId: string;
  patientId: string;
  conversationId?: string | null;
  serviceId: string;
  doctorId?: string;
  /** ISO-8601 instant. */
  startsAt: string;
  notes?: string | null;
  locale: Locale;
  source: AppointmentSource;
  actorId?: string;
  now?: Date;
  /** Skips the notice/holiday guards for staff entering a past or ad-hoc booking. */
  allowOutOfPolicy?: boolean;
}

export async function bookAppointment(request: BookRequest): Promise<BookingResult> {
  const { kb, clinicId } = request;
  const now = request.now ?? new Date();
  const service = findService(kb, request.serviceId);
  if (!service) return { ok: false, code: 'unknown_service', message: `No service matching "${request.serviceId}"` };
  if (!service.bookable && !request.allowOutOfPolicy) {
    return { ok: false, code: 'service_not_bookable', message: `${service.name_en} is not bookable online` };
  }

  const startsAt = new Date(request.startsAt);
  if (Number.isNaN(startsAt.getTime())) {
    return { ok: false, code: 'invalid_time', message: `"${request.startsAt}" is not a valid ISO-8601 instant` };
  }

  const doctor = request.doctorId
    ? findDoctor(kb, request.doctorId)
    : kb.doctors.find((d) => service.doctor_ids.includes(d.id));
  if (!doctor) return { ok: false, code: 'unknown_doctor', message: `No doctor available for ${service.name_en}` };
  if (!service.doctor_ids.includes(doctor.id)) {
    return { ok: false, code: 'unknown_doctor', message: `${doctor.name_en} does not provide ${service.name_en}` };
  }

  const endsAt = addMinutes(startsAt, service.duration_min);

  if (!request.allowOutOfPolicy) {
    const noticeMs = kb.scheduling.min_notice_hours * 3600_000;
    if (startsAt.getTime() < now.getTime() + noticeMs) {
      return { ok: false, code: 'too_soon', message: `Bookings need at least ${kb.scheduling.min_notice_hours}h notice` };
    }
    if (startsAt.getTime() > now.getTime() + kb.scheduling.max_advance_days * 86400_000) {
      return { ok: false, code: 'too_far', message: `Bookings open up to ${kb.scheduling.max_advance_days} days ahead` };
    }
    if (isHoliday(kb, zonedDateKey(startsAt, kb.clinic.timezone))) {
      return { ok: false, code: 'closed', message: 'The clinic is closed that day' };
    }
    // The requested instant must be one the availability engine would offer.
    const offered = await getAvailability({
      kb,
      clinicId,
      serviceId: service.id,
      fromDate: zonedDateKey(startsAt, kb.clinic.timezone),
      toDate: zonedDateKey(startsAt, kb.clinic.timezone),
      doctorId: doctor.id,
      locale: request.locale,
      now,
      limit: 500,
    });
    if (offered.ok && !offered.slots.some((slot) => slot.starts_at === startsAt.toISOString())) {
      const alternatives = await nearbyAlternatives(request, service.id, doctor.id, startsAt, now);
      return { ok: false, code: 'slot_taken', message: 'That exact time is not available', alternatives };
    }
  }

  const lockKey = `booking:${clinicId}:${doctor.id}`;
  return getStore().withLock(lockKey, async (): Promise<BookingResult> => {
    // Re-check under the lock: the slot may have gone while the patient typed.
    const overlapping = await appointments.bookedInWindow(
      clinicId,
      addMinutes(startsAt, -240).toISOString(),
      addMinutes(endsAt, 240).toISOString(),
      doctor.id,
    );
    if (conflicts(startsAt, endsAt, doctor.id, overlapping, service.buffer_min, kb)) {
      const alternatives = await nearbyAlternatives(request, service.id, doctor.id, startsAt, now);
      return { ok: false, code: 'slot_taken', message: 'That time was just taken', alternatives };
    }

    const row: Appointment = {
      id: newId(),
      clinic_id: clinicId,
      reference: newBookingReference(),
      patient_id: request.patientId,
      conversation_id: request.conversationId ?? null,
      service_id: service.id,
      doctor_id: doctor.id,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: 'booked',
      source: request.source,
      notes_enc: encryptNullable(request.notes ?? null),
      // The headline sales metric: was the clinic shut when this came in?
      created_outside_hours: !isWithinWorkingHours(kb, now),
      created_at: now.toISOString(),
      cancelled_at: null,
      cancel_reason: null,
    };
    const saved = await appointments.insert(row);
    await scheduleReminders(kb, saved);
    await audit.record({
      clinicId,
      actorType: request.source === 'agent' ? 'agent' : 'staff',
      actorId: request.actorId ?? null,
      action: 'appointment.create',
      entity: 'appointment',
      entityId: saved.id,
      meta: { service_id: service.id, doctor_id: doctor.id, outside_hours: saved.created_outside_hours, source: request.source },
    });
    logger.info('booking.created', {
      clinic_id: clinicId,
      appointment_id: saved.id,
      service_id: service.id,
      doctor_id: doctor.id,
      outside_hours: saved.created_outside_hours,
    });

    return {
      ok: true,
      appointment: saved,
      reference: saved.reference,
      label: describeSlot(startsAt, kb.clinic.timezone, request.locale),
      doctorName: request.locale === 'en' ? doctor.name_en : doctor.name_ar,
      serviceName: request.locale === 'en' ? service.name_en : service.name_ar,
    };
  });
}

async function nearbyAlternatives(
  request: BookRequest,
  serviceId: string,
  doctorId: string,
  around: Date,
  now: Date,
): Promise<SlotSummary[]> {
  const tz = request.kb.clinic.timezone;
  const result = await getAvailability({
    kb: request.kb,
    clinicId: request.clinicId,
    serviceId,
    fromDate: zonedDateKey(around, tz),
    toDate: zonedDateKey(new Date(around.getTime() + 6 * 86400000), tz),
    doctorId,
    locale: request.locale,
    now,
    limit: 4,
  });
  return result.ok ? result.slots : [];
}

/** Confirmation now, then 24h and 2h before the appointment. */
export async function scheduleReminders(kb: KnowledgeBase, appointment: Appointment): Promise<void> {
  const startsAt = Date.parse(appointment.starts_at);
  const plan: { kind: 'confirmation' | 'reminder_24h' | 'reminder_2h'; at: number }[] = [
    { kind: 'confirmation', at: Date.now() },
    { kind: 'reminder_24h', at: startsAt - 24 * 3600_000 },
    { kind: 'reminder_2h', at: startsAt - 2 * 3600_000 },
  ];
  for (const entry of plan) {
    // Skip reminders whose moment has already passed (e.g. a same-day booking).
    if (entry.kind !== 'confirmation' && entry.at <= Date.now()) continue;
    await reminders.schedule({
      clinicId: appointment.clinic_id,
      appointmentId: appointment.id,
      kind: entry.kind,
      sendAt: new Date(entry.at).toISOString(),
    });
  }
}

export interface RescheduleRequest {
  kb: KnowledgeBase;
  clinicId: string;
  reference: string;
  newStartsAt: string;
  /** Optional: the new slot may belong to a different doctor. */
  newDoctorId?: string;
  locale: Locale;
  actorId?: string;
  actorType?: 'agent' | 'staff';
  now?: Date;
}

export async function rescheduleAppointment(request: RescheduleRequest): Promise<BookingResult> {
  const existing = await appointments.byReference(request.clinicId, request.reference);
  if (!existing || existing.status !== 'booked') {
    return { ok: false, code: 'not_found', message: `No active booking with reference ${request.reference}` };
  }
  // Book the new slot first; only release the old one once the new one holds.
  const booked = await bookAppointment({
    kb: request.kb,
    clinicId: request.clinicId,
    patientId: existing.patient_id,
    conversationId: existing.conversation_id,
    serviceId: existing.service_id,
    doctorId: request.newDoctorId ?? existing.doctor_id,
    startsAt: request.newStartsAt,
    locale: request.locale,
    source: request.actorType === 'staff' ? 'staff' : 'agent',
    actorId: request.actorId,
    now: request.now,
  });
  if (!booked.ok) return booked;

  await appointments.update(request.clinicId, existing.id, {
    status: 'cancelled',
    cancelled_at: nowIso(),
    cancel_reason: `rescheduled to ${booked.reference}`,
  });
  await reminders.cancelForAppointment(request.clinicId, existing.id);
  await audit.record({
    clinicId: request.clinicId,
    actorType: request.actorType ?? 'agent',
    actorId: request.actorId ?? null,
    action: 'appointment.reschedule',
    entity: 'appointment',
    entityId: existing.id,
    meta: { from_reference: existing.reference, to_reference: booked.reference },
  });
  return booked;
}

export interface CancelRequest {
  clinicId: string;
  reference: string;
  reason?: string;
  actorId?: string;
  actorType?: 'agent' | 'staff';
}

export async function cancelAppointment(
  request: CancelRequest,
): Promise<{ ok: true; appointment: Appointment } | BookingFailure> {
  const existing = await appointments.byReference(request.clinicId, request.reference);
  if (!existing || existing.status !== 'booked') {
    return { ok: false, code: 'not_found', message: `No active booking with reference ${request.reference}` };
  }
  const updated = await appointments.update(request.clinicId, existing.id, {
    status: 'cancelled',
    cancelled_at: nowIso(),
    cancel_reason: (request.reason ?? 'cancelled by patient').slice(0, 200),
  });
  await reminders.cancelForAppointment(request.clinicId, existing.id);
  await audit.record({
    clinicId: request.clinicId,
    actorType: request.actorType ?? 'agent',
    actorId: request.actorId ?? null,
    action: 'appointment.cancel',
    entity: 'appointment',
    entityId: existing.id,
    meta: { reference: existing.reference },
  });
  return { ok: true, appointment: updated! };
}
