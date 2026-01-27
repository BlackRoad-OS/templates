/**
 * Webhook routes for auto-updates from GitHub
 *
 * Handles:
 * - Push events for automatic repo syncing
 * - Pull request events for validation
 * - Release events for deployment triggers
 */

import { Hono } from 'hono';
import { Env } from '../types/env';
import { BLACKROAD_REPOS } from '../types/repos';

export const webhooksRouter = new Hono<{ Bindings: Env }>();

// Verify webhook signature
async function verifySignature(
  secret: string,
  signature: string | null,
  body: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return signature === expected;
}

// GitHub webhook handler
webhooksRouter.post('/github', async (c) => {
  const body = await c.req.text();
  const signature = c.req.header('X-Hub-Signature-256');
  const event = c.req.header('X-GitHub-Event');

  // Verify signature in production
  if (c.env.ENVIRONMENT === 'production') {
    const valid = await verifySignature(c.env.WEBHOOK_SECRET, signature, body);
    if (!valid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  const payload = JSON.parse(body);

  switch (event) {
    case 'push':
      return handlePush(c, payload);
    case 'pull_request':
      return handlePullRequest(c, payload);
    case 'release':
      return handleRelease(c, payload);
    case 'workflow_run':
      return handleWorkflowRun(c, payload);
    case 'ping':
      return c.json({ message: 'pong', received: true });
    default:
      return c.json({ message: `Event ${event} received but not handled` });
  }
});

// Handle push events - trigger auto-sync
async function handlePush(c: any, payload: any) {
  const repoFullName = payload.repository?.full_name;
  const branch = payload.ref?.replace('refs/heads/', '');
  const commits = payload.commits || [];

  console.log(`Push received: ${repoFullName}@${branch} (${commits.length} commits)`);

  // Find matching repo config
  const config = BLACKROAD_REPOS.find(
    r => `${r.owner}/${r.name}` === repoFullName
  );

  if (!config) {
    return c.json({
      message: 'Repository not in sync list',
      repo: repoFullName
    });
  }

  if (branch !== config.branch) {
    return c.json({
      message: 'Push not on tracked branch',
      repo: repoFullName,
      branch,
      tracked: config.branch
    });
  }

  if (!config.syncEnabled) {
    return c.json({
      message: 'Sync disabled for this repository',
      repo: repoFullName
    });
  }

  // Trigger sync via RepoSyncManager
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/webhook', {
    method: 'POST',
    headers: { 'X-GitHub-Event': 'push' },
    body: JSON.stringify(payload)
  }));

  const result = await response.json();

  // Also submit as a job for tracking
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify({
      type: 'scrape-repo',
      payload: {
        owner: config.owner,
        repo: config.name,
        branch: config.branch,
        paths: config.paths,
        trigger: 'webhook',
        commits: commits.map((c: any) => c.id)
      },
      priority: 8 // High priority for webhook-triggered syncs
    })
  }));

  return c.json({
    message: 'Sync triggered',
    repo: repoFullName,
    branch,
    commits: commits.length,
    result
  });
}

// Handle pull request events - validate cohesion
async function handlePullRequest(c: any, payload: any) {
  const action = payload.action;
  const pr = payload.pull_request;
  const repoFullName = payload.repository?.full_name;

  console.log(`PR ${action}: ${repoFullName}#${pr.number}`);

  if (!['opened', 'synchronize', 'reopened'].includes(action)) {
    return c.json({ message: `PR action ${action} not handled` });
  }

  // Trigger cohesion check
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const syncManager = c.env.REPO_SYNC.get(syncId);

  const cohesionResponse = await syncManager.fetch(
    new Request('http://internal/cohesion')
  );
  const cohesion = await cohesionResponse.json();

  // Submit validation job
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify({
      type: 'agent-task',
      payload: {
        task: 'validate-pr-cohesion',
        context: {
          repo: repoFullName,
          pr: pr.number,
          head: pr.head.sha,
          base: pr.base.sha,
          cohesion
        }
      },
      priority: 7
    })
  }));

  return c.json({
    message: 'PR validation triggered',
    repo: repoFullName,
    pr: pr.number,
    cohesion
  });
}

// Handle release events - trigger deployment
async function handleRelease(c: any, payload: any) {
  const action = payload.action;
  const release = payload.release;
  const repoFullName = payload.repository?.full_name;

  console.log(`Release ${action}: ${repoFullName}@${release.tag_name}`);

  if (action !== 'published') {
    return c.json({ message: `Release action ${action} not handled` });
  }

  // Submit deployment job
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify({
      type: 'update-templates',
      payload: {
        repo: repoFullName,
        tag: release.tag_name,
        trigger: 'release'
      },
      priority: 9 // Highest priority for releases
    })
  }));

  return c.json({
    message: 'Deployment triggered',
    repo: repoFullName,
    tag: release.tag_name
  });
}

// Handle workflow run events
async function handleWorkflowRun(c: any, payload: any) {
  const action = payload.action;
  const workflow = payload.workflow_run;
  const repoFullName = payload.repository?.full_name;

  console.log(`Workflow ${action}: ${repoFullName} - ${workflow.name}`);

  if (action === 'completed' && workflow.conclusion === 'failure') {
    // Notify self-healer of workflow failure
    const selfHealerId = c.env.SELF_HEALER.idFromName('global');
    const selfHealer = c.env.SELF_HEALER.get(selfHealerId);

    await selfHealer.fetch(new Request('http://internal/report-error', {
      method: 'POST',
      body: JSON.stringify({
        error: `Workflow ${workflow.name} failed`,
        path: `workflow:${repoFullName}`,
        timestamp: Date.now()
      })
    }));
  }

  return c.json({
    message: 'Workflow event received',
    repo: repoFullName,
    workflow: workflow.name,
    conclusion: workflow.conclusion
  });
}

// Manual sync trigger endpoint
webhooksRouter.post('/trigger-sync', async (c) => {
  const { repo, force } = await c.req.json();

  const config = BLACKROAD_REPOS.find(
    r => `${r.owner}/${r.name}` === repo || r.name === repo
  );

  if (!config) {
    return c.json({ error: 'Repository not found in config' }, 404);
  }

  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify({
      type: 'scrape-repo',
      payload: {
        owner: config.owner,
        repo: config.name,
        branch: config.branch,
        paths: config.paths,
        trigger: 'manual',
        force: force || false
      },
      priority: 6
    })
  }));

  const result = await response.json();

  return c.json({
    message: 'Sync job submitted',
    repo: `${config.owner}/${config.name}`,
    result
  });
});

// Sync all repos endpoint
webhooksRouter.post('/sync-all', async (c) => {
  const coordId = c.env.JOB_COORDINATOR.idFromName('global');
  const coordinator = c.env.JOB_COORDINATOR.get(coordId);

  const response = await coordinator.fetch(new Request('http://internal/submit', {
    method: 'POST',
    body: JSON.stringify({
      type: 'sync-repos',
      payload: { trigger: 'manual' },
      priority: 5
    })
  }));

  const result = await response.json();

  return c.json({
    message: 'Full sync job submitted',
    result
  });
});
