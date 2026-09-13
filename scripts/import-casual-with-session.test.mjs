import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runCasualImportWithSession } from './import-casual-with-session.mjs';
import { CASUAL_IDENTITY, executeCasualImport, runCasualImportCli } from './import-casual-roster.mjs';
import { createAgentTaskBackedToken, formatSmokeError, validateLaunchSmokeToken, validateProductionQaUser } from './smoke-launch-auth.mjs';

const descriptor = JSON.parse(readFileSync(new URL('../arcade/casual-generated-v1.json', import.meta.url), 'utf8'));
const SHA = 'a'.repeat(40), SID = 'sess_owned', USER = 'user_admin', TASK = 'agent_task_owned';
const manifestArgs = ['--manifest=/offline/manifest.json', `--manifest-sha256=${descriptor.bundle.manifestSha256}`];
const executeArgs = [...manifestArgs, '--execute', '--confirm=IMPORT_CASUAL_ROSTER_PRODUCTION_V1',
  `--expected-deployed-sha=${SHA}`, '--receipt=/offline/receipt.json'];
const consumedTask = () => Object.assign(new Error('Consumed task'), { status: 400,
  errors: [{ code: 'agent_task_cannot_be_revoked' }] });

function fixture() {
  let clock = Date.now();
  const events = [], reports = [];
  const jwt = (seconds, overrides = {}) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
    sub: USER, sid: SID, iss: 'https://clerk.insertplayer.ai', azp: 'https://insertplayer.ai',
    exp: Math.floor(clock / 1000) + seconds, ...overrides,
  })).toString('base64url')}.signature`;
  const user = { id: USER, banned: false, locked: false,
    privateMetadata: { insert_player_role: 'admin', insertPlayerLaunchSmokeQa: true, launchSmokeRole: 'primary' },
    externalAccounts: [{ provider: 'oauth_google', verification: { status: 'verified' } }] };
  const clerk = {
    users: { getUser: vi.fn(async () => { events.push('identity-read'); return user; }) },
    agentTasks: {
      create: vi.fn(async () => { events.push('task-create'); return { agentTaskId: TASK,
        url: 'https://clerk.insertplayer.ai/tasks/agent_task_owned?ticket=do-not-log' }; }),
      revoke: vi.fn(async () => { events.push('task-revoke'); throw consumedTask(); }),
    },
    sessions: {
      getToken: vi.fn(async () => { events.push('token-refresh'); return { jwt: jwt(600) }; }),
      revokeSession: vi.fn(async id => { events.push('session-revoke'); return { id, status: 'revoked' }; }),
    },
  };
  let browserIdentity = { sessionId: SID, userId: USER };
  const page = {
    goto: vi.fn(async () => { events.push('task-navigation'); return { ok: () => true }; }),
    waitForURL: vi.fn(async () => {}), waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async fn => {
      if (fn.name === 'browserClerkSessionIdentity') { events.push('session-observed'); return browserIdentity; }
      if (fn.name === 'forceFreshBrowserClerkToken') return jwt(60);
      throw new Error('Unexpected browser function');
    }),
  };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => { events.push('context-close'); }) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => { events.push('browser-close'); }) };
  const runtime = { createClerkClient: vi.fn(() => clerk), chromium: { launch: vi.fn(async () => browser) },
    createAgentTaskBackedToken, formatSmokeError, validateLaunchSmokeToken, validateProductionQaUser };
  const env = { BUNDLE_ASSET: descriptor.bundle.assetName, BUNDLE_SHA256: descriptor.bundle.archiveSha256,
    ASF_ARCADE_ADMIN_CLERK_USER_ID: USER, ASF_LAUNCH_SMOKE_PRIMARY_USER_ID: USER,
    ASF_ARCADE_CLERK_SECRET_KEY: 'sk_live_OFFLINE_FIXTURE', CLERK_BACKEND_AUTH_BRIDGE_SECRET: 'b'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'c'.repeat(20), ASF_CLOUDFLARE_ZONE_ID: 'd'.repeat(32),
    GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: SHA };
  const loadRuntime = vi.fn(async () => runtime);
  const options = { env, loadRuntime, now: () => clock, readDescriptor: () => structuredClone(descriptor),
    reportCleanup: report => reports.push(structuredClone(report)),
    runImport: async (_args, { createTokenProvider }) => {
      const provider = await createTokenProvider(); await provider.getToken(); return { status: 'active' };
    } };
  return { env, user, clerk, page, context, browser, runtime, loadRuntime, events, reports, options, jwt,
    advance: ms => { clock += ms; }, setIdentity: identity => { browserIdentity = identity; },
    run: overrides => runCasualImportWithSession(executeArgs, { ...options, ...overrides }) };
}

describe('Casual import owned Agent Task session', () => {
  it('bootstraps with the real helper, imports, and revokes only its observed session and single-use task', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toEqual({ status: 'active' });
    expect(f.clerk.agentTasks.create).toHaveBeenCalledExactlyOnceWith({ onBehalfOf: { userId: USER },
      permissions: '*', agentName: 'insert-player-casual-import', taskDescription: 'Import the sealed reviewed Casual roster',
      redirectUrl: 'https://insertplayer.ai/menu', sessionMaxDurationInSeconds: 900 });
    expect(f.clerk.sessions.revokeSession).toHaveBeenCalledExactlyOnceWith(SID);
    expect(f.clerk.agentTasks.revoke).toHaveBeenCalledExactlyOnceWith(TASK);
    expect(f.context.close).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    expect(f.events.indexOf('session-observed')).toBeLessThan(f.events.indexOf('token-refresh'));
    expect(f.reports).toEqual([{ sessionEstablished: true, sessionRevoked: true,
      taskRevocation: 'consumed-session-revoked', cleanupUnknown: false, maxSessionSeconds: 900 }]);
    expect(JSON.stringify(f.reports)).not.toMatch(/sess_|user_|agent_task_|https:|ticket|signature/);
  });

  it.each(['admin-pin', 'descriptor', 'admin-role', 'qa-marker', 'oauth', 'locked'])('rejects %s before creating any task', async reason => {
    const f = fixture();
    if (reason === 'admin-pin') f.env.ASF_LAUNCH_SMOKE_PRIMARY_USER_ID = 'user_other';
    if (reason === 'descriptor') f.env.BUNDLE_SHA256 = '0'.repeat(64);
    if (reason === 'admin-role') f.user.privateMetadata.insert_player_role = 'user';
    if (reason === 'qa-marker') f.user.privateMetadata.insertPlayerLaunchSmokeQa = false;
    if (reason === 'oauth') f.user.externalAccounts[0].verification.status = 'unverified';
    if (reason === 'locked') f.user.locked = true;
    await expect(f.run()).rejects.toThrow(/Casual import failed \[/);
    expect(f.clerk.agentTasks.create).not.toHaveBeenCalled();
    expect(f.clerk.sessions.getToken).not.toHaveBeenCalled();
    expect(f.clerk.sessions.revokeSession).not.toHaveBeenCalled();
  });

  it('revokes the task without touching an unexpected browser user, and reports unknown session cleanup', async () => {
    const f = fixture(); f.setIdentity({ sessionId: 'sess_someone_else', userId: 'user_other' });
    f.clerk.agentTasks.revoke.mockResolvedValue({ agentTaskId: TASK });
    await expect(f.run()).rejects.toThrow(/cleanup is unconfirmed/);
    expect(f.clerk.sessions.getToken).not.toHaveBeenCalled();
    expect(f.clerk.sessions.revokeSession).not.toHaveBeenCalled();
    expect(f.clerk.agentTasks.revoke).toHaveBeenCalledExactlyOnceWith(TASK);
    expect(f.reports[0]).toMatchObject({ sessionEstablished: false, sessionRevoked: false, cleanupUnknown: true });
  });

  it('discovers and revokes the owned session even when navigation fails before token minting', async () => {
    const f = fixture(); f.page.goto.mockRejectedValue(new Error('Navigation failed'));
    await expect(f.run()).rejects.toThrow(/agent-task-bootstrap.*Navigation failed/);
    expect(f.clerk.sessions.getToken).not.toHaveBeenCalled();
    expect(f.clerk.sessions.revokeSession).toHaveBeenCalledExactlyOnceWith(SID);
    expect(f.clerk.agentTasks.revoke).toHaveBeenCalledExactlyOnceWith(TASK);
    expect(f.reports[0].cleanupUnknown).toBe(false);
  });

  it('does not pretend to revoke an unobservable session after a bootstrap failure', async () => {
    const f = fixture(); f.setIdentity(null);
    f.page.goto.mockRejectedValue(new Error('Navigation failed before Clerk loaded'));
    f.clerk.agentTasks.revoke.mockResolvedValue({ agentTaskId: TASK });
    await expect(f.run()).rejects.toThrow(/cleanup is unconfirmed.*15-minute lifetime/);
    expect(f.clerk.agentTasks.revoke).toHaveBeenCalledExactlyOnceWith(TASK);
    expect(f.clerk.sessions.revokeSession).not.toHaveBeenCalled();
    expect(f.reports[0]).toMatchObject({ sessionEstablished: false, sessionRevoked: false,
      taskRevocation: 'revoked', cleanupUnknown: true });
  });

  it('reports a lost task-create response as unknown without guessing an id or listing human sessions', async () => {
    const f = fixture(); f.clerk.agentTasks.create.mockRejectedValue(new Error('Connection lost'));
    await expect(f.run()).rejects.toThrow(/cleanup is unconfirmed/);
    expect(f.clerk.agentTasks.revoke).not.toHaveBeenCalled();
    expect(f.clerk.sessions.revokeSession).not.toHaveBeenCalled();
    expect(f.reports[0]).toMatchObject({ sessionEstablished: false, sessionRevoked: false,
      taskRevocation: 'unconfirmed', cleanupUnknown: true });
  });

  it('cleans up after bootstrap token refresh failure and redacts diagnostic credentials', async () => {
    const f = fixture();
    f.clerk.sessions.getToken.mockRejectedValue(new Error(`Failed https://clerk.insertplayer.ai/tasks/${TASK}?ticket=SECRET ${f.jwt(600)} sk_live_SECRET`));
    let error; try { await f.run(); } catch (caught) { error = caught; }
    expect(error.message).toContain('[agent-task-bootstrap]');
    expect(error.message).not.toMatch(/SECRET|https:|signature|sess_owned|agent_task_owned/);
    expect(f.clerk.sessions.revokeSession).toHaveBeenCalledExactlyOnceWith(SID);
    expect(f.reports[0].cleanupUnknown).toBe(false);
  });

  it('revokes after an importer error and rejects unconfirmed revocation even if import succeeded', async () => {
    const f = fixture();
    await expect(f.run({ runImport: async (_args, { createTokenProvider }) => {
      await createTokenProvider(); throw new Error('Upload failed');
    } })).rejects.toThrow(/roster-import.*Upload failed/);
    expect(f.clerk.sessions.revokeSession).toHaveBeenCalledExactlyOnceWith(SID);
    const g = fixture(); g.clerk.sessions.revokeSession.mockResolvedValue({ id: SID, status: 'active' });
    await expect(g.run()).rejects.toThrow(/cleanup is unconfirmed/);
    expect(g.reports[0]).toMatchObject({ sessionRevoked: false, taskRevocation: 'unconfirmed', cleanupUnknown: true });
  });

  it('does not treat an unrelated task revoke error as proof of a consumed task', async () => {
    const f = fixture(); f.clerk.agentTasks.revoke.mockRejectedValue({ status: 500, errors: [{ code: 'internal_error' }] });
    await expect(f.run()).rejects.toThrow(/cleanup is unconfirmed/);
    expect(f.reports[0]).toMatchObject({ sessionRevoked: true, taskRevocation: 'unconfirmed', cleanupUnknown: true });
  });

  it('refreshes only the owned SID, caches valid tokens, and bounds renewed TTL by the original 15-minute session', async () => {
    const f = fixture();
    await f.run({ runImport: async (_args, { createTokenProvider }) => {
      const provider = await createTokenProvider();
      const first = await provider.getToken(); expect(await provider.getToken()).toBe(first);
      f.advance(575_000); await provider.getToken();
      expect(f.clerk.sessions.getToken).toHaveBeenNthCalledWith(2, SID, undefined, 320);
      f.advance(291_000);
      await expect(provider.getToken()).rejects.toThrow(/bounded lifetime/);
    } });
    expect(f.clerk.sessions.getToken).toHaveBeenCalledTimes(2);
  });
});

describe('Casual preflight remains before authentication mutation', () => {
  const originalOptions = () => ({ validate: vi.fn(() => ({ manifestSha256: descriptor.bundle.manifestSha256 })),
    guard: vi.fn(() => ({ gitSha: SHA })), stdout: vi.fn() });

  it('keeps the real CLI dry-run offline and independent of credentials or browser runtime', async () => {
    const f = fixture();
    const plan = await runCasualImportWithSession(manifestArgs, { ...f.options, env: {},
      runImport: runCasualImportCli, importOptions: originalOptions() });
    expect(plan).toMatchObject({ providerCalls: 0, deletions: 0, versionCount: 34 });
    expect(f.loadRuntime).not.toHaveBeenCalled(); expect(f.reports).toEqual([]);
  });

  it.each(['asset', 'confirmation', 'branch', 'dirty', 'sha', 'origin'])('rejects failed %s guard before loading auth runtime', async reason => {
    const f = fixture(), importOptions = originalOptions();
    let args = executeArgs;
    if (reason === 'asset') importOptions.validate.mockImplementation(() => { throw new Error('Asset mismatch'); });
    if (reason === 'confirmation') args = args.filter(value => !value.startsWith('--confirm='));
    if (reason === 'branch') f.env.GITHUB_REF = 'refs/heads/other';
    if (reason === 'dirty') importOptions.guard.mockImplementation(() => { throw new Error('Dirty checkout'); });
    if (reason === 'sha') f.env.GITHUB_SHA = 'b'.repeat(40);
    if (reason === 'origin') f.env.ASF_WORKER_URL = 'https://wrong.example';
    await expect(runCasualImportWithSession(args, { ...f.options, runImport: runCasualImportCli, importOptions })).rejects.toThrow(/import-preflight/);
    expect(f.loadRuntime).not.toHaveBeenCalled(); expect(f.clerk.agentTasks.create).not.toHaveBeenCalled();
  });
});

describe('Casual rollback authentication reserve', () => {
  it('real importer restores draft after public verification crosses the normal budget following activation', async () => {
    const f = fixture(), id = 'f'.repeat(32), calls = [];
    let status = 'private';
    const fighter = () => ({ id, ownerUserId: USER, name: 'Casual', photoHash: CASUAL_IDENTITY.sourceSha256,
      qualityTier: 'contender', public: status === 'active', sources: {}, sourceHashes: {}, sprites: [], spriteVersions: [] });
    const baseClient = ({ tokenProvider }) => ({
      health: async () => ({ status: 'ok', environment: 'production', storage: { d1: 'bound', r2: 'bound' }, workerVersion: { tag: `prod-${SHA}-1` } }),
      listAdminArcade: async () => [], listOwned: async () => [], createFighter: async () => fighter(),
      getFighter: async () => fighter(),
      setArcade: async (_id, metadata) => {
        await tokenProvider.getToken(); status = metadata.status; calls.push(status);
        if (status === 'active') f.advance(721_000);
      },
      purgeArcadeCache: async () => { calls.push('purge'); },
      publicRoster: vi.fn(async () => { throw new Error('Should stop before public request'); }),
    });
    const checkpoints = [];
    await expect(f.run({ importOptions: { createClient: baseClient }, runImport: async (_args, options) => {
      const tokenProvider = await options.createTokenProvider();
      return executeCasualImport({ bundle: { manifestSha256: descriptor.bundle.manifestSha256,
        manifest: { sources: [], sprites: [] }, files: new Map() }, client: options.createClient({ tokenProvider }),
      ownerId: USER, expectedSha: SHA, onCheckpoint: value => checkpoints.push(value) });
    } })).rejects.toThrow(/reserved for rollback/);
    expect(calls).toEqual(['draft', 'active', 'purge', 'draft', 'purge']);
    expect(status).toBe('draft');
    expect(checkpoints.at(-1)).toMatchObject({ status: 'failed', leftInDraft: true, rollbackCachePurged: true, activationAttempted: true });
    expect(f.clerk.sessions.getToken).toHaveBeenNthCalledWith(2, SID, undefined, 174);
    expect(f.reports[0]).toMatchObject({ sessionRevoked: true, cleanupUnknown: false });
  });
});
