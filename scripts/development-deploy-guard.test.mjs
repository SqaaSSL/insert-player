import { describe, expect, it } from 'vitest';
import {
  assertAllowedDevelopmentContext,
  evaluateDevelopmentDeployGuard,
  isDevelopmentWranglerMutation,
  statusOutsideAttestedDevelopmentGeneration,
} from './production-deploy-guard-lib.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function evaluate(overrides = {}) {
  return evaluateDevelopmentDeployGuard({
    headSha: SHA,
    statusPorcelain: '',
    githubActions: 'true',
    githubSha: SHA,
    githubRef: 'refs/heads/develop',
    githubEventName: 'push',
    githubRunId: '456',
    githubRunAttempt: '1',
    currentBranch: '',
    remoteDevelopSha: '',
    ...overrides,
  });
}

describe('development deploy guard', () => {
  it('allows the exact clean develop commit in GitHub Actions', () => {
    const result = evaluate();
    expect(result.allowed).toBe(true);
    expect(result.context).toMatchObject({
      channel: 'github-actions',
      gitSha: SHA,
      runId: '456',
      runAttempt: '1',
    });
  });

  it('rejects dirty, mismatched, or non-develop GitHub builds', () => {
    const result = evaluate({
      statusPorcelain: '?? src/uncommitted.ts',
      githubSha: OTHER_SHA,
      githubRef: 'refs/heads/feature/demo',
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

  it('allows a clean local develop checkout only at the remote develop SHA', () => {
    const result = evaluate({
      githubActions: '',
      githubSha: '',
      githubRef: '',
      githubEventName: '',
      currentBranch: 'develop',
      remoteDevelopSha: SHA,
    });
    expect(result.allowed).toBe(true);
    expect(result.context).toMatchObject({ channel: 'local-develop', gitSha: SHA });
  });

  it('rejects stale or differently named local branches', () => {
    const result = evaluate({
      githubActions: '',
      githubSha: '',
      githubRef: '',
      githubEventName: '',
      currentBranch: 'codex/demo',
      remoteDevelopSha: OTHER_SHA,
    });
    expect(result.allowed).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'wrong_local_branch',
      'remote_develop_mismatch',
    ]));
    expect(() => assertAllowedDevelopmentContext(result)).toThrow(/origin\/develop/);
  });

  it('allows only the generated sandbox Wrangler config after exact attestation', () => {
    expect(statusOutsideAttestedDevelopmentGeneration({
      statusPorcelain: ' M worker/wrangler.sandbox.toml',
      attestedSha: SHA,
      headSha: SHA,
    })).toBe('');
    expect(statusOutsideAttestedDevelopmentGeneration({
      statusPorcelain: ' M worker/wrangler.sandbox.toml\n M src/ui/App.tsx',
      attestedSha: SHA,
      headSha: SHA,
    })).toBe(' M src/ui/App.tsx');
    expect(statusOutsideAttestedDevelopmentGeneration({
      statusPorcelain: ' M worker/wrangler.sandbox.toml',
      attestedSha: OTHER_SHA,
      headSha: SHA,
    })).toBe(' M worker/wrangler.sandbox.toml');
  });

  it('classifies only remote sandbox Wrangler writes', () => {
    expect(isDevelopmentWranglerMutation([
      'deploy', '--config', 'wrangler.sandbox.toml', '--keep-vars',
    ])).toBe(true);
    expect(isDevelopmentWranglerMutation([
      'pages', 'deploy', '../dist', '--project-name', 'insert-player-sandbox',
    ])).toBe(true);
    expect(isDevelopmentWranglerMutation([
      'd1', 'migrations', 'apply', 'insert-player-sandbox-db', '--remote',
      '--config', 'wrangler.sandbox.toml',
    ])).toBe(true);
    expect(isDevelopmentWranglerMutation([
      'r2', 'object', 'put', 'insert-player-sandbox-assets/file.png', '--file', 'file.png',
    ])).toBe(true);
    expect(isDevelopmentWranglerMutation([
      'deploy', '--config', 'wrangler.sandbox.toml', '--dry-run',
    ])).toBe(false);
    expect(isDevelopmentWranglerMutation([
      'd1', 'execute', 'insert-player-sandbox-db', '--local',
      '--config', 'wrangler.sandbox.toml',
    ])).toBe(false);
    expect(isDevelopmentWranglerMutation(['deploy', '--keep-vars'])).toBe(false);
  });
});
