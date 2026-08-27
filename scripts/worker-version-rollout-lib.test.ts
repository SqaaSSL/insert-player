import { describe, expect, it } from 'vitest';
import {
  assertDeploymentTopology,
  assertFullDeployCompatible,
  assertVersionUploadCompatible,
  assertWorkerVersionId,
  activeGenerationJobsFromWranglerOutput,
  stableGitShaFromVersion,
  stableVersionIdFromDeployment,
  versionIdFromWranglerOutput,
} from './worker-version-rollout-lib.mjs';

const stable = '11111111-1111-4111-8111-111111111111';
const candidate = '22222222-2222-4222-8222-222222222222';
const stableSha = 'a'.repeat(40);

describe('Worker version rollout parsing', () => {
  it('selects a single stable version serving exactly 100 percent', () => {
    expect(stableVersionIdFromDeployment({
      versions: [{ version_id: stable, percentage: 100 }],
    })).toBe(stable);
  });

  it('fails closed for ambiguous deployments', () => {
    expect(() => stableVersionIdFromDeployment({ versions: [] })).toThrow('one stable');
    expect(() => stableVersionIdFromDeployment({
      versions: [
        { version_id: stable, percentage: 100 },
        { version_id: candidate, percentage: 0 },
      ],
    })).toThrow('one stable');
  });

  it('derives the deployed git SHA from the exact production version tag', () => {
    expect(stableGitShaFromVersion({
      versionId: stable,
      viewedVersionId: stable,
      tag: `prod-${stableSha}-2`,
    })).toBe(stableSha);
    expect(() => stableGitShaFromVersion({
      versionId: stable,
      viewedVersionId: candidate,
      tag: `prod-${stableSha}-2`,
    })).toThrow('does not match');
  });

  it('uses the audited bootstrap only for the exact untagged stable version', () => {
    expect(stableGitShaFromVersion({
      versionId: stable,
      viewedVersionId: stable,
      tag: null,
      bootstrapVersionId: stable,
      bootstrapGitSha: stableSha,
    })).toBe(stableSha);
    expect(() => stableGitShaFromVersion({
      versionId: stable,
      viewedVersionId: stable,
      tag: null,
      bootstrapVersionId: candidate,
      bootstrapGitSha: stableSha,
    })).toThrow('bootstrap');
    expect(() => stableGitShaFromVersion({
      versionId: stable,
      viewedVersionId: stable,
      tag: 'prod-short-1',
      bootstrapVersionId: stable,
      bootstrapGitSha: 'short',
    })).toThrow('bootstrap');
  });

  it('verifies exact staged and promoted deployment topologies', () => {
    expect(() => assertDeploymentTopology({
      versions: [
        { version_id: stable, percentage: 100 },
        { version_id: candidate, percentage: 0 },
      ],
    }, [
      { versionId: stable, percentage: 100 },
      { versionId: candidate, percentage: 0 },
    ])).not.toThrow();

    expect(() => assertDeploymentTopology({
      versions: [{ version_id: candidate, percentage: 99 }],
    }, [{ versionId: candidate, percentage: 100 }])).toThrow('exactly 100%');
  });

  it('blocks Container and Durable Object lifecycle changes from Worker-only rollout', () => {
    expect(() => assertVersionUploadCompatible(['worker/src/proxy.ts'], '+[version_metadata]')).not.toThrow();
    expect(() => assertVersionUploadCompatible(['processor/src/server.ts'])).toThrow('Container changes');
    expect(() => assertVersionUploadCompatible(
      ['worker/wrangler.toml'],
      '+new_sqlite_classes = ["GenerationState"]',
    )).toThrow('Durable Object lifecycle');
    expect(() => assertFullDeployCompatible('+new_classes = ["GenerationState"]'))
      .toThrow('Durable Object lifecycle');
    expect(() => assertFullDeployCompatible('+[version_metadata]')).not.toThrow();
  });

  it('reads the exact structured Wrangler version-upload record', () => {
    expect(versionIdFromWranglerOutput([
      JSON.stringify({ type: 'telemetry', version: 1 }),
      JSON.stringify({
        type: 'version-upload',
        version: 1,
        worker_name: 'ai-street-fighter-api',
        version_id: candidate,
      }),
    ].join('\n'), 'ai-street-fighter-api')).toBe(candidate);
  });

  it('rejects malformed or wrong-worker version records', () => {
    expect(() => assertWorkerVersionId('latest')).toThrow('invalid');
    expect(() => versionIdFromWranglerOutput(JSON.stringify({
      type: 'version-upload',
      worker_name: 'other-worker',
      version_id: candidate,
    }), 'ai-street-fighter-api')).toThrow('found 0');
  });

  it('parses the exact D1 active-generation count', () => {
    expect(activeGenerationJobsFromWranglerOutput(JSON.stringify([
      { results: [{ active_jobs: 0 }], success: true },
    ]))).toBe(0);
    expect(() => activeGenerationJobsFromWranglerOutput('{}')).toThrow('active_jobs');
  });
});
