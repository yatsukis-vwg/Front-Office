import type { ChannelId, Clinic } from '../types.js';
import type { ChannelAdapter, ChannelCredentials } from './types.js';

/**
 * Channel registry.
 *
 * The pipeline resolves adapters through here, so a new channel becomes
 * available to every part of the system by registering it once at start-up.
 */

const adapters = new Map<ChannelId, ChannelAdapter>();

export function registerChannel(adapter: ChannelAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getChannel(id: ChannelId): ChannelAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`No channel adapter registered for "${id}". Register it at start-up.`);
  return adapter;
}

export function tryGetChannel(id: ChannelId): ChannelAdapter | undefined {
  return adapters.get(id);
}

export function registeredChannels(): ChannelAdapter[] {
  return [...adapters.values()];
}

/** Projects a clinic's settings into the credential bundle channels expect. */
export function credentialsForClinic(clinic: Clinic): ChannelCredentials {
  const settings = clinic.settings ?? {};
  return {
    clinicId: clinic.id,
    clinicSlug: clinic.slug,
    telegramBotToken: settings.telegram_bot_token,
    telegramWebhookSecret: settings.telegram_webhook_secret,
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  };
}
