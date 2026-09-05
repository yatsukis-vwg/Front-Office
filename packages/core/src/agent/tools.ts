import type Anthropic from '@anthropic-ai/sdk';
import { normalizePhone } from '../crypto/encryption.js';
import { appointments, escalations, patients } from '../db/repos.js';
import { findService } from '../kb/loader.js';
import type { KnowledgeBase } from '../kb/schema.js';
import { logger } from '../logger.js';
import { bookAppointment, cancelAppointment, getAvailability, rescheduleAppointment } from '../scheduling/booking.js';
import type { EscalationReason, Locale } from '../types.js';
import { addDays, describeSlot, zonedDateKey } from '../util/time.js';

/**
 * Agent tools.
 *
 * The knowledge base is in the system prompt, so there is no "search the FAQ"
 * tool — the agent only needs tools for things that touch state. Every tool
 * returns a plain object that is JSON-stringified back to the model; failures
 * come back as `{ ok: false, ... }` rather than thrown errors so the agent can
 * recover in-conversation.
 */

export interface ToolContext {
  kb: KnowledgeBase;
  clinicId: string;
  conversationId: string;
  patientId: string;
  locale: Locale;
  now: Date;
  /** Set by escalate_to_human so the pipeline knows to hand the thread over. */
  escalated: { reason: EscalationReason; detail: string } | null;
  /** Numbers the agent legitimately learned from tools; the price guard allows these. */
  allowedNumbers: Set<number>;
  /** Set when a booking succeeded, so the pipeline can attach it to the message. */
  lastBookingReference: string | null;
}

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_availability',
    description:
      'Find real bookable appointment slots for a service. ALWAYS call this before offering any time to a patient — never invent or guess availability. Returns slots that respect clinic hours, doctor schedules, breaks, holidays and existing bookings.',
    input_schema: {
      type: 'object',
      properties: {
        service_id: {
          type: 'string',
          description: 'Service id from the price list, e.g. "dental_cleaning". An Arabic service name also works.',
        },
        from_date: { type: 'string', description: 'First date to search, YYYY-MM-DD in clinic local time.' },
        to_date: { type: 'string', description: 'Last date to search, YYYY-MM-DD. Defaults to from_date + 7 days.' },
        doctor_id: { type: 'string', description: 'Optional doctor id when the patient asked for someone specific.' },
      },
      required: ['service_id', 'from_date'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book an appointment at an exact time returned by check_availability. Requires the patient name, mobile number, service and chosen slot. Returns the booking reference to read back to the patient verbatim.',
    input_schema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service id from the price list.' },
        starts_at: { type: 'string', description: 'Exact ISO-8601 start instant, copied from a check_availability result.' },
        doctor_id: { type: 'string', description: 'Doctor id from the chosen slot.' },
        patient_name: { type: 'string', description: 'Patient full name as they gave it.' },
        patient_phone: { type: 'string', description: 'Saudi mobile number, e.g. 0501234567.' },
        notes: { type: 'string', description: 'Optional scheduling note only — never clinical information.' },
      },
      required: ['service_id', 'starts_at', 'patient_name', 'patient_phone'],
    },
  },
  {
    name: 'lookup_appointment',
    description:
      'Find a patient\'s existing bookings by booking reference or mobile number. Use before rescheduling or cancelling when the patient does not quote a reference.',
    input_schema: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Booking reference such as NR-7QK4M2.' },
        phone: { type: 'string', description: 'Saudi mobile number to search by.' },
      },
      required: [],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Move an existing booking to a new time returned by check_availability. Returns a new booking reference.',
    input_schema: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Existing booking reference.' },
        new_starts_at: { type: 'string', description: 'New ISO-8601 start instant from check_availability.' },
        doctor_id: { type: 'string', description: 'Doctor id of the new slot, when it differs from the original.' },
      },
      required: ['reference', 'new_starts_at'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing booking by reference.',
    input_schema: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Booking reference to cancel.' },
        reason: { type: 'string', description: 'Short non-clinical reason, e.g. "patient travelling".' },
      },
      required: ['reference'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand the conversation to clinic staff. Call this for anything medical (symptoms, diagnosis, whether a treatment suits someone), any price not in the published list, complaints, refunds, or when the patient asks for a human. After calling it, send one short warm holding message and stop.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: [
            'medical_advice',
            'symptom_description',
            'unpublished_price',
            'treatment_suitability',
            'outcome_promise',
            'emergency_language',
            'agent_requested',
          ],
          description: 'Why the conversation needs a human.',
        },
        summary: { type: 'string', description: 'One line for the staff queue. No clinical interpretation.' },
      },
      required: ['reason', 'summary'],
    },
  },
];

type ToolResult = Record<string, unknown>;

export async function executeTool(name: string, rawInput: unknown, context: ToolContext): Promise<ToolResult> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'check_availability':
        return await runCheckAvailability(input, context);
      case 'book_appointment':
        return await runBookAppointment(input, context);
      case 'lookup_appointment':
        return await runLookupAppointment(input, context);
      case 'reschedule_appointment':
        return await runReschedule(input, context);
      case 'cancel_appointment':
        return await runCancel(input, context);
      case 'escalate_to_human':
        return await runEscalate(input, context);
      default:
        return { ok: false, error: `unknown tool "${name}"` };
    }
  } catch (error) {
    logger.error('agent.tool_failed', { tool: name, clinic_id: context.clinicId, error });
    return { ok: false, error: 'tool_failed', message: 'Something went wrong on our side. Ask the patient to hold on.' };
  }
}

async function runCheckAvailability(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const serviceId = String(input.service_id ?? '');
  const tz = context.kb.clinic.timezone;
  const fromDate = String(input.from_date ?? zonedDateKey(context.now, tz));
  const toDate = String(input.to_date ?? zonedDateKey(addDays(new Date(`${fromDate}T12:00:00Z`), 7), tz));

  const result = await getAvailability({
    kb: context.kb,
    clinicId: context.clinicId,
    serviceId,
    fromDate,
    toDate,
    doctorId: input.doctor_id ? String(input.doctor_id) : undefined,
    locale: context.locale,
    now: context.now,
  });
  if (!result.ok) return { ok: false, error: result.code, message: result.message };

  if (result.slots.length === 0) {
    return {
      ok: true,
      slots: [],
      note: 'No slots in that window. Suggest a later date range or another doctor.',
    };
  }
  const service = findService(context.kb, serviceId);
  return {
    ok: true,
    service_id: service?.id ?? serviceId,
    service_name: context.locale === 'en' ? service?.name_en : service?.name_ar,
    duration_min: service?.duration_min,
    slots: result.slots,
    instruction: 'Offer at most two or three of these. Use the label verbatim and keep starts_at for booking.',
  };
}

async function runBookAppointment(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const phoneRaw = String(input.patient_phone ?? '').trim();
  const name = String(input.patient_name ?? '').trim();
  if (!name) return { ok: false, error: 'missing_name', message: 'Ask the patient for their name first.' };
  if (!phoneRaw) return { ok: false, error: 'missing_phone', message: 'Ask the patient for their mobile number first.' };
  const phone = normalizePhone(phoneRaw);
  if (!/^\+\d{10,15}$/.test(phone)) {
    return { ok: false, error: 'invalid_phone', message: 'That does not look like a valid mobile number — ask again.' };
  }

  await patients.update(context.clinicId, context.patientId, { name, phone, locale: context.locale });

  const result = await bookAppointment({
    kb: context.kb,
    clinicId: context.clinicId,
    patientId: context.patientId,
    conversationId: context.conversationId,
    serviceId: String(input.service_id ?? ''),
    doctorId: input.doctor_id ? String(input.doctor_id) : undefined,
    startsAt: String(input.starts_at ?? ''),
    notes: input.notes ? String(input.notes).slice(0, 300) : null,
    locale: context.locale,
    source: 'agent',
    now: context.now,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.code,
      message: result.message,
      ...(result.code === 'slot_taken' ? { alternatives: result.alternatives } : {}),
    };
  }

  context.lastBookingReference = result.reference;
  return {
    ok: true,
    reference: result.reference,
    starts_at: result.appointment.starts_at,
    when: result.label,
    doctor: result.doctorName,
    service: result.serviceName,
    instruction: 'Confirm with this exact reference and this exact time. Do not restate any price.',
  };
}

async function runLookupAppointment(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const tz = context.kb.clinic.timezone;
  const reference = input.reference ? String(input.reference).trim().toUpperCase() : null;

  if (reference) {
    const found = await appointments.byReference(context.clinicId, reference);
    if (!found) return { ok: true, bookings: [], note: 'No booking with that reference.' };
    return { ok: true, bookings: [summariseAppointment(found, context)] };
  }

  let patientId = context.patientId;
  if (input.phone) {
    const match = await patients.byPhone(context.clinicId, String(input.phone));
    if (!match) return { ok: true, bookings: [], note: 'No patient found with that number.' };
    patientId = match.id;
  }
  const rows = await appointments.byPatient(context.clinicId, patientId, ['booked']);
  const upcoming = rows.filter((row) => Date.parse(row.starts_at) > context.now.getTime());
  return {
    ok: true,
    bookings: upcoming.map((row) => summariseAppointment(row, context)),
    today: zonedDateKey(context.now, tz),
  };
}

function summariseAppointment(row: { reference: string; service_id: string; doctor_id: string; starts_at: string; status: string }, context: ToolContext) {
  const service = context.kb.services.find((s) => s.id === row.service_id);
  const doctor = context.kb.doctors.find((d) => d.id === row.doctor_id);
  return {
    reference: row.reference,
    service: context.locale === 'en' ? service?.name_en : service?.name_ar,
    doctor: context.locale === 'en' ? doctor?.name_en : doctor?.name_ar,
    starts_at: row.starts_at,
    when: describeSlot(new Date(row.starts_at), context.kb.clinic.timezone, context.locale),
    status: row.status,
  };
}

async function runReschedule(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const result = await rescheduleAppointment({
    kb: context.kb,
    clinicId: context.clinicId,
    reference: String(input.reference ?? ''),
    newStartsAt: String(input.new_starts_at ?? ''),
    newDoctorId: input.doctor_id ? String(input.doctor_id) : undefined,
    locale: context.locale,
    actorType: 'agent',
    now: context.now,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: result.code,
      message: result.message,
      ...(result.code === 'slot_taken' ? { alternatives: result.alternatives } : {}),
    };
  }
  context.lastBookingReference = result.reference;
  return {
    ok: true,
    new_reference: result.reference,
    when: result.label,
    doctor: result.doctorName,
    service: result.serviceName,
    instruction: 'Tell the patient the NEW reference — the old one is no longer valid.',
  };
}

async function runCancel(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const result = await cancelAppointment({
    clinicId: context.clinicId,
    reference: String(input.reference ?? ''),
    reason: input.reason ? String(input.reason).slice(0, 200) : 'cancelled by patient',
    actorType: 'agent',
  });
  if (!result.ok) return { ok: false, error: result.code, message: result.message };
  return { ok: true, reference: result.appointment.reference, cancelled: true };
}

async function runEscalate(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const reason = String(input.reason ?? 'agent_requested') as EscalationReason;
  const detail = String(input.summary ?? '').slice(0, 400);
  context.escalated = { reason, detail };
  await escalations.open({
    clinicId: context.clinicId,
    conversationId: context.conversationId,
    reason,
    detail: detail || 'Agent requested human review',
  });
  return {
    ok: true,
    escalated: true,
    instruction:
      context.locale === 'en'
        ? 'Send one short warm holding message. Do not answer the medical or pricing question yourself.'
        : 'أرسلي رسالة دافئة قصيرة فقط. لا تجاوبين على السؤال الطبي أو السعري بنفسك.',
  };
}
