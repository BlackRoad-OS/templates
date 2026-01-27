/**
 * ⬛⬜🛣️ BlackRoad Agent Jobs Worker
 *
 * Main entry point for the Cloudflare Worker handling:
 * - Agent job orchestration and scraping
 * - Repository synchronization across BlackRoad-OS
 * - Auto-updates via webhooks and scheduled triggers
 * - Self-healing and resolution mechanisms
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { Env } from './types/env';
import { webhooksRouter } from './routes/webhooks';
import { jobsRouter } from './routes/jobs';
import { healthRouter } from './routes/health';
import { adminRouter } from './routes/admin';
import { handleScheduled } from './handlers/scheduled';
import { handleQueue } from './handlers/queue';

// Re-export Durable Objects
export { JobCoordinator } from './durable-objects/job-coordinator';
export { RepoSyncManager } from './durable-objects/repo-sync-manager';
export { SelfHealer } from './durable-objects/self-healer';

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());
app.use('*', logger());

// Error handling
app.onError((err, c) => {
  console.error('Unhandled error:', err);

  // Trigger self-healing on critical errors
  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);
  selfHealer.fetch(new Request('http://internal/report-error', {
    method: 'POST',
    body: JSON.stringify({
      error: err.message,
      stack: err.stack,
      path: c.req.path,
      timestamp: Date.now()
    })
  }));

  return c.json({
    success: false,
    error: 'Internal server error',
    requestId: crypto.randomUUID()
  }, 500);
});

// Routes
app.route('/webhooks', webhooksRouter);
app.route('/jobs', jobsRouter);
app.route('/health', healthRouter);
app.route('/admin', adminRouter);

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: '⬛⬜🛣️ BlackRoad Agent Jobs Worker',
    version: '1.0.0',
    status: 'operational',
    endpoints: {
      webhooks: '/webhooks',
      jobs: '/jobs',
      health: '/health',
      admin: '/admin'
    },
    capabilities: [
      'repo-scraping',
      'job-orchestration',
      'auto-updates',
      'self-healing'
    ]
  });
});

// Export the worker
export default {
  fetch: app.fetch,

  // Scheduled triggers for auto-updates and self-healing
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env));
  },

  // Queue consumer for async job processing
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleQueue(batch, env));
  }
};
