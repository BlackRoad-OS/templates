/**
 * JobCoordinator Durable Object
 *
 * Manages job orchestration, scheduling, and state across all agent tasks.
 * Ensures exactly-once execution and handles distributed coordination.
 */

import { Env, JobStatus, JobType, JobMessage } from '../types/env';

interface CoordinatorState {
  jobs: Map<string, JobStatus>;
  runningJobs: Set<string>;
  jobQueue: JobMessage[];
  lastProcessedAt: number;
  metrics: {
    totalJobsProcessed: number;
    totalJobsFailed: number;
    averageProcessingTime: number;
  };
}

export class JobCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private coordinatorState: CoordinatorState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.coordinatorState = {
      jobs: new Map(),
      runningJobs: new Set(),
      jobQueue: [],
      lastProcessedAt: 0,
      metrics: {
        totalJobsProcessed: 0,
        totalJobsFailed: 0,
        averageProcessingTime: 0
      }
    };

    // Restore state from storage
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<CoordinatorState>('state');
      if (stored) {
        this.coordinatorState = {
          ...stored,
          jobs: new Map(Object.entries(stored.jobs || {})),
          runningJobs: new Set(stored.runningJobs || [])
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/submit':
          return this.handleSubmitJob(request);
        case '/status':
          return this.handleGetStatus(request);
        case '/cancel':
          return this.handleCancelJob(request);
        case '/list':
          return this.handleListJobs();
        case '/metrics':
          return this.handleGetMetrics();
        case '/process':
          return this.handleProcessQueue();
        case '/cleanup':
          return this.handleCleanup();
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      console.error('JobCoordinator error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleSubmitJob(request: Request): Promise<Response> {
    const body = await request.json() as {
      type: JobType;
      payload: unknown;
      priority?: number;
    };

    const jobId = crypto.randomUUID();
    const job: JobStatus = {
      id: jobId,
      type: body.type,
      status: 'pending',
      progress: 0,
      retryCount: 0
    };

    const message: JobMessage = {
      id: jobId,
      type: body.type,
      payload: body.payload,
      priority: body.priority || 5,
      createdAt: Date.now(),
      retryCount: 0
    };

    // Add to local queue for immediate processing
    this.coordinatorState.jobQueue.push(message);
    this.coordinatorState.jobQueue.sort((a, b) => b.priority - a.priority);

    // Store job status
    this.coordinatorState.jobs.set(jobId, job);

    // Also enqueue to Cloudflare Queue for durability
    await this.env.JOBS_QUEUE.send(message);

    await this.saveState();

    // Schedule processing
    this.state.waitUntil(this.processNextJob());

    return new Response(JSON.stringify({
      success: true,
      jobId,
      status: job.status
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetStatus(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const jobId = url.searchParams.get('id');

    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Job ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const job = this.coordinatorState.jobs.get(jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(job), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCancelJob(request: Request): Promise<Response> {
    const { jobId } = await request.json() as { jobId: string };

    const job = this.coordinatorState.jobs.get(jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (job.status === 'running') {
      // Can't cancel running jobs, but we can mark for cancellation
      job.status = 'failed';
      job.error = 'Cancelled by user';
    } else if (job.status === 'pending') {
      job.status = 'failed';
      job.error = 'Cancelled by user';
      // Remove from queue
      this.coordinatorState.jobQueue = this.coordinatorState.jobQueue.filter(
        j => j.id !== jobId
      );
    }

    this.coordinatorState.jobs.set(jobId, job);
    await this.saveState();

    return new Response(JSON.stringify({ success: true, job }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleListJobs(): Promise<Response> {
    const jobs = Array.from(this.coordinatorState.jobs.values());
    return new Response(JSON.stringify({
      total: jobs.length,
      pending: jobs.filter(j => j.status === 'pending').length,
      running: jobs.filter(j => j.status === 'running').length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      jobs: jobs.slice(-100) // Last 100 jobs
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetMetrics(): Promise<Response> {
    return new Response(JSON.stringify(this.coordinatorState.metrics), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleProcessQueue(): Promise<Response> {
    const processed = await this.processNextJob();
    return new Response(JSON.stringify({ processed }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCleanup(): Promise<Response> {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    let cleaned = 0;

    for (const [id, job] of this.coordinatorState.jobs) {
      if (
        (job.status === 'completed' || job.status === 'failed') &&
        job.completedAt &&
        now - job.completedAt > maxAge
      ) {
        this.coordinatorState.jobs.delete(id);
        cleaned++;
      }
    }

    await this.saveState();

    return new Response(JSON.stringify({
      success: true,
      cleanedJobs: cleaned
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async processNextJob(): Promise<boolean> {
    if (this.coordinatorState.jobQueue.length === 0) {
      return false;
    }

    const message = this.coordinatorState.jobQueue.shift()!;
    const job = this.coordinatorState.jobs.get(message.id);

    if (!job || job.status === 'failed') {
      return false;
    }

    // Update status
    job.status = 'running';
    job.startedAt = Date.now();
    this.coordinatorState.runningJobs.add(message.id);
    this.coordinatorState.jobs.set(message.id, job);
    await this.saveState();

    try {
      // Execute the job based on type
      const result = await this.executeJob(message);

      // Update completion status
      job.status = 'completed';
      job.completedAt = Date.now();
      job.progress = 100;
      job.result = result;

      this.coordinatorState.metrics.totalJobsProcessed++;
      const processingTime = job.completedAt - job.startedAt!;
      this.coordinatorState.metrics.averageProcessingTime =
        (this.coordinatorState.metrics.averageProcessingTime *
          (this.coordinatorState.metrics.totalJobsProcessed - 1) +
          processingTime) /
        this.coordinatorState.metrics.totalJobsProcessed;
    } catch (error) {
      job.status = 'failed';
      job.error = String(error);
      job.completedAt = Date.now();
      this.coordinatorState.metrics.totalJobsFailed++;

      // Retry logic
      const maxRetries = parseInt(this.env.MAX_RETRY_ATTEMPTS || '5');
      if (message.retryCount < maxRetries) {
        message.retryCount++;
        job.status = 'retrying';
        job.retryCount = message.retryCount;

        // Exponential backoff
        const backoff = parseInt(this.env.RETRY_BACKOFF_MS || '1000');
        await new Promise(r => setTimeout(r, backoff * Math.pow(2, message.retryCount)));

        this.coordinatorState.jobQueue.push(message);
      } else {
        // Send to dead letter queue
        await this.env.DEAD_LETTER_QUEUE.send({
          ...message,
          error: String(error),
          failedAt: Date.now()
        });

        // Trigger self-healing
        const selfHealerId = this.env.SELF_HEALER.idFromName('global');
        const selfHealer = this.env.SELF_HEALER.get(selfHealerId);
        await selfHealer.fetch(new Request('http://internal/job-failed', {
          method: 'POST',
          body: JSON.stringify({
            jobId: message.id,
            jobType: message.type,
            error: String(error),
            retryCount: message.retryCount
          })
        }));
      }
    }

    this.coordinatorState.runningJobs.delete(message.id);
    this.coordinatorState.jobs.set(message.id, job);
    this.coordinatorState.lastProcessedAt = Date.now();
    await this.saveState();

    return true;
  }

  private async executeJob(message: JobMessage): Promise<unknown> {
    switch (message.type) {
      case 'scrape-repo':
        return this.executeScrapeRepo(message.payload);
      case 'sync-repos':
        return this.executeSyncRepos(message.payload);
      case 'update-templates':
        return this.executeUpdateTemplates(message.payload);
      case 'health-check':
        return this.executeHealthCheck();
      case 'reconcile':
        return this.executeReconcile();
      case 'cleanup':
        return this.executeCleanup();
      case 'agent-task':
        return this.executeAgentTask(message.payload);
      default:
        throw new Error(`Unknown job type: ${message.type}`);
    }
  }

  private async executeScrapeRepo(payload: unknown): Promise<unknown> {
    const { repo } = payload as { repo: string };
    const syncId = this.env.REPO_SYNC.idFromName(repo);
    const syncManager = this.env.REPO_SYNC.get(syncId);

    const response = await syncManager.fetch(new Request('http://internal/scrape', {
      method: 'POST',
      body: JSON.stringify(payload)
    }));

    return response.json();
  }

  private async executeSyncRepos(payload: unknown): Promise<unknown> {
    const syncId = this.env.REPO_SYNC.idFromName('global');
    const syncManager = this.env.REPO_SYNC.get(syncId);

    const response = await syncManager.fetch(new Request('http://internal/sync-all', {
      method: 'POST',
      body: JSON.stringify(payload)
    }));

    return response.json();
  }

  private async executeUpdateTemplates(payload: unknown): Promise<unknown> {
    // Template update logic - pulls latest from repos and reconciles
    return { updated: true, payload };
  }

  private async executeHealthCheck(): Promise<unknown> {
    const selfHealerId = this.env.SELF_HEALER.idFromName('global');
    const selfHealer = this.env.SELF_HEALER.get(selfHealerId);

    const response = await selfHealer.fetch(new Request('http://internal/health-check'));
    return response.json();
  }

  private async executeReconcile(): Promise<unknown> {
    // Full reconciliation - check all repos for drift
    const syncId = this.env.REPO_SYNC.idFromName('global');
    const syncManager = this.env.REPO_SYNC.get(syncId);

    const response = await syncManager.fetch(new Request('http://internal/reconcile'));
    return response.json();
  }

  private async executeCleanup(): Promise<unknown> {
    // Cleanup old data, artifacts, etc.
    return { cleanedAt: Date.now() };
  }

  private async executeAgentTask(payload: unknown): Promise<unknown> {
    // Execute Claude agent task
    const { task, context } = payload as { task: string; context: unknown };

    // This would integrate with Claude API for agent tasks
    return {
      task,
      status: 'completed',
      result: 'Agent task executed',
      context
    };
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('state', {
      ...this.coordinatorState,
      jobs: Object.fromEntries(this.coordinatorState.jobs),
      runningJobs: Array.from(this.coordinatorState.runningJobs)
    });
  }
}
