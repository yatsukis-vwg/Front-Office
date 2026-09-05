import type { NextFunction, Request, Response } from 'express';
import { constantTimeEquals, getConfig, logger } from '@front-office/core';

/**
 * Admin authentication.
 *
 * The dashboard runs server-side and forwards a shared admin key; there is no
 * browser-visible credential. Every admin route is behind this.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const provided = (req.header('x-admin-key') ?? bearer(req.header('authorization')) ?? '').trim();
  if (!provided || !constantTimeEquals(provided, getConfig().adminApiKey)) {
    logger.warn('auth.admin_rejected', { path: req.path, ip: req.ip });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

/** Job endpoints are called by a scheduler, not a person. */
export function requireCronSecret(req: Request, res: Response, next: NextFunction): void {
  const provided = (req.header('x-cron-secret') ?? bearer(req.header('authorization')) ?? String(req.query.secret ?? '')).trim();
  if (!provided || !constantTimeEquals(provided, getConfig().cronSecret)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function bearer(header: string | undefined): string | undefined {
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice(7);
}

/** Identifies the acting staff member for the audit log. */
export function staffId(req: Request): string {
  return (req.header('x-staff-id') ?? 'dashboard').slice(0, 64);
}
