import {
  TelegramChannel,
  WebChatChannel,
  WhatsAppChannel,
  assertProductionSafety,
  clinics,
  getConfig,
  listClinicSlugs,
  loadKnowledgeBaseFile,
  logger,
  registerChannel,
  type Clinic,
} from '@front-office/core';

/**
 * Process bootstrap.
 *
 * Registers the channel adapters and makes sure every clinic YAML file has a
 * matching row in the database. Adding a clinic is: drop in the YAML, restart
 * (or hit POST /admin/clinics/sync) — no migration.
 */

export async function bootstrap(): Promise<void> {
  const config = getConfig();
  assertProductionSafety(config);

  registerChannel(new TelegramChannel());
  registerChannel(new WebChatChannel());

  // WhatsApp ships wired but disabled — see docs/MESSAGING.md.
  if (process.env.ENABLE_WHATSAPP === 'true') {
    registerChannel(new WhatsAppChannel());
    logger.info('bootstrap.whatsapp_enabled');
  }

  await syncClinicsFromFiles();
  logger.info('bootstrap.ready', { store: config.storeDriver, model: config.anthropicModel });
}

/** Creates or refreshes a `clinics` row for every file in clinics/. */
export async function syncClinicsFromFiles(): Promise<Clinic[]> {
  const out: Clinic[] = [];
  for (const slug of listClinicSlugs()) {
    let kb;
    try {
      kb = loadKnowledgeBaseFile(slug);
    } catch (error) {
      logger.error('bootstrap.invalid_clinic_file', { slug, error });
      continue;
    }
    const existing = await clinics.bySlug(slug);
    if (existing) {
      const updated = await clinics.update(existing.id, {
        name: kb.clinic.name_en,
        timezone: kb.clinic.timezone,
        avg_ticket_sar: kb.clinic.avg_ticket_sar,
        retention_days: kb.clinic.retention_days,
        settings: {
          ...existing.settings,
          telegram_bot_token: process.env[`TELEGRAM_BOT_TOKEN_${slugEnv(slug)}`] ?? process.env.TELEGRAM_BOT_TOKEN ?? existing.settings?.telegram_bot_token,
          telegram_webhook_secret:
            process.env[`TELEGRAM_WEBHOOK_SECRET_${slugEnv(slug)}`] ?? process.env.TELEGRAM_WEBHOOK_SECRET ?? existing.settings?.telegram_webhook_secret,
        },
      });
      out.push(updated ?? existing);
      continue;
    }
    const created = await clinics.create({
      slug,
      name: kb.clinic.name_en,
      timezone: kb.clinic.timezone,
      avg_ticket_sar: kb.clinic.avg_ticket_sar,
      retention_days: kb.clinic.retention_days,
      settings: {
        telegram_bot_token: process.env[`TELEGRAM_BOT_TOKEN_${slugEnv(slug)}`] ?? process.env.TELEGRAM_BOT_TOKEN,
        telegram_webhook_secret: process.env[`TELEGRAM_WEBHOOK_SECRET_${slugEnv(slug)}`] ?? process.env.TELEGRAM_WEBHOOK_SECRET,
      },
    });
    logger.info('bootstrap.clinic_created', { slug, clinic_id: created.id });
    out.push(created);
  }
  return out;
}

/** `noor-riyadh` → `NOOR_RIYADH`, for per-clinic env var names. */
function slugEnv(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

export async function resolveClinic(slugOrId: string): Promise<Clinic | null> {
  return (await clinics.bySlug(slugOrId)) ?? (await clinics.byId(slugOrId));
}

export async function defaultClinic(): Promise<Clinic | null> {
  return resolveClinic(getConfig().defaultClinicSlug);
}
