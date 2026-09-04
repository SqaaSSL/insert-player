import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertAllowedProductionContext,
  evaluateProductionDeployGuard,
  statusOutsideAttestedCiGeneration,
} from './production-deploy-guard-lib.mjs';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function remoteMainSha(root) {
  const output = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']);
  return output.split(/\s+/)[0] ?? '';
}

export function assertProductionDeployAllowed({ root = defaultRoot, env = process.env } = {}) {
  const isGithubActions = String(env.GITHUB_ACTIONS ?? '').trim() === 'true';
  const isBreakGlass = String(env.ASF_PRODUCTION_BREAK_GLASS ?? '').trim() === '1';
  const headSha = git(root, ['rev-parse', 'HEAD']);
  const statusPorcelain = statusOutsideAttestedCiGeneration({
    statusPorcelain: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    githubActions: env.GITHUB_ACTIONS,
    attestedSha: env.ASF_CANONICAL_RELEASE_ATTESTED_SHA,
    headSha,
  });
  let verifiedRemoteMainSha = '';
  if (!isGithubActions && isBreakGlass) {
    try {
      verifiedRemoteMainSha = remoteMainSha(root);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Production mutation blocked: unable to verify origin/main remotely. ${detail}`);
    }
  }

  const result = evaluateProductionDeployGuard({
    headSha,
    statusPorcelain,
    githubActions: env.GITHUB_ACTIONS,
    githubSha: env.GITHUB_SHA,
    githubRef: env.GITHUB_REF,
    githubEventName: env.GITHUB_EVENT_NAME,
    githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT,
    breakGlass: env.ASF_PRODUCTION_BREAK_GLASS,
    breakGlassReason: env.ASF_PRODUCTION_BREAK_GLASS_REASON,
    expectedSha: env.ASF_EXPECTED_PRODUCTION_SHA,
    remoteMainSha: verifiedRemoteMainSha,
  });
  return assertAllowedProductionContext(result);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const context = assertProductionDeployAllowed();
    console.log(`Production release guard passed: ${context.channel} ${context.gitSha}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
