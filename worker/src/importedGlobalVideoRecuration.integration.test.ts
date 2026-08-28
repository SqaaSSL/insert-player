import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VideoSpriteCompileResponse } from '../../src/services/VideoSpriteCompileContract';
import { hashString } from './auth';
import {
  promoteFighterSpriteVersion,
  uploadFighterSource,
  uploadFighterSprite,
} from './fighters';
import {
  getImportedGlobalVideoRecurationAsset,
  promoteImportedGlobalVideoRecuration,
  rollbackImportedGlobalVideoRecuration,
  stageImportedGlobalVideoRecuration,
} from './importedGlobalVideoRecuration';
import { canonicalJson, PIXCLI_VIDEO_MODEL, PIXCLI_VIDEO_PROVIDER_ENDPOINT } from './videoSpriteGeneration';
import type { AuthContext, Env } from './types';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const USER_ID = 'imported-global-admin';
const OTHER_USER_ID = 'imported-global-other';
const FIGHTER_ID = '8'.repeat(32);
const CURRENT_VERSION_ID = '1'.repeat(32);
const CANONICAL_VERSION_ID = '2'.repeat(32);
const CURRENT_SPRITE_ID = 'imported-current-idle';
const WORKER_SHA = '3'.repeat(40);
const NEXT_WORKER_SHA = '9'.repeat(40);
const SELECTED = [40, 41, 42, 43, 44, 45, 46, 47];
const SOURCE_URL = 'https://v3.fal.media/files/example/trump-idle.mp4';

const ADMIN_AUTH = {
  userId: USER_ID,
  user: { plan_tier: 'admin' },
  claims: {},
} as AuthContext;
const NON_ADMIN_AUTH = {
  userId: USER_ID,
  user: { plan_tier: 'studio' },
  claims: {},
} as AuthContext;

interface Harness {
  mf: Miniflare;
  db: D1Database;
  bucket: R2Bucket;
  env: Env;
  currentRuntime: ArrayBuffer;
  currentRaw: ArrayBuffer;
  canonical: ArrayBuffer;
  sourceVideo: ArrayBuffer;
  hashes: {
    currentRuntime: string;
    currentRaw: string;
    canonical: string;
    sourceVideo: string;
  };
  compilerFetch: ReturnType<typeof vi.fn>;
}

interface ProposalResponse {
  proposal: {
    proposalId: string;
    fighterId: string;
    action: 'idle';
    from: {
      spriteId: string;
      spriteVersionId: string;
      processedSha256: string;
      rawSha256: string;
      frameWidth: number;
      frameHeight: number;
      frameCount: number;
      animationFormat: 'video-dense-v1';
      processingVersion: number;
    };
    to: {
      spriteVersionId: string;
      processedSha256: string;
      rawSha256: string;
      technicalOutcome: 'technical_pass' | 'needs_review' | 'reject';
      processingVersion: number;
      selectedVideoIndices: number[];
    };
    source: { canonicalKind: 'upright_raw'; videoSha256: string };
    assets: Record<string, string>;
  };
  providerCalls: 0;
}

function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let statement = '';
  let trigger = false;
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || (!statement && !line.trim())) continue;
    statement += `${line}\n`;
    if (/^\s*CREATE\s+TRIGGER\b/i.test(line)) trigger = true;
    const complete = trigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line);
    if (complete) {
      statements.push(statement.trim());
      statement = '';
      trigger = false;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

async function applyMigrations(db: D1Database): Promise<void> {
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name <= '0033_imported_global_video_recuration.sql')
    .sort()) {
    for (const statement of migrationStatements(readFileSync(join(migrationsDirectory, migration), 'utf8'))) {
      await db.prepare(statement).run();
    }
  }
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function png(width: number, height: number, marker: number): ArrayBuffer {
  const bytes = new Uint8Array(25);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = marker;
  return bytes.buffer;
}

function mp4(): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0, 0, 0, 24]);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode('isom-trump-idle-retained-source'), 8);
  return bytes.buffer;
}

function toBase64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString('base64');
}

async function compilerResponse(
  request: Request,
  outcome: 'technical_pass' | 'needs_review' | 'reject',
): Promise<VideoSpriteCompileResponse> {
  const input = await request.json() as {
    action: string;
    lineage: Record<string, string>;
    selectedVideoIndices: number[];
    videoBase64: string;
    canonicalFrameBase64: string;
  };
  const runtime = png(1536, 256, 91);
  const raw = png(3072, 2048, 92);
  const contact = png(768, 896, 93);
  const unique = png(1536, 256, 94);
  const hashes = {
    runtime: await hashString(runtime),
    raw: await hashString(raw),
    contact: await hashString(contact),
    unique: await hashString(unique),
  };
  const reportWithoutHash = {
    schema: 'video-sprite-compile-report.v1',
    schemaVersion: 1,
    compilerVersion: '6.0.0-test',
    policyVersion: 'video-sprite-policy.v1',
    action: input.action,
    expectedFacing: 'right',
    animationFormat: 'video-dense-v1',
    processingVersion: 6,
    lineage: input.lineage,
    inputs: {
      videoSha256: input.lineage.videoSha256,
      canonicalSha256: input.lineage.canonicalSha256,
      videoSizeBytes: Buffer.from(input.videoBase64, 'base64').byteLength,
      canonicalSizeBytes: Buffer.from(input.canonicalFrameBase64, 'base64').byteLength,
    },
    extraction: {
      decodedFrameCount: 49,
      selectedVideoIndices: input.selectedVideoIndices,
      frameTranslations: SELECTED.map(() => ({ dx: 0, dy: 0 })),
      canonicalDerivedF0: false,
      operatorAdjustmentApplied: true,
      selectionAlgorithm: 'operator-selected-indices-v1',
    },
    contract: {
      sequenceFormat: 'loop',
      frameSourceContract: 'video-raw-only',
      uniqueFrameCount: 8,
      playbackFrameCount: 8,
      frameWidth: 192,
      frameHeight: 256,
      allowStatic: true,
      playback: [0, 1, 2, 3, 4, 5, 6, 7],
    },
    decision: {
      outcome,
      reasonCodes: outcome === 'technical_pass' ? [] : ['operator_review_required'],
      semanticPromotionApproved: false,
    },
    artifacts: {
      runtimeSheet: { sha256: hashes.runtime, sizeBytes: runtime.byteLength, width: 1536, height: 256 },
      rawUniqueFramesSheet: { sha256: hashes.raw, sizeBytes: raw.byteLength, width: 3072, height: 2048 },
      allFramesContactSheet: {
        sha256: hashes.contact,
        sizeBytes: contact.byteLength,
        width: 768,
        height: 896,
        columns: 8,
        rows: 7,
        cellWidth: 96,
        cellHeight: 128,
      },
      uniqueFramesSheet: { sha256: hashes.unique, sizeBytes: unique.byteLength, width: 1536, height: 256 },
    },
  };
  return {
    schemaVersion: 1,
    animationFormat: 'video-dense-v1',
    processingVersion: 6,
    frameW: 192,
    frameH: 256,
    frameCount: 8,
    spriteBase64: toBase64(runtime),
    rawBase64: toBase64(raw),
    rawFrameW: 768,
    rawFrameH: 1024,
    rawFrameCount: 8,
    allFramesContactSheetBase64: toBase64(contact),
    uniqueFramesSheetBase64: toBase64(unique),
    report: {
      ...reportWithoutHash,
      reportSha256: await hashString(canonicalJson(reportWithoutHash)),
    },
  } as unknown as VideoSpriteCompileResponse;
}

async function createHarness(
  outcome: 'technical_pass' | 'needs_review' | 'reject' = 'technical_pass',
): Promise<Harness> {
  const unique = crypto.randomUUID();
  const mf = new Miniflare({ workers: [{ config: {
    type: 'worker',
    name: `imported-recuration-${unique}`,
    compatibilityDate: '2026-08-27',
    manifest: { mainModule: 'index.js', modules: { 'index.js': {
      type: 'esm',
      contents: 'export default { fetch() { return new Response("ok"); } };',
    } } },
    env: {
      DB: { type: 'd1', id: `imported-recuration-db-${unique}` },
      SPRITES: { type: 'r2', name: `imported-recuration-assets-${unique}` },
    },
  } }] });
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  await applyMigrations(db);

  const currentRuntime = png(1536, 256, 11);
  const currentRaw = png(3072, 2048, 12);
  const canonical = png(1776, 2368, 13);
  const sourceVideo = mp4();
  const hashes = {
    currentRuntime: await hashString(currentRuntime),
    currentRaw: await hashString(currentRaw),
    canonical: await hashString(canonical),
    sourceVideo: await hashString(sourceVideo),
  };
  const currentRuntimeKey = 'legacy/current-idle.png';
  const currentRawKey = 'legacy/current-idle-raw.png';
  const canonicalKey = 'legacy/upright-raw.png';
  await Promise.all([
    bucket.put(currentRuntimeKey, currentRuntime, { httpMetadata: { contentType: 'image/png' } }),
    bucket.put(currentRawKey, currentRaw, { httpMetadata: { contentType: 'image/png' } }),
    bucket.put(canonicalKey, canonical, { httpMetadata: { contentType: 'image/png' } }),
  ]);
  await db.batch([
    db.prepare(`INSERT INTO users (
      id, display_name, oauth_provider, oauth_id, clerk_user_id, plan_tier
    ) VALUES (?, 'Imported Admin', 'clerk', ?, ?, 'admin')`).bind(USER_ID, USER_ID, USER_ID),
    db.prepare(`INSERT INTO users (
      id, display_name, oauth_provider, oauth_id, clerk_user_id, plan_tier
    ) VALUES (?, 'Other Admin', 'clerk', ?, ?, 'admin')`).bind(OTHER_USER_ID, OTHER_USER_ID, OTHER_USER_ID),
    db.prepare(`INSERT INTO fighters (
      id, owner_user_id, name, photo_hash, quality_tier, public_flag,
      upright_view_raw_blob_key
    ) VALUES (?, ?, 'Imported Global', 'imported-global-photo', 'champion', 1, ?)`)
      .bind(FIGHTER_ID, USER_ID, canonicalKey),
    db.prepare(`INSERT INTO arcade_fighters (
      fighter_id, slug, sort_order, challenger_line, default_personality,
      reference_kind, reference_license, reference_credit, status
    ) VALUES (?, 'imported-global', 1, 'Legacy global', 'showboat',
      'generated', 'internal', 'Insert Player', 'active')`).bind(FIGHTER_ID),
    db.prepare(`INSERT INTO source_versions (
      id, fighter_id, kind, blob_key, content_hash
    ) VALUES (?, ?, 'upright_raw', ?, ?)`)
      .bind(CANONICAL_VERSION_ID, FIGHTER_ID, canonicalKey, hashes.canonical),
    db.prepare(`INSERT INTO sprite_versions (
      id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      frame_w, frame_h, frame_count, processing_version, content_hash,
      raw_content_hash, animation_format
    ) VALUES (?, ?, 'idle', 'champion', ?, ?, 192, 256, 8, 5, ?, ?, 'video-dense-v1')`)
      .bind(
        CURRENT_VERSION_ID,
        FIGHTER_ID,
        currentRuntimeKey,
        currentRawKey,
        hashes.currentRuntime,
        hashes.currentRaw,
      ),
    db.prepare(`INSERT INTO sprites (
      id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
      frame_w, frame_h, frame_count, processing_version, content_hash,
      raw_content_hash, animation_format
    ) VALUES (?, ?, 'idle', 'champion', ?, ?, 192, 256, 8, 5, ?, ?, 'video-dense-v1')`)
      .bind(
        CURRENT_SPRITE_ID,
        FIGHTER_ID,
        currentRuntimeKey,
        currentRawKey,
        hashes.currentRuntime,
        hashes.currentRaw,
      ),
  ]);

  const compilerFetch = vi.fn(async (request: Request) => Response.json(
    await compilerResponse(request, outcome),
  ));
  const env = {
    DB: db,
    SPRITES: bucket,
    ENVIRONMENT: 'production',
    WORKER_VERSION_METADATA: {
      id: 'imported-recuration-worker',
      tag: `prod-${WORKER_SHA}-1`,
      timestamp: '2026-08-28T00:00:00Z',
    },
    IMAGE_PROCESSOR: {
      getByName: vi.fn(() => ({ fetch: compilerFetch })),
    },
  } as unknown as Env;
  return {
    mf, db, bucket, env, currentRuntime, currentRaw, canonical, sourceVideo, hashes, compilerFetch,
  };
}

function headers(workerSha = WORKER_SHA): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Insert-Player-Expected-Worker-Sha': workerSha,
  };
}

function stageBody(target: Harness): Record<string, unknown> {
  return {
    action: 'idle',
    current: {
      spriteId: CURRENT_SPRITE_ID,
      spriteVersionId: CURRENT_VERSION_ID,
      processedSha256: target.hashes.currentRuntime,
      rawSha256: target.hashes.currentRaw,
      frameWidth: 192,
      frameHeight: 256,
      frameCount: 8,
      animationFormat: 'video-dense-v1',
      processingVersion: 5,
    },
    canonical: { kind: 'upright_raw', sha256: target.hashes.canonical },
    source: {
      url: SOURCE_URL,
      sha256: target.hashes.sourceVideo,
      sizeBytes: target.sourceVideo.byteLength,
      provider: 'fal',
      modelId: PIXCLI_VIDEO_MODEL,
      providerEndpoint: PIXCLI_VIDEO_PROVIDER_ENDPOINT,
      pixcliJobId: '4'.repeat(32),
      providerRequestId: '01a03ed6-2308-7fc2-87e3-ecfb8e87f6b1',
      promptSha256: '5'.repeat(64),
      providerRequestAuditSha256: '6'.repeat(64),
      providerResponseSha256: '7'.repeat(64),
    },
    selectedVideoIndices: SELECTED,
  };
}

function stageRequest(target: Harness, mutate: (body: Record<string, any>) => void = () => {}): Request {
  const body = stageBody(target) as Record<string, any>;
  mutate(body);
  return new Request(
    `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/imported-video-recuration/stage`,
    { method: 'POST', headers: headers(), body: JSON.stringify(body) },
  );
}

async function stage(target: Harness): Promise<ProposalResponse> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(target.sourceVideo, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(target.sourceVideo.byteLength),
    },
  })));
  const response = await stageImportedGlobalVideoRecuration(
    stageRequest(target), target.env, ADMIN_AUTH, FIGHTER_ID,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<ProposalResponse>;
}

function transitionRequest(
  operation: 'promote' | 'rollback',
  proposal: ProposalResponse['proposal'],
  options: {
    acceptNeedsReview?: boolean;
    promoteTransitionId?: string;
    workerSha?: string;
  } = {},
): Request {
  const promote = operation === 'promote';
  return new Request(
    `https://api.insertplayer.ai/api/admin/arcade/${FIGHTER_ID}/imported-video-recuration/${operation}`,
    {
      method: 'POST',
      headers: headers(options.workerSha ?? WORKER_SHA),
      body: JSON.stringify({
        proposalId: proposal.proposalId,
        fromProcessedSha256: promote ? proposal.from.processedSha256 : proposal.to.processedSha256,
        fromRawSha256: promote ? proposal.from.rawSha256 : proposal.to.rawSha256,
        toProcessedSha256: promote ? proposal.to.processedSha256 : proposal.from.processedSha256,
        toRawSha256: promote ? proposal.to.rawSha256 : proposal.from.rawSha256,
        visualReviewAccepted: promote,
        acceptNeedsReview: promote ? (options.acceptNeedsReview ?? false) : false,
        ...(promote ? {} : { promoteTransitionId: options.promoteTransitionId }),
      }),
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('imported global Video recuration Worker flow', () => {
  it('stages Trump-style retained frames without moving current and archives exact immutable evidence', async () => {
    const target = await createHarness();
    try {
      await target.db.prepare(`INSERT INTO imported_global_video_recuration_claims (
        fighter_id, action, claim_token, claimed_at, lease_expires_at
      ) VALUES (?, 'idle', ?, datetime('now', '-2 hours'), datetime('now', '-1 hour'))`)
        .bind(FIGHTER_ID, 'e'.repeat(64)).run();
      const result = await stage(target);
      expect(result.providerCalls).toBe(0);
      expect(result.proposal.action).toBe('idle');
      expect(result.proposal.source).toMatchObject({
        canonicalKind: 'upright_raw',
        videoSha256: target.hashes.sourceVideo,
      });
      expect(result.proposal.to).toMatchObject({
        processingVersion: 6,
        selectedVideoIndices: SELECTED,
      });
      expect(target.compilerFetch).toHaveBeenCalledTimes(1);
      expect(await target.db.prepare(`SELECT content_hash, raw_content_hash, processing_version
        FROM sprites WHERE id = ?`).bind(CURRENT_SPRITE_ID).first()).toEqual({
        content_hash: target.hashes.currentRuntime,
        raw_content_hash: target.hashes.currentRaw,
        processing_version: 5,
      });
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recurations`).first()).toEqual({ count: 1 });
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recuration_claims`).first()).toEqual({ count: 0 });
      const archived = await target.db.prepare(`SELECT source_video_blob_key, source_url
        FROM imported_global_video_recurations WHERE id = ?`)
        .bind(result.proposal.proposalId).first<{ source_video_blob_key: string; source_url: string }>();
      expect(archived?.source_url).toBe(SOURCE_URL);
      expect(await target.bucket.get(archived!.source_video_blob_key)
        .then((object) => object?.arrayBuffer())).toEqual(target.sourceVideo);

      const replay = await stageImportedGlobalVideoRecuration(
        stageRequest(target), target.env, ADMIN_AUTH, FIGHTER_ID,
      );
      expect(replay.status).toBe(200);
      expect((await replay.json() as ProposalResponse).proposal.proposalId)
        .toBe(result.proposal.proposalId);
      expect(target.compilerFetch).toHaveBeenCalledTimes(1);

      const videoAsset = await getImportedGlobalVideoRecurationAsset(
        new Request(`https://api.insertplayer.ai${result.proposal.assets.video}`, {
          headers: { 'X-Insert-Player-Expected-Worker-Sha': WORKER_SHA },
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
        result.proposal.proposalId,
        'video',
      );
      expect(videoAsset.status).toBe(200);
      expect(videoAsset.headers.get('X-Content-SHA256')).toBe(target.hashes.sourceVideo);
      expect(await videoAsset.arrayBuffer()).toEqual(target.sourceVideo);
    } finally {
      await target.mf.dispose();
    }
  }, 30_000);

  it('commits no proposal if current changes while the retained video is compiling', async () => {
    const target = await createHarness();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(target.sourceVideo, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(target.sourceVideo.byteLength),
        },
      })));
      target.compilerFetch.mockImplementationOnce(async (request: Request) => {
        const response = await compilerResponse(request, 'technical_pass');
        await target.db.prepare(`UPDATE sprites SET content_hash = ? WHERE id = ?`)
          .bind('d'.repeat(64), CURRENT_SPRITE_ID).run();
        return Response.json(response);
      });
      const response = await stageImportedGlobalVideoRecuration(
        stageRequest(target), target.env, ADMIN_AUTH, FIGHTER_ID,
      );
      expect(response.status).toBe(422);
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recurations`).first()).toEqual({ count: 0 });
      expect(await target.db.prepare(`SELECT content_hash FROM sprites WHERE id = ?`)
        .bind(CURRENT_SPRITE_ID).first()).toEqual({ content_hash: 'd'.repeat(64) });
    } finally {
      await target.mf.dispose();
    }
  }, 30_000);

  it('enforces admin-owner, URL/byte seals, final current/canonical CAS, and asset rehashing', async () => {
    const target = await createHarness();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(target.sourceVideo, {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(target.sourceVideo.byteLength) },
      })));
      expect((await stageImportedGlobalVideoRecuration(
        stageRequest(target), target.env, NON_ADMIN_AUTH, FIGHTER_ID,
      )).status).toBe(403);
      expect((await stageImportedGlobalVideoRecuration(
        stageRequest(target), target.env,
        { ...ADMIN_AUTH, userId: OTHER_USER_ID } as AuthContext,
        FIGHTER_ID,
      )).status).toBe(404);
      expect((await stageImportedGlobalVideoRecuration(
        stageRequest(target, (body) => { body.source.url = 'https://evil.example/video.mp4'; }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      )).status).toBe(400);
      expect((await stageImportedGlobalVideoRecuration(
        stageRequest(target, (body) => { body.source.sha256 = 'a'.repeat(64); }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      )).status).toBe(422);
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recurations`).first()).toEqual({ count: 0 });

      const result = await stage(target);
      const genericPromote = await promoteFighterSpriteVersion(
        new Request(`https://api.insertplayer.ai/api/fighters/${FIGHTER_ID}/sprites`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            animationName: 'idle',
            qualityTier: 'champion',
            contentHash: result.proposal.to.processedSha256,
            rawContentHash: result.proposal.to.rawSha256,
          }),
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      );
      expect(genericPromote.status).toBe(409);
      const spriteForm = new FormData();
      spriteForm.set('animationName', 'idle');
      spriteForm.set('qualityTier', 'champion');
      spriteForm.set('frameWidth', '192');
      spriteForm.set('frameHeight', '256');
      spriteForm.set('frameCount', '8');
      spriteForm.set('processingVersion', '6');
      spriteForm.set('animationFormat', 'video-dense-v1');
      spriteForm.set('setCurrent', 'true');
      spriteForm.set('file', new File([png(1536, 256, 101)], 'runtime.png', { type: 'image/png' }));
      expect((await uploadFighterSprite(
        new Request(`https://api.insertplayer.ai/api/fighters/${FIGHTER_ID}/sprites`, {
          method: 'POST', body: spriteForm,
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      )).status).toBe(409);
      expect((await uploadFighterSource(
        new Request(`https://api.insertplayer.ai/api/fighters/${FIGHTER_ID}/sources`, {
          method: 'POST', body: new FormData(),
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      )).status).toBe(409);
      await target.db.prepare(`UPDATE fighters SET upright_view_raw_blob_key = 'changed'
        WHERE id = ?`).bind(FIGHTER_ID).run();
      const promote = await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal), target.env, ADMIN_AUTH, FIGHTER_ID,
      );
      expect(promote.status).toBe(409);
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recuration_transitions`).first()).toEqual({ count: 0 });
      expect(await target.db.prepare(`SELECT content_hash FROM sprites WHERE id = ?`)
        .bind(CURRENT_SPRITE_ID).first()).toEqual({ content_hash: target.hashes.currentRuntime });

      await target.db.prepare(`UPDATE fighters SET upright_view_raw_blob_key = 'legacy/upright-raw.png'
        WHERE id = ?`).bind(FIGHTER_ID).run();
      const runtimeKey = await target.db.prepare(`SELECT target_processed_blob_key AS key
        FROM imported_global_video_recurations WHERE id = ?`)
        .bind(result.proposal.proposalId).first<{ key: string }>();
      await target.bucket.put(runtimeKey!.key, png(1536, 256, 111));
      const asset = await getImportedGlobalVideoRecurationAsset(
        new Request(`https://api.insertplayer.ai${result.proposal.assets.runtime}`, {
          headers: { 'X-Insert-Player-Expected-Worker-Sha': WORKER_SHA },
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
        result.proposal.proposalId,
        'runtime',
      );
      expect(asset.status).toBe(410);
    } finally {
      await target.mf.dispose();
    }
  }, 30_000);

  it('promotes and rolls back exact versions atomically with idempotency and anti-ABA', async () => {
    const target = await createHarness();
    try {
      const result = await stage(target);
      vi.stubGlobal('caches', {
        default: { delete: vi.fn(async () => false) },
      });
      await target.db.prepare(`CREATE TRIGGER test_fail_imported_pointer
        BEFORE UPDATE OF blob_key ON sprites
        WHEN OLD.id = '${CURRENT_SPRITE_ID}'
        BEGIN SELECT RAISE(ABORT, 'simulated pointer failure'); END`).run();
      const atomicFailure = await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal), target.env, ADMIN_AUTH, FIGHTER_ID,
      );
      expect(atomicFailure.status).toBe(409);
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recuration_transitions`).first()).toEqual({ count: 0 });
      expect(await target.db.prepare(`SELECT content_hash FROM sprites WHERE id = ?`)
        .bind(CURRENT_SPRITE_ID).first()).toEqual({ content_hash: target.hashes.currentRuntime });
      await target.db.prepare('DROP TRIGGER test_fail_imported_pointer').run();
      const promoted = await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal), target.env, ADMIN_AUTH, FIGHTER_ID,
      );
      expect(promoted.status, await promoted.clone().text()).toBe(200);
      const promotedBody = await promoted.json() as {
        transitionId: string;
        replayed: boolean;
        localArcadeCachePurgeAttempted: boolean;
        localArcadeCacheEntryDeleted: boolean;
      };
      expect(promotedBody).toMatchObject({
        replayed: false,
        localArcadeCachePurgeAttempted: true,
        localArcadeCacheEntryDeleted: false,
      });
      expect(await target.db.prepare(`SELECT content_hash, raw_content_hash, processing_version
        FROM sprites WHERE id = ?`).bind(CURRENT_SPRITE_ID).first()).toEqual({
        content_hash: result.proposal.to.processedSha256,
        raw_content_hash: result.proposal.to.rawSha256,
        processing_version: 6,
      });
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recuration_transitions`).first()).toEqual({ count: 1 });

      const promoteReplay = await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal), target.env, ADMIN_AUTH, FIGHTER_ID,
      );
      expect(promoteReplay.status).toBe(200);
      expect(await promoteReplay.json()).toMatchObject({ replayed: true });

      const wrongRollback = await rollbackImportedGlobalVideoRecuration(
        transitionRequest('rollback', result.proposal, { promoteTransitionId: 'f'.repeat(64) }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      );
      expect(wrongRollback.status).toBe(409);
      const disposable = await target.db.prepare(`SELECT
        target_processed_blob_key, evidence_blob_key, source_video_blob_key
        FROM imported_global_video_recurations WHERE id = ?`)
        .bind(result.proposal.proposalId).first<{
          target_processed_blob_key: string;
          evidence_blob_key: string;
          source_video_blob_key: string;
        }>();
      await target.bucket.delete([
        disposable!.target_processed_blob_key,
        disposable!.evidence_blob_key,
        disposable!.source_video_blob_key,
      ]);
      await target.db.prepare(`UPDATE fighters SET upright_view_raw_blob_key = 'canonical-changed-after-promote'
        WHERE id = ?`).bind(FIGHTER_ID).run();
      target.env.WORKER_VERSION_METADATA = {
        id: 'imported-recuration-worker-next',
        tag: `prod-${NEXT_WORKER_SHA}-1`,
        timestamp: '2026-08-29T00:00:00Z',
      };
      const rolledBack = await rollbackImportedGlobalVideoRecuration(
        transitionRequest('rollback', result.proposal, {
          promoteTransitionId: promotedBody.transitionId,
          workerSha: NEXT_WORKER_SHA,
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      );
      expect(rolledBack.status, await rolledBack.clone().text()).toBe(200);
      const rollbackBody = await rolledBack.json() as { transitionId: string; replayed: boolean };
      expect(rollbackBody.replayed).toBe(false);
      expect(await target.db.prepare(`SELECT content_hash, raw_content_hash, processing_version
        FROM sprites WHERE id = ?`).bind(CURRENT_SPRITE_ID).first()).toEqual({
        content_hash: target.hashes.currentRuntime,
        raw_content_hash: target.hashes.currentRaw,
        processing_version: 5,
      });
      expect(await target.db.prepare(`SELECT rollback_of_transition_id
        FROM imported_global_video_recuration_transitions WHERE operation = 'rollback'`).first())
        .toEqual({ rollback_of_transition_id: promotedBody.transitionId });
      expect(await target.db.prepare(`SELECT expected_worker_sha
        FROM imported_global_video_recuration_transitions WHERE operation = 'rollback'`).first())
        .toEqual({ expected_worker_sha: NEXT_WORKER_SHA });

      const rollbackReplay = await rollbackImportedGlobalVideoRecuration(
        transitionRequest('rollback', result.proposal, {
          promoteTransitionId: promotedBody.transitionId,
          workerSha: NEXT_WORKER_SHA,
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      );
      expect(rollbackReplay.status).toBe(200);
      expect(await rollbackReplay.json()).toMatchObject({
        replayed: true,
        transitionId: rollbackBody.transitionId,
      });
      expect((await getImportedGlobalVideoRecurationAsset(
        new Request(`https://api.insertplayer.ai${result.proposal.assets.canonical}`, {
          headers: { 'X-Insert-Player-Expected-Worker-Sha': NEXT_WORKER_SHA },
        }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
        result.proposal.proposalId,
        'canonical',
      )).status).toBe(200);
      expect((await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal, { workerSha: NEXT_WORKER_SHA }),
        target.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      )).status).toBe(409);
      expect(await target.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recuration_transitions`).first()).toEqual({ count: 2 });
      await expect(target.db.prepare(`UPDATE imported_global_video_recurations
        SET compiler_outcome = 'reject' WHERE id = ?`)
        .bind(result.proposal.proposalId).run()).rejects.toThrow(/immutable/);
      await expect(target.db.prepare(`UPDATE imported_global_video_recuration_transitions
        SET actor_user_id = ? WHERE id = ?`)
        .bind(OTHER_USER_ID, promotedBody.transitionId).run()).rejects.toThrow(/immutable/);
      await target.db.prepare(`INSERT INTO imported_global_video_recuration_claims (
        fighter_id, action, claim_token, claimed_at, lease_expires_at
      ) VALUES (?, 'idle', ?, datetime('now'), datetime('now', '+15 minutes'))`)
        .bind(FIGHTER_ID, 'e'.repeat(64)).run();
      await target.db.prepare('DELETE FROM fighters WHERE id = ?').bind(FIGHTER_ID).run();
      expect(await target.db.prepare(`SELECT
        (SELECT COUNT(*) FROM imported_global_video_recurations) AS proposals,
        (SELECT COUNT(*) FROM imported_global_video_recuration_transitions) AS transitions,
        (SELECT COUNT(*) FROM imported_global_video_recuration_claims) AS claims`).first())
        .toEqual({ proposals: 0, transitions: 0, claims: 0 });
      expect((await target.db.prepare('PRAGMA foreign_key_check').all()).results).toHaveLength(0);
    } finally {
      await target.mf.dispose();
    }
  }, 30_000);

  it('requires explicit needs-review acceptance and never promotes a compiler reject', async () => {
    const needsReview = await createHarness('needs_review');
    try {
      const result = await stage(needsReview);
      expect((await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal), needsReview.env, ADMIN_AUTH, FIGHTER_ID,
      )).status).toBe(422);
      expect((await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal, { acceptNeedsReview: true }),
        needsReview.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      )).status).toBe(200);
    } finally {
      await needsReview.mf.dispose();
    }

    const rejected = await createHarness('reject');
    try {
      const result = await stage(rejected);
      expect((await promoteImportedGlobalVideoRecuration(
        transitionRequest('promote', result.proposal, { acceptNeedsReview: true }),
        rejected.env,
        ADMIN_AUTH,
        FIGHTER_ID,
      )).status).toBe(422);
      expect(await rejected.db.prepare(`SELECT COUNT(*) AS count
        FROM imported_global_video_recuration_transitions`).first()).toEqual({ count: 0 });
    } finally {
      await rejected.mf.dispose();
    }
  }, 30_000);
});
