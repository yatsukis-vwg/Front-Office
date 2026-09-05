/**
 * Vercel serverless entry for the API.
 *
 * Plain JavaScript on purpose: it imports the already-compiled output from
 * `dist/`, so Vercel's bundler never has to type-check the monorepo itself —
 * `vercel.json`'s buildCommand runs `tsc -b`, which builds @front-office/core
 * through the project reference and then this app.
 *
 * Everything routes here (see the rewrite in vercel.json); Express does the
 * actual routing, exactly as it does on a long-running host.
 */
import { assertProductionSafety } from '@front-office/core';
import { createApp, ensureBootstrapped } from '../dist/app.js';

// Fail fast at cold start, not on request 10,000. Serverless has no start-up
// hook of its own, so module load is the only place a misconfigured deployment
// can be stopped before it encrypts patient data with a key published in
// .env.example. createApp() asserts too; this states the contract at the door.
assertProductionSafety();

const app = createApp();

export default async function handler(request, response) {
  try {
    // Idempotent and memoised — a warm instance pays for this once. A
    // configuration failure is latched and never retried.
    await ensureBootstrapped();
  } catch (error) {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'not_ready', message: error?.message ?? 'bootstrap failed' }));
    return;
  }
  return app(request, response);
}
