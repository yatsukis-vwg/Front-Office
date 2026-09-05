#!/usr/bin/env tsx
/**
 * Seed script — makes the demo look alive on open.
 *
 *   npm run seed                # reset and seed the demo clinic
 *   npm run seed -- --keep      # add seed data without wiping first
 *   npm run seed -- --clinic X  # seed a different clinic slug
 *
 * Produces ~57 conversations of natural Saudi Arabic traffic across Telegram
 * and the web widget, spread over the last 30 days, plus ~30 appointments in
 * the past and future, escalations, human takeovers, reminders and audit
 * entries. Booking timestamps are deliberately weighted towards evenings and
 * late nights so the headline metric — bookings captured outside working
 * hours — reflects the real pattern the product is sold on.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  FileStore,
  getConfig,
  getStore,
  isWithinWorkingHours,
  loadKnowledgeBaseFile,
  newBookingReference,
  newId,
  setStore,
  type Appointment,
  type ChannelId,
  type Clinic,
  type Conversation,
  type EscalationReason,
  type KnowledgeBase,
  type Locale,
} from '../packages/core/src/index.js';
import { appointments, audit, clinics, conversations, escalations, messages, patients, reminders } from '../packages/core/src/db/repos.js';
import { CONVERSATION_SCRIPTS, type ConversationScript, type Turn } from './seed-data/conversations.ts';

const args = process.argv.slice(2);
const keepExisting = args.includes('--keep');
const slugArg = args.indexOf('--clinic');
const SLUG = slugArg >= 0 ? args[slugArg + 1]! : getConfig().defaultClinicSlug;

/** Deterministic PRNG so every demo run produces the same, well-shaped data. */
let seed = 0x5eed1234;
function random(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}
function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)]!;
}
function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

const NOW = new Date();

async function main(): Promise<void> {
  const config = getConfig();
  if (config.storeDriver === 'file' && !keepExisting) {
    const path = resolve(config.fileStorePath);
    if (existsSync(path)) rmSync(path);
    mkdirSync(dirname(path), { recursive: true });
    setStore(new FileStore(path));
  }

  const kb = loadKnowledgeBaseFile(SLUG);
  const clinic = await ensureClinic(kb);
  console.log(`Seeding ${kb.clinic.name_en} (${clinic.id})`);

  const stats = { conversations: 0, messages: 0, appointments: 0, escalations: 0, outsideHours: 0, reminders: 0 };

  // Conversations are laid down oldest-first across the last 30 days.
  const ordered = [...CONVERSATION_SCRIPTS];
  for (const [index, script] of ordered.entries()) {
    const startedAt = conversationStartTime(index, ordered.length, script);
    const result = await seedConversation(clinic, kb, script, startedAt);
    stats.conversations++;
    stats.messages += result.messages;
    if (result.appointment) {
      stats.appointments++;
      if (result.appointment.created_outside_hours) stats.outsideHours++;
      stats.reminders += result.reminders;
    }
    if (result.escalations) stats.escalations += result.escalations;
  }

  // Top up to ~30 appointments with phone/walk-in bookings entered by staff and
  // a set of completed visits in the past, so the calendar is not empty behind.
  const extra = await seedStandaloneAppointments(clinic, kb, 30 - stats.appointments);
  stats.appointments += extra.created;
  stats.outsideHours += extra.outsideHours;

  await getStore().withLock('seed:flush', async () => undefined);
  if (getStore() instanceof FileStore) (getStore() as FileStore).flushSync();

  console.log(`
  Clinic:                 ${kb.clinic.name_ar}
  Conversations:          ${stats.conversations}
  Messages:               ${stats.messages}
  Appointments:           ${stats.appointments}
  ↳ booked outside hours: ${stats.outsideHours} (${Math.round((stats.outsideHours / Math.max(1, stats.appointments)) * 100)}%)
  Escalations:            ${stats.escalations}
  Reminders queued:       ${stats.reminders}

  Store: ${getConfig().storeDriver === 'file' ? resolve(getConfig().fileStorePath) : 'supabase'}
  Next:  npm run dev   then open http://localhost:8080/widget/demo.html
`);
}

async function ensureClinic(kb: KnowledgeBase): Promise<Clinic> {
  const existing = await clinics.bySlug(kb.clinic.slug);
  if (existing) return existing;
  return clinics.create({
    slug: kb.clinic.slug,
    name: kb.clinic.name_en,
    timezone: kb.clinic.timezone,
    avg_ticket_sar: kb.clinic.avg_ticket_sar,
    retention_days: kb.clinic.retention_days,
    settings: {
      telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN,
      telegram_webhook_secret: process.env.TELEGRAM_WEBHOOK_SECRET,
    },
  });
}

/**
 * Spreads conversations across the last 30 days.
 *
 * Hour-of-day is weighted so that roughly 45% of traffic lands outside the
 * clinic's opening hours — which is what makes the headline metric meaningful
 * rather than a rounding error.
 */
function conversationStartTime(index: number, total: number, script: ConversationScript): Date {
  const daysAgo = Math.round((1 - index / total) * 29) + (random() < 0.3 ? 0 : 0);
  const base = new Date(NOW.getTime() - daysAgo * 86400_000);

  // 55% during opening hours, 45% after close / during the afternoon break.
  const inHours = random() < 0.55;
  const hour = inHours ? pick([9, 10, 11, 12, 16, 17, 18, 19, 20]) : pick([1, 2, 7, 14, 15, 21, 22, 23, 23, 0]);
  const minute = randomInt(0, 59);

  // Rebuild the instant from the clinic's local wall clock (UTC+3).
  const local = new Date(base.getTime() + 3 * 3600_000);
  const utc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, randomInt(0, 59)) - 3 * 3600_000;
  const candidate = new Date(utc);
  // Emergencies read best as recent; keep them inside the last week.
  if (script.kind === 'emergency' && candidate.getTime() < NOW.getTime() - 7 * 86400_000) {
    return new Date(NOW.getTime() - randomInt(1, 6) * 86400_000 - randomInt(0, 20) * 3600_000);
  }
  return candidate.getTime() > NOW.getTime() ? new Date(NOW.getTime() - 3600_000) : candidate;
}

interface SeedConversationResult {
  messages: number;
  appointment: Appointment | null;
  escalations: number;
  reminders: number;
}

async function seedConversation(
  clinic: Clinic,
  kb: KnowledgeBase,
  script: ConversationScript,
  startedAt: Date,
): Promise<SeedConversationResult> {
  const locale: Locale = script.locale ?? 'ar';
  const channel: ChannelId = random() < 0.62 ? 'telegram' : 'webchat';
  const identity = extractIdentity(script);

  const displayName = identity.name ?? (channel === 'telegram' ? pick(TELEGRAM_DISPLAY_NAMES) : null);
  const existing = identity.phone ? await patients.byPhone(clinic.id, identity.phone) : null;
  const patient = existing ?? (await patients.create(clinic.id, { name: displayName, phone: identity.phone, locale }));

  const conversation = await conversations.create({
    clinicId: clinic.id,
    patientId: patient.id,
    channel,
    channelThreadId: channel === 'telegram' ? String(randomInt(100000000, 999999999)) : `web_${newId()}`,
  });

  // Booking first, so its reference can be substituted into the transcript.
  let appointment: Appointment | null = null;
  let remindersQueued = 0;
  if (script.booking) {
    appointment = await createAppointment(clinic, kb, {
      patientId: patient.id,
      conversationId: conversation.id,
      serviceId: script.booking.serviceId,
      doctorId: script.booking.doctorId,
      dayOffset: script.booking.dayOffset,
      hour: script.booking.hour,
      minute: script.booking.minute ?? 0,
      createdAt: startedAt,
      source: 'agent',
    });
    remindersQueued = await queueReminders(clinic, appointment);
  }

  let cursor = startedAt.getTime();
  let count = 0;
  let lastInboundAt: number | null = null;

  for (const turn of script.turns) {
    const isPatient = turn.from === 'patient';
    // Patients take 20–90s to reply; the agent answers in 1.5–6s; staff in minutes.
    const gap = isPatient ? randomInt(20, 90) * 1000 : turn.from === 'staff' ? randomInt(120, 900) * 1000 : randomInt(1500, 6000);
    cursor += gap;

    const body = renderTurn(turn, appointment);
    const responseMs = !isPatient && lastInboundAt !== null ? cursor - lastInboundAt : null;

    await messages.append({
      clinicId: clinic.id,
      conversationId: conversation.id,
      direction: isPatient ? 'inbound' : 'outbound',
      author: turn.from,
      body,
      responseMs: turn.from === 'staff' ? null : responseMs,
      flagged: turn.from === 'system' ? (turn.flagged ?? true) : false,
      meta: { channel, seeded: true },
      createdAt: new Date(cursor).toISOString(),
    });
    count++;
    if (isPatient) lastInboundAt = cursor;
  }

  let escalationCount = 0;
  if (script.escalation) {
    await escalations.open({
      clinicId: clinic.id,
      conversationId: conversation.id,
      reason: script.escalation.reason as EscalationReason,
      detail: script.escalation.detail,
      createdAt: new Date(startedAt.getTime() + 60_000).toISOString(),
    });
    escalationCount = 1;
    // Leave roughly a third of escalations open so the queue has live work.
    if (random() < 0.65) {
      const open = await escalations.forConversation(clinic.id, conversation.id);
      for (const row of open) await escalations.resolve(clinic.id, row.id, pick(['hind', 'ahmed', 'sara']));
    }
  }

  const patch: Partial<Conversation> = { last_message_at: new Date(cursor).toISOString() };
  if (script.humanTakeover) {
    patch.owner = 'human';
    patch.taken_over_by = pick(['hind', 'ahmed', 'sara']);
    patch.taken_over_at = new Date(cursor - 300_000).toISOString();
  }
  if (script.kind !== 'escalation' && script.kind !== 'emergency' && random() < 0.4) {
    patch.status = 'closed';
    patch.closed_at = new Date(cursor + 3600_000).toISOString();
  }
  await conversations.update(clinic.id, conversation.id, patch);

  await audit.record({
    clinicId: clinic.id,
    actorType: 'patient',
    actorId: patient.id,
    action: 'conversation.open',
    entity: 'conversation',
    entityId: conversation.id,
    meta: { channel, seeded: true },
    createdAt: startedAt.toISOString(),
  });

  return { messages: count, appointment, escalations: escalationCount, reminders: remindersQueued };
}

/**
 * Writes an appointment directly rather than going through the booking service:
 * the seeder needs to place appointments in the past and at specific times,
 * which the booking policy (minimum notice, availability) rightly refuses.
 */
async function createAppointment(
  clinic: Clinic,
  kb: KnowledgeBase,
  input: {
    patientId: string;
    conversationId: string | null;
    serviceId: string;
    doctorId: string;
    dayOffset: number;
    hour: number;
    minute: number;
    createdAt: Date;
    source: Appointment['source'];
    status?: Appointment['status'];
  },
): Promise<Appointment> {
  const service = kb.services.find((s) => s.id === input.serviceId)!;
  const day = new Date(NOW.getTime() + input.dayOffset * 86400_000);
  const local = new Date(day.getTime() + 3 * 3600_000);
  const startsAtMs =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), input.hour, input.minute, 0) - 3 * 3600_000;
  const startsAt = new Date(startsAtMs);
  const endsAt = new Date(startsAtMs + service.duration_min * 60_000);

  const status: Appointment['status'] = input.status ?? (startsAt.getTime() < NOW.getTime() ? 'completed' : 'booked');

  return appointments.insert({
    id: newId(),
    clinic_id: clinic.id,
    reference: newBookingReference(),
    patient_id: input.patientId,
    conversation_id: input.conversationId,
    service_id: service.id,
    doctor_id: input.doctorId,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    status,
    source: input.source,
    notes_enc: null,
    created_outside_hours: !isWithinWorkingHours(kb, input.createdAt),
    created_at: input.createdAt.toISOString(),
    cancelled_at: null,
    cancel_reason: null,
  });
}

async function queueReminders(clinic: Clinic, appointment: Appointment): Promise<number> {
  if (appointment.status !== 'booked') return 0;
  const startsAt = Date.parse(appointment.starts_at);
  let queued = 0;
  for (const [kind, at] of [
    ['reminder_24h', startsAt - 24 * 3600_000],
    ['reminder_2h', startsAt - 2 * 3600_000],
  ] as const) {
    if (at <= NOW.getTime()) continue;
    await reminders.schedule({
      clinicId: clinic.id,
      appointmentId: appointment.id,
      kind,
      sendAt: new Date(at).toISOString(),
    });
    queued++;
  }
  return queued;
}

/** Phone bookings and past visits that never had a chat thread. */
async function seedStandaloneAppointments(
  clinic: Clinic,
  kb: KnowledgeBase,
  target: number,
): Promise<{ created: number; outsideHours: number }> {
  if (target <= 0) return { created: 0, outsideHours: 0 };

  const walkIns = [
    { name: 'خالد الشهري', phone: '0551110001' },
    { name: 'أمل الحربي', phone: '0551110002' },
    { name: 'يوسف الغامدي', phone: '0551110003' },
    { name: 'شهد المطيري', phone: '0551110004' },
    { name: 'إبراهيم القحطاني', phone: '0551110005' },
    { name: 'لطيفة العتيبي', phone: '0551110006' },
    { name: 'راكان الدوسري', phone: '0551110007' },
    { name: 'جواهر السبيعي', phone: '0551110008' },
    { name: 'مشعل النفيعي', phone: '0551110009' },
    { name: 'رهف الزهراني', phone: '0551110010' },
    { name: 'سعود بن ناصر', phone: '0551110011' },
    { name: 'نورة الشمري', phone: '0551110012' },
  ];

  let created = 0;
  let outsideHours = 0;

  for (let i = 0; i < target; i++) {
    const person = walkIns[i % walkIns.length]!;
    const existing = await patients.byPhone(clinic.id, person.phone);
    const patient = existing ?? (await patients.create(clinic.id, { name: person.name, phone: person.phone, locale: 'ar' }));

    const service = pick(kb.services.filter((s) => s.bookable));
    const doctorId = pick(service.doctor_ids);
    // Half in the past (completed history), half ahead (a full calendar).
    const dayOffset = i % 2 === 0 ? -randomInt(1, 25) : randomInt(1, 21);
    const hour = pick([9, 10, 11, 12, 16, 17, 18, 19, 20]);
    // Staff entries are made during opening hours; agent entries can be any time.
    const source: Appointment['source'] = i % 3 === 0 ? 'staff' : 'agent';
    const createdAt =
      source === 'staff'
        ? offsetLocalTime(dayOffset - randomInt(1, 4), pick([10, 11, 12, 17, 18]))
        : offsetLocalTime(dayOffset - randomInt(1, 5), pick([0, 1, 2, 14, 15, 22, 23]));

    const status: Appointment['status'] =
      dayOffset < 0 ? (random() < 0.12 ? 'no_show' : 'completed') : random() < 0.08 ? 'cancelled' : 'booked';

    const appointment = await createAppointment(clinic, kb, {
      patientId: patient.id,
      conversationId: null,
      serviceId: service.id,
      doctorId,
      dayOffset,
      hour,
      minute: pick([0, 15, 30, 45]),
      createdAt: createdAt > NOW ? new Date(NOW.getTime() - 3600_000) : createdAt,
      source,
      status,
    });
    if (status === 'cancelled') {
      await appointments.update(clinic.id, appointment.id, {
        cancelled_at: new Date(Date.parse(appointment.created_at) + 86400_000).toISOString(),
        cancel_reason: pick(['patient travelling', 'schedule conflict', 'cancelled by patient']),
      });
    }
    await queueReminders(clinic, appointment);
    await audit.record({
      clinicId: clinic.id,
      actorType: source === 'staff' ? 'staff' : 'agent',
      actorId: source === 'staff' ? pick(['hind', 'ahmed']) : null,
      action: 'appointment.create',
      entity: 'appointment',
      entityId: appointment.id,
      meta: { service_id: service.id, doctor_id: doctorId, outside_hours: appointment.created_outside_hours, source },
      createdAt: appointment.created_at,
    });
    created++;
    if (appointment.created_outside_hours) outsideHours++;
  }
  return { created, outsideHours };
}

function offsetLocalTime(dayOffset: number, hour: number): Date {
  const day = new Date(NOW.getTime() + dayOffset * 86400_000);
  const local = new Date(day.getTime() + 3 * 3600_000);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, randomInt(0, 59), 0) - 3 * 3600_000,
  );
}

/** Pulls the patient's name and mobile out of what they typed in the script. */
function extractIdentity(script: ConversationScript): { name: string | null; phone: string | null } {
  let name: string | null = null;
  let phone: string | null = null;

  for (const turn of script.turns) {
    if (turn.from !== 'patient') continue;
    const westernised = turn.text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    const phoneMatch = /\b0?5\d{8}\b/.exec(westernised);
    if (phoneMatch && !phone) phone = phoneMatch[0].startsWith('0') ? phoneMatch[0] : `0${phoneMatch[0]}`;
    if (name || !phoneMatch) continue;

    // The name is given in the same turn as the number, often after a short
    // acknowledgement ("ايه تمام. فهد المطيري 05...", "Yes. Omar Bakr, 05...").
    const withoutPhone = turn.text.replace(/[٠-٩0-9\s+-]{9,}/g, ' ');
    for (const segment of withoutPhone.split(/[.،,\n]/).map((part) => part.trim()).reverse()) {
      if (!/^[\p{Script=Arabic}\p{Script=Latin}\s.]{5,40}$/u.test(segment)) continue;
      const words = segment.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 4) continue;
      if (ACKNOWLEDGEMENTS.has(words[0]!.toLowerCase())) continue;
      name = segment;
      break;
    }
  }

  return { name, phone };
}

/** Words that start an acknowledgement, never a name. */
const ACKNOWLEDGEMENTS = new Set([
  'ايه', 'إيه', 'اي', 'ايوه', 'تمام', 'اوك', 'زين', 'ممتاز', 'طيب', 'اكيد', 'أكيد', 'خلاص', 'حلو',
  'yes', 'ok', 'okay', 'sure', 'perfect', 'great', 'yeah', 'my', 'the',
]);

/**
 * Telegram hands us the sender's profile name even when they never type it, so
 * a thread that ends without a booking still shows a name in the console.
 */
const TELEGRAM_DISPLAY_NAMES = [
  'أبو محمد', 'سارة ع.', 'Faisal A.', 'أم تركي', 'نايف الحربي', 'رغد', 'Mohammed S.', 'هيفاء',
  'أبو خالد', 'ريما', 'Abdulrahman', 'لمى الشهري', 'سلمان', 'وضحى', 'Noura K.', 'بدر',
];

function renderTurn(turn: Turn, appointment: Appointment | null): string {
  return turn.text.replace('{{ref}}', appointment?.reference ?? newBookingReference());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
