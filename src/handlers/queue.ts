/**
 * Queue message handlers
 *
 * Processes messages from the Cloudflare Queue for async job execution
 */

import { Env, JobMessage, FailedJobMessage } from '../types/env';

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  console.log(`Processing queue batch: ${batch.messages.length} messages`);

  for (const message of batch.messages) {
    const jobMessage = message.body as JobMessage;

    try {
      await processJobMessage(jobMessage, env);
      message.ack();
    } catch (error) {
      console.error(`Failed to process job ${jobMessage.id}:`, error);

      // Retry logic is handled by Cloudflare Queues
      // After max retries, message goes to DLQ
      if (message.attempts >= parseInt(env.MAX_RETRY_ATTEMPTS || '5')) {
        // Store in KV for visibility
        const failedJob: FailedJobMessage = {
          ...jobMessage,
          error: String(error),
          failedAt: Date.now()
        };

        await env.JOBS_CACHE.put(
          `dlq:${jobMessage.id}`,
          JSON.stringify(failedJob),
          { expirationTtl: 7 * 24 * 60 * 60 } // 7 days
        );

        // Notify self-healer
        const selfHealerId = env.SELF_HEALER.idFromName('global');
        const selfHealer = env.SELF_HEALER.get(selfHealerId);

        await selfHealer.fetch(new Request('http://internal/job-failed', {
          method: 'POST',
          body: JSON.stringify({
            jobId: jobMessage.id,
            jobType: jobMessage.type,
            error: String(error),
            retryCount: message.attempts
          })
        }));

        message.ack(); // Acknowledge to prevent further retries
      } else {
        message.retry(); // Retry the message
      }
    }
  }
}

/**
 * Process individual job message
 */
async function processJobMessage(job: JobMessage, env: Env): Promise<void> {
  console.log(`Processing job: ${job.type} (${job.id})`);

  // Update job status to running via coordinator
  const coordId = env.JOB_COORDINATOR.idFromName('global');
  const coordinator = env.JOB_COORDINATOR.get(coordId);

  switch (job.type) {
    case 'scrape-repo':
      await handleScrapeRepo(job, env);
      break;

    case 'sync-repos':
      await handleSyncRepos(job, env);
      break;

    case 'update-templates':
      await handleUpdateTemplates(job, env);
      break;

    case 'health-check':
      await handleHealthCheck(job, env);
      break;

    case 'self-heal':
      await handleSelfHeal(job, env);
      break;

    case 'reconcile':
      await handleReconcile(job, env);
      break;

    case 'cleanup':
      await handleCleanup(job, env);
      break;

    case 'agent-task':
      await handleAgentTask(job, env);
      break;

    default:
      throw new Error(`Unknown job type: ${job.type}`);
  }

  console.log(`Job completed: ${job.type} (${job.id})`);
}

/**
 * Handle repo scraping job
 */
async function handleScrapeRepo(job: JobMessage, env: Env): Promise<void> {
  const { owner, repo, branch, paths } = job.payload as {
    owner: string;
    repo: string;
    branch?: string;
    paths?: string[];
  };

  const syncId = env.REPO_SYNC.idFromName(`${owner}/${repo}`);
  const syncManager = env.REPO_SYNC.get(syncId);

  await syncManager.fetch(new Request('http://internal/scrape', {
    method: 'POST',
    body: JSON.stringify({ owner, repo, branch, paths })
  }));
}

/**
 * Handle sync all repos job
 */
async function handleSyncRepos(job: JobMessage, env: Env): Promise<void> {
  const syncId = env.REPO_SYNC.idFromName('global');
  const syncManager = env.REPO_SYNC.get(syncId);

  await syncManager.fetch(new Request('http://internal/sync-all', {
    method: 'POST'
  }));
}

/**
 * Handle template update job
 */
async function handleUpdateTemplates(job: JobMessage, env: Env): Promise<void> {
  const { repo, tag } = job.payload as {
    repo: string;
    tag: string;
  };

  console.log(`Updating templates from ${repo}@${tag}`);

  // Fetch latest from repo
  const syncId = env.REPO_SYNC.idFromName(repo);
  const syncManager = env.REPO_SYNC.get(syncId);

  // Get the tree for this repo
  const treeData = await env.REPO_STATE.get(`tree:${repo}`);
  if (!treeData) {
    throw new Error(`No tree data found for ${repo}`);
  }

  const tree = JSON.parse(treeData);

  // Process templates
  // This would extract and process template files from the tree
  console.log(`Processing ${tree.files.length} files from ${repo}`);

  // Store processed templates
  await env.ARTIFACTS.put(
    `templates/${repo}/${tag}/manifest.json`,
    JSON.stringify({
      repo,
      tag,
      processedAt: Date.now(),
      fileCount: tree.files.length
    })
  );
}

/**
 * Handle health check job
 */
async function handleHealthCheck(job: JobMessage, env: Env): Promise<void> {
  const selfHealerId = env.SELF_HEALER.idFromName('global');
  const selfHealer = env.SELF_HEALER.get(selfHealerId);

  await selfHealer.fetch(new Request('http://internal/health-check'));
}

/**
 * Handle self-heal job
 */
async function handleSelfHeal(job: JobMessage, env: Env): Promise<void> {
  const { target, action } = job.payload as {
    target: string;
    action: string;
  };

  const selfHealerId = env.SELF_HEALER.idFromName('global');
  const selfHealer = env.SELF_HEALER.get(selfHealerId);

  await selfHealer.fetch(new Request('http://internal/trigger-heal', {
    method: 'POST',
    body: JSON.stringify({ target, action })
  }));
}

/**
 * Handle reconciliation job
 */
async function handleReconcile(job: JobMessage, env: Env): Promise<void> {
  const syncId = env.REPO_SYNC.idFromName('global');
  const syncManager = env.REPO_SYNC.get(syncId);

  await syncManager.fetch(new Request('http://internal/reconcile', {
    method: 'POST'
  }));
}

/**
 * Handle cleanup job
 */
async function handleCleanup(job: JobMessage, env: Env): Promise<void> {
  // Cleanup jobs
  const coordId = env.JOB_COORDINATOR.idFromName('global');
  const coordinator = env.JOB_COORDINATOR.get(coordId);

  await coordinator.fetch(new Request('http://internal/cleanup', {
    method: 'POST'
  }));
}

/**
 * Handle agent task job
 *
 * This integrates with Claude API to execute agent tasks
 */
async function handleAgentTask(job: JobMessage, env: Env): Promise<void> {
  const { task, context } = job.payload as {
    task: string;
    context: unknown;
  };

  console.log(`Executing agent task: ${task}`);

  // In a full implementation, this would:
  // 1. Call Claude API with the task and context
  // 2. Process the response
  // 3. Execute any actions the agent suggests
  // 4. Store results

  // For now, we'll log and store a placeholder result
  const result = {
    task,
    context,
    executedAt: Date.now(),
    status: 'completed',
    output: `Agent task "${task}" executed successfully`
  };

  // Store result
  await env.JOBS_CACHE.put(
    `agent-task:${job.id}`,
    JSON.stringify(result),
    { expirationTtl: 24 * 60 * 60 } // 24 hours
  );

  // If this is a cohesion validation task, process accordingly
  if (task === 'validate-pr-cohesion') {
    await handleCohesionValidation(context, env);
  }
}

/**
 * Handle PR cohesion validation
 */
async function handleCohesionValidation(context: unknown, env: Env): Promise<void> {
  const { repo, pr, cohesion } = context as {
    repo: string;
    pr: number;
    cohesion: { status: string; issues: unknown[] };
  };

  console.log(`Validating PR cohesion for ${repo}#${pr}`);

  // If there are cohesion issues, this could:
  // 1. Post a comment on the PR
  // 2. Create status checks
  // 3. Block the PR if critical issues found

  if (cohesion.status !== 'coherent') {
    console.warn(`PR ${repo}#${pr} has cohesion issues: ${cohesion.status}`);
    // Integration with GitHub would go here
  }
}
