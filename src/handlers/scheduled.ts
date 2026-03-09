/**
 * Scheduled event handlers
 *
 * Handles cron triggers for:
 * - Health checks (every 5 minutes)
 * - Repo sync checks (every 15 minutes)
 * - Full reconciliation (hourly)
 * - Cleanup and maintenance (daily)
 */

import { Env } from '../types/env';
import { BLACKROAD_REPOS } from '../types/repos';

export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const cron = event.cron;
  console.log(`Scheduled event triggered: ${cron}`);

  // Determine which handler to run based on cron pattern
  switch (cron) {
    case '*/5 * * * *':
      // Every 5 minutes: Health check & self-healing
      await handleHealthCheck(env);
      break;

    case '*/15 * * * *':
      // Every 15 minutes: Repo sync check
      await handleRepoSyncCheck(env);
      break;

    case '0 * * * *':
      // Every hour: Full reconciliation
      await handleReconciliation(env);
      break;

    case '0 0 * * *':
      // Daily: Cleanup and maintenance
      await handleMaintenance(env);
      break;

    default:
      console.log(`Unknown cron pattern: ${cron}`);
  }
}

/**
 * Health check - runs every 5 minutes
 * Checks system health and triggers self-healing if needed
 */
async function handleHealthCheck(env: Env): Promise<void> {
  console.log('Running scheduled health check...');

  if (env.SELF_HEAL_ENABLED !== 'true') {
    console.log('Self-healing disabled, skipping health check');
    return;
  }

  try {
    const selfHealerId = env.SELF_HEALER.idFromName('global');
    const selfHealer = env.SELF_HEALER.get(selfHealerId);

    const response = await selfHealer.fetch(new Request('http://internal/health-check'));
    const health = await response.json() as {
      overall: string;
      components: Array<{ name: string; status: string }>;
    };

    console.log(`Health check result: ${health.overall}`);

    // Log component status
    for (const component of health.components) {
      if (component.status !== 'healthy') {
        console.warn(`Component ${component.name} is ${component.status}`);
      }
    }
  } catch (error) {
    console.error('Health check failed:', error);

    // Report the error to self-healer
    try {
      const selfHealerId = env.SELF_HEALER.idFromName('global');
      const selfHealer = env.SELF_HEALER.get(selfHealerId);

      await selfHealer.fetch(new Request('http://internal/report-error', {
        method: 'POST',
        body: JSON.stringify({
          error: `Scheduled health check failed: ${error}`,
          path: 'scheduled:health-check',
          timestamp: Date.now()
        })
      }));
    } catch (reportError) {
      console.error('Failed to report health check error:', reportError);
    }
  }
}

/**
 * Repo sync check - runs every 15 minutes
 * Checks for repos that need syncing based on their intervals
 */
async function handleRepoSyncCheck(env: Env): Promise<void> {
  console.log('Running scheduled repo sync check...');

  if (env.AUTO_UPDATE_ENABLED !== 'true') {
    console.log('Auto-update disabled, skipping sync check');
    return;
  }

  try {
    const syncId = env.REPO_SYNC.idFromName('global');
    const syncManager = env.REPO_SYNC.get(syncId);

    // Get current sync status
    const statusResponse = await syncManager.fetch(new Request('http://internal/status'));
    const status = await statusResponse.json() as {
      repos: Array<{
        repo: string;
        lastSyncedAt: number;
        status: string;
      }>;
    };

    const now = Date.now();
    const reposToSync: string[] = [];

    // Check each repo's sync interval
    for (const config of BLACKROAD_REPOS) {
      if (!config.syncEnabled) continue;

      const repoKey = `${config.owner}/${config.name}`;
      const repoStatus = status.repos?.find(r => r.repo === repoKey);

      // Sync if:
      // - Never synced before
      // - Last sync is older than the interval
      // - Previous sync had an error
      const shouldSync =
        !repoStatus ||
        now - repoStatus.lastSyncedAt > config.scrapeInterval ||
        repoStatus.status === 'error';

      if (shouldSync) {
        reposToSync.push(repoKey);
      }
    }

    console.log(`Repos needing sync: ${reposToSync.length}`);

    // Submit sync jobs for repos that need updating
    if (reposToSync.length > 0) {
      const coordId = env.JOB_COORDINATOR.idFromName('global');
      const coordinator = env.JOB_COORDINATOR.get(coordId);

      for (const repoKey of reposToSync) {
        const [owner, name] = repoKey.split('/');
        const config = BLACKROAD_REPOS.find(
          r => r.owner === owner && r.name === name
        );

        if (config) {
          await coordinator.fetch(new Request('http://internal/submit', {
            method: 'POST',
            body: JSON.stringify({
              type: 'scrape-repo',
              payload: {
                owner: config.owner,
                repo: config.name,
                branch: config.branch,
                paths: config.paths,
                trigger: 'scheduled'
              },
              priority: 4
            })
          }));

          console.log(`Submitted sync job for ${repoKey}`);
        }
      }
    }
  } catch (error) {
    console.error('Repo sync check failed:', error);
  }
}

/**
 * Full reconciliation - runs hourly
 * Checks for drift and cohesion issues across all repos
 */
async function handleReconciliation(env: Env): Promise<void> {
  console.log('Running scheduled reconciliation...');

  try {
    const syncId = env.REPO_SYNC.idFromName('global');
    const syncManager = env.REPO_SYNC.get(syncId);

    const response = await syncManager.fetch(new Request('http://internal/reconcile', {
      method: 'POST'
    }));

    const result = await response.json() as {
      status: string;
      issues: Array<{ severity: string; message: string }>;
    };

    console.log(`Reconciliation result: ${result.status}`);

    if (result.issues && result.issues.length > 0) {
      console.log(`Found ${result.issues.length} cohesion issues`);

      // Log high-severity issues
      for (const issue of result.issues) {
        if (issue.severity === 'high' || issue.severity === 'critical') {
          console.warn(`${issue.severity.toUpperCase()}: ${issue.message}`);
        }
      }
    }
  } catch (error) {
    console.error('Reconciliation failed:', error);
  }
}

/**
 * Maintenance - runs daily
 * Cleanup old data, compact storage, etc.
 */
async function handleMaintenance(env: Env): Promise<void> {
  console.log('Running scheduled maintenance...');

  try {
    // Cleanup completed jobs older than 24 hours
    const coordId = env.JOB_COORDINATOR.idFromName('global');
    const coordinator = env.JOB_COORDINATOR.get(coordId);

    const cleanupResponse = await coordinator.fetch(
      new Request('http://internal/cleanup', { method: 'POST' })
    );
    const cleanupResult = await cleanupResponse.json() as { cleanedJobs: number };
    console.log(`Cleaned ${cleanupResult.cleanedJobs} old jobs`);

    // Cleanup old KV entries
    await cleanupOldKVEntries(env);

    // Cleanup old R2 artifacts
    await cleanupOldArtifacts(env);

    console.log('Maintenance completed');
  } catch (error) {
    console.error('Maintenance failed:', error);
  }
}

/**
 * Cleanup old KV entries
 */
async function cleanupOldKVEntries(env: Env): Promise<void> {
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();
  let deleted = 0;

  // Cleanup old escalations
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

  console.log(`Cleaned ${deleted} old KV entries`);
}

/**
 * Cleanup old R2 artifacts
 */
async function cleanupOldArtifacts(env: Env): Promise<void> {
  const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
  const now = Date.now();
  let deleted = 0;

  // List all artifacts
  const list = await env.ARTIFACTS.list({ limit: 1000 });

  for (const object of list.objects) {
    const uploadedTime = object.uploaded.getTime();
    if (now - uploadedTime > maxAge) {
      await env.ARTIFACTS.delete(object.key);
      deleted++;
    }
  }

  console.log(`Cleaned ${deleted} old R2 artifacts`);
}
