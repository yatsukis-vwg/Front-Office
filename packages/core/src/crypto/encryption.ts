import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getConfig } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

function keyBytes(): Buffer {
  const raw = getConfig().dataEncryptionKey;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key (generate with: openssl rand -base64 32)');
  }
  return key;
}

/**
 * Encrypts a value for storage at rest.
 *
 * Format: `v1:<iv>:<authTag>:<ciphertext>`, all base64. The version prefix lets
 * a future key rotation decrypt old rows while writing new ones under `v2`.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, keyBytes(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Ciphertext is not in the expected v1 envelope format');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGORITHM, keyBytes(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function encryptNullable(plaintext: string | null | undefined): string | null {
  return plaintext === null || plaintext === undefined || plaintext === '' ? null : encrypt(plaintext);
}

/**
 * Returns null instead of throwing so one unreadable row (e.g. written under a
 * rotated key) cannot take down a whole transcript view.
 */
export function decryptNullable(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

/**
 * Deterministic, salted hash used as a lookup key for phone numbers. It lets us
 * find "the patient with this number" without storing the number in the clear
 * or decrypting every row.
 */
export function hashPhone(phoneE164: string): string {
  return createHmac('sha256', getConfig().phoneHashSalt).update(normalizePhone(phoneE164)).digest('hex');
}

/**
 * Normalises Saudi numbers to E.164. Accepts 05xxxxxxxx, 5xxxxxxxx,
 * 9665xxxxxxxx, +9665xxxxxxxx and Arabic-Indic digits.
 */
export function normalizePhone(input: string): string {
  const westernised = input.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const digits = westernised.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  let value = digits.startsWith('+') ? digits.slice(1) : digits;
  if (value.startsWith('00')) value = value.slice(2);
  if (value.startsWith('9660')) value = `966${value.slice(4)}`;
  if (value.startsWith('05')) value = `966${value.slice(1)}`;
  else if (value.startsWith('5') && value.length === 9) value = `966${value}`;
  return `+${value}`;
}

export function isPlausibleSaudiMobile(input: string): boolean {
  return /^\+9665\d{8}$/.test(normalizePhone(input));
}

export function newId(): string {
  return randomUUID();
}

/** Booking references are short, unambiguous and readable over the phone. */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function newBookingReference(prefix = 'NR'): string {
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `${prefix}-${out}`;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
