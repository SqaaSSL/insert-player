import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REVIEWED_ARCADE_ACTIVATION_CONFIRMATION,
  activateReviewedArcadeFighter,
  arcadeAdminAuthHeaders,
  assertApprovedArcadeGenerationContract,
  assertReviewedActivationConfirmation,
  findCurrentArcadeEntry,
  planArcadeDraftRegistration,
  planFighterResume,
  planSideDraftPreparation,
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
