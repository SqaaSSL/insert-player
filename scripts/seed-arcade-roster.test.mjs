import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertApprovedArcadeGenerationContract,
  findCurrentArcadeEntry,
  planArcadeDraftRegistration,
  planFighterResume,
  validateManifest,
} from './seed-arcade-roster.mjs';

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

  it('keeps canary preparation separate from the capped side inference', () => {
    expect(productionWorkflow).toContain('seed_args+=(--prepare-canary --confirm-production)');
    expect(productionWorkflow).toContain('seed_args+=(--canary-side --confirm-production)');
  });
});
