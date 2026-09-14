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
    // An operator can accept a one-way rollout explicitly; nothing else unlocks it.
    expect(() => assertFullDeployCompatible('+new_sqlite_classes = ["MatchRoom"]', { allowDurableObjectLifecycle: true }))
      .not.toThrow();
    expect(() => assertFullDeployCompatible('+new_sqlite_classes = ["MatchRoom"]', { allowDurableObjectLifecycle: 'yes' as never }))
      .toThrow('Durable Object lifecycle');
  });

  it('allows explicit new Workflow bindings in production and sandbox without a lifecycle override', () => {
    const diff = ['worker/wrangler.toml', 'worker/wrangler.sandbox.toml'].map((file) => [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -91,0 +92,5 @@ cpu_ms = 300000',
      '+[[workflows]]',
      '+binding = "BATTLE_FINISHER"',
      `+name = "insert-player-battle-finisher${file.includes('sandbox') ? '-sandbox' : ''}"`,
      '+class_name = "BattleFinisherWorkflow"',
      '+',
    ].join('\n')).join('\n');
    expect(() => assertFullDeployCompatible(diff)).not.toThrow();
    expect(() => assertVersionUploadCompatible([
      'worker/wrangler.toml', 'worker/wrangler.sandbox.toml',
    ], diff)).not.toThrow();
  });

  it.each([
    '+[[migrations]]\n+tag = "v2"\n+new_sqlite_classes = ["NewRoom"]',
    '+new_classes = ["NewRoom"]',
    '+renamed_classes = [{ from = "OldRoom", to = "NewRoom" }]',
    '+deleted_classes = ["OldRoom"]',
    '+[[durable_objects.bindings]]\n+name = "ROOM"\n+class_name = "NewRoom"',
    '+[durable_objects]\n+bindings = [{ name = "ROOM", class_name = "NewRoom" }]',
  ])('still blocks DO lifecycle changes alongside a new Workflow: %s', (lifecycleDiff) => {
    const diff = '+[[workflows]]\n+class_name = "BattleFinisherWorkflow"\n' + lifecycleDiff;
    expect(() => assertFullDeployCompatible(diff)).toThrow('Durable Object lifecycle');
    expect(() => assertVersionUploadCompatible(['worker/wrangler.toml'], diff))
      .toThrow('Durable Object lifecycle');
  });

  it.each([
    '@@ -150,0 +156 @@\n+class_name = "NewRoom"',
    'diff --git a/worker/wrangler.sandbox.toml b/worker/wrangler.sandbox.toml\n+class_name = "NewRoom"',
    ' [durable_objects]\n+class_name = "NewRoom"',
    '-class_name = "OldRoom"\n+class_name = "NewRoom"',
    '+bindings = [\n+  { name = "ROOM", class_name = "NewRoom" },\n+]',
  ])('does not leak the Workflow exemption into an unproven class change: %s', (unprovenDiff) => {
    const diff = '+[[workflows]]\n+class_name = "BattleFinisherWorkflow"\n' + unprovenDiff;
    expect(() => assertFullDeployCompatible(diff)).toThrow('Durable Object lifecycle');
  });

  it('fails closed for class changes whose table is absent from the zero-context diff', () => {
    expect(() => assertFullDeployCompatible([
      '@@ -97 +97 @@ name = "existing-binding"',
      '-class_name = "OldClass"',
      '+class_name = "NewClass"',
    ].join('\n'))).toThrow('Durable Object lifecycle');
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
