import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { kbOverrides } from '../db/repos.js';
import { validateKnowledgeBase, type Doctor, type KnowledgeBase, type Service } from './schema.js';

/**
 * Loads a clinic knowledge base.
 *
 * Resolution order:
 *   1. `clinics/<slug>.yaml` — the file the clinic is onboarded with.
 *   2. `kb_overrides` row — edits made in the dashboard's KB editor, which
 *      replace the file wholesale (the editor loads the file first, so an edit
 *      is always a full document).
 *
 * Both go through the same validator, so a bad dashboard edit can never take
 * the agent down: the override is rejected and the file version is used.
 */

interface CacheEntry {
  kb: KnowledgeBase;
  loadedAt: number;
  source: 'file' | 'override';
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

/**
 * Resolves the clinics directory.
 *
 * `CLINICS_DIR` is normally relative to the working directory, which is the
 * repository root under `npm run dev` and on a long-running host. Serverless
 * platforms do not guarantee that, so when the cwd-relative path does not
 * exist we walk up from this module's own location looking for the directory.
 * That keeps one config value working on Railway, Vercel and a local checkout.
 */
export function resolveClinicsDir(dir = getConfig().clinicsDir): string {
  if (isAbsolute(dir) && existsSync(dir)) return dir;

  const fromCwd = resolve(process.cwd(), dir);
  if (existsSync(fromCwd)) return fromCwd;

  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const candidate = resolve(current, dir);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Nothing found — return the cwd-relative path so the error names what was expected.
  return fromCwd;
}

export function clinicFilePath(slug: string, dir = getConfig().clinicsDir): string {
  const base = resolveClinicsDir(dir);
  const yaml = resolve(base, `${slug}.yaml`);
  if (existsSync(yaml)) return yaml;
  const yml = resolve(base, `${slug}.yml`);
  if (existsSync(yml)) return yml;
  const json = resolve(base, `${slug}.json`);
  if (existsSync(json)) return json;
  return yaml;
}

export function listClinicSlugs(dir = getConfig().clinicsDir): string[] {
  const resolved = resolveClinicsDir(dir);
  if (!existsSync(resolved)) return [];
  return readdirSync(resolved)
    .filter((file) => /\.(ya?ml|json)$/.test(file))
    .map((file) => file.replace(/\.(ya?ml|json)$/, ''))
    .sort();
}

export function loadKnowledgeBaseFile(slug: string, dir = getConfig().clinicsDir): KnowledgeBase {
  const path = clinicFilePath(slug, dir);
  if (!existsSync(path)) {
    throw new Error(`No knowledge base file for clinic "${slug}". Expected ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  const result = validateKnowledgeBase(parsed);
  if (!result.ok) {
    const detail = result.issues.map((i) => `  ${i.path || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Knowledge base ${path} is invalid:\n${detail}`);
  }
  if (result.kb.clinic.slug !== slug) {
    throw new Error(`Knowledge base ${path} declares slug "${result.kb.clinic.slug}" but is filed as "${slug}"`);
  }
  return result.kb;
}

/** File + dashboard overrides, cached briefly so the agent path stays cheap. */
export async function loadKnowledgeBase(slug: string, clinicId?: string): Promise<KnowledgeBase> {
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.kb;

  const fileKb = loadKnowledgeBaseFile(slug);
  let kb = fileKb;
  let source: CacheEntry['source'] = 'file';

  if (clinicId) {
    const override = await kbOverrides.get(clinicId);
    if (override) {
      const result = validateKnowledgeBase(override.kb);
      if (result.ok) {
        kb = result.kb;
        source = 'override';
      } else {
        logger.warn('kb.override_invalid_falling_back_to_file', {
          clinic_id: clinicId,
          issue_count: result.issues.length,
          first_issue: result.issues[0]?.path,
        });
      }
    }
  }

  cache.set(slug, { kb, loadedAt: Date.now(), source });
  return kb;
}

/** Called after a dashboard save so the next message sees the new content. */
export function invalidateKnowledgeBaseCache(slug?: string): void {
  if (slug) cache.delete(slug);
  else cache.clear();
}

// ------------------------------------------------------------- accessors

export function findService(kb: KnowledgeBase, idOrName: string): Service | undefined {
  const needle = idOrName.trim().toLowerCase();
  return kb.services.find(
    (service) =>
      service.id.toLowerCase() === needle ||
      service.name_ar.toLowerCase() === needle ||
      service.name_en.toLowerCase() === needle ||
      service.aliases.some((alias) => alias.toLowerCase() === needle),
  );
}

export function findDoctor(kb: KnowledgeBase, idOrName: string): Doctor | undefined {
  const needle = idOrName.trim().toLowerCase();
  return kb.doctors.find(
    (doctor) => doctor.id.toLowerCase() === needle || doctor.name_ar.toLowerCase() === needle || doctor.name_en.toLowerCase() === needle,
  );
}

export function doctorsForService(kb: KnowledgeBase, service: Service): Doctor[] {
  return service.doctor_ids.map((id) => kb.doctors.find((d) => d.id === id)).filter((d): d is Doctor => Boolean(d));
}

export function instructionsForService(kb: KnowledgeBase, serviceId: string, kind: 'pre' | 'post') {
  return kb.instructions[kind].filter((entry) => entry.service_ids.includes('*') || entry.service_ids.includes(serviceId));
}

/**
 * Every number the agent is allowed to say as a price.
 *
 * The pre-send safety check compares any SAR figure in a draft against this
 * set. Anything else — a made-up quote, an arithmetic "total", a discount — is
 * blocked and the conversation is escalated.
 */
export function publishedPriceValues(kb: KnowledgeBase): Set<number> {
  const values = new Set<number>();
  for (const service of kb.services) {
    if (!service.price) continue;
    values.add(service.price.amount);
    if (service.price.max_amount !== undefined) values.add(service.price.max_amount);
  }
  return values;
}

export function formatPrice(service: Service, locale: 'ar' | 'en'): string {
  const price = service.price;
  if (!price) {
    return locale === 'ar'
      ? 'السعر يتحدد بعد الكشف — أقدر أحجز لك موعد تقييم'
      : 'Price is set after an assessment — I can book you a consultation';
  }
  const unit = locale === 'ar' ? price.unit_ar : price.unit_en;
  const suffix = unit ? ` ${unit}` : '';
  if (locale === 'ar') {
    if (price.type === 'from') return `تبدأ من ${price.amount} ريال${suffix}`;
    if (price.type === 'range') return `من ${price.amount} إلى ${price.max_amount} ريال${suffix}`;
    return `${price.amount} ريال${suffix}`;
  }
  if (price.type === 'from') return `from SAR ${price.amount}${suffix}`;
  if (price.type === 'range') return `SAR ${price.amount}–${price.max_amount}${suffix}`;
  return `SAR ${price.amount}${suffix}`;
}

export function clinicsDirPath(): string {
  return resolveClinicsDir();
}
