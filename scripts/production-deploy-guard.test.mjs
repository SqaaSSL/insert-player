import { describe, expect, it } from 'vitest';
import {
  assertAllowedProductionContext,
  evaluateProductionDeployGuard,
  isProductionWranglerMutation,
  statusOutsideAttestedCiGeneration,
} from './production-deploy-guard-lib.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function evaluate(overrides = {}) {
  return evaluateProductionDeployGuard({
    headSha: SHA,
    statusPorcelain: '',
    githubActions: 'true',
    githubSha: SHA,
    githubRef: 'refs/heads/main',
    githubEventName: 'push',
    githubRunId: '123',
    githubRunAttempt: '1',
    ...overrides,
  });
}

describe('production deploy guard', () => {
  it('allows the exact clean main commit in the canonical GitHub workflow', () => {
    const result = evaluate();
    expect(result.allowed).toBe(true);
    expect(result.context).toMatchObject({
      channel: 'github-actions',
      gitSha: SHA,
      runId: '123',
      runAttempt: '1',
    });
  });

  it('rejects dirty, mismatched, or non-main GitHub builds', () => {
    const result = evaluate({
      statusPorcelain: '?? src/uncommitted.ts',
      githubSha: OTHER_SHA,
      githubRef: 'refs/pull/42/merge',
      githubEventName: 'pull_request',
    });
    expect(result.allowed).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'dirty_tree',
      'github_sha_mismatch',
      'wrong_github_ref',
      'wrong_github_event',
    ]));
  });

  it('blocks routine local production deploys', () => {
    const result = evaluate({
      githubActions: '',
      githubSha: '',
      githubRef: '',
      githubEventName: '',
      remoteMainSha: '',
    });
    expect(result.allowed).toBe(false);
    expect(result.issues.map(({ code }) => code)).toContain('ci_only');
    expect(() => assertAllowedProductionContext(result)).toThrow(/CI-only/);
  });

  it('allows a fully explicit clean break-glass deploy only at origin/main', () => {
    const result = evaluate({
      githubActions: '',
      githubSha: '',
      githubRef: '',
      githubEventName: '',
      breakGlass: '1',
      breakGlassReason: 'Restore the production frontend after a verified outage.',
      expectedSha: SHA,
      remoteMainSha: SHA,
    });
    expect(result.allowed).toBe(true);
    expect(result.context).toMatchObject({ channel: 'break-glass', gitSha: SHA });
  });

  it('rejects break-glass deploys that are dirty, stale, or unexplained', () => {
    const result = evaluate({
      githubActions: '',
      githubSha: '',
      githubRef: '',
      githubEventName: '',
      statusPorcelain: ' M src/ui/App.tsx',
      breakGlass: '1',
      breakGlassReason: 'urgent',
      expectedSha: SHA,
      remoteMainSha: OTHER_SHA,
    });
    expect(result.allowed).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'dirty_tree',
      'remote_main_mismatch',
      'missing_break_glass_reason',
    ]));
  });

  it('allows only the known config materialized after an attested clean CI checkout', () => {
    expect(statusOutsideAttestedCiGeneration({
      statusPorcelain: ' M worker/wrangler.toml',
      githubActions: 'true',
      attestedSha: SHA,
      headSha: SHA,
    })).toBe('');
    expect(statusOutsideAttestedCiGeneration({
      statusPorcelain: ' M worker/wrangler.toml\n M src/ui/App.tsx',
      githubActions: 'true',
      attestedSha: SHA,
      headSha: SHA,
    })).toBe(' M src/ui/App.tsx');
    expect(statusOutsideAttestedCiGeneration({
      statusPorcelain: ' M worker/wrangler.toml',
      githubActions: 'true',
      attestedSha: OTHER_SHA,
      headSha: SHA,
    })).toBe(' M worker/wrangler.toml');
  });

  it('classifies production Wrangler writes without blocking dry runs, local D1, or sandbox', () => {
    expect(isProductionWranglerMutation(['deploy', '--keep-vars'])).toBe(true);
    expect(isProductionWranglerMutation(['--config', 'wrangler.toml', 'deploy'])).toBe(true);
    expect(isProductionWranglerMutation(['deploy', '--keep-vars', '--dry-run'])).toBe(false);
    expect(isProductionWranglerMutation([
      'deploy', '--config', 'wrangler.sandbox.toml', '--keep-vars',
    ])).toBe(false);
    expect(isProductionWranglerMutation([
      'pages', 'deploy', '../dist', '--project-name', 'insert-player',
    ])).toBe(true);
    expect(isProductionWranglerMutation([
      'pages', 'deploy', '../dist', '--project-name=insert-player-sandbox',
    ])).toBe(false);
    expect(isProductionWranglerMutation([
      'd1', 'migrations', 'apply', 'insert-player-db', '--remote',
    ])).toBe(true);
    expect(isProductionWranglerMutation([
      'd1', 'execute', 'insert-player-db', '--local',
    ])).toBe(false);
    expect(isProductionWranglerMutation(['delete', 'insert-player-api'])).toBe(true);
    expect(isProductionWranglerMutation([
      'pages', 'deployment', 'delete', 'deployment-id', '--project-name', 'insert-player',
    ])).toBe(true);
    expect(isProductionWranglerMutation([
      '--config=wrangler.sandbox.toml', 'pages', 'project', 'delete', 'insert-player-sandbox',
    ])).toBe(false);
    expect(isProductionWranglerMutation([
      'd1', 'time-travel', 'restore', 'insert-player-db', '--timestamp', '2026-09-04T00:00:00Z',
    ])).toBe(true);
    expect(isProductionWranglerMutation(['versions', 'secret', 'put', 'API_KEY'])).toBe(true);
    expect(isProductionWranglerMutation(['secret', 'list'])).toBe(false);
    expect(isProductionWranglerMutation(['types', 'worker-configuration.d.ts'])).toBe(false);
  });
});
