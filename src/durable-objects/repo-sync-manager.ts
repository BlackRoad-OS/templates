/**
 * RepoSyncManager Durable Object
 *
 * Manages repository scraping, synchronization, and cohesion checks
 * across all BlackRoad-OS repositories.
 */

import { Env } from '../types/env';
import {
  BLACKROAD_REPOS,
  RepoSyncState,
  ScrapedFile,
  RepoTree,
  CohesionCheck,
  DependencyMap
} from '../types/repos';

interface SyncManagerState {
  repoStates: Map<string, RepoSyncState>;
  lastFullSync: number;
  dependencyMaps: Map<string, DependencyMap>;
  cohesionStatus: CohesionCheck | null;
}

export class RepoSyncManager implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private syncState: SyncManagerState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.syncState = {
      repoStates: new Map(),
      lastFullSync: 0,
      dependencyMaps: new Map(),
      cohesionStatus: null
    };

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<SyncManagerState>('state');
      if (stored) {
        this.syncState = {
          ...stored,
          repoStates: new Map(Object.entries(stored.repoStates || {})),
          dependencyMaps: new Map(Object.entries(stored.dependencyMaps || {}))
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case '/scrape':
          return this.handleScrape(request);
        case '/sync-all':
          return this.handleSyncAll();
        case '/reconcile':
          return this.handleReconcile();
        case '/status':
          return this.handleStatus();
        case '/cohesion':
          return this.handleCohesionCheck();
        case '/dependencies':
          return this.handleGetDependencies();
        case '/webhook':
          return this.handleWebhook(request);
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      console.error('RepoSyncManager error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  private async handleScrape(request: Request): Promise<Response> {
    const { repo, owner, branch, paths } = await request.json() as {
      repo: string;
      owner: string;
      branch?: string;
      paths?: string[];
    };

    const repoKey = `${owner}/${repo}`;
    const targetBranch = branch || 'main';
    const targetPaths = paths || [''];

    // Update state to syncing
    const currentState = this.syncState.repoStates.get(repoKey) || {
      repo: repoKey,
      lastSyncedCommit: '',
      lastSyncedAt: 0,
      status: 'pending' as const,
      filesChanged: 0
    };
    currentState.status = 'syncing';
    this.syncState.repoStates.set(repoKey, currentState);
    await this.saveState();

    try {
      // Fetch latest commit
      const commitResponse = await this.githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${targetBranch}`
      );
      const commitData = await commitResponse.json() as { sha: string };
      const latestCommit = commitData.sha;

      // Check if we need to sync
      if (latestCommit === currentState.lastSyncedCommit) {
        currentState.status = 'synced';
        currentState.lastSyncedAt = Date.now();
        this.syncState.repoStates.set(repoKey, currentState);
        await this.saveState();

        return new Response(JSON.stringify({
          status: 'up-to-date',
          commit: latestCommit
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Scrape files from specified paths
      const scrapedFiles: ScrapedFile[] = [];
      for (const path of targetPaths) {
        const files = await this.scrapeDirectory(owner, repo, targetBranch, path);
        scrapedFiles.push(...files);
      }

      // Store scraped data
      const repoTree: RepoTree = {
        repo: repoKey,
        branch: targetBranch,
        sha: latestCommit,
        files: scrapedFiles,
        scrapedAt: Date.now()
      };

      // Store in KV for fast access
      await this.env.REPO_STATE.put(
        `tree:${repoKey}`,
        JSON.stringify(repoTree),
        { expirationTtl: 3600 } // 1 hour TTL
      );

      // Store in R2 for archival
      await this.env.ARTIFACTS.put(
        `repos/${repoKey}/${latestCommit}.json`,
        JSON.stringify(repoTree)
      );

      // Update dependency map
      await this.updateDependencyMap(repoKey, scrapedFiles);

      // Update state
      currentState.status = 'synced';
      currentState.lastSyncedCommit = latestCommit;
      currentState.lastSyncedAt = Date.now();
      currentState.filesChanged = scrapedFiles.length;
      this.syncState.repoStates.set(repoKey, currentState);
      await this.saveState();

      // Trigger cohesion check
      this.state.waitUntil(this.runCohesionCheck());

      return new Response(JSON.stringify({
        status: 'synced',
        commit: latestCommit,
        filesScraped: scrapedFiles.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      currentState.status = 'error';
      currentState.errorMessage = String(error);
      this.syncState.repoStates.set(repoKey, currentState);
      await this.saveState();

      // Trigger self-healing
      const selfHealerId = this.env.SELF_HEALER.idFromName('global');
      const selfHealer = this.env.SELF_HEALER.get(selfHealerId);
      await selfHealer.fetch(new Request('http://internal/sync-failed', {
        method: 'POST',
        body: JSON.stringify({
          repo: repoKey,
          error: String(error)
        })
      }));

      throw error;
    }
  }

  private async handleSyncAll(): Promise<Response> {
    const results: { repo: string; status: string; error?: string }[] = [];

    for (const config of BLACKROAD_REPOS) {
      if (!config.syncEnabled) continue;

      try {
        const response = await this.fetch(new Request('http://internal/scrape', {
          method: 'POST',
          body: JSON.stringify({
            owner: config.owner,
            repo: config.name,
            branch: config.branch,
            paths: config.paths
          })
        }));

        const result = await response.json() as { status: string };
        results.push({
          repo: `${config.owner}/${config.name}`,
          status: result.status
        });
      } catch (error) {
        results.push({
          repo: `${config.owner}/${config.name}`,
          status: 'error',
          error: String(error)
        });
      }
    }

    this.syncState.lastFullSync = Date.now();
    await this.saveState();

    return new Response(JSON.stringify({
      syncedAt: this.syncState.lastFullSync,
      results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleReconcile(): Promise<Response> {
    // Check for drift between repos
    const cohesion = await this.runCohesionCheck();

    if (cohesion.status !== 'coherent') {
      // Trigger auto-resolution for detected issues
      for (const issue of cohesion.issues) {
        if (issue.severity === 'critical' || issue.severity === 'high') {
          // Notify self-healer
          const selfHealerId = this.env.SELF_HEALER.idFromName('global');
          const selfHealer = this.env.SELF_HEALER.get(selfHealerId);
          await selfHealer.fetch(new Request('http://internal/cohesion-issue', {
            method: 'POST',
            body: JSON.stringify(issue)
          }));
        }
      }
    }

    return new Response(JSON.stringify(cohesion), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleStatus(): Promise<Response> {
    const states = Array.from(this.syncState.repoStates.values());
    return new Response(JSON.stringify({
      repos: states,
      lastFullSync: this.syncState.lastFullSync,
      cohesionStatus: this.syncState.cohesionStatus
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleCohesionCheck(): Promise<Response> {
    const cohesion = await this.runCohesionCheck();
    return new Response(JSON.stringify(cohesion), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleGetDependencies(): Promise<Response> {
    const deps = Object.fromEntries(this.syncState.dependencyMaps);
    return new Response(JSON.stringify(deps), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async handleWebhook(request: Request): Promise<Response> {
    const event = request.headers.get('X-GitHub-Event');
    const payload = await request.json() as {
      repository?: { full_name: string };
      ref?: string;
    };

    if (event === 'push' && payload.repository) {
      const repoName = payload.repository.full_name;
      const branch = payload.ref?.replace('refs/heads/', '') || 'main';

      // Find matching config
      const config = BLACKROAD_REPOS.find(
        r => `${r.owner}/${r.name}` === repoName
      );

      if (config && config.syncEnabled && branch === config.branch) {
        // Trigger sync for this repo
        this.state.waitUntil(
          this.fetch(new Request('http://internal/scrape', {
            method: 'POST',
            body: JSON.stringify({
              owner: config.owner,
              repo: config.name,
              branch: config.branch,
              paths: config.paths
            })
          }))
        );
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  private async scrapeDirectory(
    owner: string,
    repo: string,
    branch: string,
    path: string
  ): Promise<ScrapedFile[]> {
    const files: ScrapedFile[] = [];

    try {
      const response = await this.githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`
      );

      if (!response.ok) {
        return files;
      }

      const contents = await response.json() as Array<{
        type: string;
        path: string;
        sha: string;
        size: number;
        download_url?: string;
      }>;

      for (const item of contents) {
        if (item.type === 'file' && this.shouldScrapeFile(item.path)) {
          // Fetch file content
          if (item.download_url) {
            const contentResponse = await fetch(item.download_url);
            const content = await contentResponse.text();

            files.push({
              path: item.path,
              content,
              sha: item.sha,
              size: item.size,
              encoding: 'utf-8',
              lastModified: Date.now()
            });
          }
        } else if (item.type === 'dir') {
          // Recursively scrape subdirectories
          const subFiles = await this.scrapeDirectory(owner, repo, branch, item.path);
          files.push(...subFiles);
        }
      }
    } catch (error) {
      console.error(`Error scraping ${path}:`, error);
    }

    return files;
  }

  private shouldScrapeFile(path: string): boolean {
    // Include relevant file types
    const includeExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml',
      '.toml', '.md', '.sql', '.graphql', '.prisma'
    ];

    // Exclude patterns
    const excludePatterns = [
      'node_modules', '.git', 'dist', 'build', '.next',
      'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'
    ];

    const hasValidExtension = includeExtensions.some(ext => path.endsWith(ext));
    const isExcluded = excludePatterns.some(pattern => path.includes(pattern));

    return hasValidExtension && !isExcluded;
  }

  private async updateDependencyMap(repo: string, files: ScrapedFile[]): Promise<void> {
    const dependencies: DependencyMap['dependencies'] = [];

    for (const file of files) {
      // Parse imports and dependencies
      const importMatches = file.content.matchAll(
        /from\s+['"](@blackroad-os\/[^'"]+|\.\.?\/[^'"]+)['"]/g
      );

      for (const match of importMatches) {
        const importPath = match[1];
        if (importPath?.startsWith('@blackroad-os/')) {
          const depRepo = importPath.replace('@blackroad-os/', '');
          const existing = dependencies.find(d => d.repo === depRepo);
          if (existing) {
            if (!existing.files.includes(file.path)) {
              existing.files.push(file.path);
            }
          } else {
            dependencies.push({
              repo: depRepo,
              files: [file.path],
              type: 'import'
            });
          }
        }
      }
    }

    const depMap: DependencyMap = {
      repo,
      dependencies,
      lastUpdated: Date.now()
    };

    this.syncState.dependencyMaps.set(repo, depMap);
  }

  private async runCohesionCheck(): Promise<CohesionCheck> {
    const issues: CohesionCheck['issues'] = [];

    // Check for type mismatches across repos
    // Check for missing dependencies
    // Check for version drift

    const allRepos = Array.from(this.syncState.repoStates.keys());
    const allDeps = Array.from(this.syncState.dependencyMaps.values());

    for (const depMap of allDeps) {
      for (const dep of depMap.dependencies) {
        // Check if dependency repo exists and is synced
        const depRepoKey = `BlackRoad-OS/${dep.repo}`;
        const depState = this.syncState.repoStates.get(depRepoKey);

        if (!depState) {
          issues.push({
            type: 'missing-dependency',
            severity: 'high',
            source: depMap.repo,
            target: depRepoKey,
            message: `Dependency ${depRepoKey} is not being tracked`
          });
        } else if (depState.status === 'error') {
          issues.push({
            type: 'missing-dependency',
            severity: 'medium',
            source: depMap.repo,
            target: depRepoKey,
            message: `Dependency ${depRepoKey} sync is in error state`
          });
        }
      }
    }

    const cohesion: CohesionCheck = {
      status: issues.length === 0
        ? 'coherent'
        : issues.some(i => i.severity === 'critical')
          ? 'conflict'
          : 'drift-detected',
      issues,
      checkedAt: Date.now()
    };

    this.syncState.cohesionStatus = cohesion;
    await this.saveState();

    return cohesion;
  }

  private async githubFetch(url: string): Promise<Response> {
    return fetch(url, {
      headers: {
        'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'BlackRoad-Agent-Jobs-Worker'
      }
    });
  }

  private async saveState(): Promise<void> {
    await this.state.storage.put('state', {
      ...this.syncState,
      repoStates: Object.fromEntries(this.syncState.repoStates),
      dependencyMaps: Object.fromEntries(this.syncState.dependencyMaps)
    });
  }
}
