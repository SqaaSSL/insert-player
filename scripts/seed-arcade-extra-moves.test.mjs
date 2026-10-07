import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  bindReviewCanonicalSources,
  canonicalProofJson,
  isReviewGatedVideoExtraJob,
  planReviewGatedVideoStep,
  REVIEW_GATED_VIDEO_ACTIONS,
  runReviewGatedVideoDecision,
  runReviewGatedVideoExtraStep,
  runReviewGatedVideoInspection,
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
  const assets = Object.fromEntries([
    ['video', 'video'], ['contactSheet', 'contact-sheet'], ['uniqueSheet', 'unique-sheet'],
    ['runtime', 'runtime'], ['raw', 'raw'], ['report', 'report'],
  ].map(([name, kind]) => [name, `/api/generation-jobs/${job.id}/video-review/assets/${kind}?revision=1`]));
  return {
    assets,
    jobId: job.id, artifactRunId: job.artifactRunId, candidateId: 'e'.repeat(32),
    action: 'fireball', sequenceOrder: 11, status: 'awaiting_review', revision: 1,
    reportSha256: 'f'.repeat(64), technicalOutcome: 'technical_pass',
    selectedVideoIndices: [0, 2, 4, 6], sourceFrameCount: 12,
    animationFormat: 'video-dense-v1', processingVersion: 6, ...overrides,
  };
}

const PROOF_PATH = `/api/admin/arcade/${FIGHTER_ID}/video-extra/source-proof`;

/** The Worker's approved-source proof response, SHA-bound exactly as the Worker computes it. */
function proofResponse(hashes = reviewedManifest.canonicalSourceHashes) {
  const proof = {
    schemaVersion: 1, kind: 'approved-video-sources-v1', fighterId: FIGHTER_ID, ownerUserId: 'admin',
    canonicalSourceMode: 'reviewed-current-v1', canonicalSourceHashes: hashes, sources: {},
    origins: [{
      kind: 'reviewed-video-run', runId: 'c'.repeat(32), rootJobId: 'c'.repeat(32),
      runStatus: 'succeeded', recordedBy: 'sealed-manifest', sourceHashes: hashes,
    }],
    lineage: REVIEW_GATED_VIDEO_ACTIONS.map((action) => ({ action, origin: 'c'.repeat(32) })),
  };
  return {
    proof,
    proofSha256: createHash('sha256').update(canonicalProofJson(proof)).digest('hex'),
    canonicalSourceMode: 'reviewed-current-v1',
    canonicalSourceHashes: hashes,
  };
}

const ASSET_TYPES = {
  video: 'video/mp4', 'contact-sheet': 'image/png', 'unique-sheet': 'image/png',
  runtime: 'image/png', raw: 'image/png', report: 'application/json',
};

async function requestAsset(_base, _token, path) {
  const kind = path.match(/\/assets\/([a-z-]+)\?/)[1];
  const bytes = Buffer.from(`asset:${kind}`);
  return { bytes, contentType: ASSET_TYPES[kind], etag: createHash('sha256').update(bytes).digest('hex') };
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

  it('derives the manifest from production, starts one extra move bound to the proof and publishes nothing', async () => {
    const calls = [];
    let polls = 0;
    const live = proofResponse();
    const recorded = { ...live, jobId: JOB_ID, artifactRunId: RUN_ID };
    const requestApi = async (_base, _token, path, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${path}`);
      if (path === '/api/admin/arcade') return { fighters: [liveEntry] };
      if (path === `/api/fighters/${FIGHTER_ID}`) return { fighter: liveOwned };
      if (path === PROOF_PATH) return live;
      if (path === `${PROOF_PATH}?jobId=${JOB_ID}`) return recorded;
      if (path === `/api/generation-jobs?fighterId=${FIGHTER_ID}`) return { jobs: [] };
      if (path === `/api/admin/arcade/${FIGHTER_ID}/video-extra/generate/fireball` && init.method === 'POST') {
        const body = JSON.parse(init.body);
        expect(body.canonicalSourceHashes).toEqual(reviewedManifest.canonicalSourceHashes);
        expect(body.expectedSourceProofSha256).toBe(live.proofSha256);
        return {
          job: extraJob({ status: 'running', reviewStatus: 'none', stage: 'sprite:fireball' }),
          sourceProof: { proofSha256: live.proofSha256, kind: 'approved-video-sources-v1' },
        };
      }
      if (path === `/api/generation-jobs/${JOB_ID}`) {
        polls += 1;
        return { job: extraJob() };
      }
      if (path === `/api/generation-jobs/${JOB_ID}/video-review`) return { review: extraReview(extraJob()) };
      throw new Error(`Unexpected request ${init.method ?? 'GET'} ${path}`);
    };
    const destination = mkdtempSync(join(tmpdir(), 'extra-review-'));
    const result = await runReviewGatedVideoExtraStep({
      ...options(requestApi), animation: 'fireball', reviewedCanonicalManifest: null,
      reviewArtifactDir: destination, requestAsset,
    });
    expect(result).toMatchObject({ mode: 'started', review: { action: 'fireball', status: 'awaiting_review' } });
    expect(result.sourceProof.proofSha256).toBe(live.proofSha256);
    expect(polls).toBe(1);
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([
      `POST /api/admin/arcade/${FIGHTER_ID}/video-extra/generate/fireball`,
    ]);
    // The proof is fetched before the paid start, then re-read from the job.
    expect(calls.indexOf(`GET ${PROOF_PATH}`)).toBeLessThan(calls.indexOf(`POST /api/admin/arcade/${FIGHTER_ID}/video-extra/generate/fireball`));
    expect(calls).toContain(`GET ${PROOF_PATH}?jobId=${JOB_ID}`);
    // Review artifacts carry the proof for audit instead of a manifest run id.
    const descriptor = JSON.parse(readFileSync(join(destination, 'review-descriptor.json'), 'utf8'));
    expect(descriptor).toMatchObject({
      action: 'fireball', sequenceOrder: 11, reviewedManifestRunId: '', reviewedManifestSha256: '',
      reviewedCanonicalSourceMode: 'reviewed-current-v1',
      reviewedCanonicalSourceHashes: reviewedManifest.canonicalSourceHashes,
      extraMoveSourceProofSha256: live.proofSha256,
    });
    const proofBytes = readFileSync(join(destination, 'source-proof.json'));
    expect(createHash('sha256').update(proofBytes).digest('hex')).toBe(live.proofSha256);
    expect(JSON.parse(proofBytes).origins).toEqual(live.proof.origins);
  });

  it('fails closed before any start when the proof is missing, tampered or contradicts a supplied manifest', async () => {
    const posts = [];
    const api = (proofBody) => async (_base, _token, path, init = {}) => {
      if (init.method === 'POST') posts.push(path);
      if (path === '/api/admin/arcade') return { fighters: [liveEntry] };
      if (path === `/api/fighters/${FIGHTER_ID}`) return { fighter: liveOwned };
      if (path === PROOF_PATH) {
        if (proofBody instanceof Error) throw proofBody;
        return proofBody;
      }
      return { jobs: [] };
    };
    await expect(runReviewGatedVideoExtraStep({
      ...options(api(new Error('HTTP 409: The live canonical sources are not the approved Video sources'))),
      animation: 'fireball', reviewedCanonicalManifest: null,
    })).rejects.toThrow(/not the approved Video sources/);
    await expect(runReviewGatedVideoExtraStep({
      ...options(api({ ...proofResponse(), proofSha256: '0'.repeat(64) })),
      animation: 'fireball', reviewedCanonicalManifest: null,
    })).rejects.toThrow(/failed its integrity binding/);
    await expect(runReviewGatedVideoExtraStep({
      ...options(api(proofResponse({ ...reviewedManifest.canonicalSourceHashes, crouch: { processedSha256: '7'.repeat(64), rawSha256: '8'.repeat(64) } }))),
      animation: 'fireball', reviewedCanonicalManifest: reviewedManifest,
    })).rejects.toThrow(/not the approved Video sources; nothing was started/);
    expect(posts).toEqual([]);
  });

  it('binds review inspection and decisions of an extra move to its recorded proof, not a manifest artifact', async () => {
    const recorded = { ...proofResponse(), jobId: JOB_ID, artifactRunId: RUN_ID };
    const posts = [];
    const requestApi = async (_base, _token, path, init = {}) => {
      if (init.method === 'POST') {
        posts.push(path);
        return { review: extraReview(extraJob(), { status: 'approved' }), job: extraJob({ reviewStatus: 'approved' }) };
      }
      if (path === '/api/admin/arcade') return { fighters: [liveEntry] };
      if (path === `/api/fighters/${FIGHTER_ID}`) return { fighter: liveOwned };
      if (path === `/api/generation-jobs/${JOB_ID}`) return { job: extraJob() };
      if (path === `${PROOF_PATH}?jobId=${JOB_ID}`) return recorded;
      if (path === `/api/generation-jobs/${JOB_ID}/video-review`) return { review: extraReview(extraJob()) };
      throw new Error(`Unexpected request ${init.method ?? 'GET'} ${path}`);
    };
    const review = extraReview(extraJob());
    const binding = {
      jobId: JOB_ID, candidateId: review.candidateId, revision: review.revision, reportSha256: review.reportSha256,
    };
    const destination = mkdtempSync(join(tmpdir(), 'extra-inspect-'));
    const inspected = await runReviewGatedVideoInspection({
      ...options(requestApi), ...binding, reviewedCanonicalManifest: null,
      reviewedManifestRunId: '', reviewedManifestSha256: '', destination, requestAsset,
    });
    expect(inspected.descriptor).toMatchObject({ extraMoveSourceProofSha256: recorded.proofSha256, reviewedManifestRunId: '' });

    await expect(runReviewGatedVideoDecision({
      ...options(requestApi), ...binding, decision: 'approve', selectedVideoIndices: review.selectedVideoIndices,
      reviewedCanonicalManifest: null, reviewedManifestRunId: '', reviewedManifestSha256: '',
      expectedSourceProofSha256: '9'.repeat(64),
    })).rejects.toThrow(/differs from the inspected one/);
    expect(posts).toEqual([]);

    // A full-run job still requires its separately reviewed manifest, before any request.
    const untouched = async (_base, _token, path) => { throw new Error(`Unexpected request ${path}`); };
    const fullRun = {
      baseUrl: 'https://api.insertplayer.ai', token: async () => 'token', fighter, fighterId: FIGHTER_ID,
      approvedPhotoHash: fighter.reference.sourceSha256, jobId: JOB_ID, extraMove: '',
      reviewedManifestRunId: '', reviewedManifestSha256: '', requestApi: untouched, operation: 'inspection',
    };
    await expect(bindReviewCanonicalSources({ ...fullRun, reviewedCanonicalManifest: null }))
      .rejects.toThrow('Video review inspection requires the exact separately reviewed canonical manifest.');
    await expect(bindReviewCanonicalSources({ ...fullRun, reviewedCanonicalManifest: reviewedManifest }))
      .rejects.toThrow(/exact manifest producer run and file SHA-256/);
    await expect(bindReviewCanonicalSources({
      ...fullRun, reviewedCanonicalManifest: reviewedManifest, reviewedManifestRunId: '12',
      reviewedManifestSha256: '1'.repeat(64), expectedSourceProofSha256: '2'.repeat(64),
    })).rejects.toThrow(/applies only to an extra Video move/);
    expect(posts).toEqual([]);
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
