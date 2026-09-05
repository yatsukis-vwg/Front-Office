import { getConfig, logger } from '@front-office/core';
import { createApp, ensureBootstrapped } from './app.js';
import { startInProcessJobs } from './routes/jobs.js';

/**
 * Long-running API process — Railway, Render, Fly, or local development.
 *
 * For serverless (Vercel), `api/index.js` uses `createApp()` directly and never
 * reaches this file.
 */
const config = getConfig();
// createApp() runs assertProductionSafety(), so a misconfigured process dies
// here at module load rather than after opening a port.
const app = createApp();

async function main(): Promise<void> {
  await ensureBootstrapped();

  // Timers only make sense in a process that stays alive. On serverless the
  // platform scheduler drives POST /jobs/tick and /jobs/nightly instead.
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
