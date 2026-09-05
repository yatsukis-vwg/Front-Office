import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { ConfigurationError, assertProductionSafety, getConfig, resetConfigCache } from './config.js';

/**
 * The production guardrail.
 *
 * This is the last thing standing between a careless deploy and real patient
 * records encrypted with a key that is published in .env.example, so it gets
 * its own tests rather than relying on someone noticing at review time.
 */

const SAVED = { ...process.env };

function withEnv(overrides: Record<string, string | undefined>): void {
  // Ignore any developer .env on disk so the test describes only its own inputs.
  process.env.ENV_FILE = 'config.test.no-such-file';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfigCache();
}

/** Node's assert.throws does not return the error, so capture it explicitly. */
function captureThrow(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, but it returned normally' });
}

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
  resetConfigCache();
});

const SAFE_PRODUCTION = {
  NODE_ENV: 'production',
  STORE_DRIVER: 'supabase',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PHONE_HASH_SALT: 'a-real-salt-value',
  ADMIN_API_KEY: 'a-real-admin-key',
  CRON_SECRET: 'a-real-cron-secret',
};

test('development defaults are fine outside production', () => {
  withEnv({ NODE_ENV: 'development', STORE_DRIVER: 'file' });
  assert.doesNotThrow(() => assertProductionSafety(getConfig()));
});

test('a fully configured production environment starts', () => {
  withEnv(SAFE_PRODUCTION);
  assert.doesNotThrow(() => assertProductionSafety(getConfig()));
});

test('every dangerous development default is rejected in production', () => {
  withEnv({
    NODE_ENV: 'production',
    STORE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    DATA_ENCRYPTION_KEY: undefined,
    PHONE_HASH_SALT: undefined,
    ADMIN_API_KEY: undefined,
    CRON_SECRET: undefined,
  });

  const error = captureThrow(() => assertProductionSafety(getConfig()));
  assert.ok(error instanceof ConfigurationError);
  const joined = error.problems.join(' | ');
  for (const expected of ['DATA_ENCRYPTION_KEY', 'PHONE_HASH_SALT', 'ADMIN_API_KEY', 'CRON_SECRET']) {
    assert.ok(joined.includes(expected), `${expected} must be reported: ${joined}`);
  }
});

test('the file store is rejected in production', () => {
  // Vercel's /var/task is read-only and ephemeral; the file store cannot work
  // there, and silently losing patient data is worse than refusing to boot.
  withEnv({ ...SAFE_PRODUCTION, STORE_DRIVER: 'file' });
  const error = captureThrow(() => assertProductionSafety(getConfig()));
  assert.ok(error instanceof ConfigurationError);
  assert.ok(error.problems.some((problem) => problem.includes('STORE_DRIVER=file')));
});

test('a configuration failure is a ConfigurationError, not a generic Error', () => {
  // ensureBootstrapped() latches on this type instead of retrying forever, so
  // the distinction is load-bearing rather than cosmetic.
  withEnv({ ...SAFE_PRODUCTION, ADMIN_API_KEY: 'dev-admin-key' });
  const error = captureThrow(() => assertProductionSafety(getConfig()));
  assert.equal(error instanceof ConfigurationError, true);
  assert.equal(error.name, 'ConfigurationError');
});
