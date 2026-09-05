import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getConfig, logger } from '@front-office/core';
import { bootstrap } from './context.js';
import { requireAdmin, requireCronSecret } from './middleware/auth.js';
import { adminRouter } from './routes/admin.js';
import { chatRouter } from './routes/chat.js';
import { jobsRouter, startInProcessJobs } from './routes/jobs.js';
import { webhookRouter } from './routes/webhooks.js';

/**
 * API server.
 *
 * Deploys to Railway/Render/Fly as a normal Node process, or to Vercel as a
 * serverless function (see api/index.ts). Nothing in here is platform-specific
 * apart from the in-process scheduler, which is disabled when a platform cron
 * drives /jobs instead.
 */

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
app.use('/widget', express.static(new URL('../../../widget', import.meta.url).pathname, { maxAge: '1h' }));

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('server.unhandled_error', { error });
  res.status(500).json({ error: 'internal_error' });
});

async function main(): Promise<void> {
  await bootstrap();
  if (config.enableInProcessJobs) startInProcessJobs();
  app.listen(config.port, () => {
    logger.info('server.listening', { port: config.port, env: config.nodeEnv });
    process.stdout.write(
      `\n  AI receptionist API on http://localhost:${config.port}\n` +
        `  Widget demo:  http://localhost:${config.port}/widget/demo.html\n` +
        `  Health:       http://localhost:${config.port}/health\n\n`,
    );
  });
}

main().catch((error) => {
  logger.error('server.startup_failed', { error });
  process.exitCode = 1;
});

export { app };
