import type { EscalationReason } from '../types.js';
import { normalizeForMatching, westerniseDigits } from './language.js';

/**
 * Inbound tripwires.
 *
 * These run on every *incoming* patient message, BEFORE the model is called.
 * They are deliberately keyword-based and deliberately over-trigger: a false
 * positive costs a human a glance at the escalation queue, a false negative
 * costs a patient who needed an ambulance.
 */

export type TripwireSeverity = 'emergency' | 'clinical';

export interface TripwireHit {
  severity: TripwireSeverity;
  reason: EscalationReason;
  /** The pattern label, not the patient's words — safe to log and store. */
  matched: string;
}

interface Rule {
  label: string;
  severity: TripwireSeverity;
  pattern: RegExp;
}

/**
 * EMERGENCY — the agent is bypassed entirely. The patient gets the clinic's
 * emergency directive (ambulance number + urgent line) and a human is paged.
 */
const EMERGENCY_RULES: Rule[] = [
  // Arabic — normalised (hamza/ya/ta-marbuta folded) before matching.
  { label: 'ar.severe_pain', severity: 'emergency', pattern: /(الم|وجع|ياوجع|يوجعني)\s*(شديد|فظيع|لا يطاق|ما اقدر اتحمل|قاتل|مو طبيعي)/ },
  { label: 'ar.unbearable', severity: 'emergency', pattern: /(ما اقدر اتحمل|مااقدر اتحمل|ما احتمل|الالم قاتلني|اموت من الالم|ابي اموت من الوجع)/ },
  { label: 'ar.emergency_word', severity: 'emergency', pattern: /(طوار[يئ]|اسعاف|حاله طارئه|حاله خطره|انقذوني|النجده)/ },
  { label: 'ar.bleeding', severity: 'emergency', pattern: /(نزيف|ينزف|دم ما يوقف|الدم ما يوقف|نزف)/ },
  { label: 'ar.chest', severity: 'emergency', pattern: /(الم في الصدر|وجع بصدري|وجع في صدري|ضيق تنفس|ما اقدر اتنفس|صعوبه في التنفس|اختناق)/ },
  { label: 'ar.swelling_face', severity: 'emergency', pattern: /(تورم في الوجه|وجهي منتفخ|انتفاخ شديد|تورم تحت العين|الورم كبر)/ },
  { label: 'ar.fainting', severity: 'emergency', pattern: /(اغماء|غبت عن الوعي|دوخه شديده|اطيح)/ },
  { label: 'ar.allergic', severity: 'emergency', pattern: /(حساسيه شديده|حلقي منتفخ|لساني منتفخ|طفح مع تورم)/ },
  { label: 'ar.high_fever', severity: 'emergency', pattern: /(حراره عاليه|حرارتي\s*(٤٠|40|٣٩|39)|سخونه شديده)/ },
  // English
  { label: 'en.chest_pain', severity: 'emergency', pattern: /\b(chest pain|pain in my chest|can'?t breathe|cannot breathe|shortness of breath|difficulty breathing)\b/ },
  { label: 'en.bleeding', severity: 'emergency', pattern: /\b(bleeding|blood won'?t stop|haemorrhage|hemorrhage)\b/ },
  { label: 'en.severe_pain', severity: 'emergency', pattern: /\b(severe pain|unbearable pain|excruciating|worst pain|agony)\b/ },
  { label: 'en.emergency_word', severity: 'emergency', pattern: /\b(emergency|ambulance|urgent care|911|997)\b/ },
  { label: 'en.swelling', severity: 'emergency', pattern: /\b(face is swollen|severe swelling|swollen shut|throat swelling)\b/ },
  { label: 'en.fainting', severity: 'emergency', pattern: /\b(fainted|passing out|lost consciousness|dizzy and)\b/ },
];

/**
 * CLINICAL — the patient is describing symptoms or asking for an opinion.
 * The agent still replies (it can book them in), but it is put on notice by the
 * system prompt and the outgoing draft is checked hard. The conversation is
 * flagged for human review either way.
 */
const CLINICAL_RULES: Rule[] = [
  { label: 'ar.symptom_generic', severity: 'clinical', pattern: /(عندي الم|يوجعني|اشعر بالم|فيه وجع|يعورني|احس بوجع|صاير عندي|طلع لي|ظهر لي)/ },
  { label: 'ar.symptom_named', severity: 'clinical', pattern: /(تورم|انتفاخ|صديد|خراج|حبوب|طفح|حكه|احمرار|تقرح|التهاب|حساسيه|كسر|تسوس|نزول الشعر|تساقط الشعر)/ },
  { label: 'ar.diagnosis_request', severity: 'clinical', pattern: /(وش عندي|ايش عندي|وش السبب|ليش صار كذا|شخص لي|هل هذا طبيعي|هل انا محتاج|هل احتاج|وش تنصحني|وش رايك بحالتي|وش العلاج المناسب)/ },
  { label: 'ar.suitability', severity: 'clinical', pattern: /(مناسب لي|ينفع لي|يصلح لي|اقدر اسوي|هل يضرني|يأثر علي|امن لي|احسن شي لي)/ },
  { label: 'ar.medication', severity: 'clinical', pattern: /(اخذ مضاد|مضاد حيوي|اي دواء اخذ|وش الدواء|مسكن|بنادول|جرعه)/ },
  { label: 'ar.pregnancy', severity: 'clinical', pattern: /(حامل|مرضع|حمل|رضاعه)/ },
  { label: 'ar.chronic', severity: 'clinical', pattern: /(سكري|ضغط|قلب|سيوله|كيماوي|مناعه|كورتيزون)/ },
  { label: 'en.symptom', severity: 'clinical', pattern: /\b(i have pain|it hurts|swelling|abscess|infection|rash|itching|bleeding gums|sensitive tooth|broken tooth|hair loss)\b/ },
  { label: 'en.diagnosis_request', severity: 'clinical', pattern: /\b(what do i have|what is wrong with|why is this|is this normal|do i need|should i get|what do you recommend|diagnose)\b/ },
  { label: 'en.suitability', severity: 'clinical', pattern: /\b(is it safe for me|suitable for me|can i do|would it work for me|is it right for me|will it harm)\b/ },
  { label: 'en.medication', severity: 'clinical', pattern: /\b(antibiotic|what medication|painkiller|dosage|prescribe)\b/ },
  { label: 'en.pregnancy', severity: 'clinical', pattern: /\b(pregnant|breastfeeding|nursing)\b/ },
  { label: 'en.chronic', severity: 'clinical', pattern: /\b(diabetic|diabetes|blood thinner|heart condition|immune|chemotherapy)\b/ },
];

const ALL_RULES = [...EMERGENCY_RULES, ...CLINICAL_RULES];

export interface TripwireResult {
  /** True when the agent must be bypassed and the emergency directive sent. */
  emergency: boolean;
  /** True when the patient described symptoms or asked for clinical judgement. */
  clinical: boolean;
  hits: TripwireHit[];
}

export function scanInbound(text: string): TripwireResult {
  const haystack = normalizeForMatching(westerniseDigits(text));
  const hits: TripwireHit[] = [];
  for (const rule of ALL_RULES) {
    if (rule.pattern.test(haystack)) {
      hits.push({
        severity: rule.severity,
        reason: rule.severity === 'emergency' ? 'emergency_language' : 'symptom_description',
        matched: rule.label,
      });
    }
  }
  return {
    emergency: hits.some((h) => h.severity === 'emergency'),
    clinical: hits.some((h) => h.severity === 'clinical'),
    hits,
  };
}

/** Exposed so the dashboard can show operators exactly what the tripwires cover. */
export function tripwireRuleLabels(): { emergency: string[]; clinical: string[] } {
  return {
    emergency: EMERGENCY_RULES.map((r) => r.label),
    clinical: CLINICAL_RULES.map((r) => r.label),
  };
}
