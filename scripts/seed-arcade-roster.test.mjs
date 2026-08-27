import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VIDEO_SPRITE_ACTIONS as WORKER_VIDEO_SPRITE_ACTIONS } from '../src/services/VideoSpriteCompileContract';
import {
  REVIEW_GATED_VIDEO_STEP_CONFIRMATION,
  REVIEW_GATED_VIDEO_ACTIONS,
  REVIEWED_ARCADE_ACTIVATION_CONFIRMATION,
  activateReviewedArcadeFighter,
  arcadeAdminAuthHeaders,
  assertApprovedArcadeGenerationContract,
  assertAwaitingVideoReview,
  assertReviewGatedVideoStepConfirmation,
  assertReviewedCanonicalManifest,
  assertReviewedActivationConfirmation,
  findCurrentArcadeEntry,
  planArcadeDraftRegistration,
  planFighterResume,
  planReviewGatedVideoStep,
  planSideDraftPreparation,
  runReviewGatedVideoStep,
  validateManifest,
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

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const productionWorkflow = readFileSync(
  new URL('../.github/workflows/seed-arcade-production.yml', import.meta.url),
  'utf8',
);
const videoStepWorkflow = readFileSync(
  new URL('../.github/workflows/arcade-video-step-production.yml', import.meta.url),
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
    sources: completeSources(),
    sourceHashes: { original: photoHash },
    sprites: animations.map((animationName) => ({
      animationName,
      qualityTier: 'champion',
      url: `/${animationName}.png`,
      rawUrl: `/${animationName}-raw.png`,
    })),
    ...overrides,
  };
}

function reviewedActivationApi(fighter, { entry, owned } = {}) {
  const resolvedEntry = entry ?? reviewedAdminEntry(fighter);
  const resolvedOwned = owned ?? reviewedOwnedFighter(fighter);
  const calls = [];
  return {
    calls,
    requestApi: async (_baseUrl, _token, path, init = {}) => {
      calls.push({ path, method: init.method ?? 'GET', body: init.body });
      if (path === '/api/admin/arcade' && !init.method) {
        return { fighters: [resolvedEntry] };
      }
      if (path === `/api/fighters/${resolvedEntry.fighterId}` && !init.method) {
        return { fighter: resolvedOwned };
      }
      if (path === `/api/admin/arcade/${resolvedEntry.fighterId}` && init.method === 'PATCH') {
        return {
          fighter: {
            ...resolvedEntry,
            status: 'active',
            public: true,
          },
        };
      }
      throw new Error(`Unexpected reviewed activation request: ${init.method ?? 'GET'} ${path}`);
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
  return {
    jobId: job.id,
    artifactRunId: job.artifactRunId,
    candidateId: 'e'.repeat(32),
    action: 'idle',
    sequenceOrder: 0,
    status: 'awaiting_review',
    revision: 1,
    reportSha256: 'f'.repeat(64),
    technicalOutcome: 'technical_pass',
    ...overrides,
  };
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
      if (path === '/api/generation-jobs' && !init.method) return { jobs };
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

  it('activates a complete reviewed draft with only two reads and the final PATCH', async () => {
    const api = reviewedActivationApi(fighter);
    const activated = await activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: api.requestApi,
    });

    expect(activated).toMatchObject({
      fighterId: 'a'.repeat(32),
      status: 'active',
      public: true,
    });
    expect(api.calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/admin/arcade',
      `GET /api/fighters/${'a'.repeat(32)}`,
      `PATCH /api/admin/arcade/${'a'.repeat(32)}`,
    ]);
    expect(JSON.parse(api.calls[2].body)).toMatchObject({
      slug: fighter.slug,
      status: 'active',
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
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: api.requestApi,
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
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: missingRawSprite.requestApi,
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
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: photoTamper.requestApi,
    })).rejects.toThrow(/licensed-photo hash/i);
    expect(photoTamper.calls.every(({ method }) => method === 'GET')).toBe(true);

    const manifestTamper = reviewedActivationApi(fighter, {
      entry: reviewedAdminEntry(fighter, { generationPrompt: 'tampered prompt' }),
    });
    await expect(activateReviewedArcadeFighter({
      manifest,
      fighter,
      approvedPhotoHash: fighter.reference.sourceSha256,
      baseUrl: 'https://api.insertplayer.ai',
      token: async () => 'token',
      requestApi: manifestTamper.requestApi,
    })).rejects.toThrow(/roster manifest.*generationPrompt/i);
    expect(manifestTamper.calls.every(({ method }) => method === 'GET')).toBe(true);
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
      'GET /api/generation-jobs',
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
    });
    const queued = videoJob({
      id: continuedVideoJobId,
      status: 'queued',
      reviewStatus: 'none',
      stage: 'queued',
      resumedFromJobId: approved.id,
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
      if (path === '/api/generation-jobs' && !init.method) return { jobs: [approved] };
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
      canonicalSourceMode: 'reviewed-current-v1',
      canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    });
    expect(calls.some(({ path }) => (
      /generation-contract|\/sources(?:\/|$)|\/approve$|\/reject$|\/adjust$/.test(path)
    ))).toBe(false);
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
    expect(videoStepWorkflow).toContain('group: production-arcade-video-${{ inputs.slug }}');
    expect(videoStepWorkflow).toContain('cancel-in-progress: false');
    expect(videoStepWorkflow).toContain('--video-step');
    expect(videoStepWorkflow).toContain('--confirm-video-step="$REQUESTED_CONFIRMATION"');
    expect(videoStepWorkflow).toContain('reviewed_manifest_run_id:');
    expect(videoStepWorkflow).toContain('arcade-reviewed-canonical-manifest-$REQUESTED_SLUG');
    expect(videoStepWorkflow).toContain('--reviewed-canonical-manifest=%s');
    expect(videoStepWorkflow).toContain('ASF_WORKER_HEALTH_URL: ${{ vars.ASF_WORKER_HEALTH_URL }}');
    expect(videoStepWorkflow).toContain('health?.status !== \'ok\'');
    expect(videoStepWorkflow).toContain('health.environment !== \'production\'');
    expect(videoStepWorkflow).toContain('health.workerVersion.tag.startsWith(expectedTagPrefix)');
    expect(videoStepWorkflow).toContain('const expectedTagPrefix = `prod-${expectedSha}-`;');
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
