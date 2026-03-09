/**
 * Jobs API routes
 *
 * Endpoints for managing agent jobs, viewing status, and manual operations
 */

import { Hono } from 'hono';
import { Env, JobType } from '../types/env';
import { z } from 'zod';

export const jobsRouter = new Hono<{ Bindings: Env }>();

// Job submission schema
const submitJobSchema = z.object({
  type: z.enum([
    'scrape-repo',
    'sync-repos',
    'update-templates',
    'health-check',
    'self-heal',
    'reconcile',
    'cleanup',
    'agent-task'
  ]),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().min(1).max(10).optional()
});

// Submit a new job
jobsRouter.post('/submit', async (c) => {
  const body = await c.req.json();

  const parsed = submitJobSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid job data', details: parsed.error }, 400);
  }

  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify(parsed.data)
  }));

  const result = await response.json();
  return c.json(result);
});

// Get job status
jobsRouter.get('/status/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(
    new Request(`http://internal/status?id=${jobId}`)
  );

  if (!response.ok) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json(await response.json());
});

// List all jobs
jobsRouter.get('/list', async (c) => {
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/list'));
  return c.json(await response.json());
});

// Cancel a job
jobsRouter.post('/cancel/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/cancel', {
    method: 'POST',
    body: JSON.stringify({ jobId })
  }));

  return c.json(await response.json());
});

// Get job metrics
jobsRouter.get('/metrics', async (c) => {
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/metrics'));
  return c.json(await response.json());
});

// Trigger job processing
jobsRouter.post('/process', async (c) => {
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/process', {
    method: 'POST'
  }));

  return c.json(await response.json());
});

// Submit agent task
jobsRouter.post('/agent-task', async (c) => {
  const { task, context, priority } = await c.req.json();

  if (!task) {
    return c.json({ error: 'Task description required' }, 400);
  }

  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify({
      type: 'agent-task' as JobType,
      payload: { task, context },
      priority: priority || 5
    })
  }));

  return c.json(await response.json());
});

// Bulk job submission
jobsRouter.post('/bulk-submit', async (c) => {
  const { jobs } = await c.req.json() as { jobs: Array<{ type: JobType; payload?: unknown; priority?: number }> };

  if (!Array.isArray(jobs)) {
    return c.json({ error: 'Jobs array required' }, 400);
  }

  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const results = await Promise.all(
    jobs.map(async (job) => {
      const response = await coordinator.fetch(new Request('http://internal/submit', {
        method: 'POST',
        body: JSON.stringify(job)
      }));
      return response.json();
    })
  );

  return c.json({
    submitted: results.length,
    results
  });
});

// Get dead letter queue entries
jobsRouter.get('/dlq', async (c) => {
  // List recent DLQ entries from KV
  const entries: unknown[] = [];
  const list = await c.env.JOBS_CACHE.list({ prefix: 'dlq:' });

  for (const key of list.keys) {
    const value = await c.env.JOBS_CACHE.get(key.name);
    if (value) {
      entries.push(JSON.parse(value));
    }
  }

  return c.json({
    count: entries.length,
    entries
  });
});

// Retry a failed job from DLQ
jobsRouter.post('/dlq/retry/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const key = `dlq:${jobId}`;

  const value = await c.env.JOBS_CACHE.get(key);
  if (!value) {
    return c.json({ error: 'Job not found in DLQ' }, 404);
  }

  const failedJob = JSON.parse(value);

  // Resubmit with reset retry count
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify({
      type: failedJob.type,
      payload: failedJob.payload,
      priority: failedJob.priority
    })
  }));

  // Remove from DLQ
  await c.env.JOBS_CACHE.delete(key);

  return c.json({
    message: 'Job resubmitted',
    result: await response.json()
  });
});
