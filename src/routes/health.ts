/**
 * Health check routes
 *
 * Endpoints for monitoring system health and triggering self-healing
 */

import { Hono } from 'hono';
import { Env } from '../types/env';

export const healthRouter = new Hono<{ Bindings: Env }>();

// Basic health check
healthRouter.get('/', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/health-check'));
  const health = await response.json() as {
    overall: string;
    components: Array<{ name: string; status: string }>;
    lastUpdated: number;
  };

  // Return appropriate status code based on health
  const statusCode = health.overall === 'healthy' ? 200 :
    health.overall === 'degraded' ? 200 : 503;

  return c.json(health, statusCode);
});

// Detailed health status
healthRouter.get('/detailed', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const healthResponse = await selfHealer.fetch(new Request('http://internal/status'));
  const health = await healthResponse.json();

  // Get job coordinator status
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);
  const jobsResponse = await coordinator.fetch(new Request('http://internal/list'));
  const jobs = await jobsResponse.json();

  // Get sync status
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);
  const syncResponse = await syncManager.fetch(new Request('http://internal/status'));
  const sync = await syncResponse.json();

  return c.json({
    health,
    jobs,
    sync,
    environment: c.env.ENVIRONMENT,
    timestamp: Date.now()
  });
});

// Liveness probe (for k8s/container health)
healthRouter.get('/live', async (c) => {
  return c.json({ status: 'alive', timestamp: Date.now() });
});

// Readiness probe
healthRouter.get('/ready', async (c) => {
  try {
    // Quick check that essential services are responsive
    await c.env.JOBS_CACHE.get('health-check-ready');

    return c.json({ status: 'ready', timestamp: Date.now() });
  } catch (error) {
    return c.json({
      status: 'not ready',
      error: String(error),
      timestamp: Date.now()
    }, 503);
  }
});

// Trigger manual health check
healthRouter.post('/check', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/health-check'));
  return c.json(await response.json());
});

// Get self-healer status
healthRouter.get('/healer', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/status'));
  return c.json(await response.json());
});

// Get healing actions
healthRouter.get('/healer/actions', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/actions'));
  return c.json(await response.json());
});

// Get resolution patterns
healthRouter.get('/healer/patterns', async (c) => {
  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/patterns'));
  return c.json(await response.json());
});

// Trigger manual healing action
healthRouter.post('/heal', async (c) => {
  const { target, action } = await c.req.json();

  if (!target || !action) {
    return c.json({ error: 'Target and action required' }, 400);
  }

  const validActions = ['retry', 'restart', 'failover', 'escalate', 'notify'];
  if (!validActions.includes(action)) {
    return c.json({ error: `Invalid action. Valid: ${validActions.join(', ')}` }, 400);
  }

  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/trigger-heal', {
    method: 'POST',
    body: JSON.stringify({ target, action })
  }));

  return c.json(await response.json());
});

// Report error (for external systems)
healthRouter.post('/report-error', async (c) => {
  const error = await c.req.json();

  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

  const response = await selfHealer.fetch(new Request('http://internal/report-error', {
    method: 'POST',
    body: JSON.stringify({
      ...error,
      timestamp: error.timestamp || Date.now()
    })
  }));

  return c.json(await response.json());
});

// Get escalations
healthRouter.get('/escalations', async (c) => {
  const escalations: unknown[] = [];
  const list = await c.env.JOBS_CACHE.list({ prefix: 'escalation:' });

  for (const key of list.keys) {
    const value = await c.env.JOBS_CACHE.get(key.name);
    if (value) {
      escalations.push(JSON.parse(value));
    }
  }

  return c.json({
    count: escalations.length,
    escalations
  });
});

// Clear escalation
healthRouter.delete('/escalations/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.JOBS_CACHE.delete(`escalation:${id}`);
  return c.json({ deleted: true });
});
