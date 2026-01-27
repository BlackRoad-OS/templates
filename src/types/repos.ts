/**
 * BlackRoad-OS Repository definitions and configurations
 * These repos are monitored, scraped, and kept in sync
 */

import { RepoConfig } from './env';

// Core BlackRoad-OS repositories to monitor and sync
export const BLACKROAD_REPOS: RepoConfig[] = [
  {
    owner: 'BlackRoad-OS',
    name: 'blackroad-prism-console',
    branch: 'main',
    paths: ['src/', 'lib/', 'config/', 'templates/'],
    syncEnabled: true,
    scrapeInterval: 15 * 60 * 1000 // 15 minutes
  },
  {
    owner: 'BlackRoad-OS',
    name: 'templates',
    branch: 'main',
    paths: ['src/', 'workers/', 'schemas/'],
    syncEnabled: true,
    scrapeInterval: 15 * 60 * 1000
  },
  {
    owner: 'BlackRoad-OS',
    name: 'infrastructure',
    branch: 'main',
    paths: ['terraform/', 'kubernetes/', 'cloudflare/'],
    syncEnabled: true,
    scrapeInterval: 30 * 60 * 1000 // 30 minutes
  },
  {
    owner: 'BlackRoad-OS',
    name: 'agent-sdk',
    branch: 'main',
    paths: ['src/', 'examples/', 'docs/'],
    syncEnabled: true,
    scrapeInterval: 15 * 60 * 1000
  },
  {
    owner: 'BlackRoad-OS',
    name: 'shared-types',
    branch: 'main',
    paths: ['types/', 'schemas/'],
    syncEnabled: true,
    scrapeInterval: 10 * 60 * 1000 // 10 minutes - types change often
  }
];

// Repository sync state
export interface RepoSyncState {
  repo: string;
  lastSyncedCommit: string;
  lastSyncedAt: number;
  status: 'synced' | 'pending' | 'syncing' | 'error';
  filesChanged: number;
  errorMessage?: string;
}

// Scraped file data
export interface ScrapedFile {
  path: string;
  content: string;
  sha: string;
  size: number;
  encoding: string;
  lastModified: number;
}

// Repository tree structure
export interface RepoTree {
  repo: string;
  branch: string;
  sha: string;
  files: ScrapedFile[];
  scrapedAt: number;
}

// Cross-repo dependency map
export interface DependencyMap {
  repo: string;
  dependencies: {
    repo: string;
    files: string[];
    type: 'import' | 'type' | 'config';
  }[];
  lastUpdated: number;
}

// Cohesion check result
export interface CohesionCheck {
  status: 'coherent' | 'drift-detected' | 'conflict';
  issues: {
    type: 'type-mismatch' | 'missing-dependency' | 'version-drift' | 'schema-conflict';
    severity: 'low' | 'medium' | 'high' | 'critical';
    source: string;
    target: string;
    message: string;
  }[];
  checkedAt: number;
}
