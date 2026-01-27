/**
 * Admin routes for system management
 *
 * Protected endpoints for configuration, maintenance, and debugging
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { BLACKROAD_REPOS } from '../types/repos';

export const adminRouter = new Hono<{ Bindings: Env }>();

// Get system configuration
adminRouter.get('/config', async (c) => {
  return c.json({
    environment: c.env.ENVIRONMENT,
    logLevel: c.env.LOG_LEVEL,
    selfHealEnabled: c.env.SELF_HEAL_ENABLED === 'true',
    autoUpdateEnabled: c.env.AUTO_UPDATE_ENABLED === 'true',
    maxRetryAttempts: parseInt(c.env.MAX_RETRY_ATTEMPTS || '5'),
    retryBackoffMs: parseInt(c.env.RETRY_BACKOFF_MS || '1000'),
    trackedRepos: BLACKROAD_REPOS.map(r => ({
      name: `${r.owner}/${r.name}`,
      branch: r.branch,
      syncEnabled: r.syncEnabled,
      syncInterval: r.scrapeInterval
    }))
  });
});

// Get sync status for all repos
adminRouter.get('/repos', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/status'));
  return c.json(await response.json());
});

// Get repo dependencies
adminRouter.get('/dependencies', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/dependencies'));
  return c.json(await response.json());
});

// Get cohesion status
adminRouter.get('/cohesion', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/cohesion'));
  return c.json(await response.json());
});

// Trigger full reconciliation
adminRouter.post('/reconcile', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/reconcile', {
    method: 'POST'
  }));

  return c.json(await response.json());
});

// Trigger cleanup
adminRouter.post('/cleanup', async (c) => {
  // Cleanup job coordinator
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const jobsCleanup = await coordinator.fetch(new Request('http://internal/cleanup', {
    method: 'POST'
  }));

  // Cleanup old KV entries
  const kvCleanup = await cleanupKV(c.env);

  return c.json({
    jobs: await jobsCleanup.json(),
    kv: kvCleanup
  });
});

// Get stored artifacts
adminRouter.get('/artifacts', async (c) => {
  const prefix = c.req.query('prefix') || 'repos/';
  const limit = parseInt(c.req.query('limit') || '50');

  const list = await c.env.ARTIFACTS.list({ prefix, limit });

  return c.json({
    count: list.objects.length,
    truncated: list.truncated,
    objects: list.objects.map(obj => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded
    }))
  });
});

// Delete artifact
adminRouter.delete('/artifacts/:key', async (c) => {
  const key = c.req.param('key');
  await c.env.ARTIFACTS.delete(key);
  return c.json({ deleted: true });
});

// Get KV stats
adminRouter.get('/kv/stats', async (c) => {
  const jobsCacheList = await c.env.JOBS_CACHE.list();
  const repoStateList = await c.env.REPO_STATE.list();

  return c.json({
    jobsCache: {
      keys: jobsCacheList.keys.length,
      truncated: jobsCacheList.list_complete === false
    },
    repoState: {
      keys: repoStateList.keys.length,
      truncated: repoStateList.list_complete === false
    }
  });
});

// Debug: dump state
adminRouter.get('/debug/state', async (c) => {
  if (c.env.ENVIRONMENT === 'production') {
    return c.json({ error: 'Not available in production' }, 403);
  }

  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);
  const jobsState = await coordinator.fetch(new Request('http://internal/list'));

  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);
  const syncState = await syncManager.fetch(new Request('http://internal/status'));

  const selfHealerId = c.env.SELF_HEALER.idFromName('global');
  const selfHealer = c.env.SELF_HEALER.get(selfHealerId);
  const healerState = await selfHealer.fetch(new Request('http://internal/status'));

  return c.json({
    jobs: await jobsState.json(),
    sync: await syncState.json(),
    healer: await healerState.json()
  });
});

// Reset state (dangerous - dev only)
adminRouter.post('/debug/reset', async (c) => {
  if (c.env.ENVIRONMENT === 'production') {
    return c.json({ error: 'Not available in production' }, 403);
  }

  const { component } = await c.req.json();

  if (!component || !['jobs', 'sync', 'healer', 'all'].includes(component)) {
    return c.json({
      error: 'Invalid component. Valid: jobs, sync, healer, all'
    }, 400);
  }

  // This would need to be implemented in each Durable Object
  // For now, just acknowledge
  return c.json({
    message: `Reset requested for: ${component}`,
    warning: 'This operation is not yet implemented'
  });
});

// Helper to cleanup old KV entries
async function cleanupKV(env: Env): Promise<{ deleted: number }> {
  let deleted = 0;
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();

  // Cleanup escalations older than 7 days
  const escalationList = await env.JOBS_CACHE.list({ prefix: 'escalation:' });
  for (const key of escalationList.keys) {
    const value = await env.JOBS_CACHE.get(key.name);
    if (value) {
      const data = JSON.parse(value);
      if (data.createdAt && now - data.createdAt > maxAge) {
        await env.JOBS_CACHE.delete(key.name);
        deleted++;
      }
    }
  }

  // Cleanup old DLQ entries
  const dlqList = await env.JOBS_CACHE.list({ prefix: 'dlq:' });
  for (const key of dlqList.keys) {
    const value = await env.JOBS_CACHE.get(key.name);
    if (value) {
      const data = JSON.parse(value);
      if (data.failedAt && now - data.failedAt > maxAge) {
        await env.JOBS_CACHE.delete(key.name);
        deleted++;
      }
    }
  }

  return { deleted };
}
