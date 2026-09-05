import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, setStore } from '../db/index.js';
import { clinics, patients } from '../db/repos.js';
import { loadKnowledgeBaseFile } from '../kb/loader.js';
import { registerChannel } from '../messaging/registry.js';
import { WebChatChannel } from '../messaging/channels/webchat.js';
import { bookAppointment, cancelAppointment, getAvailability, rescheduleAppointment } from './booking.js';
import { findAvailableSlots, isWithinWorkingHours } from './availability.js';
import { zonedDateKey, zonedToUtc } from '../util/time.js';
import type { Clinic } from '../types.js';

const kb = loadKnowledgeBaseFile('noor-riyadh', 'clinics');
const TZ = kb.clinic.timezone;

let dir: string;
let clinic: Clinic;
let patientId: string;

/** A Sunday at 10:00 Riyadh time — the clinic is open, no holiday. */
const NOW = zonedToUtc(TZ, 2026, 10, 4, 10, 0);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fo-sched-'));
  setStore(new FileStore(join(dir, 'db.json')));
  registerChannel(new WebChatChannel());
  clinic = await clinics.create({
    slug: kb.clinic.slug,
    name: kb.clinic.name_en,
    timezone: TZ,
    avg_ticket_sar: kb.clinic.avg_ticket_sar,
    retention_days: kb.clinic.retention_days,
    settings: {},
  });
  const patient = await patients.create(clinic.id, { name: 'تجربة', phone: '0501234567' });
  patientId = patient.id;
});

after(() => {
  setStore(undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('the clinic is open Sunday morning and closed Friday', () => {
  assert.equal(isWithinWorkingHours(kb, NOW), true);
  // Friday 2026-10-09 at noon.
  assert.equal(isWithinWorkingHours(kb, zonedToUtc(TZ, 2026, 10, 9, 12, 0)), false);
  // Sunday 14:00 falls inside the 13:00–16:00 break.
  assert.equal(isWithinWorkingHours(kb, zonedToUtc(TZ, 2026, 10, 4, 14, 0)), false);
  // 23:00 — the after-hours window that produces the headline metric.
  assert.equal(isWithinWorkingHours(kb, zonedToUtc(TZ, 2026, 10, 4, 23, 0)), false);
});

test('no slots are offered on a clinic holiday', () => {
  const service = kb.services.find((s) => s.id === 'dental_cleaning')!;
  const slots = findAvailableSlots({
    kb,
    service,
    fromDate: '2026-09-23',
    toDate: '2026-09-23',
    existing: [],
    now: zonedToUtc(TZ, 2026, 9, 20, 10, 0),
    limit: 20,
  });
  assert.equal(slots.length, 0);
});

test('slots respect the doctor schedule, not just clinic hours', () => {
  // dr_khalid works 16:00–21:00 Sun–Thu only.
  const service = kb.services.find((s) => s.id === 'root_canal')!;
  const slots = findAvailableSlots({
    kb,
    service,
    fromDate: '2026-10-05',
    toDate: '2026-10-05',
    existing: [],
    now: NOW,
    limit: 50,
  });
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(slot.startsAt)) % 24;
    assert.ok(hour >= 16 && hour < 21, `slot at ${hour}:00 is outside Dr Khalid's hours`);
    assert.equal(slot.doctorId, 'dr_khalid');
  }
});

test('slots never fall inside the clinic break', () => {
  const service = kb.services.find((s) => s.id === 'dental_cleaning')!;
  const slots = findAvailableSlots({ kb, service, fromDate: '2026-10-05', toDate: '2026-10-05', existing: [], now: NOW, limit: 100 });
  for (const slot of slots) {
    const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(slot.startsAt)) % 24;
    assert.ok(hour < 13 || hour >= 16, `slot at ${hour}:00 falls in the 13:00–16:00 break`);
  }
});

test('booking an offered slot succeeds and returns a reference', async () => {
  const availability = await getAvailability({
    kb,
    clinicId: clinic.id,
    serviceId: 'dental_cleaning',
    fromDate: '2026-10-05',
    toDate: '2026-10-06',
    locale: 'ar',
    now: NOW,
  });
  assert.equal(availability.ok, true);
  const slot = availability.ok ? availability.slots[0]! : undefined;
  assert.ok(slot);

  const booked = await bookAppointment({
    kb,
    clinicId: clinic.id,
    patientId,
    serviceId: 'dental_cleaning',
    doctorId: slot!.doctor_id,
    startsAt: slot!.starts_at,
    locale: 'ar',
    source: 'agent',
    now: NOW,
  });
  assert.equal(booked.ok, true, booked.ok ? '' : booked.message);
  if (booked.ok) {
    assert.match(booked.reference, /^NR-[2-9A-Z]{6}$/);
    assert.equal(booked.appointment.status, 'booked');
    assert.equal(booked.appointment.created_outside_hours, false, 'booked at 10:00, clinic open');
  }
});

test('the same slot cannot be booked twice', async () => {
  const availability = await getAvailability({
    kb,
    clinicId: clinic.id,
    serviceId: 'zoom_whitening',
    fromDate: '2026-10-07',
    toDate: '2026-10-07',
    locale: 'ar',
    now: NOW,
  });
  assert.equal(availability.ok, true);
  const slot = availability.ok ? availability.slots[0]! : undefined;
  assert.ok(slot);

  const first = await bookAppointment({
    kb, clinicId: clinic.id, patientId, serviceId: 'zoom_whitening',
    doctorId: slot!.doctor_id, startsAt: slot!.starts_at, locale: 'ar', source: 'agent', now: NOW,
  });
  assert.equal(first.ok, true);

  const second = await bookAppointment({
    kb, clinicId: clinic.id, patientId, serviceId: 'zoom_whitening',
    doctorId: slot!.doctor_id, startsAt: slot!.starts_at, locale: 'ar', source: 'agent', now: NOW,
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.code, 'slot_taken');
    assert.ok(second.alternatives.length > 0, 'a taken slot must come back with alternatives');
  }
});

test('concurrent booking attempts on one slot produce exactly one appointment', async () => {
  const availability = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'hydrafacial',
    fromDate: '2026-10-08', toDate: '2026-10-08', locale: 'ar', now: NOW,
  });
  assert.equal(availability.ok, true);
  const slot = availability.ok ? availability.slots[0]! : undefined;
  assert.ok(slot);

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      bookAppointment({
        kb, clinicId: clinic.id, patientId, serviceId: 'hydrafacial',
        doctorId: slot!.doctor_id, startsAt: slot!.starts_at, locale: 'ar', source: 'agent',
        now: NOW, allowOutOfPolicy: true,
      }),
    ),
  );
  const succeeded = attempts.filter((a) => a.ok);
  assert.equal(succeeded.length, 1, `expected exactly one winner, got ${succeeded.length}`);
});

test('a booked slot disappears from availability', async () => {
  const before = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'lip_filler',
    fromDate: '2026-10-11', toDate: '2026-10-11', locale: 'ar', now: NOW, limit: 100,
  });
  assert.equal(before.ok, true);
  const target = before.ok ? before.slots[0]! : undefined;
  assert.ok(target);

  await bookAppointment({
    kb, clinicId: clinic.id, patientId, serviceId: 'lip_filler',
    doctorId: target!.doctor_id, startsAt: target!.starts_at, locale: 'ar', source: 'agent', now: NOW,
  });

  const after = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'lip_filler',
    fromDate: '2026-10-11', toDate: '2026-10-11', locale: 'ar', now: NOW, limit: 100,
  });
  assert.equal(after.ok, true);
  if (after.ok) {
    assert.equal(after.slots.some((s) => s.starts_at === target!.starts_at), false);
  }
});

test('a booking made at 2am is flagged as captured outside working hours', async () => {
  const nightTime = zonedToUtc(TZ, 2026, 10, 12, 2, 0);
  const availability = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'deep_cleanse',
    fromDate: '2026-10-13', toDate: '2026-10-13', locale: 'ar', now: nightTime,
  });
  assert.equal(availability.ok, true);
  const slot = availability.ok ? availability.slots[0]! : undefined;
  assert.ok(slot);

  const booked = await bookAppointment({
    kb, clinicId: clinic.id, patientId, serviceId: 'deep_cleanse',
    doctorId: slot!.doctor_id, startsAt: slot!.starts_at, locale: 'ar', source: 'agent', now: nightTime,
  });
  assert.equal(booked.ok, true);
  if (booked.ok) assert.equal(booked.appointment.created_outside_hours, true);
});

test('bookings require the configured minimum notice', async () => {
  const soon = new Date(NOW.getTime() + 30 * 60_000);
  const result = await bookAppointment({
    kb, clinicId: clinic.id, patientId, serviceId: 'dental_consult',
    startsAt: soon.toISOString(), locale: 'ar', source: 'agent', now: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'too_soon');
});

test('reschedule frees the old slot and issues a new reference', async () => {
  const availability = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'dental_consult',
    fromDate: '2026-10-14', toDate: '2026-10-15', locale: 'ar', now: NOW, limit: 20,
  });
  assert.equal(availability.ok, true);
  const slots = availability.ok ? availability.slots : [];
  const first = slots[0];
  // Keep the same doctor so the move exercises the time change, not a handover.
  const second = slots.find((s) => s.doctor_id === first?.doctor_id && s.starts_at !== first?.starts_at);
  assert.ok(first && second);

  const booked = await bookAppointment({
    kb, clinicId: clinic.id, patientId, serviceId: 'dental_consult',
    doctorId: first!.doctor_id, startsAt: first!.starts_at, locale: 'ar', source: 'agent', now: NOW,
  });
  assert.equal(booked.ok, true);
  const originalRef = booked.ok ? booked.reference : '';

  const moved = await rescheduleAppointment({
    kb, clinicId: clinic.id, reference: originalRef,
    newStartsAt: second!.starts_at, newDoctorId: second!.doctor_id, locale: 'ar', now: NOW,
  });
  assert.equal(moved.ok, true);
  if (moved.ok) assert.notEqual(moved.reference, originalRef);

  // The original time is bookable again.
  const after = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'dental_consult',
    fromDate: zonedDateKey(new Date(first!.starts_at), TZ),
    toDate: zonedDateKey(new Date(first!.starts_at), TZ),
    doctorId: first!.doctor_id, locale: 'ar', now: NOW, limit: 100,
  });
  assert.equal(after.ok, true);
  if (after.ok) assert.equal(after.slots.some((s) => s.starts_at === first!.starts_at), true);
});

test('cancelling releases the slot and a second cancel is rejected', async () => {
  const availability = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'meso_skin',
    fromDate: '2026-10-18', toDate: '2026-10-18', locale: 'ar', now: NOW,
  });
  assert.equal(availability.ok, true);
  const slot = availability.ok ? availability.slots[0]! : undefined;
  const booked = await bookAppointment({
    kb, clinicId: clinic.id, patientId, serviceId: 'meso_skin',
    doctorId: slot!.doctor_id, startsAt: slot!.starts_at, locale: 'ar', source: 'agent', now: NOW,
  });
  assert.equal(booked.ok, true);
  const reference = booked.ok ? booked.reference : '';

  const cancelled = await cancelAppointment({ clinicId: clinic.id, reference, reason: 'patient travelling' });
  assert.equal(cancelled.ok, true);

  const again = await cancelAppointment({ clinicId: clinic.id, reference });
  assert.equal(again.ok, false);
});

test('an unknown service is rejected rather than guessed', async () => {
  const result = await getAvailability({
    kb, clinicId: clinic.id, serviceId: 'nose_job',
    fromDate: '2026-10-05', toDate: '2026-10-06', locale: 'ar', now: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'unknown_service');
});

test('a doctor who does not provide the service is rejected', async () => {
  const result = await bookAppointment({
    kb, clinicId: clinic.id, patientId,
    serviceId: 'zoom_whitening', doctorId: 'dr_khalid',
    startsAt: zonedToUtc(TZ, 2026, 10, 19, 17, 0).toISOString(),
    locale: 'ar', source: 'agent', now: NOW,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'unknown_doctor');
});

