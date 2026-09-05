#!/usr/bin/env tsx
/**
 * Points a Telegram bot at this deployment's webhook.
 *
 *   npm run telegram:register -- https://your-host.example.com [clinic-slug]
 *
 * Reads the bot token and webhook secret from the environment, using the
 * per-clinic variables when they are set:
 *   TELEGRAM_BOT_TOKEN_<SLUG>      / TELEGRAM_BOT_TOKEN
 *   TELEGRAM_WEBHOOK_SECRET_<SLUG> / TELEGRAM_WEBHOOK_SECRET
 */
import { randomBytes } from 'node:crypto';
import { getConfig } from '../packages/core/src/config.js';
import { setTelegramWebhook } from '../packages/core/src/messaging/channels/telegram.js';

const config = getConfig();
const [baseUrlArg, slugArg] = process.argv.slice(2);
const baseUrl = (baseUrlArg ?? config.publicBaseUrl).replace(/\/$/, '');
const slug = slugArg ?? config.defaultClinicSlug;
const envSuffix = slug.toUpperCase().replace(/-/g, '_');

const token = process.env[`TELEGRAM_BOT_TOKEN_${envSuffix}`] ?? process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env[`TELEGRAM_WEBHOOK_SECRET_${envSuffix}`] ?? process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token) {
  console.error(
    `No bot token. Set TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN_${envSuffix}) in .env.\n` +
      'Create a bot by messaging @BotFather on Telegram and sending /newbot.',
  );
  process.exit(1);
}

if (!secret) {
  console.error(
    `No webhook secret. Add this to .env and re-run:\n\n  TELEGRAM_WEBHOOK_SECRET=${randomBytes(24).toString('hex')}\n\n` +
      'Telegram echoes it back on every update; the adapter rejects anything without it.',
  );
  process.exit(1);
}

if (!baseUrl.startsWith('https://')) {
  console.error(`Telegram requires an HTTPS webhook URL. Got: ${baseUrl}\nFor local development use ngrok: ngrok http ${config.port}`);
  process.exit(1);
}

const webhookUrl = `${baseUrl}/webhooks/telegram/${slug}`;
const result = await setTelegramWebhook(token, webhookUrl, secret);

if (result.ok) {
  console.log(`✓ Telegram webhook registered\n  clinic: ${slug}\n  url:    ${webhookUrl}\n\nMessage your bot — it should answer in Arabic.`);
} else {
  console.error(`✗ Telegram rejected the registration: ${result.description ?? 'unknown error'}`);
  process.exit(1);
}
