import { getConfig } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/**
 * Keys whose values must never reach a log line. PDPL treats health data as a
 * sensitive category, so message bodies, names and phone numbers are dropped
 * rather than truncated. Log identifiers instead and read the content through
 * the audited admin API.
 */
const FORBIDDEN_KEYS = new Set([
  'body',
  'text',
  'message',
  'body_enc',
  'content',
  'transcript',
  'name',
  'patient_name',
  'phone',
  'patient_phone',
  'notes',
  'reply',
  'draft',
  'answer',
  'question',
]);

const SECRET_KEYS = [/token/i, /secret/i, /key$/i, /password/i, /authorization/i];

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) {
        out[k] = '[redacted]';
      } else if (SECRET_KEYS.some((re) => re.test(k))) {
        out[k] = '[secret]';
      } else {
        out[k] = scrub(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const threshold = LEVELS[getConfig().logLevel] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (scrub(fields) as Record<string, unknown>) : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/** Exported for the logging test — asserts message bodies cannot leak. */
export const __scrubForTest = scrub;
