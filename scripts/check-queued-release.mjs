import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);

function requireContext({ branch, headSha, env }) {
  if (branch !== 'main' && branch !== 'develop') throw new Error('Queued release requires --branch=main or --branch=develop.');
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_SERVER_URL !== 'https://github.com'
    || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || env.GITHUB_REF !== `refs/heads/${branch}`
    || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('Queued release requires the canonical branch in a GitHub Actions push or workflow_dispatch run.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) {
    throw new Error('Queued release requires a valid GitHub repository identity.');
  }
  if (!isSha(headSha) || !isSha(env.GITHUB_SHA) || headSha !== env.GITHUB_SHA) {
    throw new Error('Queued release checkout must match the exact GITHUB_SHA that started this run.');
  }
  return { branch, gitSha: headSha, repository: env.GITHUB_REPOSITORY };
}

/** A later branch tip makes an older queued release a successful no-op.
 * Invalid evidence is never interpreted as a superseded release. */
export function evaluateQueuedRelease({ branch, headSha, env, remoteRef }) {
  const context = requireContext({ branch, headSha, env });
  if (remoteRef?.ref !== `refs/heads/${branch}` || remoteRef?.object?.type !== 'commit'
    || !isSha(remoteRef?.object?.sha)) {
    throw new Error('Queued release could not verify the current remote branch commit.');
  }
  return { ...context, currentSha: remoteRef.object.sha, current: headSha === remoteRef.object.sha };
}

function readCheckoutHead(root) {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).trim();
  } catch {
    throw new Error('Queued release could not verify checkout HEAD.');
  }
}

function loadRemoteRef({ branch, repository, root, env }) {
  try {
    const result = execFileSync('gh', [
      'api', `repos/${repository}/git/ref/heads/${branch}`, '--hostname', 'github.com',
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28',
    ], {
      cwd: root, env: { ...env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    return JSON.parse(result);
  } catch {
    // Never forward subprocess errors, responses or authentication diagnostics.
    throw new Error('Queued release could not read the current branch from GitHub.');
  }
}

/** Must execute after checkout inside the deployment job's concurrency lock,
 * before credentials are used for mutations. Existing release guards remain
 * responsible for clean-source attestation and deployment authorization. */
export async function checkQueuedRelease({
  branch, root = defaultRoot, env = process.env, readHead = readCheckoutHead, loadRef = loadRemoteRef,
} = {}) {
  // Pin the triggering identity before awaiting the remote lookup. Do not
  // check out the latest branch tip or convert a newer tip into authorization.
  const runEnv = { ...env };
  const headSha = readHead(root);
  const context = requireContext({ branch, headSha, env: runEnv });
  if (typeof runEnv.GH_TOKEN !== 'string' || !runEnv.GH_TOKEN.trim()) {
    throw new Error('Queued release requires GH_TOKEN for the GitHub branch lookup.');
  }
  let remoteRef;
  try {
    remoteRef = await loadRef({ ...context, root, env: { ...runEnv } });
  } catch {
    throw new Error('Queued release could not read the current branch from GitHub.');
  }
  return evaluateQueuedRelease({ branch, headSha, env: runEnv, remoteRef });
}

export async function runQueuedRelease(options = {}) {
  const env = options.env ?? process.env;
  if (!env.GITHUB_OUTPUT || !env.GITHUB_STEP_SUMMARY) {
    throw new Error('Queued release requires GitHub Actions output and summary files.');
  }
  const result = await checkQueuedRelease(options);
  const summary = result.current
    ? `The queued ${result.branch} release \`${result.gitSha}\` is still current.\n`
    : `Skipped superseded ${result.branch} release \`${result.gitSha}\`: the branch now points to \`${result.currentSha}\`. No deployment mutations were started by this run.\n`;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `## Queued release freshness\n\n${summary}\n`);
    // Emit authorization last, only after valid remote evidence and summary.
    appendFileSync(env.GITHUB_OUTPUT, `current=${result.current}\n`);
  } catch {
    throw new Error('Queued release could not publish its GitHub Actions decision.');
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !/^--branch=(main|develop)$/.test(args[0])) {
      throw new Error('Usage: node scripts/check-queued-release.mjs --branch=main|develop');
    }
    const result = await runQueuedRelease({ branch: args[0].slice('--branch='.length) });
    console.log(`Queued ${result.branch} release ${result.current ? 'is current' : 'was superseded'}: ${result.gitSha}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Queued release verification failed.');
    process.exitCode = 1;
  }
}
