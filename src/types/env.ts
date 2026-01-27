/**
 * Environment bindings and type definitions
 */

export interface Env {
  // Durable Objects
  JOB_COORDINATOR: DurableObjectNamespace;
  REPO_SYNC: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;

  // KV Namespaces
  JOBS_CACHE: KVNamespace;
  REPO_STATE: KVNamespace;

  // D1 Database
  DB: D1Database;

  // Queues
  JOBS_QUEUE: Queue<JobMessage>;
  DEAD_LETTER_QUEUE: Queue<FailedJobMessage>;

  // R2 Storage
  ARTIFACTS: R2Bucket;

  // Environment Variables
  ENVIRONMENT: 'development' | 'staging' | 'production';
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  SELF_HEAL_ENABLED: string;
  AUTO_UPDATE_ENABLED: string;
  MAX_RETRY_ATTEMPTS: string;
  RETRY_BACKOFF_MS: string;

  // Secrets
  GITHUB_TOKEN: string;
  WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
}

export interface JobMessage {
  id: string;
  type: JobType;
  payload: unknown;
  priority: number;
  createdAt: number;
  retryCount: number;
}

export interface FailedJobMessage extends JobMessage {
  error: string;
  failedAt: number;
}

export type JobType =
  | 'scrape-repo'
  | 'sync-repos'
  | 'update-templates'
  | 'health-check'
  | 'self-heal'
  | 'reconcile'
  | 'cleanup'
  | 'agent-task';

export interface RepoConfig {
  owner: string;
  name: string;
  branch: string;
  paths: string[];
  syncEnabled: boolean;
  scrapeInterval: number;
}

export interface JobStatus {
  id: string;
  type: JobType;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'retrying';
  progress: number;
  result?: unknown;
  error?: string;
  startedAt?: number;
  completedAt?: number;
  retryCount: number;
}

export interface HealthStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  components: {
    name: string;
    status: 'healthy' | 'degraded' | 'unhealthy';
    lastCheck: number;
    message?: string;
  }[];
  lastUpdated: number;
}

export interface SelfHealAction {
  id: string;
  type: 'retry' | 'restart' | 'failover' | 'escalate' | 'notify';
  target: string;
  reason: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: number;
  executedAt?: number;
}
