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
import { createApp, ensureBootstrapped } from '../dist/app.js';

const app = createApp();

export default async function handler(request, response) {
  try {
    // Idempotent and memoised — a warm instance pays for this once.
    await ensureBootstrapped();
  } catch (error) {
    response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'not_ready', message: error?.message ?? 'bootstrap failed' }));
    return;
  }
  return app(request, response);
}
