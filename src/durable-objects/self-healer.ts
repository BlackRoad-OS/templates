/**
 * SelfHealer Durable Object
 *
 * Autonomous self-healing and resolution system that:
 * - Monitors system health continuously
 * - Detects failures and anomalies
 * - Automatically triggers resolution actions
 * - Escalates when self-healing fails
 * - Learns from past failures to prevent recurrence
 */

import { Env, HealthStatus, SelfHealAction } from '../types/env';

interface HealerState {
  healthStatus: HealthStatus;
  pendingActions: Map<string, SelfHealAction>;
  completedActions: SelfHealAction[];
  errorHistory: ErrorRecord[];
  resolutionPatterns: ResolutionPattern[];
  lastHealthCheck: number;
  consecutiveFailures: number;
}

interface ErrorRecord {
  id: string;
  type: string;
  message: string;
  source: string;
  timestamp: number;
  resolved: boolean;
  resolutionAction?: string;
}

interface ResolutionPattern {
  errorPattern: string;
  action: SelfHealAction['type'];
  successRate: number;
  lastUsed: number;
  timesUsed: number;
}

export class SelfHealer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private healerState: HealerState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.healerState = {
      healthStatus: {
        overall: 'healthy',
        components: [],
        lastUpdated: 0
      },
      pendingActions: new Map(),
      completedActions: [],
      errorHistory: [],
      resolutionPatterns: this.getDefaultPatterns(),
      lastHealthCheck: 0,
      consecutiveFailures: 0
    };

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<HealerState>('state');
      if (stored) {
        this.healerState = {
          ...stored,
          pendingActions: new Map(Object.entries(stored.pendingActions || {}))
        };
      }
    });

    // Set up alarm for continuous health monitoring
    this.state.storage.setAlarm(Date.now() + 60000); // Check every minute
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/health-check':
          return this.handleHealthCheck();
        case '/report-error':
          return this.handleReportError(request);
        case '/job-failed':
          return this.handleJobFailed(request);
        case '/sync-failed':
          return this.handleSyncFailed(request);
        case '/cohesion-issue':
          return this.handleCohesionIssue(request);
        case '/trigger-heal':
          return this.handleTriggerHeal(request);
        case '/status':
          return this.handleStatus();
        case '/actions':
          return this.handleGetActions();
        case '/patterns':
          return this.handleGetPatterns();
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      console.error('SelfHealer error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  async alarm(): Promise<void> {
    // Periodic health check and self-healing
    await this.runHealthCheck();
    await this.processPendingActions();
    await this.cleanupOldRecords();

    // Schedule next alarm
    this.state.storage.setAlarm(Date.now() + 60000);
  }

  private async handleHealthCheck(): Promise<Response> {
    const health = await this.runHealthCheck();
    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleReportError(request: Request): Promise<Response> {
    const error = await request.json() as {
      error: string;
      stack?: string;
      path?: string;
      timestamp: number;
    };

    const errorRecord: ErrorRecord = {
      id: crypto.randomUUID(),
      type: 'runtime-error',
      message: error.error,
      source: error.path || 'unknown',
      timestamp: error.timestamp,
      resolved: false
    };

    this.healerState.errorHistory.push(errorRecord);
    await this.analyzeAndHeal(errorRecord);
    await this.saveState();

    return new Response(JSON.stringify({ recorded: true, errorId: errorRecord.id }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleJobFailed(request: Request): Promise<Response> {
    const { jobId, jobType, error, retryCount } = await request.json() as {
      jobId: string;
      jobType: string;
      error: string;
      retryCount: number;
    };

    const errorRecord: ErrorRecord = {
      id: crypto.randomUUID(),
      type: 'job-failure',
      message: `Job ${jobType} failed: ${error}`,
      source: `job:${jobId}`,
      timestamp: Date.now(),
      resolved: false
    };

    this.healerState.errorHistory.push(errorRecord);

    // Determine healing action based on job type and retry count
    if (retryCount >= parseInt(this.env.MAX_RETRY_ATTEMPTS || '5')) {
      // Max retries exceeded - escalate
      await this.createHealAction({
        type: 'escalate',
        target: `job:${jobId}`,
        reason: `Job ${jobType} failed after ${retryCount} retries: ${error}`
      });
    } else {
      // Analyze and attempt auto-heal
      await this.analyzeAndHeal(errorRecord);
    }

    await this.saveState();

    return new Response(JSON.stringify({ handled: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleSyncFailed(request: Request): Promise<Response> {
    const { repo, error } = await request.json() as {
      repo: string;
      error: string;
    };

    const errorRecord: ErrorRecord = {
      id: crypto.randomUUID(),
      type: 'sync-failure',
      message: `Sync failed for ${repo}: ${error}`,
      source: `repo:${repo}`,
      timestamp: Date.now(),
      resolved: false
    };

    this.healerState.errorHistory.push(errorRecord);

    // Auto-heal: retry sync with backoff
    await this.createHealAction({
      type: 'retry',
      target: `repo:${repo}`,
      reason: `Sync failed: ${error}`
    });

    await this.saveState();

    return new Response(JSON.stringify({ handled: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCohesionIssue(request: Request): Promise<Response> {
    const issue = await request.json() as {
      type: string;
      severity: string;
      source: string;
      target: string;
      message: string;
    };

    const errorRecord: ErrorRecord = {
      id: crypto.randomUUID(),
      type: 'cohesion-issue',
      message: issue.message,
      source: `${issue.source}->${issue.target}`,
      timestamp: Date.now(),
      resolved: false
    };

    this.healerState.errorHistory.push(errorRecord);

    if (issue.severity === 'critical') {
      // Immediate escalation for critical issues
      await this.createHealAction({
        type: 'escalate',
        target: issue.source,
        reason: `Critical cohesion issue: ${issue.message}`
      });
    } else {
      // Attempt auto-resolution
      await this.createHealAction({
        type: 'restart',
        target: issue.source,
        reason: `Cohesion drift detected: ${issue.message}`
      });
    }

    await this.saveState();

    return new Response(JSON.stringify({ handled: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleTriggerHeal(request: Request): Promise<Response> {
    const { target, action } = await request.json() as {
      target: string;
      action: SelfHealAction['type'];
    };

    await this.createHealAction({
      type: action,
      target,
      reason: 'Manual trigger'
    });

    await this.processPendingActions();
    await this.saveState();

    return new Response(JSON.stringify({ triggered: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleStatus(): Promise<Response> {
    return new Response(JSON.stringify({
      health: this.healerState.healthStatus,
      pendingActions: Array.from(this.healerState.pendingActions.values()),
      recentErrors: this.healerState.errorHistory.slice(-20),
      consecutiveFailures: this.healerState.consecutiveFailures
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetActions(): Promise<Response> {
    return new Response(JSON.stringify({
      pending: Array.from(this.healerState.pendingActions.values()),
      completed: this.healerState.completedActions.slice(-50)
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetPatterns(): Promise<Response> {
    return new Response(JSON.stringify(this.healerState.resolutionPatterns), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async runHealthCheck(): Promise<HealthStatus> {
    const components: HealthStatus['components'] = [];

    // Check Job Coordinator
    try {
      const coordId = this.env.JOB_COORDINATOR.idFromName('global');
      const coordinator = this.env.JOB_COORDINATOR.get(coordId);
      const response = await coordinator.fetch(new Request('http://internal/metrics'));
      const metrics = await response.json();

      components.push({
        name: 'job-coordinator',
        status: 'healthy',
        lastCheck: Date.now(),
        message: `Processed: ${(metrics as { totalJobsProcessed: number }).totalJobsProcessed}`
      });
    } catch (error) {
      components.push({
        name: 'job-coordinator',
        status: 'unhealthy',
        lastCheck: Date.now(),
        message: String(error)
      });
    }

    // Check Repo Sync Manager
    try {
      const syncId = this.env.REPO_SYNC.idFromName('global');
      const syncManager = this.env.REPO_SYNC.get(syncId);
      const response = await syncManager.fetch(new Request('http://internal/status'));
      const status = await response.json();

      const repos = (status as { repos: Array<{ status: string }> }).repos || [];
      const errorCount = repos.filter((r: { status: string }) => r.status === 'error').length;

      components.push({
        name: 'repo-sync',
        status: errorCount > 0 ? 'degraded' : 'healthy',
        lastCheck: Date.now(),
        message: `${repos.length} repos tracked, ${errorCount} in error`
      });
    } catch (error) {
      components.push({
        name: 'repo-sync',
        status: 'unhealthy',
        lastCheck: Date.now(),
        message: String(error)
      });
    }

    // Check KV health
    try {
      await this.env.JOBS_CACHE.put('health-check', Date.now().toString());
      const val = await this.env.JOBS_CACHE.get('health-check');
      components.push({
        name: 'kv-storage',
        status: val ? 'healthy' : 'degraded',
        lastCheck: Date.now()
      });
    } catch (error) {
      components.push({
        name: 'kv-storage',
        status: 'unhealthy',
        lastCheck: Date.now(),
        message: String(error)
      });
    }

    // Calculate overall health
    const unhealthyCount = components.filter(c => c.status === 'unhealthy').length;
    const degradedCount = components.filter(c => c.status === 'degraded').length;

    let overall: HealthStatus['overall'] = 'healthy';
    if (unhealthyCount > 0) {
      overall = 'unhealthy';
      this.healerState.consecutiveFailures++;
    } else if (degradedCount > 0) {
      overall = 'degraded';
    } else {
      this.healerState.consecutiveFailures = 0;
    }

    // Trigger self-healing if consecutive failures exceed threshold
    if (this.healerState.consecutiveFailures >= 3) {
      await this.triggerEmergencyHeal();
    }

    this.healerState.healthStatus = {
      overall,
      components,
      lastUpdated: Date.now()
    };

    this.healerState.lastHealthCheck = Date.now();
    await this.saveState();

    return this.healerState.healthStatus;
  }

  private async analyzeAndHeal(error: ErrorRecord): Promise<void> {
    // Find matching resolution pattern
    const pattern = this.healerState.resolutionPatterns.find(p =>
      error.message.toLowerCase().includes(p.errorPattern.toLowerCase())
    );

    if (pattern && pattern.successRate > 0.5) {
      // Use known successful pattern
      await this.createHealAction({
        type: pattern.action,
        target: error.source,
        reason: error.message
      });

      pattern.lastUsed = Date.now();
      pattern.timesUsed++;
    } else {
      // Default resolution strategy
      await this.createHealAction({
        type: 'retry',
        target: error.source,
        reason: error.message
      });
    }
  }

  private async createHealAction(params: {
    type: SelfHealAction['type'];
    target: string;
    reason: string;
  }): Promise<SelfHealAction> {
    const action: SelfHealAction = {
      id: crypto.randomUUID(),
      type: params.type,
      target: params.target,
      reason: params.reason,
      status: 'pending',
      createdAt: Date.now()
    };

    this.healerState.pendingActions.set(action.id, action);
    return action;
  }

  private async processPendingActions(): Promise<void> {
    for (const [id, action] of this.healerState.pendingActions) {
      if (action.status !== 'pending') continue;

      action.status = 'executing';
      action.executedAt = Date.now();

      try {
        await this.executeHealAction(action);
        action.status = 'completed';

        // Update resolution pattern success rate
        this.updatePatternSuccess(action, true);

        // Mark related errors as resolved
        this.healerState.errorHistory
          .filter(e => e.source === action.target && !e.resolved)
          .forEach(e => {
            e.resolved = true;
            e.resolutionAction = action.id;
          });
      } catch (error) {
        action.status = 'failed';
        console.error(`Heal action ${action.id} failed:`, error);

        // Update resolution pattern failure
        this.updatePatternSuccess(action, false);

        // Escalate if healing fails
        if (action.type !== 'escalate') {
          await this.createHealAction({
            type: 'escalate',
            target: action.target,
            reason: `Self-healing failed: ${error}`
          });
        }
      }

      // Move to completed
      this.healerState.pendingActions.delete(id);
      this.healerState.completedActions.push(action);
    }
  }

  private async executeHealAction(action: SelfHealAction): Promise<void> {
    console.log(`Executing heal action: ${action.type} on ${action.target}`);

    switch (action.type) {
      case 'retry':
        await this.executeRetry(action);
        break;
      case 'restart':
        await this.executeRestart(action);
        break;
      case 'failover':
        await this.executeFailover(action);
        break;
      case 'escalate':
        await this.executeEscalate(action);
        break;
      case 'notify':
        await this.executeNotify(action);
        break;
    }
  }

  private async executeRetry(action: SelfHealAction): Promise<void> {
    const [type, id] = action.target.split(':');

    if (type === 'repo') {
      // Retry repo sync
      const syncId = this.env.REPO_SYNC.idFromName(id);
      const syncManager = this.env.REPO_SYNC.get(syncId);

      // Wait with exponential backoff
      await new Promise(r => setTimeout(r, 2000));

      await syncManager.fetch(new Request('http://internal/scrape', {
        method: 'POST',
        body: JSON.stringify({ repo: id.split('/')[1], owner: id.split('/')[0] })
      }));
    } else if (type === 'job') {
      // Re-queue job
      const coordId = this.env.JOB_COORDINATOR.idFromName('global');
      const coordinator = this.env.JOB_COORDINATOR.get(coordId);

      await coordinator.fetch(new Request('http://internal/process', {
        method: 'POST'
      }));
    }
  }

  private async executeRestart(action: SelfHealAction): Promise<void> {
    // Trigger full sync for the component
    const syncId = this.env.REPO_SYNC.idFromName('global');
    const syncManager = this.env.REPO_SYNC.get(syncId);

    await syncManager.fetch(new Request('http://internal/sync-all', {
      method: 'POST'
    }));
  }

  private async executeFailover(action: SelfHealAction): Promise<void> {
    // In a multi-region setup, this would switch to backup
    // For now, just log and proceed
    console.log(`Failover triggered for: ${action.target}`);
  }

  private async executeEscalate(action: SelfHealAction): Promise<void> {
    // Send notification about critical issue
    console.error(`ESCALATION: ${action.reason} - Target: ${action.target}`);

    // Store escalation for external monitoring
    await this.env.JOBS_CACHE.put(
      `escalation:${action.id}`,
      JSON.stringify(action),
      { expirationTtl: 86400 } // 24 hours
    );

    // Could integrate with PagerDuty, Slack, etc.
  }

  private async executeNotify(action: SelfHealAction): Promise<void> {
    // Send notification
    console.log(`Notification: ${action.reason}`);
  }

  private async triggerEmergencyHeal(): Promise<void> {
    console.error('EMERGENCY: Multiple consecutive health check failures');

    // Create emergency escalation
    await this.createHealAction({
      type: 'escalate',
      target: 'system',
      reason: `Emergency: ${this.healerState.consecutiveFailures} consecutive health check failures`
    });

    // Attempt system restart
    await this.createHealAction({
      type: 'restart',
      target: 'system',
      reason: 'Emergency restart due to health check failures'
    });

    await this.processPendingActions();
  }

  private updatePatternSuccess(action: SelfHealAction, success: boolean): void {
    // Find or create pattern
    let pattern = this.healerState.resolutionPatterns.find(
      p => p.action === action.type
    );

    if (!pattern) {
      pattern = {
        errorPattern: action.reason.substring(0, 50),
        action: action.type,
        successRate: success ? 1 : 0,
        lastUsed: Date.now(),
        timesUsed: 1
      };
      this.healerState.resolutionPatterns.push(pattern);
    } else {
      // Update success rate with exponential moving average
      const alpha = 0.3;
      pattern.successRate = alpha * (success ? 1 : 0) + (1 - alpha) * pattern.successRate;
      pattern.timesUsed++;
      pattern.lastUsed = Date.now();
    }
  }

  private getDefaultPatterns(): ResolutionPattern[] {
    return [
      {
        errorPattern: 'timeout',
        action: 'retry',
        successRate: 0.8,
        lastUsed: 0,
        timesUsed: 0
      },
      {
        errorPattern: 'rate limit',
        action: 'retry',
        successRate: 0.9,
        lastUsed: 0,
        timesUsed: 0
      },
      {
        errorPattern: 'connection',
        action: 'retry',
        successRate: 0.7,
        lastUsed: 0,
        timesUsed: 0
      },
      {
        errorPattern: 'not found',
        action: 'notify',
        successRate: 0.5,
        lastUsed: 0,
        timesUsed: 0
      },
      {
        errorPattern: 'permission',
        action: 'escalate',
        successRate: 0.9,
        lastUsed: 0,
        timesUsed: 0
      }
    ];
  }

  private async cleanupOldRecords(): Promise<void> {
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();

    this.healerState.errorHistory = this.healerState.errorHistory.filter(
      e => now - e.timestamp < maxAge
    );

    this.healerState.completedActions = this.healerState.completedActions.filter(
      a => a.executedAt && now - a.executedAt < maxAge
    );
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('state', {
      ...this.healerState,
      pendingActions: Object.fromEntries(this.healerState.pendingActions)
    });
  }
}
