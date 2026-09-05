import { publishedPriceValues } from '../kb/loader.js';
import type { KnowledgeBase } from '../kb/schema.js';
import type { EscalationReason, Locale } from '../types.js';
import { normalizeForMatching, westerniseDigits } from './language.js';

/**
 * PRE-SEND SAFETY CHECK.
 *
 * Every outgoing message produced by the agent passes through `checkOutgoing`
 * before it reaches a channel. There is no code path that sends an agent draft
 * without it — see messaging/pipeline.ts. The system prompt asks the model to
 * behave; this function is what actually guarantees it.
 *
 * Four prohibitions, enforced here rather than in the prompt:
 *   1. no medical advice, diagnosis or symptom interpretation
 *   2. no price that is not in the clinic's published list
 *   3. no statement about whether a treatment suits this individual
 *   4. no promised outcome
 */

export type ViolationCode =
  | 'medical_advice'
  | 'unpublished_price'
  | 'treatment_suitability'
  | 'outcome_promise';

export interface Violation {
  code: ViolationCode;
  /** Rule label — safe to persist and show in the dashboard. */
  rule: string;
  /** Short evidence snippet, kept for the escalation queue so staff can judge. */
  evidence: string;
}

export interface PreSendResult {
  allowed: boolean;
  violations: Violation[];
  /** Present when `allowed` is false: the warm holding reply to send instead. */
  replacement?: string;
  escalationReason?: EscalationReason;
}

interface TextRule {
  code: ViolationCode;
  label: string;
  pattern: RegExp;
}

/**
 * Medical advice / diagnosis / symptom interpretation.
 * Matched against the *outgoing draft* after Arabic normalisation.
 */
const MEDICAL_ADVICE_RULES: TextRule[] = [
  { code: 'medical_advice', label: 'ar.diagnosis', pattern: /(هذا (يبدو|غالبا|على الاغلب|اكيد)|اللي عندك (هو|غالبا)|يبدو انك (تعاني|عندك)|الاعراض (هذي|اللي) تدل|تشخيص|هذا التهاب|هذا خراج|هذا تسوس|عندك التهاب|عندك خراج|السبب (هو|غالبا))/ },
  { code: 'medical_advice', label: 'ar.treatment_advice', pattern: /(انصحك (ت|بأن|بان)|نصيحتي (لك|انك)|لازم (تاخذ|تستخدم|تسوي) (دواء|مضاد|مسكن)|خذ (مضاد|مسكن|بنادول|حبوب)|استخدم (مرهم|دواء|مضاد)|تحتاج (علاج|مضاد حيوي|جراحه)|العلاج المناسب لك|الافضل لك ت)/ },
  { code: 'medical_advice', label: 'ar.reassurance', pattern: /(ما فيه شي|شي طبيعي ولا يحتاج|لا تخاف بيروح لحاله|ما يحتاج دكتور|بيطيب لحاله|عادي وبيختفي)/ },
  { code: 'medical_advice', label: 'ar.dosage', pattern: /(حبه كل|مرتين في اليوم|ثلاث مرات يوميا|جرعه|ملغم|ملغ)/ },
  { code: 'medical_advice', label: 'en.diagnosis', pattern: /\b(this (looks|sounds) like|you (probably )?have (an? )?(infection|abscess|cavity|inflammation)|the symptoms suggest|it'?s likely (an?|that)|diagnos)/ },
  { code: 'medical_advice', label: 'en.treatment_advice', pattern: /\b(i (would )?recommend (you )?(take|use|apply|start)|you should take|you need (an )?antibiotic|take (ibuprofen|paracetamol|panadol|painkillers)|apply .{0,20}(ointment|gel|cream) (to|on))/ },
  { code: 'medical_advice', label: 'en.reassurance', pattern: /\b(nothing to worry about|it'?s normal and will go away|no need to see a (doctor|dentist)|it will heal on its own)\b/ },
  { code: 'medical_advice', label: 'en.dosage', pattern: /\b(\d+\s?mg\b|twice a day|three times a day|once daily|dosage)/ },
];

/** Statements about whether a treatment suits this particular person. */
const SUITABILITY_RULES: TextRule[] = [
  { code: 'treatment_suitability', label: 'ar.suitable_for_you', pattern: /(مناسب لك|يناسبك|يصلح لك|ينفع لك|في حالتك|بحالتك|حالتك تحتاج|انت مرشح|انتي مرشحه|امن لك|ما يضرك|ما راح يضرك|تقدر تسويه بدون قلق|وضعك يسمح)/ },
  { code: 'treatment_suitability', label: 'ar.not_suitable', pattern: /(ما ينفع لك|ما يناسبك|ما يصلح لك|ممنوع عليك|لا تسوي)/ },
  { code: 'treatment_suitability', label: 'en.suitable_for_you', pattern: /\b(suitable for you|right for you|in your case|you'?re a (good )?candidate|safe for you|won'?t harm you|works for your (skin|teeth|condition))\b/ },
  { code: 'treatment_suitability', label: 'en.not_suitable', pattern: /\b(not suitable for you|you shouldn'?t (get|have|do)|you can'?t have this)\b/ },
];

/** Promised results. A clinic can describe a treatment; it cannot promise one. */
const OUTCOME_RULES: TextRule[] = [
  { code: 'outcome_promise', label: 'ar.guarantee', pattern: /(نضمن|مضمون|اضمن لك|ضمان النتيجه|النتيجه مضمونه|اكيد بتحصل|اكيد راح ي|بالتاكيد راح|١٠٠٪|100 ?٪|100 ?%|مئه بالمئه|نهائيا وما يرجع|للابد|تختفي تماما|يختفي نهائيا|بيروح نهائي)/ },
  { code: 'outcome_promise', label: 'ar.promise_verb', pattern: /(اوعدك|نعدك|بنخليك|راح تطلع مثل|بتصير مثل)/ },
  { code: 'outcome_promise', label: 'en.guarantee', pattern: /\b(we guarantee|guaranteed results?|100% (effective|success|safe)|permanent(ly)? (remove|removes|gone)|will definitely|you will (definitely )?(get|see)|risk[- ]free|no side effects)\b/ },
  { code: 'outcome_promise', label: 'en.promise_verb', pattern: /\b(i promise|we promise|you'?ll look like)\b/ },
];

const TEXT_RULES = [...MEDICAL_ADVICE_RULES, ...SUITABILITY_RULES, ...OUTCOME_RULES];

/**
 * Any figure the draft presents as money. Matches "1800 ريال", "١٨٠٠ ر.س",
 * "SAR 1,800", "1800 SR", "بـ 1800". Deliberately broad — a number the check
 * cannot classify is a number the agent should not have written.
 */
const PRICE_PATTERNS: RegExp[] = [
  /(\d[\d,،.]*)\s*(?:ريال|ريإل|ر\.?س|sar|sr|﷼)/gi,
  /(?:ريال|sar|sr|﷼)\s*(\d[\d,،.]*)/gi,
  /(?:سعر|بسعر|تكلفه|التكلفه|بكم|كلفه|قيمته|بمبلغ|السعر)\D{0,12}?(\d[\d,،.]*)/gi,
  /\b(?:costs?|price is|for)\s*(\d[\d,،.]{2,})\b/gi,
];

export interface PreSendContext {
  kb: KnowledgeBase;
  locale: Locale;
  /**
   * Numbers the draft is allowed to contain even though they are not prices —
   * e.g. a booking reference's digits, a confirmed appointment time, the
   * clinic's phone number. Supplied by the pipeline.
   */
  allowedNumbers?: number[];
}

export function checkOutgoing(draft: string, context: PreSendContext): PreSendResult {
  const violations: Violation[] = [];
  const haystack = normalizeForMatching(westerniseDigits(draft));

  for (const rule of TEXT_RULES) {
    const match = rule.pattern.exec(haystack);
    // Rules are non-global, but reset defensively in case one gains /g.
    rule.pattern.lastIndex = 0;
    if (match) {
      violations.push({ code: rule.code, rule: rule.label, evidence: snippet(haystack, match.index) });
    }
  }

  violations.push(...checkPrices(draft, context));

  if (violations.length === 0) return { allowed: true, violations: [] };

  // The first violation decides the escalation reason shown in the queue.
  const primary = violations[0]!;
  return {
    allowed: false,
    violations,
    replacement: context.locale === 'en' ? context.kb.agent.holding_reply_en : context.kb.agent.holding_reply_ar,
    escalationReason: primary.code as EscalationReason,
  };
}

/**
 * Price guard.
 *
 * Extracts every money-shaped figure from the draft and requires each one to
 * appear in the clinic's published price list (or in the caller's allow-list of
 * non-price numbers). An invented quote, a "total for 6 veneers", or a discount
 * the agent made up all fail here.
 */
function checkPrices(draft: string, context: PreSendContext): Violation[] {
  const allowed = new Set<number>([...publishedPriceSet(context.kb), ...(context.allowedNumbers ?? [])]);
  const normalised = westerniseDigits(draft);
  const violations: Violation[] = [];
  const seen = new Set<number>();

  for (const pattern of PRICE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalised)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      const value = Number(raw.replace(/[,،]/g, '').replace(/\.$/, ''));
      if (!Number.isFinite(value) || value <= 0) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (!allowed.has(value)) {
        violations.push({
          code: 'unpublished_price',
          rule: 'price.not_in_published_list',
          evidence: `quoted ${value} SAR, not in published price list`,
        });
      }
    }
  }
  return violations;
}

/**
 * Every monetary figure the clinic has actually published.
 *
 * That is the structured price list *plus* any figure the clinic wrote into
 * its own policy text, FAQ answers or instructions (late fees, deposits,
 * no-show charges). Those are published too — the rule is "the agent may only
 * repeat numbers the clinic authored", not "only service prices".
 */
const priceSetCache = new WeakMap<KnowledgeBase, Set<number>>();

export function publishedPriceSet(kb: KnowledgeBase): Set<number> {
  const cached = priceSetCache.get(kb);
  if (cached) return cached;

  const values = new Set<number>(publishedPriceValues(kb));
  const authored: string[] = [
    ...Object.values(kb.policies).filter((v): v is string => typeof v === 'string'),
    ...kb.faqs.flatMap((faq) => [faq.a_ar, faq.a_en ?? '']),
    ...kb.instructions.pre.map((i) => i.text_ar),
    ...kb.instructions.post.map((i) => i.text_ar),
    ...kb.insurance.accepted.map((i) => i.notes_ar ?? ''),
    kb.insurance.notes_ar ?? '',
  ];
  for (const value of extractMoneyFigures(authored.join('\n'))) values.add(value);

  priceSetCache.set(kb, values);
  return values;
}

/** Pulls every money-shaped figure out of a block of text. */
export function extractMoneyFigures(text: string): number[] {
  const normalised = westerniseDigits(text);
  const out = new Set<number>();
  for (const pattern of PRICE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalised)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      const value = Number(raw.replace(/[,،]/g, '').replace(/\.$/, ''));
      if (Number.isFinite(value) && value > 0) out.add(value);
    }
  }
  return [...out];
}

function snippet(text: string, index: number): string {
  const start = Math.max(0, index - 25);
  return text.slice(start, Math.min(text.length, index + 55)).trim();
}

/**
 * Second gate for tool *arguments*: the agent must not be able to write a
 * clinical note into an appointment record either.
 */
export function checkToolFreeText(value: string, context: PreSendContext): PreSendResult {
  return checkOutgoing(value, { ...context, allowedNumbers: [...(context.allowedNumbers ?? [])] });
}

/**
 * The emergency directive. Never model-generated — read straight from the KB.
 *
 * `{{ambulance}}`, `{{urgent_line}}` and `{{nearest_er}}` are substituted from
 * the structured clinic fields, so the numbers a patient is told to call can
 * never drift away from the numbers the clinic configured.
 */
export function emergencyDirective(kb: KnowledgeBase, locale: Locale): string {
  const emergency = kb.clinic.emergency;
  const base = locale === 'en' ? kb.agent.emergency_reply_en : kb.agent.emergency_reply_ar;
  const filled = base
    .replaceAll('{{ambulance}}', emergency.ambulance_number)
    .replaceAll('{{urgent_line}}', emergency.urgent_line)
    .replaceAll('{{nearest_er}}', emergency.nearest_er_ar ?? '');
  const parts = [filled];
  if (!base.includes('{{urgent_line}}')) {
    parts.push(
      locale === 'en'
        ? `Ambulance: ${emergency.ambulance_number} · Clinic urgent line: ${emergency.urgent_line}`
        : `الإسعاف: ${emergency.ambulance_number} · خط العيادة المستعجل: ${emergency.urgent_line}`,
    );
  }
  if (locale === 'ar' && emergency.nearest_er_ar && !base.includes('{{nearest_er}}')) {
    parts.push(emergency.nearest_er_ar);
  }
  return parts.filter(Boolean).join('\n');
}

export function holdingReply(kb: KnowledgeBase, locale: Locale): string {
  return locale === 'en' ? kb.agent.holding_reply_en : kb.agent.holding_reply_ar;
}
