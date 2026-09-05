import type { Locale } from '../types.js';

const ARABIC_RANGE = /[؀-ۿݐ-ݿ]/g;
const LATIN_RANGE = /[A-Za-z]/g;

/**
 * Picks the reply language from what the patient actually wrote.
 *
 * Default is Arabic: a Riyadh clinic's inbound traffic is overwhelmingly
 * Arabic, and an English reply to an Arabic message reads as a bot. We only
 * switch to English when Latin script clearly dominates, so "ok تمام" or a
 * message full of Arabizi still gets an Arabic answer.
 */
export function detectLocale(text: string, fallback: Locale = 'ar'): Locale {
  const arabic = (text.match(ARABIC_RANGE) ?? []).length;
  const latin = (text.match(LATIN_RANGE) ?? []).length;
  if (arabic === 0 && latin === 0) return fallback;
  if (arabic === 0) return latin >= 3 ? 'en' : fallback;
  if (latin === 0) return 'ar';
  return latin > arabic * 2 ? 'en' : 'ar';
}

/**
 * Locale for a whole thread: the patient's most recent messages win, but a
 * single "thanks" should not flip an Arabic conversation into English.
 */
export function detectConversationLocale(patientMessages: string[], fallback: Locale = 'ar'): Locale {
  const recent = patientMessages.slice(-5);
  if (recent.length === 0) return fallback;
  let arabic = 0;
  let latin = 0;
  for (const message of recent) {
    arabic += (message.match(ARABIC_RANGE) ?? []).length;
    latin += (message.match(LATIN_RANGE) ?? []).length;
  }
  if (arabic === 0 && latin === 0) return fallback;
  return latin > arabic * 2 ? 'en' : 'ar';
}

/** Strips tashkeel and normalises alef/ya/ta-marbuta so keyword matching is robust. */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeForMatching(text: string): string {
  return normalizeArabic(text.toLowerCase());
}

/** Converts Arabic-Indic digits to ASCII so number extraction works on both. */
export function westerniseDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
