import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { getConfig, logger } from '@front-office/core';
import { bootstrap } from './context.js';
import { requireAdmin, requireCronSecret } from './middleware/auth.js';
import { adminRouter } from './routes/admin.js';
import { chatRouter } from './routes/chat.js';
import { jobsRouter } from './routes/jobs.js';
import { webhookRouter } from './routes/webhooks.js';

/**
 * Builds the Express app.
 *
 * Kept separate from `server.ts` so the same app can run two ways:
 *   - a long-running process that calls `listen()` (Railway, Render, Fly, local)
 *   - a serverless function that never listens (Vercel — see api/index.js)
 *
 * Nothing here starts a listener, opens a port, or schedules a timer.
 */
export function createApp(): express.Express {
  const config = getConfig();
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    cors({
      // The widget is embedded on clinic sites, so the chat API is public by
      // design; the admin API is behind an admin key regardless of origin.
      origin: true,
      credentials: false,
    }),
  );

  // WhatsApp signs the raw body, so keep a copy before JSON parsing consumes it.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true, store: config.storeDriver, uptime_s: Math.round(process.uptime()) });
  });

  app.use('/webhooks', webhookRouter);
  app.use('/api/chat', chatRouter);
  app.use('/api/admin', requireAdmin, adminRouter);
  app.use('/jobs', requireCronSecret, jobsRouter);

  // Serves the embeddable widget script and its demo page from the API origin,
  // so a clinic only has to add one <script> tag.
  app.use('/widget', express.static(widgetDir(), { maxAge: '1h' }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('server.unhandled_error', { error });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

/**
 * Locates `widget/` relative to this module, so it is found whether the code is
 * running from `src/` under tsx or from `dist/` after a build.
 */
function widgetDir(): string {
  return fileURLToPath(new URL('../../../widget', import.meta.url));
}

/**
 * Runs `bootstrap()` exactly once per process.
 *
 * A serverless platform may route several requests to one warm instance, and
 * each of them calls this; registering the channel adapters twice is harmless
 * but re-syncing clinics on every request is not.
 */
let bootstrapPromise: Promise<void> | undefined;

export function ensureBootstrapped(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap().catch((error) => {
      // Let the next request retry rather than wedging the instance forever.
      bootstrapPromise = undefined;
      throw error;
    });
  }
  return bootstrapPromise;
}
