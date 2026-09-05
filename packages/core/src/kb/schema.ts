import { z } from 'zod';

/**
 * The clinic knowledge base schema.
 *
 * This file *is* the product's configuration surface. Onboarding a new clinic
 * means writing one YAML file that validates against this schema — no code
 * changes, no migrations, no redeploy of business logic.
 */

const clockRegex = /^([01]?\d|2[0-3]):[0-5]\d$/;
const clock = z.string().regex(clockRegex, 'expected HH:MM (24h)');
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** 0 = Sunday … 6 = Saturday. Saudi working week runs Sunday–Thursday. */
const weekday = z.number().int().min(0).max(6);

export const breakSchema = z.object({
  start: clock,
  end: clock,
  label_ar: z.string().optional(),
});

export const workingHoursSchema = z.object({
  days: z.array(weekday).min(1),
  open: clock,
  close: clock,
  breaks: z.array(breakSchema).default([]),
});

export const priceSchema = z.object({
  /** `fixed` quotes one number; `from` and `range` are the only other shapes the agent may quote. */
  type: z.enum(['fixed', 'from', 'range']).default('fixed'),
  amount: z.number().nonnegative(),
  max_amount: z.number().nonnegative().optional(),
  currency: z.literal('SAR').default('SAR'),
  /** e.g. "للجلسة الواحدة" / "per session". Shown verbatim with the price. */
  unit_ar: z.string().optional(),
  unit_en: z.string().optional(),
});

export const serviceSchema = z.object({
  id: z.string().min(1),
  name_ar: z.string().min(1),
  name_en: z.string().min(1),
  category_ar: z.string().optional(),
  description_ar: z.string().optional(),
  description_en: z.string().optional(),
  duration_min: z.number().int().positive(),
  /** Minutes of clean-up/turnaround reserved after the appointment. */
  buffer_min: z.number().int().nonnegative().default(0),
  price: priceSchema.nullable().default(null),
  doctor_ids: z.array(z.string()).min(1),
  bookable: z.boolean().default(true),
  /** True when the clinic requires an assessment visit before this service. */
  requires_consultation: z.boolean().default(false),
  aliases: z.array(z.string()).default([]),
});

export const doctorSchema = z.object({
  id: z.string().min(1),
  name_ar: z.string().min(1),
  name_en: z.string().min(1),
  title_ar: z.string().optional(),
  speciality_ar: z.string().min(1),
  speciality_en: z.string().optional(),
  gender: z.enum(['male', 'female']).optional(),
  languages: z.array(z.string()).default(['ar']),
  bio_ar: z.string().optional(),
  /** Overrides the clinic-wide hours for this doctor. */
  working_hours: z.array(workingHoursSchema).default([]),
  days_off: z.array(dateKey).default([]),
});

export const insurerSchema = z.object({
  name_ar: z.string().min(1),
  name_en: z.string().optional(),
  direct_billing: z.boolean().default(true),
  notes_ar: z.string().optional(),
});

export const instructionSchema = z.object({
  id: z.string().min(1),
  /** `["*"]` applies to every service. */
  service_ids: z.array(z.string()).default(['*']),
  title_ar: z.string().min(1),
  text_ar: z.string().min(1),
  text_en: z.string().optional(),
});

export const faqSchema = z.object({
  id: z.string().min(1),
  q_ar: z.string().min(1),
  a_ar: z.string().min(1),
  q_en: z.string().optional(),
  a_en: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export const knowledgeBaseSchema = z.object({
  version: z.literal(1),
  clinic: z.object({
    slug: z.string().regex(/^[a-z0-9-]+$/, 'slug must be lowercase kebab-case'),
    name_ar: z.string().min(1),
    name_en: z.string().min(1),
    tagline_ar: z.string().optional(),
    timezone: z.string().default('Asia/Riyadh'),
    /** Used by the metrics page: bookings × avg ticket = estimated captured revenue. */
    avg_ticket_sar: z.number().positive().default(900),
    retention_days: z.number().int().positive().default(730),
    address: z.object({
      ar: z.string().min(1),
      en: z.string().min(1),
      district_ar: z.string().optional(),
      city_ar: z.string().default('الرياض'),
      map_url: z.string().url(),
      landmark_ar: z.string().optional(),
      parking_ar: z.string().optional(),
    }),
    contact: z.object({
      phone: z.string().min(1),
      whatsapp: z.string().optional(),
      email: z.string().email().optional(),
      instagram: z.string().optional(),
      website: z.string().optional(),
    }),
    hours: z.array(workingHoursSchema).min(1),
    /** Clinic closures (Eid, national day, maintenance). No slots are offered. */
    holidays: z.array(dateKey).default([]),
    emergency: z.object({
      ambulance_number: z.string().default('997'),
      urgent_line: z.string().min(1),
      /** Nearest ER, quoted verbatim in the emergency directive. */
      nearest_er_ar: z.string().optional(),
    }),
  }),
  scheduling: z
    .object({
      slot_granularity_min: z.number().int().positive().default(15),
      min_notice_hours: z.number().nonnegative().default(2),
      max_advance_days: z.number().int().positive().default(60),
      max_slots_offered: z.number().int().positive().default(6),
    })
    .default({}),
  services: z.array(serviceSchema).min(1),
  doctors: z.array(doctorSchema).min(1),
  insurance: z.object({
    accepted: z.array(insurerSchema).default([]),
    not_accepted_ar: z.array(z.string()).default([]),
    notes_ar: z.string().optional(),
  }),
  instructions: z.object({
    pre: z.array(instructionSchema).default([]),
    post: z.array(instructionSchema).default([]),
  }),
  policies: z.object({
    cancellation_ar: z.string().min(1),
    late_ar: z.string().optional(),
    deposit_ar: z.string().optional(),
    no_show_ar: z.string().optional(),
    minors_ar: z.string().optional(),
  }),
  faqs: z.array(faqSchema).min(1),
  agent: z.object({
    persona_name_ar: z.string().min(1),
    persona_name_en: z.string().min(1),
    greeting_ar: z.string().min(1),
    greeting_en: z.string().min(1),
    /** Warm holding reply sent whenever the safety layer blocks a draft. */
    holding_reply_ar: z.string().min(1),
    holding_reply_en: z.string().min(1),
    /** Sent immediately on emergency language, before the agent is ever called. */
    emergency_reply_ar: z.string().min(1),
    emergency_reply_en: z.string().min(1),
    /** Extra clinic-specific voice notes appended to the system prompt. */
    style_notes_ar: z.array(z.string()).default([]),
  }),
});

export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type Doctor = z.infer<typeof doctorSchema>;
export type WorkingHours = z.infer<typeof workingHoursSchema>;
export type Faq = z.infer<typeof faqSchema>;
export type Price = z.infer<typeof priceSchema>;
export type Instruction = z.infer<typeof instructionSchema>;

export interface KbValidationIssue {
  path: string;
  message: string;
}

export interface KbValidationSuccess {
  ok: true;
  kb: KnowledgeBase;
}

export interface KbValidationFailure {
  ok: false;
  issues: KbValidationIssue[];
}

export type KbValidationResult = KbValidationSuccess | KbValidationFailure;

/**
 * Explicit type guard, for the same reason as `isBookingFailure`: callers get a
 * declared predicate rather than relying on the compiler inferring discriminated
 * narrowing across a package boundary.
 */
export function isKbValidationFailure(result: KbValidationResult): result is KbValidationFailure {
  return result.ok === false;
}

/**
 * Validates structure *and* the cross-references the schema cannot express:
 * a service pointing at an unknown doctor is the single most likely mistake
 * when a new clinic is onboarded, and it must fail loudly at load time rather
 * than produce an empty availability list at 2am.
 */
export function validateKnowledgeBase(input: unknown): KbValidationResult {
  const parsed = knowledgeBaseSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }
  const kb = parsed.data;
  const issues: KbValidationIssue[] = [];
  const doctorIds = new Set(kb.doctors.map((d) => d.id));

  for (const [i, service] of kb.services.entries()) {
    for (const doctorId of service.doctor_ids) {
      if (!doctorIds.has(doctorId)) {
        issues.push({ path: `services.${i}.doctor_ids`, message: `unknown doctor id "${doctorId}"` });
      }
    }
    if (service.price?.type === 'range' && service.price.max_amount === undefined) {
      issues.push({ path: `services.${i}.price`, message: 'price.type "range" requires max_amount' });
    }
    if (service.price?.max_amount !== undefined && service.price.max_amount < service.price.amount) {
      issues.push({ path: `services.${i}.price`, message: 'max_amount must be greater than or equal to amount' });
    }
  }

  const serviceIds = new Set(kb.services.map((s) => s.id));
  for (const group of ['pre', 'post'] as const) {
    for (const [i, instruction] of kb.instructions[group].entries()) {
      for (const serviceId of instruction.service_ids) {
        if (serviceId !== '*' && !serviceIds.has(serviceId)) {
          issues.push({ path: `instructions.${group}.${i}.service_ids`, message: `unknown service id "${serviceId}"` });
        }
      }
    }
  }

  for (const [i, window] of kb.clinic.hours.entries()) {
    if (toMinutes(window.close) <= toMinutes(window.open)) {
      issues.push({ path: `clinic.hours.${i}`, message: 'close must be after open' });
    }
    for (const [j, brk] of window.breaks.entries()) {
      if (toMinutes(brk.end) <= toMinutes(brk.start)) {
        issues.push({ path: `clinic.hours.${i}.breaks.${j}`, message: 'break end must be after start' });
      }
    }
  }

  const duplicateIds = findDuplicates([
    ...kb.services.map((s) => `service:${s.id}`),
    ...kb.doctors.map((d) => `doctor:${d.id}`),
    ...kb.faqs.map((f) => `faq:${f.id}`),
  ]);
  for (const duplicate of duplicateIds) {
    issues.push({ path: 'ids', message: `duplicate id "${duplicate}"` });
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: kb.clinic.timezone });
  } catch {
    issues.push({ path: 'clinic.timezone', message: `"${kb.clinic.timezone}" is not a valid IANA timezone` });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, kb };
}

function toMinutes(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dupes.add(value);
    seen.add(value);
  }
  return [...dupes];
}
