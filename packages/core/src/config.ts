import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

/**
 * Loads a `.env` file if one is present, without overriding variables the
 * platform already set. Keeps `npm run dev` a single command locally while
 * leaving Railway/Vercel/Fly environment variables authoritative in production.
 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), process.env.ENV_FILE ?? '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing ` # comment` from an unquoted value.
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function num(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} must be a number`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export type StoreDriver = 'supabase' | 'file';

export interface AppConfig {
  nodeEnv: string;
  /**
   * `file` keeps everything in a local JSON file so the sales demo runs with no
   * external services. `supabase` is the deployment path.
   */
  storeDriver: StoreDriver;
  fileStorePath: string;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
  anthropicApiKey?: string;
  anthropicModel: string;
  anthropicEffort: 'low' | 'medium' | 'high';
  anthropicMaxTokens: number;
  /** base64-encoded 32-byte key for AES-256-GCM patient data encryption. */
  dataEncryptionKey: string;
  phoneHashSalt: string;
  adminApiKey: string;
  publicBaseUrl: string;
  clinicsDir: string;
  defaultClinicSlug: string;
  cronSecret: string;
  enableInProcessJobs: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  port: number;
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  loadDotEnv();
  cached = {
    nodeEnv: optional('NODE_ENV') ?? 'development',
    storeDriver: (optional('STORE_DRIVER') as StoreDriver | undefined) ?? 'file',
    fileStorePath: optional('FILE_STORE_PATH') ?? '.data/demo.json',
    supabaseUrl: optional('SUPABASE_URL'),
    supabaseServiceKey: optional('SUPABASE_SERVICE_ROLE_KEY'),
    anthropicApiKey: optional('ANTHROPIC_API_KEY'),
    anthropicModel: optional('ANTHROPIC_MODEL') ?? 'claude-opus-5',
    anthropicEffort: (optional('ANTHROPIC_EFFORT') as AppConfig['anthropicEffort']) ?? 'medium',
    anthropicMaxTokens: num('ANTHROPIC_MAX_TOKENS', 2048),
    // Dev default keeps `npm run demo` zero-config. Production start-up refuses
    // to boot on this value — see assertProductionSafety below.
    dataEncryptionKey: optional('DATA_ENCRYPTION_KEY') ?? 'ZGV2LW9ubHktaW5zZWN1cmUta2V5LTMyLWJ5dGVzISE=',
    phoneHashSalt: optional('PHONE_HASH_SALT') ?? 'dev-only-phone-salt',
    adminApiKey: optional('ADMIN_API_KEY') ?? 'dev-admin-key',
    publicBaseUrl: optional('PUBLIC_BASE_URL') ?? 'http://localhost:8080',
    clinicsDir: optional('CLINICS_DIR') ?? 'clinics',
    defaultClinicSlug: optional('DEFAULT_CLINIC_SLUG') ?? 'noor-riyadh',
    cronSecret: optional('CRON_SECRET') ?? 'dev-cron-secret',
    enableInProcessJobs: bool('ENABLE_INPROCESS_JOBS', true),
    logLevel: (optional('LOG_LEVEL') as AppConfig['logLevel']) ?? 'info',
    port: num('PORT', 8080),
  };
  if (cached.storeDriver === 'supabase') {
    required('SUPABASE_URL');
    required('SUPABASE_SERVICE_ROLE_KEY');
  }
  return cached;
}

/**
 * Thrown when the process is configured in a way that must never serve real
 * patient data. Distinct from a transient start-up failure: retrying cannot
 * fix it, so callers treat it as terminal rather than as a blip.
 */
export class ConfigurationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Refusing to start in production:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}

/**
 * Called at start-up on every entry point — the long-running server, the
 * serverless function, and `createApp()` itself. Development defaults are
 * convenient but must never reach a deployment holding real patient data.
 */
export function assertProductionSafety(config: AppConfig = getConfig()): void {
  if (config.nodeEnv !== 'production') return;
  const problems: string[] = [];
  if (config.dataEncryptionKey.startsWith('ZGV2LW9ubHkt')) problems.push('DATA_ENCRYPTION_KEY is still the development default');
  if (config.phoneHashSalt === 'dev-only-phone-salt') problems.push('PHONE_HASH_SALT is still the development default');
  if (config.adminApiKey === 'dev-admin-key') problems.push('ADMIN_API_KEY is still the development default');
  if (config.cronSecret === 'dev-cron-secret') problems.push('CRON_SECRET is still the development default');
  if (config.storeDriver === 'file') problems.push('STORE_DRIVER=file is not supported in production; use supabase');
  if (problems.length > 0) throw new ConfigurationError(problems);
}

/** Test helper — forces the next getConfig() call to re-read the environment. */
export function resetConfigCache(): void {
  cached = undefined;
}
