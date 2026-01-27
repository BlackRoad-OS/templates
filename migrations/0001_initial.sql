-- Initial schema for BlackRoad Agent Jobs
-- D1 Database: blackroad-jobs

-- Job history table
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payload TEXT,
    result TEXT,
    error TEXT,
    priority INTEGER DEFAULT 5,
    retry_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    CONSTRAINT valid_status CHECK (status IN ('pending', 'running', 'completed', 'failed', 'retrying'))
);

-- Index for querying jobs by status
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Index for querying jobs by type
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_jobs_completed_at ON jobs(completed_at);

-- Repo sync state table
CREATE TABLE IF NOT EXISTS repo_sync_state (
    repo TEXT PRIMARY KEY,
    last_synced_commit TEXT,
    last_synced_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    files_changed INTEGER DEFAULT 0,
    error_message TEXT,
    CONSTRAINT valid_status CHECK (status IN ('synced', 'pending', 'syncing', 'error'))
);

-- Health check history
CREATE TABLE IF NOT EXISTS health_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    overall_status TEXT NOT NULL,
    components TEXT NOT NULL, -- JSON array
    checked_at INTEGER NOT NULL
);

-- Index for health check history queries
CREATE INDEX IF NOT EXISTS idx_health_checks_at ON health_checks(checked_at);

-- Error history table
CREATE TABLE IF NOT EXISTS error_history (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    source TEXT,
    resolved INTEGER DEFAULT 0,
    resolution_action TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);

-- Index for unresolved errors
CREATE INDEX IF NOT EXISTS idx_errors_unresolved ON error_history(resolved) WHERE resolved = 0;

-- Self-heal actions table
CREATE TABLE IF NOT EXISTS heal_actions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    executed_at INTEGER,
    CONSTRAINT valid_type CHECK (type IN ('retry', 'restart', 'failover', 'escalate', 'notify')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'executing', 'completed', 'failed'))
);

-- Dependency map table
CREATE TABLE IF NOT EXISTS dependencies (
    source_repo TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    file_path TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'import',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source_repo, target_repo, file_path),
    CONSTRAINT valid_type CHECK (type IN ('import', 'type', 'config'))
);

-- Cohesion issues table
CREATE TABLE IF NOT EXISTS cohesion_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    message TEXT NOT NULL,
    resolved INTEGER DEFAULT 0,
    detected_at INTEGER NOT NULL,
    resolved_at INTEGER,
    CONSTRAINT valid_severity CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

-- Index for unresolved cohesion issues
CREATE INDEX IF NOT EXISTS idx_cohesion_unresolved ON cohesion_issues(resolved) WHERE resolved = 0;
