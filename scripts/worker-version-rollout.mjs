import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDeploymentTopology,
  assertFullDeployCompatible,
  assertVersionUploadCompatible,
  assertWorkerVersionId,
  stableGitShaFromVersion,
  stableVersionIdFromDeployment,
} from './worker-version-rollout-lib.mjs';
import { assertProductionDeployAllowed } from './production-deploy-guard.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, 'worker');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function runWrangler(args, capture = false) {
  const result = spawnSync(npx, ['--no-install', 'wrangler', ...args], {
    cwd: workerDir,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: process.env,
    timeout: 300_000,
  });
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
    throw new Error(`Wrangler ${args.join(' ')} failed.${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`);
  }
  return result.stdout ?? '';
}

function deploymentStatus() {
  return JSON.parse(runWrangler(['deployments', 'status', '--json'], true));
}

function versionDetails(versionId) {
  return JSON.parse(runWrangler(['versions', 'view', versionId, '--json'], true));
}

function emitOutput(key, value) {
  console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`, { encoding: 'utf8' });
  }
}

async function main() {
  const action = process.argv[2];
  if (['rollback', 'stage', 'promote'].includes(action)) {
    const context = assertProductionDeployAllowed({ root });
    console.log(`Worker rollout mutation authorized: ${context.channel} ${context.gitSha}.`);
  }
  if (action === 'current') {
    const stableVersionId = stableVersionIdFromDeployment(deploymentStatus());
    const details = versionDetails(stableVersionId);
    const stableGitSha = stableGitShaFromVersion({
      versionId: stableVersionId,
      viewedVersionId: details?.id,
      tag: details?.annotations?.['workers/tag'],
      bootstrapVersionId: process.env.ASF_BOOTSTRAP_STABLE_VERSION_ID,
      bootstrapGitSha: process.env.ASF_BOOTSTRAP_STABLE_GIT_SHA,
    });
    emitOutput('stable_version_id', stableVersionId);
    emitOutput('stable_git_sha', stableGitSha);
    return;
  }
  if (action === 'guard' || action === 'guard-full') {
    const base = String(process.env.ROLLOUT_BASE_SHA || 'HEAD^').trim();
    const head = String(process.env.ROLLOUT_HEAD_SHA || 'HEAD').trim();
    runGit(['rev-parse', '--verify', `${base}^{commit}`]);
    runGit(['rev-parse', '--verify', `${head}^{commit}`]);
    runGit(['merge-base', '--is-ancestor', base, head]);
    const files = runGit(['diff', '--name-only', base, head])
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
    const wranglerDiff = runGit([
      'diff', '--unified=0', base, head, '--',
      'worker/wrangler.toml', 'worker/wrangler.sandbox.toml',
    ]);
    if (action === 'guard-full') {
      const allowDurableObjectLifecycle = String(process.env.ASF_ALLOW_DURABLE_OBJECT_LIFECYCLE || '').trim() === '1';
      if (allowDurableObjectLifecycle) {
        console.warn(
          'ASF_ALLOW_DURABLE_OBJECT_LIFECYCLE=1: this rollout may ship Durable Object lifecycle changes '
          + 'and cannot be rolled back to the previous Worker version.',
        );
      }
      assertFullDeployCompatible(wranglerDiff, { allowDurableObjectLifecycle });
    } else {
      assertVersionUploadCompatible(files, wranglerDiff);
    }
    return;
  }

  const stable = assertWorkerVersionId(
    process.env.STABLE_WORKER_VERSION_ID,
    'STABLE_WORKER_VERSION_ID',
  );
  if (action === 'rollback') {
    runWrangler([
      'rollback', stable, '--yes',
      '--message', 'Restore stable Worker after failed Meterkey transport rollout',
    ]);
    assertDeploymentTopology(deploymentStatus(), [
      { versionId: stable, percentage: 100 },
    ]);
    return;
  }
  const candidate = assertWorkerVersionId(
    process.env.CANDIDATE_WORKER_VERSION_ID,
    'CANDIDATE_WORKER_VERSION_ID',
  );
  if (stable === candidate) throw new Error('Stable and candidate Worker versions must differ.');

  if (action === 'stage') {
    runWrangler([
      'versions', 'deploy',
      `${stable}@100%`, `${candidate}@0%`,
      '--yes',
      '--message', 'Stage Meterkey transport candidate at zero traffic',
    ]);
    assertDeploymentTopology(deploymentStatus(), [
      { versionId: stable, percentage: 100 },
      { versionId: candidate, percentage: 0 },
    ]);
    return;
  }
  if (action === 'verify-stage') {
    assertDeploymentTopology(deploymentStatus(), [
      { versionId: stable, percentage: 100 },
      { versionId: candidate, percentage: 0 },
    ]);
    return;
  }
  if (action === 'promote') {
    runWrangler([
      'versions', 'deploy', `${candidate}@100%`, '--yes',
      '--message', 'Promote verified Meterkey transport candidate',
    ]);
    assertDeploymentTopology(deploymentStatus(), [
      { versionId: candidate, percentage: 100 },
    ]);
    return;
  }
  throw new Error('Usage: worker-version-rollout.mjs guard|guard-full|current|stage|verify-stage|promote|rollback');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
