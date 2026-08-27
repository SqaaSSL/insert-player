import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VIDEO_SPRITE_ACTIONS as WORKER_VIDEO_SPRITE_ACTIONS } from '../src/services/VideoSpriteCompileContract';
import {
  REVIEW_GATED_VIDEO_STEP_CONFIRMATION,
  REVIEW_GATED_VIDEO_RESUME_CONFIRMATION,
  REVIEW_GATED_VIDEO_RESTART_CONFIRMATION,
  REVIEW_GATED_VIDEO_REVIEW_CONFIRMATIONS,
  REVIEW_GATED_VIDEO_ACTIONS,
  REVIEWED_ARCADE_ACTIVATION_CONFIRMATION,
  activateReviewedArcadeFighter,
  apiAssetRequest,
  apiRequest,
  arcadeAdminAuthHeaders,
  assertApprovedArcadeGenerationContract,
  assertAwaitingVideoReview,
  assertPinnedProductionWorkerHealth,
  assertReviewGatedVideoStepConfirmation,
  assertReviewGatedVideoRecoveryConfirmation,
  assertReviewGatedVideoReviewConfirmation,
  assertReviewedCanonicalManifest,
  assertReviewedActivationConfirmation,
  assertReviewedProductionApiOrigin,
  assertReviewedVideoFinalJobId,
  clerkRequest,
  findCurrentArcadeEntry,
  planArcadeDraftRegistration,
  planFighterResume,
  planReviewGatedVideoStep,
  planSideDraftPreparation,
  pinProductionWorkerHealth,
  runReviewGatedVideoStep,
  runReviewGatedVideoDecision,
  runReviewGatedVideoInspection,
  validateManifest,
  verifyReviewedVideoActivationProvenance,
} from './seed-arcade-roster.mjs';

describe('Arcade admin backend authentication', () => {
  it('adds the backend bridge only when explicitly configured', () => {
    expect(arcadeAdminAuthHeaders('session-token')).toEqual({
      Authorization: 'Bearer session-token',
      'X-Insert-Player-Admin-Seed': 'clerk-backend',
    });
    expect(arcadeAdminAuthHeaders('session-token', 'b'.repeat(32))).toEqual({
      Authorization: 'Bearer session-token',
      'X-Insert-Player-Admin-Seed': 'clerk-backend',
      'X-Insert-Player-Clerk-Backend-Auth': 'b'.repeat(32),
    });
  });
});

describe('Reviewed production Worker pin', () => {
  const sha = 'a'.repeat(40);
  const healthy = {
    status: 'ok',
    environment: 'production',
    storage: { d1: 'bound', r2: 'bound' },
    workerVersion: { id: 'worker-version-id', tag: `prod-${sha}-1` },
  };

  it('accepts only the exact full deployed SHA tag', () => {
    expect(assertPinnedProductionWorkerHealth(healthy, sha)).toBe(`prod-${sha}-1`);
    expect(() => assertPinnedProductionWorkerHealth({
      ...healthy,
      workerVersion: { ...healthy.workerVersion, tag: `prod-${sha}0-1` },
    }, sha)).toThrow(/exact SHA/);
    expect(() => assertPinnedProductionWorkerHealth(healthy, 'a'.repeat(39)))
      .toThrow(/full lowercase deployed commit SHA/);
  });

  it('pins only ASF_WORKER_URL/health and rejects redirects or a different origin', async () => {
    const requestHealth = async (url, init) => {
      expect(url).toBe('https://api.insertplayer.ai/health');
      expect(init.redirect).toBe('error');
      return Response.json(healthy);
    };
    await expect(pinProductionWorkerHealth({
      baseUrl: 'https://api.insertplayer.ai',
      configuredHealthUrl: 'https://api.insertplayer.ai/health',
      expectedSha: sha,
      requestHealth,
    })).resolves.toMatchObject({ tag: `prod-${sha}-1` });
    await expect(pinProductionWorkerHealth({
      baseUrl: 'https://api.insertplayer.ai',
      configuredHealthUrl: 'https://worker.example/health',
      expectedSha: sha,
      requestHealth,
    })).rejects.toThrow(/must be the \/health endpoint of ASF_WORKER_URL/);
  });

  it('rejects every non-exact reviewed production API origin', () => {
    expect(assertReviewedProductionApiOrigin('https://api.insertplayer.ai'))
      .toBe('https://api.insertplayer.ai');
    for (const baseUrl of [
      'http://api.insertplayer.ai',
      'https://api.insertplayer.ai:443',
      'https://user@api.insertplayer.ai',
      'https://api.insertplayer.ai/',
      'https://api.insertplayer.ai//',
      'https://api.insertplayer.ai/path',
      'https://api.insertplayer.ai?preview=1',
      'https://api.insertplayer.ai#preview',
      'https://worker.example',
    ]) {
      expect(() => assertReviewedProductionApiOrigin(baseUrl))
        .toThrow(/exact https:\/\/api\.insertplayer\.ai origin/);
    }
  });

  it('forbids redirects on every authenticated HTTP client', async () => {
    const calls = [];
    const request = async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    };
    await clerkRequest('clerk-secret', '/sessions', {}, request);
    await apiRequest(
      'https://api.insertplayer.ai',
      async () => 'admin-token',
      '/api/admin/arcade',
      {},
      request,
    );
    await apiAssetRequest(
      'https://api.insertplayer.ai',
      async () => 'admin-token',
      '/api/generation-jobs/job/video-review/assets/runtime?revision=1',
      request,
    );
    expect(calls).toHaveLength(3);
    expect(calls.every(({ init }) => init.redirect === 'error')).toBe(true);
    expect(calls.map(({ init }) => init.headers.Authorization)).toEqual([
      'Bearer clerk-secret',
      'Bearer admin-token',
      'Bearer admin-token',
    ]);
  });
});

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const productionWorkflow = readFileSync(
  new URL('../.github/workflows/seed-arcade-production.yml', import.meta.url),
  'utf8',
);
const videoStepWorkflow = readFileSync(
  new URL('../.github/workflows/arcade-video-step-production.yml', import.meta.url),
  'utf8',
);
const videoReviewWorkflow = readFileSync(
  new URL('../.github/workflows/arcade-video-review-production.yml', import.meta.url),
  'utf8',
);
const seedRosterScript = readFileSync(
  new URL('./seed-arcade-roster.mjs', import.meta.url),
  'utf8',
);

const animations = [
  'idle',
  'walk',
  'high_punch',
  'low_punch',
  'high_kick',
  'low_kick',
  'jump',
  'crouch',
  'hit',
  'ko',
  'victory',
];

function completeSources(overrides = {}) {
  return {
    original: '/original.png',
    side: '/side.png',
    sideRaw: '/side-raw.png',
    upright: '/upright.png',
    uprightRaw: '/upright-raw.png',
    crouch: '/crouch.png',
    crouchRaw: '/crouch-raw.png',
    ...overrides,
  };
}

function championSprites(names) {
  return names.map((animationName) => ({ animationName, qualityTier: 'champion' }));
}

function approvedVideoBytes(animationName, kind) {
  return Buffer.from(`approved-video:${animationName}:${kind}`);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function activationVideoJobId(index) {
  return (index + 1).toString(16).padStart(32, '0');
}

function reviewedAdminEntry(fighter, overrides = {}) {
  return {
    fighterId: 'a'.repeat(32),
    fighterName: fighter.name,
    qualityTier: 'champion',
    public: false,
    slug: fighter.slug,
    rank: fighter.rank,
    challengerLine: fighter.challengerLine,
    defaultPersonality: fighter.defaultPersonality,
    reference: {
      kind: fighter.reference.kind,
      sourceUrl: fighter.reference.sourceUrl,
      license: fighter.reference.license,
      credit: fighter.reference.credit,
    },
    generationPrompt: fighter.referencePrompt,
    status: 'draft',
    updatedAt: '2026-08-27 03:00:00',
    ...overrides,
  };
}

function reviewedOwnedFighter(fighter, overrides = {}) {
  const photoHash = fighter.reference.sourceSha256;
  return {
    id: 'a'.repeat(32),
    name: fighter.name,
    photoHash,
    qualityTier: 'champion',
    public: false,
    updatedAt: '2026-08-27 03:00:01',
    sources: completeSources(),
    sourceHashes: { original: photoHash },
    sprites: animations.map((animationName) => ({
      animationName,
      qualityTier: 'champion',
      url: `/${animationName}.png`,
      rawUrl: `/${animationName}-raw.png`,
      contentHash: digest(approvedVideoBytes(animationName, 'runtime')),
      rawContentHash: digest(approvedVideoBytes(animationName, 'raw')),
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 8,
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
    })),
    ...overrides,
  };
}

function reviewedActivationApi(fighter, { entry, owned } = {}) {
  const resolvedEntry = entry ?? reviewedAdminEntry(fighter);
  const resolvedOwned = owned ?? reviewedOwnedFighter(fighter);
  const calls = [];
  const assetCalls = [];
  const artifactRunId = 'd'.repeat(32);
  const completedStages = [
    'source:side', 'source:upright', 'source:crouch',
    ...WORKER_VIDEO_SPRITE_ACTIONS.map((action) => `sprite:${action}`),
  ];
  const jobs = new Map(WORKER_VIDEO_SPRITE_ACTIONS.map((action, index) => {
    const id = activationVideoJobId(index);
    return [id, {
      id,
      fighterId: resolvedEntry.fighterId,
      tier: 'champion',
      creationFlow: 'video',
      operation: 'fighter_generation',
      targetKind: null,
      targetName: null,
      artifactRunId,
      resumedFromJobId: index === 0 ? null : activationVideoJobId(index - 1),
      status: 'succeeded',
      reviewStatus: 'approved',
      fullRunRestartRequired: false,
      stage: index === WORKER_VIDEO_SPRITE_ACTIONS.length - 1 ? 'complete' : 'review:approved',
      progressCurrent: 14,
      progressTotal: 14,
      resumable: false,
      completedStages,
      pendingStages: [],
      preservedArtifactCount: completedStages.length,
    }];
  }));
  const reviews = new Map(WORKER_VIDEO_SPRITE_ACTIONS.map((action, index) => {
    const jobId = activationVideoJobId(index);
    return [jobId, {
      jobId,
      artifactRunId,
      candidateId: (0x100 + index).toString(16).padStart(32, '0'),
      action,
      sequenceOrder: index,
      status: 'approved',
      revision: 1,
      reportSha256: String(index + 1).repeat(64).slice(0, 64),
      technicalOutcome: 'technical_pass',
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
      frameCount: 8,
      rawFrameCount: 8,
      reviewedAt: '2026-08-27T03:00:00.000Z',
    }];
  }));
  return {
    calls,
    assetCalls,
    finalJobId: activationVideoJobId(WORKER_VIDEO_SPRITE_ACTIONS.length - 1),
    requestApi: async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET', body: init.body });
      if (path === '/api/admin/arcade' && !init.method) {
        return { fighters: [resolvedEntry] };
      }
      if (path === `/api/fighters/${resolvedEntry.fighterId}` && !init.method) {
        return { fighter: resolvedOwned };
      }
      const jobMatch = path.match(/^\/api\/generation-jobs\/([a-f0-9]{32})$/);
      if (jobMatch && !init.method && jobs.has(jobMatch[1])) {
        return { job: jobs.get(jobMatch[1]) };
      }
      const reviewMatch = path.match(/^\/api\/generation-jobs\/([a-f0-9]{32})\/video-review$/);
      if (reviewMatch && !init.method && reviews.has(reviewMatch[1])) {
        return { review: reviews.get(reviewMatch[1]) };
      }
      if (
        path === `/api/admin/arcade/${resolvedEntry.fighterId}/activate-reviewed-video`
        && init.method === 'POST'
      ) {
        return {
          fighter: {
            ...resolvedEntry,
            status: 'active',
            public: true,
          },
          provenance: {
            schemaVersion: 1,
            fighterId: resolvedEntry.fighterId,
            artifactRunId,
            finalJobId: activationVideoJobId(WORKER_VIDEO_SPRITE_ACTIONS.length - 1),
            approvedActionCount: 11,
            finalAction: 'victory',
            animationFormat: 'video-dense-v1',
            currentSpritesVerified: true,
          },
        };
      }
      throw new Error(`Unexpected reviewed activation request: ${init.method ?? 'GET'} ${path}`);
    },
    requestAsset: async (_baseUrl, _token, path) => {
      assetCalls.push(path);
      const match = path.match(
        /^\/api\/generation-jobs\/([a-f0-9]{32})\/video-review\/assets\/(runtime|raw)\?revision=1$/,
      );
      if (!match) throw new Error(`Unexpected reviewed activation asset: ${path}`);
      const job = jobs.get(match[1]);
      const review = reviews.get(match[1]);
      if (!job || !review) throw new Error(`Unknown reviewed activation asset: ${path}`);
      const bytes = approvedVideoBytes(review.action, match[2]);
      return { bytes, etag: digest(bytes) };
    },
  };
}

const videoJobId = 'b'.repeat(32);
const continuedVideoJobId = 'c'.repeat(32);
const videoRunId = 'd'.repeat(32);

function videoJob(overrides = {}) {
  return {
    id: videoJobId,
    fighterId: 'a'.repeat(32),
    tier: 'champion',
    creationFlow: 'video',
    operation: 'fighter_generation',
    targetKind: null,
    targetName: null,
    artifactRunId: videoRunId,
    status: 'succeeded',
    reviewStatus: 'awaiting_review',
    fullRunRestartRequired: false,
    stage: 'awaiting_review',
    progressCurrent: 4,
    progressTotal: 14,
    resumable: false,
    pendingStages: ['sprite:walk'],
    ...overrides,
  };
}

function videoReview(job = videoJob(), overrides = {}) {
  const revision = overrides.revision ?? 1;
  return {
    jobId: job.id,
    artifactRunId: job.artifactRunId,
    candidateId: 'e'.repeat(32),
    action: 'idle',
    sequenceOrder: 0,
    status: 'awaiting_review',
    revision,
    reportSha256: 'f'.repeat(64),
    technicalOutcome: 'technical_pass',
    selectedVideoIndices: [0, 2, 4, 6],
    sourceFrameCount: 12,
    animationFormat: 'video-dense-v1',
    processingVersion: 5,
    assets: {
      video: `/api/generation-jobs/${job.id}/video-review/assets/video?revision=${revision}`,
      contactSheet: `/api/generation-jobs/${job.id}/video-review/assets/contact-sheet?revision=${revision}`,
      uniqueSheet: `/api/generation-jobs/${job.id}/video-review/assets/unique-sheet?revision=${revision}`,
      runtime: `/api/generation-jobs/${job.id}/video-review/assets/runtime?revision=${revision}`,
      raw: `/api/generation-jobs/${job.id}/video-review/assets/raw?revision=${revision}`,
      report: `/api/generation-jobs/${job.id}/video-review/assets/report?revision=${revision}`,
    },
    ...overrides,
  };
}

async function boundReviewAsset(_baseUrl, _token, path) {
  const kind = path.match(/\/assets\/(video|contact-sheet|unique-sheet|runtime|raw|report)\?revision=\d+$/)?.[1];
  if (!kind) throw new Error(`Unexpected review asset path: ${path}`);
  const bytes = Buffer.from(`private-reviewed-${kind}`);
  const contentType = kind === 'video'
    ? 'video/mp4'
    : kind === 'report'
      ? 'application/json'
      : 'image/png';
  return { bytes, etag: digest(bytes), contentType };
}

function videoStepReadApi(fighter, jobs, reviews = new Map()) {
  const entry = reviewedAdminEntry(fighter);
  const owned = reviewedOwnedFighter(fighter);
  const calls = [];
  return {
    calls,
    requestApi: async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET', body: init.body });
      if (path === '/api/admin/arcade' && !init.method) return { fighters: [entry] };
      if (path === `/api/fighters/${entry.fighterId}` && !init.method) return { fighter: owned };
      if (path === `/api/generation-jobs?fighterId=${entry.fighterId}` && !init.method) {
        return { jobs };
      }
      const reviewMatch = path.match(/^\/api\/generation-jobs\/([a-f0-9]{32})\/video-review$/);
      if (reviewMatch && !init.method && reviews.has(reviewMatch[1])) {
        return { review: reviews.get(reviewMatch[1]) };
      }
      throw new Error(`Unexpected Video step request: ${init.method ?? 'GET'} ${path}`);
    },
  };
}

describe('Arcade roster resume planning', () => {
  it('requires every official prompt to preserve its licensed reference identity', () => {
    expect(() => validateManifest(manifest)).not.toThrow();

    const missingReference = structuredClone(manifest);
    missingReference.fighters[0].referencePrompt = 'Create a premium realistic 2.5D full-body arcade fighter on green.';
    expect(() => validateManifest(missingReference)).toThrow(/licensed-photo identity/);

    const identityErasing = structuredClone(manifest);
    identityErasing.fighters[0].referencePrompt = 'Use the licensed reference photo, then replace it from the written description only.';
    expect(() => validateManifest(identityErasing)).toThrow(/text-only replacement face/);
  });

  it('builds every canonical source and animation for an empty draft', () => {
    expect(planFighterResume({ sources: { original: '/original.png' }, sprites: [] })).toEqual({
      sourceNames: ['side', 'upright', 'crouch'],
      animationNames: animations,
      ready: false,
    });
  });

  it('rebuilds the dependent source chain and every animation after a source gap', () => {
    const sources = completeSources({ uprightRaw: null });
    expect(planFighterResume({ sources, sprites: championSprites(['idle', 'walk']) })).toEqual({
      sourceNames: ['upright', 'crouch'],
      animationNames: animations,
      ready: false,
    });
  });

  it('keeps complete sources and fills only missing Champion animations', () => {
    const current = ['idle', 'walk', 'high_punch', 'high_kick'];
    expect(planFighterResume({
      sources: completeSources(),
      sprites: [
        ...championSprites(current),
        { animationName: 'low_punch', qualityTier: 'rookie' },
      ],
    })).toEqual({
      sourceNames: [],
      animationNames: animations.filter((name) => !current.includes(name)),
      ready: false,
    });
  });

  it('recognizes a complete Champion fighter', () => {
    expect(planFighterResume({
      sources: completeSources(),
      sprites: championSprites(animations),
    })).toEqual({ sourceNames: [], animationNames: [], ready: true });
  });

  it('ignores retired entries and fails closed on a current slug collision', () => {
    expect(findCurrentArcadeEntry([
      { fighterId: 'retired', slug: 'donald-trump', status: 'retired' },
      { fighterId: 'current', slug: 'donald-trump', status: 'draft' },
    ], 'donald-trump')).toMatchObject({ fighterId: 'current' });

    expect(() => findCurrentArcadeEntry([
      { fighterId: 'one', slug: 'donald-trump', status: 'draft' },
      { fighterId: 'two', slug: 'donald-trump', status: 'active' },
    ], 'donald-trump')).toThrow(/Multiple current Arcade fighters/);
  });

  it('stages only a missing probe draft and refuses to mutate a published fighter', () => {
    expect(planSideDraftPreparation(null, 'bad-bunny', {
      allowCreate: true,
      mode: 'probe',
    })).toEqual({ action: 'create', entry: null });

    const draft = {
      fighterId: 'a'.repeat(32),
      slug: 'bad-bunny',
      status: 'draft',
    };
    expect(planSideDraftPreparation(draft, 'bad-bunny', {
      allowCreate: true,
      mode: 'probe',
    })).toEqual({ action: 'reuse', entry: draft });

    expect(() => planSideDraftPreparation({ ...draft, status: 'active' }, 'bad-bunny', {
      allowCreate: true,
      mode: 'probe',
    })).toThrow(/restricted to draft fighters/);
  });

  it('restarts only the matching content-addressed draft', () => {
    expect(planArcadeDraftRegistration(
      { fighterId: 'old-draft', slug: 'donald-trump', status: 'draft' },
      'old-draft',
      'donald-trump',
      'b8cdec38c5a7e804',
      true,
    )).toEqual({ slug: 'donald-trump', restartFullGeneration: true });

    expect(() => planArcadeDraftRegistration(
      { fighterId: 'live', slug: 'donald-trump', status: 'active' },
      'live',
      'donald-trump',
      'b8cdec38c5a7e804',
      true,
    )).toThrow(/only a draft can be restarted/);
    expect(() => planArcadeDraftRegistration(
      null,
      'new-draft',
      'donald-trump',
      'b8cdec38c5a7e804',
      true,
    )).toThrow(/No current Arcade draft/);
    expect(() => planArcadeDraftRegistration(
      { fighterId: 'old-draft', slug: 'donald-trump', status: 'draft' },
      'different-fighter',
      'donald-trump',
      'b8cdec38c5a7e804',
      true,
    )).toThrow(/content-addressed cloud fighter/);
  });

  it('uses a collision-safe temporary slug for an ordinary unreviewed replacement', () => {
    expect(planArcadeDraftRegistration(
      { fighterId: 'current', slug: 'donald-trump', status: 'active' },
      'new-draft',
      'donald-trump',
      'b8cdec38c5a7e804',
      false,
    )).toEqual({
      slug: 'donald-trump-next-b8cdec38',
      restartFullGeneration: false,
    });
    expect(() => planArcadeDraftRegistration(
      { fighterId: 'same-fighter', slug: 'donald-trump', status: 'draft' },
      'same-fighter',
      'donald-trump',
      'b8cdec38c5a7e804',
      false,
    )).toThrow(/use --resume or --restart-draft/);
  });
});

describe('Reviewed Arcade activation', () => {
  const fighter = manifest.fighters.find((entry) => entry.slug === 'bad-bunny');

  it('requires the dedicated activation phrase', () => {
    expect(() => assertReviewedActivationConfirmation('GEMINI_ONLY_PRODUCTION'))
      .toThrow(/ACTIVATE_REVIEWED_ARCADE_FIGHTER_PRODUCTION/);
    expect(() => assertReviewedActivationConfirmation(REVIEWED_ARCADE_ACTIVATION_CONFIRMATION))
      .not.toThrow();
  });

  it('requires an exact final Video job binding', () => {
    expect(() => assertReviewedVideoFinalJobId('')).toThrow(/final-job-id/i);
    expect(() => assertReviewedVideoFinalJobId('A'.repeat(32))).toThrow(/final-job-id/i);
    expect(assertReviewedVideoFinalJobId(activationVideoJobId(10)))
      .toBe(activationVideoJobId(10));
  });

  it('activates only after proving the final victory and all eleven current Video sprites', async () => {
    const api = reviewedActivationApi(fighter);
    const activated = await activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      reviewedVideoFinalJobId: api.finalJobId,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: api.requestApi,
      requestAsset: api.requestAsset,
    });

    expect(activated).toMatchObject({
      fighterId: 'a'.repeat(32),
      status: 'active',
      public: true,
    });
    expect(api.calls[0]).toMatchObject({ method: 'GET', path: '/api/admin/arcade' });
    expect(api.calls[1]).toMatchObject({
      method: 'GET', path: `/api/fighters/${'a'.repeat(32)}`,
    });
    expect(api.calls.filter(({ path }) => /\/video-review$/.test(path))).toHaveLength(11);
    expect(api.calls.filter(({ path }) => /^\/api\/generation-jobs\/[a-f0-9]{32}$/.test(path)))
      .toHaveLength(11);
    expect(api.assetCalls).toHaveLength(22);
    expect(api.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: `/api/admin/arcade/${'a'.repeat(32)}/activate-reviewed-video`,
    });
    expect(JSON.parse(api.calls.at(-1).body)).toEqual({
      finalJobId: api.finalJobId,
      arcadeUpdatedAt: '2026-08-27 03:00:00',
      fighterUpdatedAt: '2026-08-27 03:00:01',
    });
    expect(api.calls.some(({ path }) => /generation-contract|\/generate(?:\/|$)|\/sources(?:\/|$)/.test(path)))
      .toBe(false);
  });

  it('blocks an incomplete draft before the activation PATCH', async () => {
    const api = reviewedActivationApi(fighter, {
      owned: reviewedOwnedFighter(fighter, {
        sources: completeSources({ uprightRaw: null }),
      }),
    });

    await expect(activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      reviewedVideoFinalJobId: api.finalJobId,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: api.requestApi,
      requestAsset: api.requestAsset,
    })).rejects.toThrow(/incomplete.*source:upright/i);
    expect(api.calls.every(({ method }) => method === 'GET')).toBe(true);

    const missingRawSprite = reviewedActivationApi(fighter, {
      owned: reviewedOwnedFighter(fighter, {
        sprites: reviewedOwnedFighter(fighter).sprites.map((sprite) => (
          sprite.animationName === 'high_kick' ? { ...sprite, rawUrl: null } : sprite
        )),
      }),
    });
    await expect(activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      reviewedVideoFinalJobId: missingRawSprite.finalJobId,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: missingRawSprite.requestApi,
      requestAsset: missingRawSprite.requestAsset,
    })).rejects.toThrow(/sprite:high_kick:clean\/raw/i);
    expect(missingRawSprite.calls.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('blocks licensed-photo or manifest tampering before the activation PATCH', async () => {
    const photoTamper = reviewedActivationApi(fighter, {
      owned: reviewedOwnedFighter(fighter, { photoHash: '0'.repeat(64) }),
    });
    await expect(activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      reviewedVideoFinalJobId: photoTamper.finalJobId,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: photoTamper.requestApi,
      requestAsset: photoTamper.requestAsset,
    })).rejects.toThrow(/licensed-photo hash/i);
    expect(photoTamper.calls.every(({ method }) => method === 'GET')).toBe(true);

    const manifestTamper = reviewedActivationApi(fighter, {
      entry: reviewedAdminEntry(fighter, { generationPrompt: 'tampered prompt' }),
    });
    await expect(activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      reviewedVideoFinalJobId: manifestTamper.finalJobId,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: manifestTamper.requestApi,
      requestAsset: manifestTamper.requestAsset,
    })).rejects.toThrow(/roster manifest.*generationPrompt/i);
    expect(manifestTamper.calls.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('blocks a current sprite pointer that no longer matches its approved Video revision', async () => {
    const owned = reviewedOwnedFighter(fighter);
    owned.sprites = owned.sprites.map((sprite) => (
      sprite.animationName === 'high_kick'
        ? { ...sprite, contentHash: '0'.repeat(64) }
        : sprite
    ));
    const api = reviewedActivationApi(fighter, { owned });
    await expect(activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      reviewedVideoFinalJobId: api.finalJobId,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: api.requestApi,
      requestAsset: api.requestAsset,
    })).rejects.toThrow(/high_kick.*do not match approved Video revision/i);
    expect(api.calls.some(({ path }) => path.endsWith('/activate-reviewed-video'))).toBe(false);
  });

  it('blocks activation unless the supplied final job is the completed victory approval', async () => {
    const api = reviewedActivationApi(fighter);
    const requestApi = async (baseUrl, token, path, init) => {
      const body = await api.requestApi(baseUrl, token, path, init);
      if (path === `/api/generation-jobs/${api.finalJobId}`) {
        return { job: { ...body.job, stage: 'review:approved', pendingStages: ['sprite:victory'] } };
      }
      return body;
    };
    await expect(verifyReviewedVideoActivationProvenance({
      fighterId: 'a'.repeat(32),
      owned: reviewedOwnedFighter(fighter),
      finalJobId: api.finalJobId,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi,
      requestAsset: api.requestAsset,
    })).rejects.toThrow(/Final victory job.*completed 14-stage/i);
  });
});

describe('Review-gated Arcade Video step', () => {
  const fighter = manifest.fighters.find((entry) => entry.slug === 'bad-bunny');
  const runnerOptions = (requestApi) => ({
    manifest,
    fighter,
    approvedPhotoHash: fighter.reference.sourceSha256,
    baseUrl: 'https://api.insertplayer.ai',
    token: async () => 'token',
    requestApi,
    pause: async () => {},
    pollIntervalMs: 0,
  });
  const reviewedManifest = {
    schemaVersion: 1,
    canonicalSourceMode: 'reviewed-current-v1',
    slug: fighter.slug,
    fighterId: 'a'.repeat(32),
    photoHash: fighter.reference.sourceSha256,
    canonicalSourceHashes: {
      side: { processedSha256: '1'.repeat(64), rawSha256: '2'.repeat(64) },
      upright: { processedSha256: '3'.repeat(64), rawSha256: '4'.repeat(64) },
      crouch: { processedSha256: '5'.repeat(64), rawSha256: '6'.repeat(64) },
    },
  };

  it('uses the exact Worker action order for all eleven review sequence bindings', () => {
    expect(REVIEW_GATED_VIDEO_ACTIONS).toEqual([...WORKER_VIDEO_SPRITE_ACTIONS]);
    const job = videoJob();
    for (const [sequenceOrder, action] of WORKER_VIDEO_SPRITE_ACTIONS.entries()) {
      const review = videoReview(job, { action, sequenceOrder });
      expect(assertAwaitingVideoReview(review, job)).toBe(review);
      expect(() => assertAwaitingVideoReview({
        ...review,
        sequenceOrder: (sequenceOrder + 1) % WORKER_VIDEO_SPRITE_ACTIONS.length,
      }, job)).toThrow(/sealed identity or technical-report contract/);
    }
  });

  it('requires its own exact production confirmation', () => {
    expect(() => assertReviewGatedVideoStepConfirmation('GEMINI_ONLY_PRODUCTION'))
      .toThrow(/START_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION/);
    expect(() => assertReviewGatedVideoStepConfirmation(REVIEW_GATED_VIDEO_STEP_CONFIRMATION))
      .not.toThrow();
    expect(() => assertReviewGatedVideoRecoveryConfirmation(
      'resume-failed', REVIEW_GATED_VIDEO_RESUME_CONFIRMATION,
    )).not.toThrow();
    expect(() => assertReviewGatedVideoRecoveryConfirmation(
      'restart-full', REVIEW_GATED_VIDEO_RESTART_CONFIRMATION,
    )).not.toThrow();
    expect(() => assertReviewGatedVideoRecoveryConfirmation(
      'restart-full', REVIEW_GATED_VIDEO_RESUME_CONFIRMATION,
    )).toThrow(/RESTART_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION/);
    for (const decision of ['inspect', 'approve', 'adjust', 'reject']) {
      expect(() => assertReviewGatedVideoReviewConfirmation(
        decision, REVIEW_GATED_VIDEO_REVIEW_CONFIRMATIONS[decision],
      )).not.toThrow();
    }
  });

  it('accepts only an exact separately reviewed canonical manifest', () => {
    expect(assertReviewedCanonicalManifest(reviewedManifest, {
      slug: fighter.slug,
      fighterId: 'a'.repeat(32),
      photoHash: fighter.reference.sourceSha256,
    })).toBe(reviewedManifest);
    expect(() => assertReviewedCanonicalManifest({
      ...reviewedManifest,
      canonicalSourceHashes: {
        ...reviewedManifest.canonicalSourceHashes,
        side: { ...reviewedManifest.canonicalSourceHashes.side, extra: true },
      },
    })).toThrow(/side hashes are invalid/i);
    expect(() => assertReviewedCanonicalManifest({
      ...reviewedManifest,
      fighterId: 'b'.repeat(32),
    }, { fighterId: 'a'.repeat(32) })).toThrow(/does not match the selected fighter/i);
  });

  it('rejects an existing Video job whose sealed run does not match that manifest', async () => {
    const stale = videoJob({
      status: 'running',
      reviewStatus: 'none',
      canonicalSourceMode: 'reviewed-current-v1',
      canonicalSourceHashes: {
        ...reviewedManifest.canonicalSourceHashes,
        crouch: {
          ...reviewedManifest.canonicalSourceHashes.crouch,
          rawSha256: '9'.repeat(64),
        },
      },
    });
    const api = videoStepReadApi(fighter, [stale]);
    await expect(runReviewGatedVideoStep({
      ...runnerOptions(api.requestApi),
      reviewedCanonicalManifest: reviewedManifest,
    })).rejects.toThrow(/not sealed to the separately reviewed canonical manifest/i);
    expect(api.calls).toHaveLength(3);
  });

  it('returns an existing awaiting-review candidate without any mutation', async () => {
    const job = videoJob();
    const api = videoStepReadApi(fighter, [job], new Map([[job.id, videoReview(job)]]));
    const result = await runReviewGatedVideoStep(runnerOptions(api.requestApi));

    expect(result).toMatchObject({
      mode: 'reused-review',
      mutated: false,
      job: { id: job.id, creationFlow: 'video', reviewStatus: 'awaiting_review' },
      review: {
        jobId: job.id,
        candidateId: 'e'.repeat(32),
        action: 'idle',
        technicalOutcome: 'technical_pass',
      },
    });
    expect(api.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/admin/arcade',
      `GET /api/fighters/${'a'.repeat(32)}`,
      `GET /api/generation-jobs?fighterId=${'a'.repeat(32)}`,
      `GET /api/generation-jobs/${job.id}/video-review`,
    ]);
    expect(api.calls.some(({ method, path }) => (
      method !== 'GET' || /generation-contract|\/sources(?:\/|$)|\/approve$/.test(path)
    ))).toBe(false);
  });

  it('refuses a roster entry that is not the exact private Champion draft', async () => {
    const entry = reviewedAdminEntry(fighter, { public: true });
    const calls = [];
    const requestApi = async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET' });
      if (path === '/api/admin/arcade') return { fighters: [entry] };
      if (path === `/api/fighters/${entry.fighterId}`) {
        return { fighter: reviewedOwnedFighter(fighter) };
      }
      throw new Error(`Unexpected draft validation request: ${path}`);
    };

    await expect(runReviewGatedVideoStep(runnerOptions(requestApi)))
      .rejects.toThrow(/exact private Champion draft.*visibility/);
    expect(calls).toEqual([
      { path: '/api/admin/arcade', method: 'GET' },
      { path: `/api/fighters/${entry.fighterId}`, method: 'GET' },
    ]);
  });

  it('continues an approved action through the same admin endpoint and stops at the next review', async () => {
    const approved = videoJob({
      status: 'succeeded',
      reviewStatus: 'approved',
      stage: 'review:approved',
      resumable: true,
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    const queued = videoJob({
      id: continuedVideoJobId,
      status: 'queued',
      reviewStatus: 'none',
      stage: 'queued',
      resumedFromJobId: approved.id,
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    const awaiting = {
      ...queued,
      status: 'succeeded',
      reviewStatus: 'awaiting_review',
      stage: 'awaiting_review',
      progressCurrent: 5,
    };
    const nextReview = videoReview(awaiting, {
      candidateId: '1'.repeat(32),
      action: 'walk',
      sequenceOrder: 1,
      technicalOutcome: 'needs_review',
    });
    const entry = reviewedAdminEntry(fighter);
    const owned = reviewedOwnedFighter(fighter);
    const calls = [];
    const requestApi = async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET', body: init.body });
      if (path === '/api/admin/arcade' && !init.method) return { fighters: [entry] };
      if (path === `/api/fighters/${entry.fighterId}` && !init.method) return { fighter: owned };
      if (path === `/api/generation-jobs?fighterId=${entry.fighterId}` && !init.method) {
        return { jobs: [approved] };
      }
      if (path === `/api/admin/arcade/${entry.fighterId}/generate` && init.method === 'POST') {
        return { job: queued };
      }
      if (path === `/api/generation-jobs/${queued.id}` && !init.method) return { job: awaiting };
      if (path === `/api/generation-jobs/${queued.id}/video-review` && !init.method) {
        return { review: nextReview };
      }
      throw new Error(`Unexpected Video continuation request: ${init.method ?? 'GET'} ${path}`);
    };

    const result = await runReviewGatedVideoStep({
      ...runnerOptions(requestApi),
      reviewedCanonicalManifest: reviewedManifest,
    });
    expect(result).toMatchObject({
      mode: 'continued',
      mutated: true,
      job: { id: continuedVideoJobId, reviewStatus: 'awaiting_review' },
      review: { action: 'walk', technicalOutcome: 'needs_review' },
    });
    const posts = calls.filter(({ method }) => method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(`/api/admin/arcade/${entry.fighterId}/generate`);
    expect(JSON.parse(posts[0].body)).toEqual({
      legal: {
        legalVersion: manifest.legalVersion,
        ageConfirmed: true,
        termsAccepted: true,
        photoRightsConfirmed: true,
        aiProcessingConfirmed: true,
        immediatePerformanceConfirmed: true,
        withdrawalLossAcknowledged: true,
      },
      creationFlow: 'video',
      recoveryFromJobId: approved.id,
      canonicalSourceMode: 'reviewed-current-v1',
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    expect(calls.some(({ path }) => (
      /generation-contract|\/sources(?:\/|$)|\/approve$|\/reject$|\/adjust$/.test(path)
    ))).toBe(false);
  });

  it('plans only an explicit exact unsealed zero-checkpoint legacy root for full restart', () => {
    const unsealed = videoJob({
      artifactRunId: videoJobId,
      status: 'failed',
      reviewStatus: 'none',
      stage: 'source:side',
      resumable: false,
      fullRunRestartRequired: true,
      canonicalSourceMode: null,
      canonicalSourceHashes: null,
      preservedArtifactCount: 0,
      completedStages: [],
    });

    expect(planReviewGatedVideoStep(
      [unsealed],
      unsealed.fighterId,
      { restartFromJobId: unsealed.id },
    )).toEqual({ action: 'restart-full', job: unsealed });
    expect(() => planReviewGatedVideoStep(
      [{ ...unsealed, fullRunRestartRequired: false }],
      unsealed.fighterId,
      { restartFromJobId: unsealed.id },
    )).toThrow(/not an exact terminal restart-required run/);
  });

  it('persists the exact recovery job binding before a later poll failure', async () => {
    const entry = reviewedAdminEntry(fighter);
    const owned = reviewedOwnedFighter(fighter);
    const queued = videoJob({
      status: 'queued', reviewStatus: 'none', stage: 'queued',
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    const failed = {
      ...queued,
      status: 'failed',
      stage: 'video:provider',
      resumable: true,
      errorCode: 'provider_transport_failed',
    };
    const calls = [];
    const requestApi = async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET' });
      if (path === '/api/admin/arcade' && !init.method) return { fighters: [entry] };
      if (path === `/api/fighters/${entry.fighterId}` && !init.method) return { fighter: owned };
      if (path === `/api/generation-jobs?fighterId=${entry.fighterId}` && !init.method) return { jobs: [] };
      if (path === `/api/admin/arcade/${entry.fighterId}/generate` && init.method === 'POST') {
        return { job: queued };
      }
      if (path === `/api/generation-jobs/${queued.id}` && !init.method) return { job: failed };
      throw new Error(`Unexpected failed-poll request: ${init.method ?? 'GET'} ${path}`);
    };
    const destination = mkdtempSync(join(tmpdir(), 'arcade-video-recovery-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(runReviewGatedVideoStep({
        ...runnerOptions(requestApi),
        reviewedCanonicalManifest: reviewedManifest,
        reviewedManifestRunId: '123',
        reviewedManifestSha256: '8'.repeat(64),
        expectedWorkerSha: '7'.repeat(40),
        reviewArtifactDir: destination,
      })).rejects.toThrow(/Video generation failed/);
      expect(calls.filter(({ method }) => method === 'POST')).toHaveLength(1);
      expect(log.mock.calls.flat().join('\n')).toContain(`"jobId":"${queued.id}"`);
      expect(JSON.parse(readFileSync(join(destination, 'video-job-descriptor.json'), 'utf8')))
        .toEqual({
          schemaVersion: 1,
          fighter: fighter.slug,
          mode: 'started',
          operation: 'start',
          jobId: queued.id,
          artifactRunId: queued.artifactRunId,
          resumedFromJobId: null,
          reviewedCanonicalSourceMode: reviewedManifest.canonicalSourceMode,
          reviewedCanonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
          reviewedManifestRunId: '123',
          reviewedManifestSha256: '8'.repeat(64),
          expectedWorkerSha: '7'.repeat(40),
        });
    } finally {
      log.mockRestore();
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it.each([
    {
      operation: 'resume-failed',
      source: videoJob({
        status: 'failed', reviewStatus: 'none', stage: 'video:compile',
        resumable: true, fullRunRestartRequired: false,
        canonicalSourceMode: reviewedManifest.canonicalSourceMode,
        canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
      }),
      expectedMode: 'resumed-failed',
      expectedRestart: false,
    },
    {
      operation: 'restart-full',
      source: videoJob({
        status: 'succeeded', reviewStatus: 'rejected', stage: 'review:rejected',
        resumable: false, fullRunRestartRequired: true,
        canonicalSourceMode: reviewedManifest.canonicalSourceMode,
        canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
      }),
      expectedMode: 'restarted-full',
      expectedRestart: true,
    },
    {
      operation: 'restart-full',
      source: videoJob({
        artifactRunId: videoJobId,
        status: 'failed', reviewStatus: 'none', stage: 'video:provider',
        resumable: false, fullRunRestartRequired: true,
        canonicalSourceMode: null,
        canonicalSourceHashes: null,
        preservedArtifactCount: 0,
        completedStages: [],
      }),
      expectedMode: 'restarted-full',
      expectedRestart: true,
    },
    {
      operation: 'restart-full',
      source: videoJob({
        status: 'succeeded', reviewStatus: 'approved', stage: 'review:restart_required',
        resumable: false, fullRunRestartRequired: true,
        canonicalSourceMode: reviewedManifest.canonicalSourceMode,
        canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
      }),
      expectedMode: 'restarted-full',
      expectedRestart: true,
    },
  ])('performs one exact sealed $operation POST and no accidental duplicate', async ({
    operation, source, expectedMode, expectedRestart,
  }) => {
    const entry = reviewedAdminEntry(fighter);
    const owned = reviewedOwnedFighter(fighter);
    const freshRunId = operation === 'restart-full' ? continuedVideoJobId : source.artifactRunId;
    const queued = videoJob({
      id: continuedVideoJobId,
      artifactRunId: freshRunId,
      resumedFromJobId: operation === 'resume-failed' ? source.id : null,
      status: 'queued', reviewStatus: 'none', stage: 'queued',
      resumable: false, fullRunRestartRequired: false,
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    const awaiting = {
      ...queued, status: 'succeeded', reviewStatus: 'awaiting_review', stage: 'awaiting_review',
    };
    const review = videoReview(awaiting);
    const calls = [];
    const requestApi = async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET', body: init.body });
      if (path === '/api/admin/arcade' && !init.method) return { fighters: [entry] };
      if (path === `/api/fighters/${entry.fighterId}` && !init.method) return { fighter: owned };
      if (path === `/api/generation-jobs?fighterId=${entry.fighterId}` && !init.method) {
        return { jobs: [source] };
      }
      if (path === `/api/admin/arcade/${entry.fighterId}/generate` && init.method === 'POST') {
        return { job: queued };
      }
      if (path === `/api/generation-jobs/${queued.id}` && !init.method) return { job: awaiting };
      if (path === `/api/generation-jobs/${queued.id}/video-review` && !init.method) {
        return { review };
      }
      throw new Error(`Unexpected recovery request: ${init.method ?? 'GET'} ${path}`);
    };
    const result = await runReviewGatedVideoStep({
      ...runnerOptions(requestApi),
      reviewedCanonicalManifest: reviewedManifest,
      ...(operation === 'resume-failed' ? { resumeFromJobId: source.id } : {}),
      ...(operation === 'restart-full' ? { restartFromJobId: source.id } : {}),
    });
    expect(result).toMatchObject({ mode: expectedMode, mutated: true });
    const posts = calls.filter(({ method }) => method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body)).toEqual({
      legal: {
        legalVersion: manifest.legalVersion,
        ageConfirmed: true,
        termsAccepted: true,
        photoRightsConfirmed: true,
        aiProcessingConfirmed: true,
        immediatePerformanceConfirmed: true,
        withdrawalLossAcknowledged: true,
      },
      creationFlow: 'video',
      ...(expectedRestart ? { restart: true } : {}),
      recoveryFromJobId: source.id,
      canonicalSourceMode: 'reviewed-current-v1',
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
  });

  it('keeps a sealed restart root bound to the exact reviewed manifest before POST', async () => {
    const sealedMismatch = videoJob({
      status: 'failed',
      reviewStatus: 'none',
      stage: 'video:provider',
      resumable: false,
      fullRunRestartRequired: true,
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: {
        ...reviewedManifest.canonicalSourceHashes,
        side: {
          ...reviewedManifest.canonicalSourceHashes.side,
          rawSha256: '9'.repeat(64),
        },
      },
    });
    const api = videoStepReadApi(fighter, [sealedMismatch]);

    await expect(runReviewGatedVideoStep({
      ...runnerOptions(api.requestApi),
      reviewedCanonicalManifest: reviewedManifest,
      restartFromJobId: sealedMismatch.id,
    })).rejects.toThrow(/not sealed to the separately reviewed canonical manifest/i);
    expect(api.calls.some(({ method }) => method === 'POST')).toBe(false);
  });

  it('still rejects a fresh restart root that is not strictly sealed to the manifest', async () => {
    const unsealed = videoJob({
      artifactRunId: videoJobId,
      status: 'failed',
      reviewStatus: 'none',
      stage: 'source:side',
      resumable: false,
      fullRunRestartRequired: true,
      canonicalSourceMode: null,
      canonicalSourceHashes: null,
      preservedArtifactCount: 0,
      completedStages: [],
    });
    const freshMismatch = videoJob({
      id: continuedVideoJobId,
      artifactRunId: continuedVideoJobId,
      status: 'queued',
      reviewStatus: 'none',
      stage: 'queued',
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: {
        ...reviewedManifest.canonicalSourceHashes,
        crouch: {
          ...reviewedManifest.canonicalSourceHashes.crouch,
          processedSha256: '9'.repeat(64),
        },
      },
    });
    const entry = reviewedAdminEntry(fighter);
    const owned = reviewedOwnedFighter(fighter);
    const calls = [];
    const requestApi = async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET', body: init.body });
      if (path === '/api/admin/arcade' && !init.method) return { fighters: [entry] };
      if (path === `/api/fighters/${entry.fighterId}` && !init.method) return { fighter: owned };
      if (path === `/api/generation-jobs?fighterId=${entry.fighterId}` && !init.method) {
        return { jobs: [unsealed] };
      }
      if (path === `/api/admin/arcade/${entry.fighterId}/generate` && init.method === 'POST') {
        return { job: freshMismatch };
      }
      throw new Error(`Unexpected strict restart request: ${init.method ?? 'GET'} ${path}`);
    };

    await expect(runReviewGatedVideoStep({
      ...runnerOptions(requestApi),
      reviewedCanonicalManifest: reviewedManifest,
      restartFromJobId: unsealed.id,
    })).rejects.toThrow(/not sealed to the separately reviewed canonical manifest/i);
    const posts = calls.filter(({ method }) => method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body)).toMatchObject({
      creationFlow: 'video',
      restart: true,
      recoveryFromJobId: unsealed.id,
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
  });

  it('fails a stale recovery source before POST when any newer job exists', () => {
    const rejected = videoJob({
      status: 'succeeded', reviewStatus: 'rejected', fullRunRestartRequired: true,
    });
    const newer = videoJob({
      id: continuedVideoJobId, status: 'failed', reviewStatus: 'none', resumable: true,
    });
    expect(() => planReviewGatedVideoStep(
      [newer, rejected], 'a'.repeat(32), { restartFromJobId: rejected.id },
    )).toThrow(/not the latest Video job/);
  });

  it('exports one immutable six-asset inspection descriptor with exact review lineage', async () => {
    const job = videoJob({
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    const review = videoReview(job);
    const api = videoStepReadApi(fighter, [], new Map([[job.id, review]]));
    const requestApi = async (baseUrl, token, path, init = {}) => {
      if (path === `/api/generation-jobs/${job.id}` && !init.method) return { job };
      return api.requestApi(baseUrl, token, path, init);
    };
    const destination = mkdtempSync(join(tmpdir(), 'arcade-video-review-'));
    try {
      const result = await runReviewGatedVideoInspection({
        ...runnerOptions(requestApi),
        reviewedCanonicalManifest: reviewedManifest,
        reviewedManifestRunId: '123',
        reviewedManifestSha256: '8'.repeat(64),
        jobId: job.id,
        candidateId: review.candidateId,
        revision: review.revision,
        reportSha256: review.reportSha256,
        destination,
        requestAsset: boundReviewAsset,
      });
      expect(result.descriptor).toMatchObject({
        schemaVersion: 1,
        fighter: fighter.slug,
        fighterId: job.fighterId,
        jobId: job.id,
        artifactRunId: job.artifactRunId,
        candidateId: review.candidateId,
        revision: 1,
        reportSha256: review.reportSha256,
        action: 'idle',
        sequenceOrder: 0,
        technicalOutcome: 'technical_pass',
        selectedVideoIndices: review.selectedVideoIndices,
        sourceFrameCount: 12,
        animationFormat: 'video-dense-v1',
        processingVersion: 5,
        reviewedManifestRunId: '123',
        reviewedManifestSha256: '8'.repeat(64),
      });
      expect(Object.keys(result.descriptor.assets)).toEqual([
        'video', 'contactSheet', 'uniqueSheet', 'runtime', 'raw', 'report',
      ]);
      for (const filename of [
        'video.mp4', 'contact-sheet.png', 'unique-sheet.png',
        'runtime.png', 'raw.png', 'report.json', 'review-descriptor.json',
      ]) {
        expect(readFileSync(join(destination, filename)).byteLength).toBeGreaterThan(0);
      }
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it.each(['approve', 'adjust', 'reject'])(
    'applies one exact human-bound %s decision and never auto-reviews',
    async (decision) => {
      const entry = reviewedAdminEntry(fighter);
      const owned = reviewedOwnedFighter(fighter);
      const job = videoJob({
        canonicalSourceMode: reviewedManifest.canonicalSourceMode,
        canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
      });
      const review = videoReview(job);
      const requestedIndices = decision === 'adjust' ? [1, 3, 5, 7] : review.selectedVideoIndices;
      const updated = decision === 'approve'
        ? { ...review, status: 'approved', continuationAvailable: true }
        : decision === 'adjust'
          ? videoReview(job, {
              revision: review.revision + 1,
              reportSha256: '9'.repeat(64),
              selectedVideoIndices: requestedIndices,
            })
          : { ...review, status: 'rejected', fullRunRestartRequired: true };
      const calls = [];
      const requestApi = async (_baseUrl, _token, path, init = {}) => {
        calls.push({ path, method: init.method ?? 'GET', body: init.body });
        if (path === '/api/admin/arcade' && !init.method) return { fighters: [entry] };
        if (path === `/api/fighters/${entry.fighterId}` && !init.method) return { fighter: owned };
        if (path === `/api/generation-jobs/${job.id}` && !init.method) return { job };
        if (path === `/api/generation-jobs/${job.id}/video-review` && !init.method) {
          return { review };
        }
        if (path === `/api/generation-jobs/${job.id}/video-review/${decision}` && init.method === 'POST') {
          return { review: updated };
        }
        throw new Error(`Unexpected decision request: ${init.method ?? 'GET'} ${path}`);
      };
      const destination = decision === 'adjust'
        ? mkdtempSync(join(tmpdir(), 'arcade-video-adjust-'))
        : '';
      try {
        const result = await runReviewGatedVideoDecision({
          ...runnerOptions(requestApi),
          reviewedCanonicalManifest: reviewedManifest,
          reviewedManifestRunId: '123',
          reviewedManifestSha256: '8'.repeat(64),
          decision,
          jobId: job.id,
          candidateId: review.candidateId,
          revision: review.revision,
          reportSha256: review.reportSha256,
          selectedVideoIndices: decision === 'reject' ? null : requestedIndices,
          reason: decision === 'reject' ? 'The reviewed motion breaks the approved pose contract.' : '',
          destination,
          requestAsset: boundReviewAsset,
        });
        expect(result).toMatchObject({ decision, review: { status: updated.status } });
        expect(result.descriptor === null).toBe(decision !== 'adjust');
        const posts = calls.filter(({ method }) => method === 'POST');
        expect(posts).toHaveLength(1);
        expect(JSON.parse(posts[0].body)).toEqual({
          candidateId: review.candidateId,
          revision: review.revision,
          reportSha256: review.reportSha256,
          ...(decision === 'adjust' ? { selectedVideoIndices: requestedIndices } : {}),
          ...(decision === 'reject'
            ? { reason: 'The reviewed motion breaks the approved pose contract.' }
            : {}),
        });
      } finally {
        if (destination) rmSync(destination, { recursive: true, force: true });
      }
    },
  );

  it('refuses a stale review binding without issuing a decision POST', async () => {
    const job = videoJob({
      canonicalSourceMode: reviewedManifest.canonicalSourceMode,
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    const review = videoReview(job);
    const api = videoStepReadApi(fighter, [], new Map([[job.id, review]]));
    const requestApi = async (baseUrl, token, path, init = {}) => {
      if (path === `/api/generation-jobs/${job.id}`) return { job };
      return api.requestApi(baseUrl, token, path, init);
    };
    await expect(runReviewGatedVideoDecision({
      ...runnerOptions(requestApi),
      reviewedCanonicalManifest: reviewedManifest,
      reviewedManifestRunId: '123',
      reviewedManifestSha256: '8'.repeat(64),
      decision: 'approve',
      jobId: job.id,
      candidateId: '7'.repeat(32),
      revision: review.revision,
      reportSha256: review.reportSha256,
      selectedVideoIndices: review.selectedVideoIndices,
    })).rejects.toThrow(/binding changed before mutation/);
    expect(api.calls.some(({ method }) => method === 'POST')).toBe(false);
  });

  it('fails closed on cross-flow, failed, rejected, or restart-required state', () => {
    expect(() => planReviewGatedVideoStep([
      videoJob({ status: 'running', reviewStatus: 'none', creationFlow: 'original' }),
    ], 'a'.repeat(32))).toThrow(/crossed its sealed scope/);
    expect(() => planReviewGatedVideoStep([
      videoJob({ status: 'failed', reviewStatus: 'none' }),
    ], 'a'.repeat(32))).toThrow(/never retries or restarts/);
    expect(() => planReviewGatedVideoStep([
      videoJob({ reviewStatus: 'rejected' }),
    ], 'a'.repeat(32))).toThrow(/explicit full-run restart/);
    expect(() => planReviewGatedVideoStep([
      videoJob({ reviewStatus: 'approved', fullRunRestartRequired: true }),
    ], 'a'.repeat(32))).toThrow(/explicit full-run restart/);
  });

  it('uses an additive per-fighter workflow with no Gemini-only preflight or review mutation', () => {
    expect(videoStepWorkflow).toContain('workflow_dispatch:');
    expect(videoStepWorkflow).toContain('START_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION');
    expect(videoStepWorkflow).toContain('RESUME_FAILED_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION');
    expect(videoStepWorkflow).toContain('RESTART_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION');
    expect(videoStepWorkflow).toContain('- resume-failed');
    expect(videoStepWorkflow).toContain('- restart-full');
    expect(videoStepWorkflow).toContain('--resume-video-run-from="$RECOVERY_FROM_JOB_ID"');
    expect(videoStepWorkflow).toContain('--restart-video-run-from="$RECOVERY_FROM_JOB_ID"');
    expect(videoStepWorkflow).toContain('group: production-worker-mutations');
    expect(videoStepWorkflow).toContain('cancel-in-progress: false');
    expect(videoStepWorkflow).toContain('--video-step');
    expect(videoStepWorkflow).toContain('--confirm-video-step="$REQUESTED_CONFIRMATION"');
    expect(videoStepWorkflow).toContain('reviewed_manifest_run_id:');
    expect(videoStepWorkflow).toMatch(
      /reviewed_manifest_run_id:[\s\S]*?required: true[\s\S]*?type: string/,
    );
    expect(videoStepWorkflow).toContain('reviewed_manifest_run_id must be a required numeric');
    expect(videoStepWorkflow).toContain("run.status !== 'completed'");
    expect(videoStepWorkflow).toContain("run.conclusion !== 'success'");
    expect(videoStepWorkflow).toContain('allowedProducerPaths');
    expect(videoStepWorkflow).toContain('import-reviewed-xai-canonical-production.yml');
    expect(videoStepWorkflow).toContain('import-reviewed-elon-mixed-canonical-production.yml');
    expect(videoStepWorkflow).toContain('import-reviewed-global-mixed-canonical-production.yml');
    expect(videoStepWorkflow).toContain('arcade-reviewed-canonical-manifest-$REQUESTED_SLUG');
    expect(videoStepWorkflow).toContain('--reviewed-canonical-manifest=%s');
    expect(videoStepWorkflow).toContain('--expected-deployed-sha="$GITHUB_SHA"');
    expect(videoStepWorkflow).toContain('--reviewed-manifest-run-id="$REVIEWED_MANIFEST_RUN_ID"');
    expect(videoStepWorkflow).toContain('--video-review-export-dir="$RUNNER_TEMP/video-review"');
    expect(videoStepWorkflow).toContain('actions/upload-artifact@v7');
    expect(videoStepWorkflow).toContain('if: always()');
    expect(videoStepWorkflow).toContain('arcade-video-review-${{ inputs.slug }}-${{ github.run_id }}');
    expect(videoStepWorkflow).toContain('ASF_WORKER_HEALTH_URL: ${{ vars.ASF_WORKER_HEALTH_URL }}');
    expect(videoStepWorkflow).toContain('health?.status !== \'ok\'');
    expect(videoStepWorkflow).toContain('health.environment !== \'production\'');
    expect(videoStepWorkflow).toContain('expectedTag.test(health.workerVersion.tag)');
    expect(videoStepWorkflow).toContain('new RegExp(`^prod-${expectedSha}-[1-9][0-9]*$`)');
    expect(videoStepWorkflow).toContain("workerBase !== 'https://api.insertplayer.ai'");
    expect(videoStepWorkflow).toContain("redirect: 'error'");
    expect(videoStepWorkflow).not.toContain('npm run check:production');
    expect(videoStepWorkflow).not.toContain('docker build');
    expect(videoStepWorkflow).not.toContain('generation-contract');
    expect(videoStepWorkflow).not.toContain('assert-approved-image-providers');
    expect(videoStepWorkflow).not.toContain('--activate');
    expect(videoStepWorkflow).not.toContain('/approve');
    expect(videoStepWorkflow).not.toContain('/sources');
    expect(videoStepWorkflow).not.toContain('generate-source');
  });

  it('wires the separately reviewed manifest from the CLI into the exact Video POST path', () => {
    expect(seedRosterScript).toMatch(
      /if \(videoStep\) \{[\s\S]*?runReviewGatedVideoStep\(\{[\s\S]*?reviewedCanonicalManifest,[\s\S]*?\}\);/,
    );
  });

  it('keeps inspection separate from every exact human review decision in Actions', () => {
    expect(videoReviewWorkflow).toContain('- inspect');
    expect(videoReviewWorkflow).toContain('- approve');
    expect(videoReviewWorkflow).toContain('- adjust');
    expect(videoReviewWorkflow).toContain('- reject');
    expect(videoReviewWorkflow).toContain('INSPECT_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION');
    expect(videoReviewWorkflow).toContain('APPROVE_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION');
    expect(videoReviewWorkflow).toContain('ADJUST_REVIEW_GATED_VIDEO_ARCADE_PRODUCTION');
    expect(videoReviewWorkflow).toContain('REJECT_AND_ABANDON_REVIEW_GATED_VIDEO_RUN_PRODUCTION');
    expect(videoReviewWorkflow).toContain("if: inputs.operation != 'inspect'");
    expect(videoReviewWorkflow).toContain('run.head_sha !== process.env.GITHUB_SHA');
    expect(videoReviewWorkflow).toContain('arcade-video-step-production.yml');
    expect(videoReviewWorkflow).toContain('arcade-video-review-$REQUESTED_SLUG-$INSPECTION_RUN_ID');
    expect(videoReviewWorkflow).toContain('review-descriptor.json');
    expect(videoReviewWorkflow).toContain('reviewedManifestSha256 === manifestSha');
    expect(videoReviewWorkflow).toContain("raw: ['raw.png', 'image/png']");
    expect(videoReviewWorkflow).toContain('--video-review-inspect');
    expect(videoReviewWorkflow).toContain('--video-review-decision="$REQUESTED_OPERATION"');
    expect(videoReviewWorkflow).toContain('--video-review-selected-indices="$SELECTED_VIDEO_INDICES"');
    expect(videoReviewWorkflow).toContain('--video-review-reason="$REJECTION_REASON"');
    expect(videoReviewWorkflow).toContain('--video-review-export-dir="$RUNNER_TEMP/video-review"');
    expect(videoReviewWorkflow).toContain('actions/upload-artifact@v7');
    expect(videoReviewWorkflow).toContain('run: npm --prefix worker ci');
    expect(videoReviewWorkflow).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(videoReviewWorkflow).toContain('CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}');
    expect(videoReviewWorkflow).toContain("if: inputs.operation == 'inspect' || inputs.operation == 'adjust'");
    expect(videoReviewWorkflow).toContain('arcade-video-review-${{ inputs.slug }}-${{ github.run_id }}');
    expect(videoReviewWorkflow).toContain("workerBase !== 'https://api.insertplayer.ai'");
    expect(videoReviewWorkflow).toContain("redirect: 'error'");
    expect(videoReviewWorkflow).not.toContain('/generate');
    expect(videoReviewWorkflow).not.toContain('generation-contract');
  });
});

describe('Arcade roster provider preflight', () => {
  const approved = {
    ready: true,
    runtime: 'canvas-skia',
    contract: {
      schemaVersion: 1,
      processorRuntimeRevision: 'meterkey-transport-v1',
      allowedGenerationProviders: ['gemini'],
      sourceModels: {
        side: 'gemini-3-pro-image',
        upright: 'gemini-3-pro-image',
        crouch: 'gemini-3-pro-image',
      },
      championAnimation: {
        scaffoldModel: 'gemini-3.1-flash-image',
        renderModel: 'gemini-3-pro-image',
        reviewModel: 'gemini-3-pro-image',
      },
      fallbackPolicy: 'fail-closed',
    },
  };

  it('accepts the deployed pre-multi-provider Gemini contract', () => {
    expect(assertApprovedArcadeGenerationContract(approved)).toEqual(approved.contract);
  });

  it('fails before seeding when any provider or model differs', () => {
    const flux = structuredClone(approved);
    flux.contract.allowedGenerationProviders = ['fal'];
    expect(() => assertApprovedArcadeGenerationContract(flux)).toThrow(/aborted before mutation/);

    const changedSource = structuredClone(approved);
    changedSource.contract.sourceModels.side = 'gemini-3.1-flash-image';
    expect(() => assertApprovedArcadeGenerationContract(changedSource)).toThrow(/aborted before mutation/);

    const unavailable = structuredClone(approved);
    unavailable.ready = false;
    expect(() => assertApprovedArcadeGenerationContract(unavailable)).toThrow(/aborted before mutation/);
  });

  it('keeps a non-billable preflight as the production workflow default', () => {
    expect(productionWorkflow).toContain('default: preflight');
    expect(productionWorkflow).toContain('if: inputs.operation != \'preflight\'');
    expect(productionWorkflow).toContain('seed_args+=(--preflight-only)');
    expect(productionWorkflow).toContain(
      '"$REQUESTED_OPERATION" != "dry-run" && "$REQUESTED_OPERATION" != "preflight"',
    );
  });

  it('keeps reviewed activation separate from generation and provider preflight', () => {
    expect(productionWorkflow).toContain('- activate-reviewed');
    expect(productionWorkflow).toContain('ACTIVATE_REVIEWED_ARCADE_FIGHTER_PRODUCTION');
    expect(productionWorkflow).toContain("if: inputs.operation != 'activate-reviewed'");
    expect(productionWorkflow).toContain('--activate-reviewed');
    expect(productionWorkflow).toContain('--confirm-activation="$REQUESTED_CONFIRMATION"');
    expect(productionWorkflow).toContain('reviewed_video_final_job_id:');
    expect(productionWorkflow).toContain('--reviewed-video-final-job-id="$REVIEWED_VIDEO_FINAL_JOB_ID"');
    expect(productionWorkflow).toContain('--expected-deployed-sha="$GITHUB_SHA"');
    expect(productionWorkflow).toContain("if: inputs.operation == 'activate-reviewed'");
    expect(productionWorkflow).toContain('expectedTag.test(health.workerVersion.tag)');
    expect(productionWorkflow).toContain("workerBase !== 'https://api.insertplayer.ai'");
    expect(productionWorkflow).toContain("redirect: 'error'");
    expect(seedRosterScript).toContain('verifyReviewedVideoActivationProvenance');
    expect(seedRosterScript).toContain('approvedActionCount: approvals.length');
    expect(seedRosterScript).toContain("finalAction: 'victory'");
  });

  it('keeps the Original operations free of reviewed Video-only requirements', () => {
    expect(productionWorkflow).toContain("if: inputs.operation == 'activate-reviewed'");
    expect(productionWorkflow).toContain(
      'if [[ "$REQUESTED_OPERATION" != "activate-reviewed" && -n "$REVIEWED_VIDEO_FINAL_JOB_ID" ]]',
    );
    expect(productionWorkflow).toContain('seed_args+=(--confirm-production)');
    expect(productionWorkflow).toContain('seed_args+=(--resume --confirm-production)');
  });

  it('keeps canary preparation separate from the capped side inference', () => {
    expect(productionWorkflow).toContain('seed_args+=(--prepare-canary --confirm-production)');
    expect(productionWorkflow).toContain('seed_args+=(--canary-side --confirm-production)');
  });

  it('exposes the one-call side probe as a separately guarded production operation', () => {
    expect(productionWorkflow).toContain('- probe-side');
    expect(productionWorkflow).toContain('seed_args+=(--probe-side --confirm-production)');
  });
});
