import type { NextFunction, Request, Response } from 'express';

/**
 * Minimal fixed-window limiter, in memory.
 *
 * Enough to stop a single abusive web-chat session from burning API credit.
 * A multi-instance deployment should move this to Redis or the platform edge —
 * noted in docs/DEPLOYMENT.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(options: { windowMs: number; max: number; keyFn?: (req: Request) => string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = options.keyFn ? options.keyFn(req) : (req.ip ?? 'unknown');
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    if (bucket.count >= options.max) {
      res.status(429).json({ error: 'too_many_requests', retry_after_ms: bucket.resetAt - now });
      return;
    }
    bucket.count++;
    next();
  };
}

// Keep the map from growing without bound in a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();
