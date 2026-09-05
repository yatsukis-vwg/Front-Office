import { Router } from 'express';
import { clinics, closeOutPastAppointments, logger, purgeAllClinics, runDueReminders } from '@front-office/core';

/**
 * Scheduled jobs.
 *
 * Exposed as HTTP so any scheduler can drive them — Vercel Cron, Railway Cron,
 * GitHub Actions, or the in-process scheduler in server.ts. All are idempotent.
 */
export const jobsRouter: Router = Router();

/** Every 5 minutes: send due confirmations and reminders. */
jobsRouter.post('/tick', async (_req, res) => {
  const summary = await runDueReminders(100);
  res.json({ ok: true, reminders: summary });
});

/** Nightly: close out past appointments and run the PDPL retention purge. */
jobsRouter.post('/nightly', async (_req, res) => {
  const all = await clinics.list();
  let closed = 0;
  for (const clinic of all) closed += await closeOutPastAppointments(clinic.id);
  const purges = await purgeAllClinics();
  logger.info('jobs.nightly', { clinics: all.length, appointments_closed: closed });
  res.json({ ok: true, appointments_closed: closed, purges });
});

/** In-process scheduler, for single-instance deployments and the demo. */
export function startInProcessJobs(): void {
  const FIVE_MINUTES = 5 * 60_000;
  const ONE_HOUR = 60 * 60_000;

  const reminderTimer = setInterval(() => {
    runDueReminders(100).catch((error) => logger.error('jobs.reminder_tick_failed', { error }));
  }, FIVE_MINUTES);
  reminderTimer.unref();

  const nightlyTimer = setInterval(() => {
    void (async () => {
      try {
        const all = await clinics.list();
        for (const clinic of all) await closeOutPastAppointments(clinic.id);
        await purgeAllClinics();
      } catch (error) {
        logger.error('jobs.nightly_failed', { error });
      }
    })();
  }, ONE_HOUR);
  nightlyTimer.unref();

  logger.info('jobs.in_process_scheduler_started');
}
