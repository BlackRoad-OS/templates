# ⬛⬜🛣️ BlackRoad Agent Jobs Worker

Cloudflare Workers-based system for autonomous agent job orchestration, repository scraping, auto-updates, and self-healing capabilities.

## Overview

This system provides:

- **Job Orchestration**: Distributed job coordination with exactly-once execution guarantees
- **Repository Scraping**: Automated scraping and syncing of BlackRoad-OS repositories
- **Auto-Updates**: Webhook-triggered and scheduled repository synchronization
- **Self-Healing**: Autonomous error detection, resolution, and escalation
- **Cohesion Checking**: Cross-repository dependency tracking and drift detection

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Workers                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │    Hono      │  │   Webhooks   │  │  Scheduled   │         │
│  │   Router     │◄─┤   Handler    │  │   Triggers   │         │
│  └──────┬───────┘  └──────────────┘  └──────┬───────┘         │
│         │                                    │                  │
│         ▼                                    ▼                  │
│  ┌─────────────────────────────────────────────────────┐       │
│  │              Durable Objects                         │       │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐      │       │
│  │  │    Job     │ │   Repo     │ │   Self     │      │       │
│  │  │Coordinator │ │SyncManager │ │  Healer    │      │       │
│  │  └─────┬──────┘ └─────┬──────┘ └─────┬──────┘      │       │
│  └────────│──────────────│──────────────│─────────────┘       │
│           │              │              │                      │
│           ▼              ▼              ▼                      │
│  ┌─────────────────────────────────────────────────────┐       │
│  │                 Storage Layer                        │       │
│  │  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────────┐           │       │
│  │  │ KV  │  │ D1  │  │ R2  │  │ Queues  │           │       │
│  │  └─────┘  └─────┘  └─────┘  └─────────┘           │       │
│  └─────────────────────────────────────────────────────┘       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BlackRoad-OS Repositories                    │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │ prism-console    │  │ templates        │  ...               │
│  └──────────────────┘  └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Job Orchestration
- Priority-based job queue with configurable concurrency
- Automatic retries with exponential backoff
- Dead letter queue for failed jobs
- Real-time job status tracking

### Repository Scraping
- Configurable repository monitoring
- Incremental sync (only changed files)
- Dependency mapping across repositories
- Template extraction and processing

### Auto-Updates
- GitHub webhook integration for push/PR/release events
- Scheduled sync checks (configurable intervals)
- Manual trigger endpoints
- Cohesion validation on PRs

### Self-Healing
- Continuous health monitoring
- Automatic error pattern recognition
- Learning-based resolution strategies
- Escalation for unresolvable issues

## Quick Start

### Prerequisites
- Node.js 20+
- Cloudflare account with Workers, D1, R2, and Queues enabled
- GitHub token for API access

### Installation

```bash
# Clone the repository
git clone https://github.com/BlackRoad-OS/templates.git
cd templates

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Edit .env with your values

# Set up secrets
wrangler secret put GITHUB_TOKEN
wrangler secret put WEBHOOK_SECRET
wrangler secret put ANTHROPIC_API_KEY

# Run migrations
npm run db:migrate:local

# Start development server
npm run dev
```

### Deployment

```bash
# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy:production
```

## API Endpoints

### Health
- `GET /health` - Basic health check
- `GET /health/detailed` - Detailed system status
- `GET /health/live` - Liveness probe
- `GET /health/ready` - Readiness probe
- `POST /health/heal` - Trigger manual healing

### Jobs
- `POST /jobs/submit` - Submit a new job
- `GET /jobs/status/:id` - Get job status
- `GET /jobs/list` - List all jobs
- `POST /jobs/cancel/:id` - Cancel a job
- `GET /jobs/metrics` - Job processing metrics

### Webhooks
- `POST /webhooks/github` - GitHub webhook handler
- `POST /webhooks/trigger-sync` - Manual sync trigger
- `POST /webhooks/sync-all` - Sync all repositories

### Admin
- `GET /admin/config` - System configuration
- `GET /admin/repos` - Repository sync status
- `GET /admin/cohesion` - Cohesion check results
- `POST /admin/reconcile` - Trigger reconciliation

## Configuration

### Tracked Repositories

Edit `src/types/repos.ts` to configure monitored repositories:

```typescript
export const BLACKROAD_REPOS: RepoConfig[] = [
  {
    owner: 'BlackRoad-OS',
    name: 'blackroad-prism-console',
    branch: 'main',
    paths: ['src/', 'lib/', 'config/'],
    syncEnabled: true,
    scrapeInterval: 15 * 60 * 1000 // 15 minutes
  },
  // ... more repos
];
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | Environment name | `development` |
| `LOG_LEVEL` | Logging level | `debug` |
| `SELF_HEAL_ENABLED` | Enable self-healing | `true` |
| `AUTO_UPDATE_ENABLED` | Enable auto-updates | `true` |
| `MAX_RETRY_ATTEMPTS` | Max job retries | `5` |
| `RETRY_BACKOFF_MS` | Base backoff time | `1000` |

### Secrets (via `wrangler secret put`)

- `GITHUB_TOKEN` - GitHub API access token
- `WEBHOOK_SECRET` - GitHub webhook signature secret
- `ANTHROPIC_API_KEY` - Claude API key for agent tasks

## Self-Healing System

The self-healer monitors system health and automatically resolves issues:

### Resolution Actions
- **Retry**: Re-attempt failed operations with backoff
- **Restart**: Trigger full re-sync of affected components
- **Failover**: Switch to backup systems (multi-region)
- **Escalate**: Alert for manual intervention
- **Notify**: Send notifications without action

### Resolution Patterns
The system learns from past failures:

```typescript
{
  errorPattern: 'timeout',
  action: 'retry',
  successRate: 0.8,
  timesUsed: 150
}
```

Patterns with higher success rates are preferred for similar errors.

## Development

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Run tests
npm test

# Format code
npm run format
```

## Scheduled Tasks

| Cron | Task | Description |
|------|------|-------------|
| `*/5 * * * *` | Health Check | Monitor system health |
| `*/15 * * * *` | Repo Sync Check | Check for repos needing sync |
| `0 * * * *` | Reconciliation | Full cohesion check |
| `0 0 * * *` | Maintenance | Cleanup old data |

## License

MIT - BlackRoad-OS

---

⬛⬜🛣️
