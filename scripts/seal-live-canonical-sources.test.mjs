import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIVE_CANONICAL_REVIEW_CONFIRMATION,
  LIVE_CANONICAL_SEAL_CONFIRMATION,
  LIVE_CANONICAL_SEAL_QA_DECISION,
  LIVE_CANONICAL_SEAL_SAFETY_CONFIRMATION,
  LIVE_CANONICAL_SEAL_SLUGS,
  LIVE_CANONICAL_SOURCE_KINDS,
  runLiveCanonicalReview,
  runLiveCanonicalSeal,
} from './seal-live-canonical-sources.mjs';
import { assertReviewedCanonicalManifest } from './seed-arcade-roster.mjs';

const roster = JSON.parse(readFileSync(new URL('../arcade/roster-2026.json', import.meta.url), 'utf8'));
const SLUG = 'lamine-yamal';
const rosterFighter = roster.fighters.find((entry) => entry.slug === SLUG);
const FIGHTER_ID = 'a'.repeat(32);
const OWNER = 'user_live_owner';
const ORIGIN = 'https://api.insertplayer.ai';
const KEYS = { side: 'side', side_raw: 'sideRaw', upright: 'upright', upright_raw: 'uprightRaw', crouch: 'crouch', crouch_raw: 'crouchRaw' };
const directories = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function png(label) {
  const bytes = Buffer.alloc(64, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(768, 16);
  bytes.writeUInt32BE(1024, 20);
  Buffer.from(label).copy(bytes, 24, 0, Math.min(40, Buffer.byteLength(label)));
  return bytes;
}

function liveWorld({ status = 'active', missing = null } = {}) {
  const bytes = Object.fromEntries(LIVE_CANONICAL_SOURCE_KINDS.map((kind) => [kind, png(`live:${kind}`)]));
  const versions = Object.fromEntries(LIVE_CANONICAL_SOURCE_KINDS.map((kind, index) => [kind, String(index + 1).repeat(32)]));
  const pathFor = (kind) => `/assets/users/${OWNER}/fighters/${FIGHTER_ID}/sources/${kind}_${versions[kind]}.png`;
  const fighter = {
    id: FIGHTER_ID, name: rosterFighter.name, qualityTier: 'champion', photoHash: rosterFighter.reference.sourceSha256, public: true,
    sources: Object.fromEntries(LIVE_CANONICAL_SOURCE_KINDS.filter((kind) => kind !== missing).map((kind) => [KEYS[kind], `${ORIGIN}${pathFor(kind)}`])),
    sourceHashes: Object.fromEntries(LIVE_CANONICAL_SOURCE_KINDS.filter((kind) => kind !== missing).map((kind) => [kind, sha256(bytes[kind])])),
  };
  const calls = [];
  return {
    bytes,
    calls,
    requestApi: async (path, init = {}) => {
      calls.push(`${init.method ?? 'GET'} ${path}`);
      if (init.method && init.method !== 'GET') throw new Error('sealing must never mutate');
      if (path === '/api/admin/arcade') {
        return { fighters: [{ fighterId: FIGHTER_ID, slug: SLUG, fighterName: rosterFighter.name, qualityTier: 'champion', status, public: status === 'active' }] };
      }
      if (path === `/api/fighters/${FIGHTER_ID}`) return { fighter };
      throw new Error(`unexpected ${path}`);
    },
    requestAsset: async (path) => {
      const kind = LIVE_CANONICAL_SOURCE_KINDS.find((candidate) => pathFor(candidate) === path);
      if (!kind) throw new Error(`unexpected asset ${path}`);
      return new Response(bytes[kind], { headers: { 'content-type': 'image/png', 'content-length': String(bytes[kind].byteLength) } });
    },
    fighter,
  };
}

function output() {
  const dir = mkdtempSync(join(tmpdir(), 'insert-player-live-seal-'));
  directories.push(dir);
  return dir;
}

const base = (world, outputDirectory) => ({
  slug: SLUG, roster, requestApi: world.requestApi, requestAsset: world.requestAsset,
  safetyConfirmation: LIVE_CANONICAL_SEAL_SAFETY_CONFIRMATION, outputDirectory,
});

describe('sealing live canonical sources of an active official fighter', () => {
  it('is restricted to the four active official fighters', async () => {
    expect(LIVE_CANONICAL_SEAL_SLUGS).toEqual(['rosalia-v2', 'lamine-yamal', 'elon-musk', 'donald-trump']);
    const world = liveWorld();
    await expect(runLiveCanonicalReview({ ...base(world, output()), slug: 'player-one', confirmation: LIVE_CANONICAL_REVIEW_CONFIRMATION }))
      .rejects.toThrow(/restricted/);
  });

  it('exports the six live PNGs and a descriptor for review, producing no manifest and no mutation', async () => {
    const world = liveWorld();
    const dir = output();
    const result = await runLiveCanonicalReview({ ...base(world, dir), confirmation: LIVE_CANONICAL_REVIEW_CONFIRMATION });
    for (const kind of LIVE_CANONICAL_SOURCE_KINDS) {
      expect(readFileSync(join(dir, `${kind}.png`)).equals(world.bytes[kind])).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(dir, 'live-canonical-review-descriptor.json'), 'utf8'))).toEqual(result.descriptor);
    expect(existsSync(join(dir, 'reviewed-canonical-manifest.json'))).toBe(false);
    expect(world.calls.every((call) => call.startsWith('GET '))).toBe(true);
  });

  it('seals only the unchanged human-approved sources into a reviewed-current-v1 manifest', async () => {
    const world = liveWorld();
    const review = await runLiveCanonicalReview({ ...base(world, output()), confirmation: LIVE_CANONICAL_REVIEW_CONFIRMATION });
    const dir = output();
    const sealed = await runLiveCanonicalSeal({
      ...base(world, dir), confirmation: LIVE_CANONICAL_SEAL_CONFIRMATION, qaDecision: LIVE_CANONICAL_SEAL_QA_DECISION,
      approvedDescriptorSha256: review.descriptorSha256, approvedDescriptor: review.descriptor, reviewedBy: 'operator',
    });
    const manifest = JSON.parse(readFileSync(join(dir, 'reviewed-canonical-manifest.json'), 'utf8'));
    expect(manifest).toEqual(sealed.manifest);
    expect(assertReviewedCanonicalManifest(manifest, { slug: SLUG, fighterId: FIGHTER_ID, photoHash: rosterFighter.reference.sourceSha256 }))
      .toBe(manifest);
    expect(manifest.canonicalSourceHashes.crouch).toEqual({
      processedSha256: sha256(world.bytes.crouch), rawSha256: sha256(world.bytes.crouch_raw),
    });
    expect(sealed.receipt).toMatchObject({ providerCalls: 0, sourceMutations: 0, generationStarted: false, activated: false });
    expect(world.calls.every((call) => call.startsWith('GET '))).toBe(true);
  });

  it('refuses to seal when the live sources changed after review, or the approval inputs are wrong', async () => {
    const world = liveWorld();
    const review = await runLiveCanonicalReview({ ...base(world, output()), confirmation: LIVE_CANONICAL_REVIEW_CONFIRMATION });
    const seal = (overrides) => runLiveCanonicalSeal({
      ...base(world, output()), confirmation: LIVE_CANONICAL_SEAL_CONFIRMATION, qaDecision: LIVE_CANONICAL_SEAL_QA_DECISION,
      approvedDescriptorSha256: review.descriptorSha256, reviewedBy: 'operator', ...overrides,
    });
    await expect(seal({ qaDecision: 'APPROVE' })).rejects.toThrow(/QA decision/);
    await expect(seal({ confirmation: LIVE_CANONICAL_REVIEW_CONFIRMATION })).rejects.toThrow(/confirmation/);
    await expect(seal({ approvedDescriptorSha256: 'f'.repeat(64) })).rejects.toThrow(/changed since the approved review/);
    await expect(seal({ approvedDescriptor: { ...review.descriptor, fighter: { ...review.descriptor.fighter, name: 'x' } } }))
      .rejects.toThrow(/does not match its SHA-256/);
    world.bytes.upright = png('swapped after review');
    world.fighter.sourceHashes.upright = sha256(world.bytes.upright);
    await expect(seal({})).rejects.toThrow(/changed since the approved review/);
  });

  it('fails closed for a draft fighter or an incomplete source set', async () => {
    await expect(runLiveCanonicalReview({ ...base(liveWorld({ status: 'draft' }), output()), confirmation: LIVE_CANONICAL_REVIEW_CONFIRMATION }))
      .rejects.toThrow(/not an active official fighter/);
    await expect(runLiveCanonicalReview({ ...base(liveWorld({ missing: 'crouch_raw' }), output()), confirmation: LIVE_CANONICAL_REVIEW_CONFIRMATION }))
      .rejects.toThrow(/no complete current crouch_raw source/);
  });

  it('keeps the production workflow read-only, two-phase, commit-pinned and long-retained', () => {
    const workflow = readFileSync(new URL('../.github/workflows/seal-live-canonical-sources-production.yml', import.meta.url), 'utf8');
    for (const phrase of [
      LIVE_CANONICAL_REVIEW_CONFIRMATION, LIVE_CANONICAL_SEAL_CONFIRMATION, LIVE_CANONICAL_SEAL_QA_DECISION,
      LIVE_CANONICAL_SEAL_SAFETY_CONFIRMATION, 'environment: production', 'group: production-worker-mutations',
      'expectedTag.test(health.workerVersion.tag)', "workerBase !== 'https://api.insertplayer.ai'",
      'arcade-reviewed-canonical-manifest-${{ inputs.slug }}', 'retention-days: 90',
      "path !== '.github/workflows/seal-live-canonical-sources-production.yml'",
      'arcade-live-canonical-review-$REQUESTED_SLUG-$REVIEW_RUN_ID',
    ]) expect(workflow).toContain(phrase);
    for (const slug of LIVE_CANONICAL_SEAL_SLUGS) expect(workflow).toContain(`- ${slug}`);
    expect(workflow).not.toMatch(/\/generate(?:\/|\s|$)|\/approve(?:\/|\s|$)|--activate|PIXCLI_API_KEY|FAL_API_KEY|method: 'POST'/);
  });

  it('lets every Video consumer accept the live seal as a manifest producer', () => {
    for (const name of ['arcade-video-step-production.yml', 'arcade-video-review-production.yml', 'arcade-video-extra-production.yml']) {
      const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
      expect(workflow).toContain("'.github/workflows/seal-live-canonical-sources-production.yml'");
    }
  });
});

describe('extra-move production workflows', () => {
  const extra = readFileSync(new URL('../.github/workflows/arcade-video-extra-production.yml', import.meta.url), 'utf8');
  const review = readFileSync(new URL('../.github/workflows/arcade-video-review-production.yml', import.meta.url), 'utf8');

  it('mirrors the Video step: pinned, serialized, exact phrases, private review media', () => {
    for (const phrase of [
      'START_REVIEW_GATED_VIDEO_EXTRA_ANIMATION', 'ACTIVATE_REVIEWED_ARCADE_EXTRA_ANIMATION',
      'ROLLBACK_REVIEWED_ARCADE_EXTRA_ANIMATION', 'group: production-worker-mutations', 'environment: production',
      'expectedTag.test(health.workerVersion.tag)', '--expected-deployed-sha="$GITHUB_SHA"',
      '--video-extra-animation="$REQUESTED_ANIMATION"', '--activate-reviewed-extra', '--rollback-reviewed-extra',
      '--reviewed-manifest-run-id="$REVIEWED_MANIFEST_RUN_ID"', '--video-review-export-dir="$RUNNER_TEMP/video-review"',
      'arcade-video-review-${{ inputs.slug }}-${{ github.run_id }}', 'arcade-reviewed-canonical-manifest-$REQUESTED_SLUG',
      '- fireball', '- uppercut', '- start', '- activate', '- rollback',
    ]) expect(extra).toContain(phrase);
  });

  it('lets the review workflow bind decisions for extra moves', () => {
    expect(review).toContain("'jump', 'crouch', 'hit', 'ko', 'victory', 'fireball', 'uppercut',");
    expect(review).toContain("'.github/workflows/arcade-video-extra-production.yml'");
  });
});
