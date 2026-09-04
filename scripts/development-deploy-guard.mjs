import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertAllowedDevelopmentContext,
  evaluateDevelopmentDeployGuard,
  statusOutsideAttestedDevelopmentGeneration,
} from './production-deploy-guard-lib.mjs';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

function currentBranch(root) {
  try {
    return git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch {
    return '';
  }
}

function remoteDevelopSha(root) {
  const output = git(root, ['ls-remote', '--exit-code', 'origin', 'refs/heads/develop']);
  return output.split(/\s+/)[0] ?? '';
}

export function assertDevelopmentDeployAllowed({ root = defaultRoot, env = process.env } = {}) {
  const isGithubActions = String(env.GITHUB_ACTIONS ?? '').trim() === 'true';
  const headSha = git(root, ['rev-parse', 'HEAD']);
  const statusPorcelain = statusOutsideAttestedDevelopmentGeneration({
    statusPorcelain: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    attestedSha: env.ASF_CANONICAL_DEVELOPMENT_ATTESTED_SHA,
    headSha,
  });
  let verifiedRemoteDevelopSha = '';
  if (!isGithubActions) {
    try {
      verifiedRemoteDevelopSha = remoteDevelopSha(root);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Sandbox mutation blocked: unable to verify origin/develop remotely. ${detail}`);
    }
  }

  const result = evaluateDevelopmentDeployGuard({
    headSha,
    statusPorcelain,
    githubActions: env.GITHUB_ACTIONS,
    githubSha: env.GITHUB_SHA,
    githubRef: env.GITHUB_REF,
    githubEventName: env.GITHUB_EVENT_NAME,
    githubRunId: env.GITHUB_RUN_ID,
    githubRunAttempt: env.GITHUB_RUN_ATTEMPT,
    currentBranch: currentBranch(root),
    remoteDevelopSha: verifiedRemoteDevelopSha,
  });
  return assertAllowedDevelopmentContext(result);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const context = assertDevelopmentDeployAllowed();
    console.log(`Sandbox release guard passed: ${context.channel} ${context.gitSha}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
