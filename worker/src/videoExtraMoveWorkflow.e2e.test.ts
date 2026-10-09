import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {
    protected env: unknown;

    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class NonRetryableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NonRetryableError';
    }
  },
}));
// Clerk is the only edge the router test replaces: every authenticated route
// resolves to the seeded admin row, exactly as a verified admin session would.
vi.mock('./auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('./auth')>();
  return {
    ...original,
    requireAuth: async (_request: Request, env: Env) => ({
      userId: 'extra-admin',
      user: await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind('extra-admin').first(),
      claims: {},
    }),
  };
});

import worker from './index';
import {
  activateAdminArcadeVideoExtra,
  rollbackAdminArcadeVideoExtra,
  startAdminArcadeVideoExtraGeneration,
} from './arcadeVideoExtras';
import { hashString } from './auth';
import { optionalGenerationJobAuth } from './generationAuth';
import { handleProxy } from './proxy';
import { FighterGenerationWorkflow } from './generationWorkflow';
import { CURRENT_LEGAL_VERSION } from './legal';
import type { AuthContext, Env } from './types';
import {
  PIXCLI_VIDEO_MODEL,
  PIXCLI_VIDEO_PROVIDER_ENDPOINT,
  canonicalJson,
  type PixcliVideoPayload,
} from './videoSpriteGeneration';
import {
  adjustVideoSpriteReview,
  approveVideoSpriteReview,
  getVideoSpriteReview,
  rejectVideoSpriteReview,
} from './videoSpriteReview';
import {
  VIDEO_SPRITE_ACTIONS,
  VIDEO_SPRITE_ACTION_PROFILES,
  VIDEO_SPRITE_COMPILABLE_ACTIONS,
  type VideoSpriteExtraAction,
} from '../../src/services/VideoSpriteCompileContract';

/**
 * End to end for one review-gated extra move on an active official Champion,
 * on the real D1 migrations: start (live source proof) -> the real
 * FighterGenerationWorkflow (sealed source import, PixCLI dispatch, compile,
 * candidate + revision persistence) -> awaiting_review -> approve -> activate.
 * Only the network edges are fakes: the Worker's PixCLI proxy and the
 * image-processor container.
 */

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const USER_ID = 'extra-admin';
const FIGHTER_ID = 'c'.repeat(32);
const API_BASE = 'https://api.extra-move.test';
const PIXCLI_ORIGIN = 'https://pixcli.extra-move.test';
const WORKER_BASE = 'https://worker.extra-move.test';
const PROCESSOR_CONTRACT_URL = new URL('../../processor/src/videoSpriteContract.ts', import.meta.url).href;
const SOURCE_NAMES = ['side', 'upright', 'crouch'] as const;
const LEGAL = {
  legalVersion: CURRENT_LEGAL_VERSION,
  ageConfirmed: true,
  termsAccepted: true,
  photoRightsConfirmed: true,
  aiProcessingConfirmed: true,
  immediatePerformanceConfirmed: true,
  withdrawalLossAcknowledged: true,
};
const ADMIN = {
  userId: USER_ID,
  rateLimitKey: `user:${USER_ID}`,
  claims: {},
  user: { id: USER_ID, plan_tier: 'admin' },
} as unknown as AuthContext;

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

function png(width: number, height: number, marker: number, byteLength = 64): ArrayBuffer {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = marker;
  return bytes.buffer;
}

function mp4(): ArrayBuffer {
  const bytes = new Uint8Array(4096);
  bytes.set(new TextEncoder().encode('ftyp'), 4);
  bytes.set(new TextEncoder().encode('isomfireball'), 8);
  return bytes.buffer;
}

function base64(buffer: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(buffer)).toString('base64');
}

function hex(seed: number): string {
  return seed.toString(16).padStart(32, '0');
}

interface Harness {
  mf: Miniflare;
  db: D1Database;
  bucket: R2Bucket;
  env: Env;
  workflowStarts: string[];
  processorRequests: Array<Record<string, unknown>>;
  providerCalls: string[];
}

async function harness(): Promise<Harness> {
  const unique = crypto.randomUUID();
  const mf = new Miniflare({ workers: [{ config: {
    type: 'worker', name: `extra-${unique}`, compatibilityDate: '2026-08-22',
    manifest: { mainModule: 'index.js', modules: { 'index.js': {
      type: 'esm', contents: 'export default { fetch() { return new Response("ok"); } };',
    } } },
    env: {
      DB: { type: 'd1', id: `extra-db-${unique}` },
      SPRITES: { type: 'r2', name: `extra-assets-${unique}` },
    },
  } }] });
  const db = await mf.getD1Database('DB');
  const bucket = await mf.getR2Bucket('SPRITES') as unknown as R2Bucket;
  for (const migration of readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of migrationStatements(readFileSync(join(migrationsDirectory, migration), 'utf8'))) {
      await db.prepare(statement).run();
    }
  }
  const workflowStarts: string[] = [];
  const processorRequests: Array<Record<string, unknown>> = [];
  const providerCalls: string[] = [];
  const env = {
    DB: db,
    SPRITES: bucket,
    ENVIRONMENT: 'development',
    CORS_ORIGIN: 'https://insertplayer.ai',
    GENERATION_API_BASE_URL: API_BASE,
    GENERATION_JOB_SIGNING_SECRET: 'extra-move-e2e-generation-signing-secret-with-entropy',
    PIXCLI_BASE_URL: PIXCLI_ORIGIN,
    // Placeholder for the fake upstream; never a real credential.
    PIXCLI_API_KEY: 'pixcli-e2e-placeholder',
    FIGHTER_GENERATION: {
      async create(options: { id: string }) {
        workflowStarts.push(options.id);
        return { id: options.id };
      },
      async get(id: string) {
        return { async status() { return { status: workflowStarts.includes(id) ? 'running' : 'unknown' }; } };
      },
    },
    IMAGE_PROCESSOR: {
      getByName: () => ({
        async fetch(request: Request) {
          const body = await request.json() as Record<string, unknown>;
          processorRequests.push(body);
          // The real processor request contract gates the fake compile, like the container's server.
          const contract = await import(/* @vite-ignore */ PROCESSOR_CONTRACT_URL) as {
            parseVideoSpriteCompileRequest(value: unknown): unknown;
          };
          try {
            contract.parseVideoSpriteCompileRequest(body);
          } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : 'invalid' }, { status: 400 });
          }
          return Response.json(await compileFixture(body));
        },
      }),
    },
  } as unknown as Env;
  return { mf, db, bucket, env, workflowStarts, processorRequests, providerCalls };
}

/** A compiler response that satisfies the Worker's report projection for the requested action. */
async function compileFixture(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const action = body.action as VideoSpriteExtraAction;
  const profile = VIDEO_SPRITE_ACTION_PROFILES[action];
  const loop = profile.sequenceFormat === 'loop';
  const unique = profile.uniqueFrameCount;
  const decodedFrameCount = 12;
  // An operator adjustment recompiles the same MP4 with explicitly chosen frames.
  const operatorSelected = Array.isArray(body.selectedVideoIndices) ? body.selectedVideoIndices as number[] : null;
  const selected = operatorSelected ?? Array.from({ length: loop ? unique : unique - 1 }, (_, index) => index + 1);
  const marker = operatorSelected ? 100 : 0;
  const playback = Array.from({ length: unique }, (_, index) => index);
  if (profile.sequenceFormat === 'forward-ping-pong') playback.push(...playback.slice(0, -1).reverse());
  const runtime = png(Math.min(8, playback.length) * 192, Math.ceil(playback.length / 8) * 256, marker + 1);
  const raw = png(Math.min(4, unique) * 768, Math.ceil(unique / 4) * 1024, marker + 2);
  const contact = png(8 * 96, Math.ceil(decodedFrameCount / 8) * 128, marker + 3);
  const uniqueSheet = png(Math.min(8, unique) * 192, Math.ceil(unique / 8) * 256, marker + 4);
  const lineage = body.lineage as Record<string, string>;
  const video = Buffer.from(String(body.videoBase64), 'base64');
  const canonical = Buffer.from(String(body.canonicalFrameBase64), 'base64');
  const reportWithoutHash = {
    schema: 'video-sprite-compile-report.v1',
    schemaVersion: 1,
    compilerVersion: '1.0.0',
    policyVersion: 'video-sprite-policy.v1',
    action,
    expectedFacing: 'right',
    animationFormat: 'video-dense-v1',
    processingVersion: 6,
    lineage,
    inputs: {
      videoSha256: lineage.videoSha256,
      canonicalSha256: lineage.canonicalSha256,
      videoSizeBytes: video.byteLength,
      canonicalSizeBytes: canonical.byteLength,
    },
    extraction: {
      decodedFrameCount,
      selectedVideoIndices: selected,
      frameTranslations: Array.from({ length: unique }, () => ({ dx: 0, dy: 0 })),
      canonicalDerivedF0: !loop,
      operatorAdjustmentApplied: Boolean(operatorSelected),
      selectionAlgorithm: operatorSelected
        ? 'operator-selected-indices-v1'
        : body.automaticSelectionPolicy ?? 'cumulative-motion-quantiles-v2',
    },
    contract: {
      sequenceFormat: profile.sequenceFormat,
      frameSourceContract: loop ? 'video-raw-only' : 'canonical-f0-plus-video',
      uniqueFrameCount: unique,
      playbackFrameCount: playback.length,
      frameWidth: 192,
      frameHeight: 256,
      allowStatic: profile.allowStatic,
      playback,
    },
    decision: { outcome: 'technical_pass', reasonCodes: [], semanticPromotionApproved: false },
    artifacts: {
      runtimeSheet: { sha256: await hashString(runtime), sizeBytes: runtime.byteLength, width: Math.min(8, playback.length) * 192, height: Math.ceil(playback.length / 8) * 256 },
      rawUniqueFramesSheet: { sha256: await hashString(raw), sizeBytes: raw.byteLength, width: Math.min(4, unique) * 768, height: Math.ceil(unique / 4) * 1024 },
      allFramesContactSheet: {
        sha256: await hashString(contact), sizeBytes: contact.byteLength, width: 8 * 96,
        height: Math.ceil(decodedFrameCount / 8) * 128, columns: 8, rows: Math.ceil(decodedFrameCount / 8),
        cellWidth: 96, cellHeight: 128,
      },
      uniqueFramesSheet: { sha256: await hashString(uniqueSheet), sizeBytes: uniqueSheet.byteLength, width: Math.min(8, unique) * 192, height: Math.ceil(unique / 8) * 256 },
    },
  };
  return {
    schemaVersion: 1,
    animationFormat: 'video-dense-v1',
    processingVersion: 6,
    frameW: 192,
    frameH: 256,
    frameCount: playback.length,
    spriteBase64: base64(runtime),
    rawBase64: base64(raw),
    rawFrameW: 768,
    rawFrameH: 1024,
    rawFrameCount: unique,
    allFramesContactSheetBase64: base64(contact),
    uniqueFramesSheetBase64: base64(uniqueSheet),
    report: { ...reportWithoutHash, reportSha256: await hashString(canonicalJson(reportWithoutHash)) },
  };
}

/**
 * Worker requests run through the real PixCLI proxy; only PixCLI upstream is
 * fake: one upload, one dispatch, a completed job and its audit.
 */
function installPixcliProxy(target: Harness): void {
  const realFetch = globalThis.fetch;
  let payload: PixcliVideoPayload | null = null;
  const jobId = 'b'.repeat(32);
  const video = mp4();
  const providerRequestId = '01a03b3c-5e4a-7eb2-8881-3ff0aafebe36';
  const assets = new Map<string, { bytes: ArrayBuffer; type: string }>();
  const json = (value: unknown) => {
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === API_BASE) {
      // The real Worker proxy: generation-token auth, session policy, dispatch identity, accounting.
      const auth = await optionalGenerationJobAuth(request, target.env);
      if (auth instanceof Response) return auth;
      if (!auth) return Response.json({ error: 'generation token missing' }, { status: 401 });
      return await handleProxy(request, target.env, auth) ?? Response.json({ error: 'not proxied' }, { status: 404 });
    }
    if (url.origin !== PIXCLI_ORIGIN) return realFetch(input, init);
    const method = request.method;
    const path = url.pathname;
    target.providerCalls.push(`${method} ${path}`);
    if (method === 'POST' && path === '/api/v1/uploads') return Response.json({ hash: 'a'.repeat(32) });
    if (method === 'POST' && path === '/api/v1/video/advanced') {
      payload = await request.json() as PixcliVideoPayload;
      return Response.json({ job_id: jobId, deduplicated: false });
    }
    if (method === 'GET' && path === `/api/v1/jobs/${jobId}`) return Response.json({ status: 'completed' });
    if (method === 'GET' && path === `/api/v1/jobs/${jobId}/canva`) {
      if (!payload) throw new Error('canva requested before dispatch');
      const imageUrl = `${PIXCLI_ORIGIN}/api/v1/assets/${payload.image}`;
      const providerRequest = json({
        model: PIXCLI_VIDEO_PROVIDER_ENDPOINT,
        input: {
          duration: payload.params.duration, resolution: payload.params.resolution,
          prompt: payload.prompt, image_url: imageUrl,
        },
        retry_policy: 'none',
        fallback_policy: 'none',
      });
      const providerResponse = json({
        video: {
          url: 'https://v3b.fal.media/files/example/video.mp4', content_type: 'video/mp4',
          file_name: 'video-result.mp4', file_size: video.byteLength, width: 1280, height: 720,
          fps: 24, duration: 2.04, num_frames: 49,
        },
      });
      assets.set('c'.repeat(32), { bytes: providerRequest, type: 'application/json' });
      assets.set('d'.repeat(32), { bytes: providerResponse, type: 'application/json' });
      assets.set('e'.repeat(32), { bytes: video, type: 'video/mp4' });
      const asset = async (hash: string, metadata: Record<string, unknown>) => {
        const entry = assets.get(hash)!;
        return {
          hash, url: `${PIXCLI_ORIGIN}/api/v1/assets/${hash}`, mime_type: entry.type,
          width: null, height: null, size_bytes: entry.bytes.byteLength,
          metadata: entry.type === 'application/json'
            ? { ...metadata, content_sha256: await hashString(entry.bytes) }
            : metadata,
          created_at: '2026-10-09T00:00:00.000Z',
        };
      };
      return Response.json({
        job: { job_id: jobId, status: 'completed', type: 'video', mode: 'advanced', total_steps: 1, current_step: 0, cost: 330000 },
        input: { ...payload, image_url: imageUrl, image_urls: [imageUrl], enriched_prompt: payload.prompt },
        classification: {},
        pipeline: {},
        provider_runs: [{ provider: 'fal', modelId: PIXCLI_VIDEO_MODEL, requestId: providerRequestId }],
        assets: [
          await asset('c'.repeat(32), { artifact_kind: 'provider_request', model: PIXCLI_VIDEO_MODEL }),
          await asset('d'.repeat(32), {
            artifact_kind: 'provider_response', model: PIXCLI_VIDEO_MODEL, provider_request_id: providerRequestId,
          }),
          await asset('e'.repeat(32), {
            model: PIXCLI_VIDEO_MODEL, prompt: payload.prompt, provider_request_id: providerRequestId,
            source_url: 'https://v3b.fal.media/files/example/video.mp4',
          }),
        ],
        traces: [],
      });
    }
    const assetMatch = path.match(/^\/api\/v1\/assets\/([a-f0-9]{32})$/);
    if (method === 'GET' && assetMatch && assets.has(assetMatch[1])) {
      const entry = assets.get(assetMatch[1])!;
      return new Response(entry.bytes, {
        headers: { 'Content-Type': entry.type, 'Content-Length': String(entry.bytes.byteLength) },
      });
    }
    return Response.json({ error: `unexpected ${method} ${path}` }, { status: 500 });
  });
}

/**
 * Production shape of an active official Champion: licensed Arcade entry, six
 * canonical sources, and 11 live v5 sprites approved in one sealed reviewed run.
 */
async function seedApprovedChampion(
  target: Harness,
  arcade: { photoHash: string; sortOrder: number; challengerLine: string; sourceUrl: string } = {
    photoHash: 'e'.repeat(64), sortOrder: 3, challengerLine: 'Lamine Yamal steps in',
    sourceUrl: 'https://commons.wikimedia.org/x',
  },
): Promise<void> {
  const { db, bucket } = target;
  await db.batch([
    db.prepare(`INSERT INTO users (id, display_name, oauth_provider, oauth_id, plan_tier)
      VALUES (?, 'Arcade Admin', 'clerk', 'clerk-extra-admin', 'admin')`).bind(USER_ID),
    db.prepare(`INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier, public_flag)
      VALUES (?, ?, 'Lamine Yamal', ?, 'champion', 1)`).bind(FIGHTER_ID, USER_ID, arcade.photoHash),
    db.prepare(`INSERT INTO arcade_fighters (
      fighter_id, slug, sort_order, challenger_line, default_personality,
      reference_kind, reference_source_url, reference_license, reference_credit, status
    ) VALUES (?, 'lamine-yamal', ?, ?, 'showboat', 'licensed', ?, 'CC BY-SA 4.0', 'Credit', 'active')`)
      .bind(FIGHTER_ID, arcade.sortOrder, arcade.challengerLine, arcade.sourceUrl),
  ]);

  const sealedSources: Record<string, { processed: Record<string, string>; raw: Record<string, string> }> = {};
  for (const [index, name] of SOURCE_NAMES.entries()) {
    const pair: Record<string, Record<string, string>> = {};
    for (const [offset, kind] of [[0, name], [1, `${name}_raw`]] as const) {
      const bytes = png(768, 1024, 10 + index * 2 + offset);
      const sha256 = await hashString(bytes);
      const key = `users/${USER_ID}/fighters/${FIGHTER_ID}/sources/${kind}.png`;
      const versionId = hex(0x10 + index * 2 + offset);
      await bucket.put(key, bytes, { customMetadata: { contentHash: sha256 } });
      await db.prepare(`INSERT INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
        VALUES (?, ?, ?, ?, ?)`).bind(versionId, FIGHTER_ID, kind, key, sha256).run();
      pair[offset ? 'raw' : 'processed'] = { versionId, blobKey: key, contentSha256: sha256 };
    }
    sealedSources[name] = pair as typeof sealedSources[string];
  }
  await db.prepare(`UPDATE fighters SET
    side_view_blob_key = ?, side_view_raw_blob_key = ?,
    upright_view_blob_key = ?, upright_view_raw_blob_key = ?,
    crouch_view_blob_key = ?, crouch_view_raw_blob_key = ? WHERE id = ?`).bind(
    sealedSources.side.processed.blobKey, sealedSources.side.raw.blobKey,
    sealedSources.upright.processed.blobKey, sealedSources.upright.raw.blobKey,
    sealedSources.crouch.processed.blobKey, sealedSources.crouch.raw.blobKey, FIGHTER_ID,
  ).run();

  const runId = hex(0x100);
  const manifest = JSON.stringify({
    side: sealedSources.side.processed.blobKey, sideRaw: sealedSources.side.raw.blobKey,
    upright: sealedSources.upright.processed.blobKey, uprightRaw: sealedSources.upright.raw.blobKey,
    crouch: sealedSources.crouch.processed.blobKey, crouchRaw: sealedSources.crouch.raw.blobKey,
    reviewedCanonicalSources: {
      schemaVersion: 1, mode: 'reviewed-current-v1', fighterId: FIGHTER_ID, ownerUserId: USER_ID,
      sources: sealedSources,
    },
  });
  for (const [index, action] of VIDEO_SPRITE_ACTIONS.entries()) {
    const jobId = hex(0x100 + index);
    const chargeId = hex(0x200 + index);
    const sessionId = hex(0x300 + index);
    const candidateId = hex(0x400 + index);
    const versionId = hex(0x500 + index);
    const runtime = png(1536, 256, 40 + index);
    const raw = png(3072, 2048, 70 + index);
    const runtimeSha = await hashString(runtime);
    const rawSha = await hashString(raw);
    const runtimeKey = `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${action}.png`;
    const rawKey = `users/${USER_ID}/fighters/${FIGHTER_ID}/sprites/${action}-raw.png`;
    await bucket.put(runtimeKey, runtime);
    await bucket.put(rawKey, raw);
    const statements = [
      db.prepare(`INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        VALUES (?, ?, 0, 'arcade_seed_generation', ?)`).bind(`ledger-${index}`, USER_ID, FIGHTER_ID),
      db.prepare(`INSERT INTO generation_charges (
        id, user_id, tier, status, reason, fighter_id, ledger_id, expires_at, creation_flow
      ) VALUES (?, ?, 'champion', 'committed', 'arcade_seed_generation', ?, ?, datetime('now', '+1 day'), 'video')`)
        .bind(chargeId, USER_ID, FIGHTER_ID, `ledger-${index}`),
      db.prepare(`INSERT INTO provider_sessions (
        id, user_id, rate_limit_key, tier, purpose, charge_id, status, provider_call_limit, expires_at, creation_flow
      ) VALUES (?, ?, ?, 'champion', 'fighter_generation', ?, 'completed', 12, datetime('now', '+1 day'), 'video')`)
        .bind(sessionId, USER_ID, `user:${USER_ID}`, chargeId),
    ];
    if (index === 0) {
      statements.push(db.prepare(`INSERT INTO generation_artifact_runs (
        id, user_id, fighter_id, tier, operation, root_job_id, original_charge_id,
        source_manifest_json, status, completed_at, creation_flow, video_generation_policy
      ) VALUES (?, ?, ?, 'champion', 'fighter_generation', ?, ?, ?, 'succeeded', datetime('now'), 'video', 'studio_curated_v1')`)
        .bind(runId, USER_ID, FIGHTER_ID, jobId, chargeId, manifest));
    }
    statements.push(
      db.prepare(`INSERT INTO generation_jobs (
        id, workflow_instance_id, user_id, fighter_id, charge_id, provider_session_id, tier,
        operation, status, stage, artifact_run_id, resumed_from_job_id, creation_flow, review_status,
        finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'champion', 'fighter_generation', 'succeeded', 'complete', ?, ?, 'video', 'approved', datetime('now'))`)
        .bind(jobId, jobId, USER_ID, FIGHTER_ID, chargeId, sessionId, runId, index ? hex(0x100 + index - 1) : null),
      db.prepare(`INSERT INTO sprite_versions (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key, frame_w, frame_h,
        frame_count, processing_version, content_hash, raw_content_hash, animation_format
      ) VALUES (?, ?, ?, 'champion', ?, ?, 192, 256, 8, 5, ?, ?, 'video-dense-v1')`)
        .bind(versionId, FIGHTER_ID, action, runtimeKey, rawKey, runtimeSha, rawSha),
      db.prepare(`INSERT INTO sprites (
        id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key, frame_w, frame_h,
        frame_count, processing_version, content_hash, raw_content_hash, animation_format
      ) VALUES (?, ?, ?, 'champion', ?, ?, 192, 256, 8, 5, ?, ?, 'video-dense-v1')`)
        .bind(`live-${action}`, FIGHTER_ID, action, runtimeKey, rawKey, runtimeSha, rawSha),
      db.prepare(`INSERT INTO video_sprite_candidates (
        id, run_id, job_id, user_id, fighter_id, action, sequence_order, status,
        current_revision, approved_revision, reviewed_at, reviewed_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', 1, 1, '2026-08-27 10:00:00', ?)`)
        .bind(candidateId, runId, jobId, USER_ID, FIGHTER_ID, action, index, USER_ID),
      db.prepare(`INSERT INTO video_sprite_candidate_revisions (
        candidate_id, revision, compiler_outcome, sprite_version_id, provider_model, pixcli_job_id,
        provider_request_id, prompt_sha256, canonical_blob_key, canonical_sha256,
        provider_audit_blob_key, provider_audit_sha256, video_blob_key, video_sha256, video_size_bytes,
        processed_blob_key, processed_sha256, raw_blob_key, raw_sha256,
        contact_sheet_blob_key, contact_sheet_sha256, unique_sheet_blob_key, unique_sheet_sha256,
        report_blob_key, report_sha256, report_content_sha256, frame_w, frame_h, frame_count,
        raw_frame_w, raw_frame_h, raw_frame_count, source_frame_count, animation_format,
        processing_version, selected_indices_json, playback_json, translations_json
      ) VALUES (?, 1, 'technical_pass', ?, 'grok-imagine-i2v-pinned', ?, ?, ?, 'canonical.png', ?,
        'audit.json', ?, 'video.mp4', ?, 4096, ?, ?, ?, ?, 'contact.png', ?, 'unique.png', ?,
        'report.json', ?, ?, 192, 256, 8, 768, 1024, 8, 49, 'video-dense-v1', 5,
        '[0,1,2,3,4,5,6,7]', '[0,1,2,3,4,5,6,7]', '[]')`)
        .bind(
          candidateId, versionId, hex(0x600 + index), `provider-request-${index}`, '1'.repeat(64),
          '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), runtimeKey, runtimeSha, rawKey, rawSha,
          '5'.repeat(64), '6'.repeat(64), '7'.repeat(64), '8'.repeat(64),
        ),
    );
    await db.batch(statements);
  }
  await db.batch(SOURCE_NAMES.map((name, index) => db.prepare(`INSERT INTO generation_artifact_checkpoints (
    run_id, artifact_kind, artifact_name, stage_index, tier, status, clean_version_id, raw_version_id,
    clean_blob_key, raw_blob_key, clean_content_hash, raw_content_hash, completed_by_job_id
  ) VALUES (?, 'source', ?, ?, 'champion', 'approved', ?, ?, ?, ?, ?, ?, ?)`).bind(
    runId, name, index + 1,
    sealedSources[name].processed.versionId, sealedSources[name].raw.versionId,
    sealedSources[name].processed.blobKey, sealedSources[name].raw.blobKey,
    sealedSources[name].processed.contentSha256, sealedSources[name].raw.contentSha256, hex(0x100),
  )));
}

/**
 * The production router for every Worker request (admin API and provider
 * proxy). The workflow a start enqueues runs when the operator first polls it.
 */
function installRouter(target: Harness): void {
  const proxied = globalThis.fetch;
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  let ran = new Set<string>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== WORKER_BASE) return proxied(input, init);
    const pending = target.workflowStarts.find((id) => !ran.has(id));
    if (pending && url.pathname === `/api/generation-jobs/${pending}`) {
      ran = new Set([...ran, pending]);
      const { step } = workflowStep();
      await new FighterGenerationWorkflow({} as ExecutionContext, target.env).run(
        { payload: { jobId: pending } } as never, step as never,
      );
    }
    return worker.fetch(request, target.env, ctx);
  });
}

/** Cloudflare Workflow step semantics needed here: run each step once, never sleep. */
function workflowStep() {
  const names: string[] = [];
  return {
    names,
    step: {
      async do<T>(name: string, configOrFn: unknown, maybeFn?: () => Promise<T>): Promise<T> {
        names.push(name);
        const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as () => Promise<T>;
        return fn();
      },
      async sleep(name: string): Promise<void> {
        names.push(name);
      },
    },
  };
}

function post(body: unknown): Request {
  return new Request('https://api.insertplayer.ai/api/admin/arcade/x', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function startAndGenerate(target: Harness, move: VideoSpriteExtraAction): Promise<string> {
  const started = await startAdminArcadeVideoExtraGeneration(post({ legal: LEGAL }), target.env, ADMIN, FIGHTER_ID, move);
  const body = await started.json() as { job?: { id: string }; error?: string };
  expect(body.error).toBeUndefined();
  const jobId = body.job!.id;
  const { step } = workflowStep();
  await expect(new FighterGenerationWorkflow({} as ExecutionContext, target.env).run(
    { payload: { jobId } } as never, step as never,
  )).resolves.toMatchObject({ jobId, reviewStatus: 'awaiting_review' });
  return jobId;
}

async function currentReview(target: Harness, jobId: string): Promise<Record<string, unknown>> {
  const response = await getVideoSpriteReview(new Request('https://api.insertplayer.ai/r'), target.env, ADMIN, jobId);
  expect(response.status).toBe(200);
  return (await response.json() as { review: Record<string, unknown> }).review;
}

describe('review-gated extra Video move end to end on the real migrations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts, generates, persists, approves and activates one fireball without touching the 11 actions', async () => {
    const target = await harness();
    try {
      await seedApprovedChampion(target);
      installPixcliProxy(target);
      const liveBefore = await target.db.prepare(`
        SELECT animation_name, blob_key, content_hash FROM sprites WHERE fighter_id = ? ORDER BY animation_name
      `).bind(FIGHTER_ID).all();

      // 1. Start: live source proof, authorization, durable job and recorded proof.
      const started = await startAdminArcadeVideoExtraGeneration(
        post({ legal: LEGAL }), target.env, ADMIN, FIGHTER_ID, 'fireball',
      );
      const startedBody = await started.json() as { job?: { id: string }; sourceProof?: { proofSha256: string }; error?: string };
      expect(startedBody.error).toBeUndefined();
      expect(started.status).toBe(202);
      const jobId = startedBody.job!.id;
      expect(target.workflowStarts).toEqual([jobId]);
      const proofRow = await target.db.prepare(`SELECT action, proof_sha256 FROM video_extra_source_proofs WHERE job_id = ?`)
        .bind(jobId).first();
      expect(proofRow).toEqual({ action: 'fireball', proof_sha256: startedBody.sourceProof!.proofSha256 });

      // 2. The real generation workflow, with only the provider and container faked.
      const { step, names } = workflowStep();
      const workflow = new FighterGenerationWorkflow({} as ExecutionContext, target.env);
      await expect(workflow.run({ payload: { jobId } } as never, step as never))
        .resolves.toMatchObject({ jobId, status: 'succeeded', reviewStatus: 'awaiting_review' });
      expect(names.slice(0, 6)).toEqual([
        'initialize generation',
        'load durable artifact run',
        'recover legacy Arcade generation prompt',
        'video: import reviewed canonical side source',
        'video: import reviewed canonical upright source',
        'video: import reviewed canonical crouch source',
      ]);
      expect(target.providerCalls.filter((call) => call.startsWith('POST'))).toEqual([
        'POST /api/v1/uploads',
        'POST /api/v1/video/advanced',
      ]);
      expect(target.processorRequests).toHaveLength(1);
      expect(target.processorRequests[0]).toMatchObject({ schemaVersion: 1, action: 'fireball', expectedFacing: 'right' });

      const job = await target.db.prepare(`
        SELECT status, stage, review_status, artifact_run_id FROM generation_jobs WHERE id = ?
      `).bind(jobId).first<{ status: string; stage: string; review_status: string; artifact_run_id: string }>();
      expect(job).toMatchObject({ status: 'succeeded', stage: 'awaiting_review', review_status: 'awaiting_review' });
      const candidate = await target.db.prepare(`
        SELECT candidate.id, candidate.action, candidate.sequence_order, candidate.status,
          revision.processing_version, revision.frame_count, revision.report_sha256
        FROM video_sprite_candidates candidate
        JOIN video_sprite_candidate_revisions revision ON revision.candidate_id = candidate.id
        WHERE candidate.job_id = ?
      `).bind(jobId).first<Record<string, unknown>>();
      expect(candidate).toMatchObject({
        action: 'fireball', sequence_order: VIDEO_SPRITE_COMPILABLE_ACTIONS.indexOf('fireball'),
        status: 'awaiting_review', processing_version: 6, frame_count: 8,
      });
      expect(candidate!.sequence_order).toBe(11);
      const charge = await target.db.prepare(`
        SELECT charge.status FROM generation_charges charge JOIN generation_jobs job ON job.charge_id = charge.id WHERE job.id = ?
      `).bind(jobId).first();
      expect(charge).toEqual({ status: 'committed' });

      // 3. Human review through the real review code path; approval publishes nothing.
      const reviewResponse = await getVideoSpriteReview(new Request('https://api.insertplayer.ai/r'), target.env, ADMIN, jobId);
      expect(reviewResponse.status).toBe(200);
      const { review } = await reviewResponse.json() as { review: Record<string, unknown> };
      expect(review).toMatchObject({
        action: 'fireball', extraMove: 'fireball', sequenceOrder: 11, status: 'awaiting_review',
        continuationAvailable: false,
      });
      const approved = await approveVideoSpriteReview(post({
        candidateId: review.candidateId, revision: review.revision, reportSha256: review.reportSha256,
      }), target.env, ADMIN, jobId);
      const approvedBody = await approved.json() as Record<string, unknown>;
      expect(approvedBody.error).toBeUndefined();
      expect(approved.status).toBe(200);
      expect(await target.db.prepare(`SELECT id FROM sprites WHERE fighter_id = ? AND animation_name = 'fireball'`)
        .bind(FIGHTER_ID).first()).toBeNull();

      // 4. Activation publishes exactly the approved fireball sheet.
      const activated = await activateAdminArcadeVideoExtra(post({ jobId }), target.env, ADMIN, FIGHTER_ID);
      const activatedBody = await activated.json() as Record<string, unknown>;
      expect(activatedBody.error).toBeUndefined();
      expect(activatedBody).toMatchObject({ animation: 'fireball', jobId, published: true });
      const fireball = await target.db.prepare(`
        SELECT processing_version, frame_count, animation_format FROM sprites
        WHERE fighter_id = ? AND animation_name = 'fireball' AND quality_tier = 'champion'
      `).bind(FIGHTER_ID).first();
      expect(fireball).toEqual({ processing_version: 6, frame_count: 8, animation_format: 'video-dense-v1' });
      const liveAfter = await target.db.prepare(`
        SELECT animation_name, blob_key, content_hash FROM sprites
        WHERE fighter_id = ? AND animation_name <> 'fireball' ORDER BY animation_name
      `).bind(FIGHTER_ID).all();
      expect(liveAfter.results).toEqual(liveBefore.results);
    } finally {
      await target.mf.dispose();
    }
  }, 120_000);

  it('adjusts an uppercut before approval, then publishes and rolls back exactly that revision', async () => {
    const target = await harness();
    try {
      await seedApprovedChampion(target);
      installPixcliProxy(target);
      const jobId = await startAndGenerate(target, 'uppercut');
      const first = await currentReview(target, jobId);
      expect(first).toMatchObject({ action: 'uppercut', extraMove: 'uppercut', sequenceOrder: 12, revision: 1 });
      expect(target.processorRequests[0]).toMatchObject({ action: 'uppercut' });

      const adjusted = await adjustVideoSpriteReview(post({
        candidateId: first.candidateId, revision: 1, reportSha256: first.reportSha256,
        selectedVideoIndices: [2, 3, 4, 5, 6, 8, 10],
      }), target.env, ADMIN, jobId);
      const adjustedBody = await adjusted.json() as { review?: Record<string, unknown>; error?: string };
      expect(adjustedBody.error).toBeUndefined();
      expect(adjustedBody.review).toMatchObject({
        revision: 2, status: 'awaiting_review', selectedVideoIndices: [2, 3, 4, 5, 6, 8, 10],
      });
      expect(target.processorRequests[1]).toMatchObject({
        action: 'uppercut', selectedVideoIndices: [2, 3, 4, 5, 6, 8, 10],
      });
      // No second paid provider dispatch for an adjustment.
      expect(target.providerCalls.filter((call) => call === 'POST /api/v1/video/advanced')).toHaveLength(1);

      const second = adjustedBody.review!;
      const approved = await approveVideoSpriteReview(post({
        candidateId: second.candidateId, revision: 2, reportSha256: second.reportSha256,
      }), target.env, ADMIN, jobId);
      expect(approved.status).toBe(200);
      const activated = await activateAdminArcadeVideoExtra(post({ jobId }), target.env, ADMIN, FIGHTER_ID);
      expect(await activated.json()).toMatchObject({ animation: 'uppercut', published: true });
      const live = await target.db.prepare(`
        SELECT sprite.content_hash = revision.processed_sha256 AS exact
        FROM sprites sprite
        JOIN video_sprite_candidates candidate ON candidate.job_id = ?
        JOIN video_sprite_candidate_revisions revision
          ON revision.candidate_id = candidate.id AND revision.revision = candidate.approved_revision
        WHERE sprite.fighter_id = ? AND sprite.animation_name = 'uppercut'
      `).bind(jobId, FIGHTER_ID).first();
      expect(live).toEqual({ exact: 1 });

      const rolledBack = await rollbackAdminArcadeVideoExtra(post({ jobId }), target.env, ADMIN, FIGHTER_ID);
      expect(await rolledBack.json()).toMatchObject({ animation: 'uppercut', published: false, removed: true });
      expect(await target.db.prepare(`SELECT id FROM sprites WHERE fighter_id = ? AND animation_name = 'uppercut'`)
        .bind(FIGHTER_ID).first()).toBeNull();
    } finally {
      await target.mf.dispose();
    }
  }, 120_000);

  it('rejects a fireball candidate, publishes nothing, and lets a fresh start generate again', async () => {
    const target = await harness();
    try {
      await seedApprovedChampion(target);
      installPixcliProxy(target);
      const firstJobId = await startAndGenerate(target, 'fireball');
      const review = await currentReview(target, firstJobId);
      const rejected = await rejectVideoSpriteReview(post({
        candidateId: review.candidateId, revision: review.revision, reportSha256: review.reportSha256,
        reason: 'Fireball reads as a shove, not a projectile throw',
      }), target.env, ADMIN, firstJobId);
      const rejectedBody = await rejected.json() as { review?: Record<string, unknown>; error?: string };
      expect(rejectedBody.error).toBeUndefined();
      expect(rejectedBody.review).toMatchObject({ status: 'rejected' });
      const refused = await activateAdminArcadeVideoExtra(post({ jobId: firstJobId }), target.env, ADMIN, FIGHTER_ID);
      expect(refused.status).toBe(404);
      expect(await target.db.prepare(`SELECT id FROM sprites WHERE fighter_id = ? AND animation_name = 'fireball'`)
        .bind(FIGHTER_ID).first()).toBeNull();

      const secondJobId = await startAndGenerate(target, 'fireball');
      expect(secondJobId).not.toBe(firstJobId);
      const runs = await target.db.prepare(`
        SELECT job.artifact_run_id AS run_id FROM generation_jobs job WHERE job.id IN (?, ?)
      `).bind(firstJobId, secondJobId).all<{ run_id: string }>();
      expect(new Set(runs.results.map((row) => row.run_id)).size).toBe(2);
      expect(await currentReview(target, secondJobId)).toMatchObject({
        action: 'fireball', sequenceOrder: 11, status: 'awaiting_review',
      });
    } finally {
      await target.mf.dispose();
    }
  }, 120_000);

  it('runs the operator script against the real Worker router: start, decide, activate', async () => {
    const target = await harness();
    try {
      const roster = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../arcade/roster-2026.json'), 'utf8'));
      const fighter = roster.fighters.find((entry: { slug: string }) => entry.slug === 'lamine-yamal');
      await seedApprovedChampion(target, {
        photoHash: fighter.reference.sourceSha256,
        sortOrder: fighter.rank,
        challengerLine: fighter.challengerLine,
        sourceUrl: fighter.reference.sourceUrl,
      });
      // One origin for everything: the script's admin calls and the workflow's
      // provider proxy both go through the production router.
      target.env.GENERATION_API_BASE_URL = WORKER_BASE;
      installPixcliProxy(target);
      installRouter(target);
      const script = await import(/* @vite-ignore */ new URL('../../scripts/seed-arcade-roster.mjs', import.meta.url).href);
      const options = {
        manifest: roster, fighter, approvedPhotoHash: fighter.reference.sourceSha256,
        baseUrl: WORKER_BASE, token: async () => 'admin-session', pause: async () => {}, pollIntervalMs: 0,
      };
      const destination = mkdtempSync(join(tmpdir(), 'extra-e2e-'));
      const started = await script.runReviewGatedVideoExtraStep({
        ...options, animation: 'fireball', reviewedCanonicalManifest: null, reviewArtifactDir: destination,
      });
      expect(started).toMatchObject({ mode: 'started', review: { action: 'fireball', sequenceOrder: 11 } });
      expect(started.descriptor).toMatchObject({
        action: 'fireball', reviewedManifestRunId: '', extraMoveSourceProofSha256: started.sourceProof.proofSha256,
      });
      expect(target.workflowStarts).toEqual([started.job.id]);

      const decided = await script.runReviewGatedVideoDecision({
        ...options,
        reviewedCanonicalManifest: null, reviewedManifestRunId: '', reviewedManifestSha256: '',
        expectedSourceProofSha256: started.descriptor.extraMoveSourceProofSha256,
        decision: 'approve', jobId: started.job.id, candidateId: started.review.candidateId,
        revision: started.review.revision, reportSha256: started.review.reportSha256,
        selectedVideoIndices: started.review.selectedVideoIndices,
      });
      expect(decided.review).toMatchObject({ status: 'approved', action: 'fireball' });

      await script.setReviewedArcadeExtraPublication({ ...options, jobId: started.job.id, operation: 'activate' });
      expect(await target.db.prepare(`
        SELECT processing_version, animation_format FROM sprites WHERE fighter_id = ? AND animation_name = 'fireball'
      `).bind(FIGHTER_ID).first()).toEqual({ processing_version: 6, animation_format: 'video-dense-v1' });
    } finally {
      await target.mf.dispose();
    }
  }, 180_000);
});
