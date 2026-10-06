import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VIDEO_SPRITE_ACTIONS as WORKER_VIDEO_SPRITE_ACTIONS,
  VIDEO_SPRITE_EXTRA_ACTIONS as WORKER_VIDEO_SPRITE_EXTRA_ACTIONS,
} from '../src/services/VideoSpriteCompileContract';
import {
  REVIEWED_ARCADE_EXTRA_ACTIVATION_CONFIRMATION,
  REVIEWED_ARCADE_EXTRA_ROLLBACK_CONFIRMATION,
  REVIEW_GATED_VIDEO_EXTRA_ACTIONS,
  REVIEW_GATED_VIDEO_EXTRA_CONFIRMATION,
  assertAwaitingVideoReview,
  assertReviewGatedVideoExtraConfirmation,
  assertReviewedExtraActivationConfirmation,
  isReviewGatedVideoExtraJob,
  planReviewGatedVideoStep,
  runReviewGatedVideoExtraStep,
  setReviewedArcadeExtraPublication,
} from './seed-arcade-roster.mjs';

const manifest = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const fighter = manifest.fighters.find((entry) => entry.slug === 'bad-bunny');
const FIGHTER_ID = 'a'.repeat(32);
const JOB_ID = 'b'.repeat(32);
const RUN_ID = 'd'.repeat(32);
const reviewedManifest = {
  schemaVersion: 1,
  canonicalSourceMode: 'reviewed-current-v1',
  slug: fighter.slug,
  fighterId: FIGHTER_ID,
  photoHash: fighter.reference.sourceSha256,
  canonicalSourceHashes: {
    side: { processedSha256: '1'.repeat(64), rawSha256: '2'.repeat(64) },
    upright: { processedSha256: '3'.repeat(64), rawSha256: '4'.repeat(64) },
    crouch: { processedSha256: '5'.repeat(64), rawSha256: '6'.repeat(64) },
  },
};
const liveEntry = { fighterId: FIGHTER_ID, fighterName: fighter.name, qualityTier: 'champion', slug: fighter.slug, status: 'active', public: true };
const liveOwned = { id: FIGHTER_ID, name: fighter.name, qualityTier: 'champion', photoHash: fighter.reference.sourceSha256, public: true };

function extraJob(overrides = {}) {
  return {
    id: JOB_ID, fighterId: FIGHTER_ID, tier: 'champion', creationFlow: 'video',
    operation: 'fighter_retry_animation', targetKind: 'animation', targetName: 'fireball',
    artifactRunId: RUN_ID, status: 'succeeded', reviewStatus: 'awaiting_review',
    fullRunRestartRequired: false, stage: 'awaiting_review', progressCurrent: 1, progressTotal: 1,
    canonicalSourceMode: reviewedManifest.canonicalSourceMode,
    canonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
    ...overrides,
  };
}

function extraReview(job, overrides = {}) {
  return {
    jobId: job.id, artifactRunId: job.artifactRunId, candidateId: 'e'.repeat(32),
    action: 'fireball', sequenceOrder: 11, status: 'awaiting_review', revision: 1,
    reportSha256: 'f'.repeat(64), technicalOutcome: 'technical_pass',
    selectedVideoIndices: [0, 2, 4, 6], sourceFrameCount: 12,
    animationFormat: 'video-dense-v1', processingVersion: 6, ...overrides,
  };
}

const options = (requestApi) => ({
  manifest, fighter, approvedPhotoHash: fighter.reference.sourceSha256,
  baseUrl: 'https://api.insertplayer.ai', token: async () => 'token', requestApi,
  pause: async () => {}, pollIntervalMs: 0,
});

describe('review-gated extra Video moves in the operator script', () => {
  it('mirrors the Worker extra moves and their sequence after the 11-action run', () => {
    expect(REVIEW_GATED_VIDEO_EXTRA_ACTIONS).toEqual([...WORKER_VIDEO_SPRITE_EXTRA_ACTIONS]);
    const job = extraJob();
    expect(assertAwaitingVideoReview(extraReview(job), job)).toBeTruthy();
    expect(() => assertAwaitingVideoReview(extraReview(job, { sequenceOrder: 0 }), job)).toThrow(/sealed identity/);
    expect(() => assertAwaitingVideoReview(extraReview(job, { action: 'uppercut', sequenceOrder: 12 }), job))
      .toThrow(/sealed identity/);
    expect(WORKER_VIDEO_SPRITE_ACTIONS).toHaveLength(11);
  });

  it('requires its own explicit confirmations', () => {
    expect(() => assertReviewGatedVideoExtraConfirmation('fireball', '')).toThrow(REVIEW_GATED_VIDEO_EXTRA_CONFIRMATION);
    expect(() => assertReviewGatedVideoExtraConfirmation('high_punch', REVIEW_GATED_VIDEO_EXTRA_CONFIRMATION)).toThrow(/fireball, uppercut/);
    expect(() => assertReviewGatedVideoExtraConfirmation('uppercut', REVIEW_GATED_VIDEO_EXTRA_CONFIRMATION)).not.toThrow();
    expect(() => assertReviewedExtraActivationConfirmation('activate', REVIEWED_ARCADE_EXTRA_ROLLBACK_CONFIRMATION)).toThrow();
    expect(() => assertReviewedExtraActivationConfirmation('activate', REVIEWED_ARCADE_EXTRA_ACTIVATION_CONFIRMATION)).not.toThrow();
    expect(() => assertReviewedExtraActivationConfirmation('rollback', REVIEWED_ARCADE_EXTRA_ROLLBACK_CONFIRMATION)).not.toThrow();
  });

  it('keeps the full-run planner blind to extra-move jobs', () => {
    expect(isReviewGatedVideoExtraJob(extraJob())).toBe(true);
    expect(isReviewGatedVideoExtraJob(extraJob({ targetName: 'idle' }))).toBe(false);
    expect(planReviewGatedVideoStep([extraJob()], FIGHTER_ID)).toEqual({ action: 'start', job: null });
  });

  it('starts one extra move on the live fighter, waits for review and publishes nothing', async () => {
    const calls = [];
    let polls = 0;
    const requestApi = async (_base, _token, path, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${path}`);
      if (path === '/api/admin/arcade') return { fighters: [liveEntry] };
      if (path === `/api/fighters/${FIGHTER_ID}`) return { fighter: liveOwned };
      if (path === `/api/generation-jobs?fighterId=${FIGHTER_ID}`) return { jobs: [] };
      if (path === `/api/admin/arcade/${FIGHTER_ID}/video-extra/generate/fireball` && init.method === 'POST') {
        const body = JSON.parse(init.body);
        expect(body.canonicalSourceHashes).toEqual(reviewedManifest.canonicalSourceHashes);
        return { job: extraJob({ status: 'running', reviewStatus: 'none', stage: 'sprite:fireball' }) };
      }
      if (path === `/api/generation-jobs/${JOB_ID}`) {
        polls += 1;
        return { job: extraJob() };
      }
      if (path === `/api/generation-jobs/${JOB_ID}/video-review`) return { review: extraReview(extraJob()) };
      throw new Error(`Unexpected request ${init.method ?? 'GET'} ${path}`);
    };
    const result = await runReviewGatedVideoExtraStep({
      ...options(requestApi), animation: 'fireball', reviewedCanonicalManifest: reviewedManifest,
    });
    expect(result).toMatchObject({ mode: 'started', review: { action: 'fireball', status: 'awaiting_review' } });
    expect(polls).toBe(1);
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([
      `POST /api/admin/arcade/${FIGHTER_ID}/video-extra/generate/fireball`,
    ]);
  });

  it('publishes and rolls back only an approved extra-move job', async () => {
    const posts = [];
    const approvedJob = extraJob({ reviewStatus: 'approved', stage: 'complete' });
    const requestApi = async (_base, _token, path, init = {}) => {
      if (path === '/api/admin/arcade') return { fighters: [liveEntry] };
      if (path === `/api/fighters/${FIGHTER_ID}`) return { fighter: liveOwned };
      if (path === `/api/generation-jobs/${JOB_ID}`) return { job: approvedJob };
      const match = path.match(/\/video-extra\/(activate|rollback)$/);
      if (match && init.method === 'POST') {
        posts.push(match[1]);
        return { fighterId: FIGHTER_ID, animation: 'fireball', jobId: JOB_ID, published: match[1] === 'activate' };
      }
      throw new Error(`Unexpected request ${init.method ?? 'GET'} ${path}`);
    };
    await setReviewedArcadeExtraPublication({ ...options(requestApi), jobId: JOB_ID, operation: 'activate' });
    await setReviewedArcadeExtraPublication({ ...options(requestApi), jobId: JOB_ID, operation: 'rollback' });
    expect(posts).toEqual(['activate', 'rollback']);

    const awaitingApi = async (_base, _token, path) => {
      if (path === '/api/admin/arcade') return { fighters: [liveEntry] };
      if (path === `/api/fighters/${FIGHTER_ID}`) return { fighter: liveOwned };
      if (path === `/api/generation-jobs/${JOB_ID}`) return { job: extraJob() };
      throw new Error(`Unexpected request ${path}`);
    };
    await expect(setReviewedArcadeExtraPublication({ ...options(awaitingApi), jobId: JOB_ID, operation: 'activate' }))
      .rejects.toThrow(/not approved/);
  });
});
