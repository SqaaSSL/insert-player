import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkQueuedRelease, evaluateQueuedRelease, runQueuedRelease } from './check-queued-release.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TOKEN = 'test-token-that-must-not-appear-in-errors';
const temporaryPaths = [];

function environment(branch = 'main', sha = A) {
  return {
    GITHUB_ACTIONS: 'true', GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: 'SqaaSSL/insert-player', GITHUB_SHA: sha, GH_TOKEN: TOKEN,
  };
}

function reference(sha = A, branch = 'main') {
  return { ref: `refs/heads/${branch}`, object: { type: 'commit', sha } };
}

function outputFiles() {
  const directory = mkdtempSync(join(tmpdir(), 'queued-release-test-'));
  temporaryPaths.push(directory);
  return { GITHUB_OUTPUT: join(directory, 'output'), GITHUB_STEP_SUMMARY: join(directory, 'summary') };
}

afterEach(() => {
  for (const directory of temporaryPaths.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('queued release freshness', () => {
  it.each([
    ['main', 'push'], ['main', 'workflow_dispatch'],
    ['develop', 'push'], ['develop', 'workflow_dispatch'],
  ])('allows the triggering revision still current on %s for %s', async (branch, event) => {
    const env = { ...environment(branch), GITHUB_EVENT_NAME: event };
    const loadRef = vi.fn(() => reference(A, branch));
    expect(await checkQueuedRelease({ branch, env, readHead: () => A, loadRef })).toEqual({
      branch, repository: 'SqaaSSL/insert-player', gitSha: A, currentSha: A, current: true,
    });
    expect(loadRef).toHaveBeenCalledOnce();
    expect(loadRef.mock.calls[0][0]).toMatchObject({ branch, repository: 'SqaaSSL/insert-player', gitSha: A });
  });

  it('does not roll back B when older A finishes validation and reaches the deployment lock later', async () => {
    const deployed = [];
    const loadRef = vi.fn(() => reference(B));
    for (const sha of [B, A]) {
      const env = { ...environment('main', sha), ...outputFiles() };
      const result = await runQueuedRelease({ branch: 'main', env, readHead: () => sha, loadRef });
      if (result.current) deployed.push(result.gitSha);
      expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`current=${sha === B}\n`);
      if (sha === A) {
        const summary = readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
        expect(summary).toContain(`Skipped superseded main release \`${A}\``);
        expect(summary).toContain(`branch now points to \`${B}\``);
        expect(summary).toContain('No deployment mutations were started');
      }
    }
    expect(deployed).toEqual([B]);
  });

  it.each([
    { GITHUB_ACTIONS: 'false' }, { GITHUB_SERVER_URL: 'https://untrusted.example' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'merge_group' },
    { GITHUB_REF: 'refs/pull/12/merge' }, { GITHUB_REF: 'refs/heads/develop' }, { GITHUB_REF: 'refs/tags/main' },
    { GITHUB_RUN_ID: '' }, { GITHUB_RUN_ID: '0' }, { GITHUB_RUN_ATTEMPT: '0' }, { GITHUB_RUN_ATTEMPT: 'no' },
    { GITHUB_REPOSITORY: '' }, { GITHUB_REPOSITORY: 'SqaaSSL/insert-player/../other' },
    { GITHUB_REPOSITORY: 'SqaaSSL/insert-player?ref=other' },
    { GITHUB_SHA: '' }, { GITHUB_SHA: B }, { GITHUB_SHA: 'a'.repeat(39) }, { GITHUB_SHA: '0'.repeat(40) },
  ])('fails closed before remote lookup for invalid triggering context %o', async overrides => {
    const loadRef = vi.fn(() => reference());
    const env = { ...environment(), ...overrides, ...outputFiles() };
    await expect(runQueuedRelease({ branch: 'main', env, readHead: () => A, loadRef })).rejects.toThrow();
    expect(loadRef).not.toHaveBeenCalled();
    expect(() => readFileSync(env.GITHUB_OUTPUT, 'utf8')).toThrow();
  });

  it.each(['feature', '', undefined])('rejects unsupported branch %s', branch => {
    expect(() => evaluateQueuedRelease({ branch, headSha: A, env: environment(), remoteRef: reference() }))
      .toThrow('--branch=main or --branch=develop');
  });

  it.each(['', B, 'not-a-commit', '0'.repeat(40)])('rejects an unpinned or invalid checkout HEAD %s', async headSha => {
    const loadRef = vi.fn(() => reference());
    await expect(checkQueuedRelease({ branch: 'main', env: environment(), readHead: () => headSha, loadRef }))
      .rejects.toThrow('checkout must match the exact GITHUB_SHA');
    expect(loadRef).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, 'not JSON', reference(A, 'develop'),
    { ref: 'refs/heads/main', object: { type: 'tag', sha: A } },
    ...[undefined, null, '', 'a'.repeat(39), `${A}\ncurrent=true`, '0'.repeat(40), 123]
      .map(sha => ({ ref: 'refs/heads/main', object: { type: 'commit', sha } })),
  ])('rejects malformed or wrong-ref API evidence without emitting a skip or authorization: %o', async remoteRef => {
    const env = { ...environment(), ...outputFiles() };
    await expect(runQueuedRelease({ branch: 'main', env, readHead: () => A, loadRef: () => remoteRef }))
      .rejects.toThrow('could not verify the current remote branch commit');
    expect(() => readFileSync(env.GITHUB_OUTPUT, 'utf8')).toThrow();
  });

  it('fails closed on lookup failure without printing authentication details or publishing current=false', async () => {
    const env = { ...environment(), ...outputFiles() };
    const failure = runQueuedRelease({ branch: 'main', env, readHead: () => A, loadRef: async () => {
      throw new Error(`Network failure: Authorization Bearer ${TOKEN}`);
    } });
    await expect(failure).rejects.toThrow('could not read the current branch from GitHub');
    await expect(failure).rejects.not.toThrow(TOKEN);
    expect(() => readFileSync(env.GITHUB_OUTPUT, 'utf8')).toThrow();
  });

  it('requires explicit authenticated lookup instead of using a remembered gh login', async () => {
    const loadRef = vi.fn(() => reference());
    await expect(checkQueuedRelease({ branch: 'main', env: { ...environment(), GH_TOKEN: '' }, readHead: () => A, loadRef }))
      .rejects.toThrow('requires GH_TOKEN');
    expect(loadRef).not.toHaveBeenCalled();
  });

  it('keeps the triggering revision pinned while asynchronous evidence is loaded', async () => {
    const env = environment();
    const result = await checkQueuedRelease({ branch: 'main', env, readHead: () => A, loadRef: async request => {
      env.GITHUB_SHA = B;
      request.env.GITHUB_SHA = B;
      return reference(B);
    } });
    expect(result).toMatchObject({ gitSha: A, currentSha: B, current: false });
  });

  it('reads actual checkout HEAD independently of GITHUB_SHA without network access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'queued-release-git-'));
    temporaryPaths.push(root);
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--quiet']);
    git(['-c', 'user.name=Queued release test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '--quiet', '-m', 'Pinned revision']);
    const headSha = git(['rev-parse', 'HEAD']);
    expect(await checkQueuedRelease({ branch: 'main', root, env: environment('main', headSha), loadRef: () => reference(headSha) }))
      .toMatchObject({ gitSha: headSha, current: true });
    const loadRef = vi.fn();
    await expect(checkQueuedRelease({ branch: 'main', root, env: environment('main', A), loadRef }))
      .rejects.toThrow('checkout must match');
    expect(loadRef).not.toHaveBeenCalled();
  });

  it('does not authorize deployment when the Actions summary cannot be written', async () => {
    const env = { ...environment(), ...outputFiles() };
    env.GITHUB_STEP_SUMMARY = join(env.GITHUB_STEP_SUMMARY, 'missing-parent');
    await expect(runQueuedRelease({ branch: 'main', env, readHead: () => A, loadRef: () => reference() }))
      .rejects.toThrow('could not publish');
    expect(() => readFileSync(env.GITHUB_OUTPUT, 'utf8')).toThrow();
  });

  it('requires the runner-provided output files before checking freshness', async () => {
    const loadRef = vi.fn();
    await expect(runQueuedRelease({ branch: 'main', env: environment(), readHead: () => A, loadRef }))
      .rejects.toThrow('output and summary files');
    expect(loadRef).not.toHaveBeenCalled();
  });

  it.each([[], ['--branch=feature'], ['--branch=main', '--branch=develop'], ['--branch=main', '--ignore-failure']].map(args => ({ args })))
    ('fails closed for unsupported CLI arguments $args', ({ args }) => {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-queued-release.mjs', import.meta.url)), ...args], {
        encoding: 'utf8', env: {},
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
      expect(result.stdout).not.toContain('current=true');
    });
});
