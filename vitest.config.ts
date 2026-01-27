import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'miniflare',
    environmentOptions: {
      bindings: {
        ENVIRONMENT: 'test',
        LOG_LEVEL: 'debug',
        SELF_HEAL_ENABLED: 'true',
        AUTO_UPDATE_ENABLED: 'true',
        MAX_RETRY_ATTEMPTS: '3',
        RETRY_BACKOFF_MS: '100'
      },
      kvNamespaces: ['JOBS_CACHE', 'REPO_STATE'],
      durableObjects: {
        JOB_COORDINATOR: 'JobCoordinator',
        REPO_SYNC: 'RepoSyncManager',
        SELF_HEALER: 'SelfHealer'
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'test/']
    }
  },
  resolve: {
    alias: {
      '@': './src'
    }
  }
});
