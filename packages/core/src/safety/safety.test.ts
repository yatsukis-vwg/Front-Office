import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadKnowledgeBaseFile } from '../kb/loader.js';
import { detectLocale } from './language.js';
import { checkOutgoing, emergencyDirective, publishedPriceSet } from './presend.js';
import { scanInbound } from './tripwires.js';

const kb = loadKnowledgeBaseFile('noor-riyadh', 'clinics');
const ar = { kb, locale: 'ar' as const };
const en = { kb, locale: 'en' as const };

// ------------------------------------------------------------- tripwires

test('emergency language in Arabic trips the emergency wire', () => {
  for (const text of [
    'الحين عندي ألم شديد ما أقدر أتحمله',
    'فيه نزيف من اللثة ما يوقف',
    'حالة طوارئ ساعدوني',
    'وجهي منتفخ وتورم شديد تحت العين',
  ]) {
    const result = scanInbound(text);
    assert.equal(result.emergency, true, `expected emergency for: ${text}`);
  }
});

test('emergency language in English trips the emergency wire', () => {
  for (const text of ['I have chest pain', "I can't breathe properly", 'severe pain in my jaw', 'there is bleeding that will not stop']) {
    assert.equal(scanInbound(text).emergency, true, `expected emergency for: ${text}`);
  }
});

test('symptom descriptions trip the clinical wire but not the emergency wire', () => {
  const result = scanInbound('عندي ألم بسيط في ضرس العقل وفيه تورم بسيط');
  assert.equal(result.clinical, true);
  assert.equal(result.emergency, false);
});

test('a plain booking request trips nothing', () => {
  for (const text of ['أبي أحجز موعد تنظيف أسنان بكرة', 'وش دوامكم يوم السبت؟', 'كم سعر التبييض؟', 'I want to book a cleaning']) {
    const result = scanInbound(text);
    assert.equal(result.emergency, false, `false emergency for: ${text}`);
    assert.equal(result.clinical, false, `false clinical for: ${text}`);
  }
});

// -------------------------------------------------------- pre-send guard

test('a normal booking confirmation passes the pre-send check', () => {
  const draft = 'تمام! حجزت لك موعد تنظيف أسنان الثلاثاء الساعة ٥ العصر مع د. ريم. رقم حجزك NR-7QK4M2 🌿';
  const result = checkOutgoing(draft, ar);
  assert.equal(result.allowed, true, JSON.stringify(result.violations));
});

test('published prices are allowed', () => {
  assert.equal(checkOutgoing('تبييض الأسنان بالليزر ١٨٠٠ ريال، والتنظيف ٣٥٠ ريال.', ar).allowed, true);
  assert.equal(checkOutgoing('Zoom whitening is SAR 1800 and cleaning is SAR 350.', en).allowed, true);
});

test('policy fees written in the knowledge base are treated as published', () => {
  assert.equal(checkOutgoing('لو ألغيت قبل الموعد بأقل من ٤ ساعات يُحتسب ١٠٠ ريال على الموعد الجاي.', ar).allowed, true);
  assert.equal(checkOutgoing('العربون ٥٠٠ ريال ويُخصم من قيمة العلاج.', ar).allowed, true);
});

test('an invented price is blocked and escalated', () => {
  const result = checkOutgoing('أقدر أسوي لك التبييض بـ ١٢٥٠ ريال بس لأنك عميلة قديمة.', ar);
  assert.equal(result.allowed, false);
  assert.equal(result.escalationReason, 'unpublished_price');
  assert.ok(result.replacement && result.replacement.length > 0);
});

test('a made-up total for multiple units is blocked', () => {
  const result = checkOutgoing('ست عدسات فينير تطلع لك 13200 ريال.', ar);
  assert.equal(result.allowed, false);
  assert.equal(result.violations[0]?.code, 'unpublished_price');
});

test('medical advice is blocked in both languages', () => {
  const arabic = checkOutgoing('اللي عندك غالبًا التهاب لثة، خذ مضاد حيوي وبيروح خلال يومين.', ar);
  assert.equal(arabic.allowed, false);
  assert.equal(arabic.violations.some((v) => v.code === 'medical_advice'), true);

  const english = checkOutgoing('This sounds like an infection — I recommend you take an antibiotic.', en);
  assert.equal(english.allowed, false);
  assert.equal(english.violations.some((v) => v.code === 'medical_advice'), true);
});

test('symptom reassurance is blocked', () => {
  const result = checkOutgoing('ما فيه شي عليك، شي طبيعي وبيطيب لحاله.', ar);
  assert.equal(result.allowed, false);
  assert.equal(result.violations.some((v) => v.code === 'medical_advice'), true);
});

test('individual suitability statements are blocked', () => {
  assert.equal(checkOutgoing('الفيلر مناسب لك تمامًا وما راح يضرك.', ar).allowed, false);
  assert.equal(checkOutgoing("In your case veneers are the right choice and it's safe for you.", en).allowed, false);
});

test('outcome promises are blocked', () => {
  assert.equal(checkOutgoing('نضمن لك نتيجة ١٠٠٪ والتصبغات تختفي تمامًا.', ar).allowed, false);
  assert.equal(checkOutgoing('We guarantee results — permanently removes all hair.', en).allowed, false);
});

test('the first violation drives the escalation reason', () => {
  const result = checkOutgoing('الفيلر مناسب لك ونضمن لك النتيجة.', ar);
  assert.equal(result.allowed, false);
  assert.equal(result.escalationReason, 'treatment_suitability');
});

test('booking reference digits and appointment times are not read as prices', () => {
  const draft = 'موعدك يوم الأربعاء الساعة ٤:٣٠ العصر، ورقم الحجز NR-4M92XQ. رقمنا +966112345678.';
  assert.equal(checkOutgoing(draft, ar).allowed, true);
});

test('caller-supplied allowed numbers pass (e.g. a quoted total the code computed)', () => {
  const result = checkOutgoing('المجموع ٢٧٠٠ ريال.', { ...ar, allowedNumbers: [2700] });
  assert.equal(result.allowed, true);
});

test('published price set contains every service price and policy fee', () => {
  const set = publishedPriceSet(kb);
  assert.equal(set.has(1800), true);
  assert.equal(set.has(4500), true);
  assert.equal(set.has(18000), true);
  assert.equal(set.has(100), true, 'late cancellation fee from policies');
  assert.equal(set.has(150), true, 'no-show fee / consultation');
  assert.equal(set.has(1250), false);
});

// -------------------------------------------------------------- language

test('locale detection follows the patient', () => {
  assert.equal(detectLocale('أبي أحجز موعد'), 'ar');
  assert.equal(detectLocale('I want to book an appointment'), 'en');
  assert.equal(detectLocale('ok تمام أبي أحجز'), 'ar', 'a stray English word must not flip to English');
  assert.equal(detectLocale('👍'), 'ar');
});

test('the emergency directive comes from the knowledge base, never the model', () => {
  const directive = emergencyDirective(kb, 'ar');
  assert.ok(directive.includes(kb.clinic.emergency.ambulance_number), 'must carry the ambulance number');
  assert.ok(directive.includes(kb.clinic.emergency.urgent_line));
});
