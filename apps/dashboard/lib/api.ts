import { cookies } from 'next/headers';

/**
 * Server-side API client.
 *
 * The admin key lives only in the Next.js server process — it is never sent to
 * the browser. Client components talk to /api/proxy/*, which re-signs the
 * request with the key. That keeps a single trust boundary.
 */

export const API_BASE = (process.env.API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? 'dev-admin-key';
export const CLINIC_SLUG = process.env.DEFAULT_CLINIC_SLUG ?? 'noor-riyadh';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export async function adminFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; staffId?: string; cache?: RequestCache } = {},
): Promise<T> {
  const url = new URL(`${API_BASE}/api/admin${path}`);
  if (!url.searchParams.has('clinic')) url.searchParams.set('clinic', CLINIC_SLUG);

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'x-admin-key': ADMIN_KEY,
      'x-staff-id': options.staffId ?? (await currentStaffId()),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    // The dashboard shows live operational data; never serve it from a cache.
    cache: options.cache ?? 'no-store',
  });

  const text = await response.text();
  const parsed = text ? safeJson(text) : null;
  if (!response.ok) {
    throw new ApiError(`API ${options.method ?? 'GET'} ${path} failed with ${response.status}`, response.status, parsed);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Identifies the signed-in staff member for the audit log. */
export async function currentStaffId(): Promise<string> {
  const store = await cookies();
  return store.get('fo_staff')?.value ?? 'dashboard';
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return store.get('fo_session')?.value === sessionValue();
}

export function sessionValue(): string {
  // The password is a shared operational secret, not per-user credentials —
  // documented as such in the README. Swap for SSO before real patient data.
  const secret = process.env.DASHBOARD_PASSWORD ?? 'demo';
  let hash = 2166136261;
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `s${(hash >>> 0).toString(36)}`;
}
