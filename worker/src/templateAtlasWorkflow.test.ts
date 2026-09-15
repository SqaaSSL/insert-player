import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStep } from 'cloudflare:workers';
import type { Env, GenerationArtifactRun, GenerationJob } from './types';
import { hashString } from './auth';
import { atlasAnimationPlan, storedGenerationRenderer } from './templateGenerationPolicy';
import { generationStagesForOperation } from './generationArtifacts';
import { getTemplateAtlasPlanIds, TEMPLATE_ATLAS_ANIMATION_NAMES, TEMPLATE_ATLAS_MODEL,
  TEMPLATE_ATLAS_VERSION, type TemplateAtlasReceipt, type TemplateAtlasRendererVersion } from '../../src/services/TemplateAtlasContract';
import type { CompiledTemplateAtlasSprite, TemplateAtlasAnimationName } from '../../src/services/TemplateAtlasContract';
import { TEMPLATE_ATLAS_MANIFEST_SHA256, templateAtlasPlayback, templateAtlasSourcePlanIds } from '../../src/services/TemplateAtlasPlayback';
import { loadTemplateAtlasRaw, loadTemplateAtlasReceipt, persistImmutableAtlasJson,
  saveTemplateAtlasRaw, saveTemplateAtlasReceipt } from './templateAtlasCheckpoints';
import type { TemplateAtlasStreamInput } from './templateAtlasStream';

const mock = vi.hoisted(() => ({ checkpoint: new Map<string, object>(), persisted: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class { constructor(_ctx: unknown, protected env: unknown) {} } }));
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
vi.mock('./generationArtifacts', async (original) => ({
  ...await original<typeof import('./generationArtifacts')>(),
  reuseSpriteCheckpoint: vi.fn(async (_env, _job, name) => mock.checkpoint.get(name) ?? null),
  recordSpriteCheckpoint: vi.fn(async (_env, _job, params) => { mock.checkpoint.set(params.animationName, params); }),
}));
vi.mock('./generatedAssets', async (original) => ({
  ...await original<typeof import('./generatedAssets')>(),
  persistGeneratedSprite: mock.persisted,
}));
import { FighterGenerationWorkflow } from './generationWorkflow';

function bucket() {
  const objects = new Map<string, Uint8Array>();
  return { objects, binding: {
    async get(key: string) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer } : null;
    },
    async head(key: string) { return objects.has(key) ? { size: objects.get(key)!.length } : null; },
    async put(key: string, value: string | ArrayBuffer, options?: { onlyIf?: unknown }) {
      if (options?.onlyIf && objects.has(key)) return null;
      objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value).slice());
      return { key };
    },
  } as unknown as R2Bucket };
}

const job = { id: '1'.repeat(32), user_id: 'test-owner', fighter_id: '2'.repeat(32), artifact_run_id: '3'.repeat(32),
  provider_session_id: '4'.repeat(32), tier: 'rookie', creation_flow: 'original', creation_package: 'complete',
  animation_plan_json: atlasAnimationPlan('rookie-two-atlas-v1'), operation: 'fighter_generation',
} as GenerationJob;
const raw = new ArrayBuffer(24);
const header = new DataView(raw);
header.setUint32(0, 0x89504e47); header.setUint32(4, 0x0d0a1a0a); header.setUint32(16, 4096); header.setUint32(20, 4096);
const rawBase64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
// Deliberately header-only fixtures: this suite validates the Worker boundary;
// the processor suite separately decodes real PNGs and tests malformed chunks.
function pngHeaderBase64(width: number, height: number): string {
  const bytes = raw.slice(0);
  const header = new DataView(bytes);
  header.setUint32(16, width); header.setUint32(20, height);
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
function receipt(planId: string, rendererVersion: TemplateAtlasRendererVersion = 'rookie-two-atlas-v1'): TemplateAtlasReceipt {
  return { requestId: '12345678-1234-1234-1234-123456789abc', requestScope: `job:${job.artifact_run_id}:atlas:${planId}`,
    provenance: { rendererVersion, templateVersion: TEMPLATE_ATLAS_VERSION, planId,
      templateManifestSha256: TEMPLATE_ATLAS_MANIFEST_SHA256, templateImageSha256: 'b'.repeat(64), preparedUprightSha256: 'c'.repeat(64),
      inputUprightSha256: 'd'.repeat(64), promptSha256: 'e'.repeat(64), requestBodySha256: 'f'.repeat(64),
      model: TEMPLATE_ATLAS_MODEL, referenceRoles: ['template', 'prepared-upright'], originalPhotoIncluded: false } };
}
type TestWorkflow = {
  runTemplateAtlasFlow: (job: GenerationJob, run: GenerationArtifactRun, renderer: TemplateAtlasRendererVersion, prompt: undefined, step: WorkflowStep) => Promise<void>;
  callProcessor: (job: GenerationJob, path: string, body: Record<string, unknown>, atlases?: readonly TemplateAtlasStreamInput[]) => Promise<unknown>;
  generateSourcePair: (job: GenerationJob, body: { cleanKind: string }) => Promise<{ cleanKey: string; rawKey: string }>;
  recordProgress: (...args: unknown[]) => Promise<void>;
  recordStageStarted: (...args: unknown[]) => Promise<void>;
};
const step = { do: async (_name: string, _config: unknown, action: () => Promise<unknown>) => action(),
  sleep: vi.fn(async () => {}) } as unknown as WorkflowStep;

function harness(failCompile = false, mutateSprite?: (sprite: CompiledTemplateAtlasSprite) => void) {
  const storage = bucket();
  const env = { SPRITES: storage.binding } as Env;
  const flow = new FighterGenerationWorkflow({} as never, env) as unknown as TestWorkflow;
  flow.recordProgress = vi.fn(async () => {});
  flow.recordStageStarted = vi.fn(async () => {});
  flow.generateSourcePair = vi.fn(async (_job, body) => {
    storage.objects.set(body.cleanKind, new Uint8Array(raw));
    return { cleanKey: body.cleanKind, rawKey: `${body.cleanKind}-raw` };
  });
  flow.callProcessor = vi.fn(async (_job, path, body, atlases?: readonly TemplateAtlasStreamInput[]) => {
    const renderer = body.rendererVersion as TemplateAtlasRendererVersion;
    if (path === '/v1/generate-template-atlas') {
      if (body.operation === 'submit') return { status: 'submitted', receipt: receipt(body.planId as string, renderer) };
      return { status: 'completed', receipt: body.receipt, rawBase64, width: 4096, height: 4096, sha256: await hashString(raw) };
    }
    if (failCompile) { failCompile = false; throw new Error('Compiler temporarily offline'); }
    const name = (body.animationNames as TemplateAtlasAnimationName[])[0];
    const playback = templateAtlasPlayback(name);
    const columns = Math.min(4, playback.sequence.length), rows = Math.ceil(playback.sequence.length / columns);
    const imageBase64 = pngHeaderBase64(columns * 768, rows * 1024);
    const usedPlanIds = templateAtlasSourcePlanIds(renderer, name);
    expect(body).not.toHaveProperty('atlases'); // RAWs use bounded R2 streaming, not one large JSON string.
    const sources = await Promise.all(atlases!
      .filter(atlas => usedPlanIds.includes(atlas.planId))
      .map(async atlas => ({ planId: atlas.planId, rawSha256: await hashString(storage.objects.get(atlas.rawKey)!.slice().buffer),
        templateImageSha256: 'b'.repeat(64), geometryFingerprint: '1'.repeat(64) })));
    const sprite: CompiledTemplateAtlasSprite = {
      animationName: name, imageBase64, rawBase64: imageBase64, frameW: 768, frameH: 1024,
      frameCount: playback.sequence.length, columns, rows, ...playback, originX: .5, originY: 1884 / 2048,
      animationFormat: 'template-atlas-v1', processingVersion: 6,
      provenance: { rendererVersion: renderer, templateVersion: TEMPLATE_ATLAS_VERSION,
        templateManifestSha256: TEMPLATE_ATLAS_MANIFEST_SHA256, sources,
        fullCanvasRegistration: { width: 1536, height: 2048, groundY: 1884, originX: .5, originY: 1884 / 2048 } },
      qa: { passed: true, semanticApprovalClaimed: false, warnings: [], perFrameFit: false, repeatsAreExact: true },
    };
    mutateSprite?.(sprite);
    return { sprites: [sprite] };
  });
  return { flow, env, storage, run: () => flow.runTemplateAtlasFlow(job, { original_blob_key: 'original' } as GenerationArtifactRun,
    'rookie-two-atlas-v1', undefined, step) };
}

beforeEach(() => {
  mock.checkpoint.clear(); mock.persisted.mockReset();
  mock.persisted.mockImplementation(async (_env, params) => ({ versionId: params.animationName, ...params }));
});

describe('versioned Template Atlas pipeline', () => {
  it('keeps legacy jobs at 3+11 stages and makes the new contract exactly 2+20', () => {
    expect(storedGenerationRenderer({ animation_plan_json: null })).toBe('legacy-v1');
    expect(generationStagesForOperation('fighter_generation')).toHaveLength(14);
    const stages = generationStagesForOperation('fighter_generation', null, job);
    expect(stages).toHaveLength(22);
    expect(stages.filter(stage => stage.artifactKind === 'source').map(stage => stage.artifactName)).toEqual(['side', 'upright']);
    expect(stages.filter(stage => stage.artifactKind === 'sprite').map(stage => stage.artifactName)).toEqual(TEMPLATE_ATLAS_ANIMATION_NAMES);
    expect(() => storedGenerationRenderer({ animation_plan_json: '{"version":2}' })).toThrow();
  });

  it('submits exactly two atlases, never the photograph, and saves all 20 authored animations', async () => {
    const { flow, run, storage } = harness();
    await run();
    const calls = vi.mocked(flow.callProcessor).mock.calls;
    const submits = calls.filter(([, , body]) => body.operation === 'submit');
    expect(submits).toHaveLength(2);
    expect(calls.slice(0, 2).every(([, , body]) => body.operation === 'submit')).toBe(true);
    expect(submits.every(([, , body]) => body.uprightBase64 === rawBase64 && !('originalBase64' in body))).toBe(true);
    expect(calls.filter(([, path]) => path === '/v1/compile-template-atlas')).toHaveLength(20);
    expect(mock.persisted).toHaveBeenCalledTimes(20);
    expect(mock.persisted.mock.calls.find(([, params]) => params.animationName === 'high_kick')?.[1]).toMatchObject({
      frameCount: 21, frameWidth: 768, frameHeight: 1024, processingVersion: 6, animationFormat: 'template-atlas-v1',
    });
    expect([...storage.objects.keys()].filter(key => key.endsWith('/raw.json'))).toHaveLength(2);
    expect([...storage.objects.keys()].filter(key => key.includes('/compiled/'))).toHaveLength(20);
    const compiled = [...storage.objects.entries()].filter(([key]) => key.includes('/compiled/'))
      .map(([, bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
    expect(compiled.reduce((sum, metadata) => sum + metadata.frameCount, 0)).toBe(184);
    for (const metadata of compiled) {
      expect(metadata.sequence).toEqual(templateAtlasPlayback(metadata.animationName).sequence);
      expect(metadata.provenance.sources.map((source: { planId: string }) => source.planId))
        .toEqual(templateAtlasSourcePlanIds('rookie-two-atlas-v1', metadata.animationName));
    }
  });

  it('resumes a failed compiler from the two preserved RAWs without a new provider submission', async () => {
    const { flow, run } = harness(true);
    await expect(run()).rejects.toThrow('temporarily offline');
    vi.mocked(flow.callProcessor).mockClear();
    await run();
    expect(vi.mocked(flow.callProcessor).mock.calls.every(([, path]) => path === '/v1/compile-template-atlas')).toBe(true);
    expect(mock.persisted).toHaveBeenCalledTimes(20);
    vi.mocked(flow.callProcessor).mockClear();
    await run();
    expect(flow.callProcessor).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong sequence', (sprite: CompiledTemplateAtlasSprite) => { sprite.sequence[0] = 'master-131'; }],
    ['wrong PNG dimensions', (sprite: CompiledTemplateAtlasSprite) => {
      sprite.imageBase64 = pngHeaderBase64(sprite.columns * 768, sprite.rows * 1024 + 1);
    }],
    ['wrong source RAW', (sprite: CompiledTemplateAtlasSprite) => { sprite.provenance.sources[0].rawSha256 = '0'.repeat(64); }],
  ] as const)('rejects qa:true with %s while preserving RAWs for inference-free diagnosis', async (_label, mutate) => {
    const { flow, run, storage } = harness(false, mutate);
    await expect(run()).rejects.toThrow(/contract|dimensions|provenance/);
    expect(mock.persisted).not.toHaveBeenCalled();
    expect([...storage.objects.keys()].filter(key => key.endsWith('/raw.json'))).toHaveLength(2);
    expect([...storage.objects.keys()].some(key => key.includes('/compiled/'))).toBe(false);
    vi.mocked(flow.callProcessor).mockClear();
    await expect(run()).rejects.toThrow(/contract|dimensions|provenance/);
    expect(vi.mocked(flow.callProcessor).mock.calls.every(([, path]) => path === '/v1/compile-template-atlas')).toBe(true);
  });

  it('keeps Champion a separate one-sheet-per-animation contract', () => {
    expect(getTemplateAtlasPlanIds('champion-animation-sheet-v1', TEMPLATE_ATLAS_ANIMATION_NAMES)).toHaveLength(20);
    expect(getTemplateAtlasPlanIds('champion-animation-sheet-v1', ['high_kick'])).toEqual(['champion-animation-sheet-v1:high_kick']);
  });

  it('does not overwrite a receipt, rejects alien plans and keeps non-4K RAW for diagnosis', async () => {
    const { env, storage } = harness();
    const planId = getTemplateAtlasPlanIds('rookie-two-atlas-v1', ['idle'])[0];
    const first = receipt(planId);
    await saveTemplateAtlasReceipt(env, job, 'rookie-two-atlas-v1', planId, first);
    await saveTemplateAtlasReceipt(env, job, 'rookie-two-atlas-v1', planId, first);
    await expect(saveTemplateAtlasReceipt(env, job, 'rookie-two-atlas-v1', planId, { ...first, requestId: 'another-id' })).rejects.toThrow('conflict');
    await expect(loadTemplateAtlasRaw(env, job, 'rookie-two-atlas-v1', '../foreign')).rejects.toThrow('Unauthorized');
    const invalidSize = raw.slice(0);
    new DataView(invalidSize).setUint32(16, 2048);
    const saved = await saveTemplateAtlasRaw(env, job, 'rookie-two-atlas-v1', planId, first,
      invalidSize, await hashString(invalidSize), 2048, 4096);
    expect(saved.width).toBe(2048);
    storage.objects.delete(saved.rawKey);
    await expect(loadTemplateAtlasRaw(env, job, 'rookie-two-atlas-v1', planId)).rejects.toThrow('refusing paid regeneration');
  });

  it('fails corrupt durable JSON closed instead of treating it as an absent inference', async () => {
    const { env, storage } = harness();
    const renderer = 'rookie-two-atlas-v1';
    const planId = getTemplateAtlasPlanIds(renderer, ['idle'])[0];
    await saveTemplateAtlasReceipt(env, job, renderer, planId, receipt(planId));
    const key = [...storage.objects.keys()].find(key => key.endsWith('/receipt.json'))!;
    for (const malformed of ['{broken', 'null', 'false', '[]']) {
      storage.objects.set(key, new TextEncoder().encode(malformed));
      await expect(loadTemplateAtlasReceipt(env, job, renderer, planId)).rejects.toThrow('Invalid atlas checkpoint JSON');
    }
    await expect(persistImmutableAtlasJson(env, 'too-large.json', { text: 'x'.repeat(33 * 1024) })).rejects.toThrow('size');
    expect(storage.objects.has('too-large.json')).toBe(false);
  });

  it('rejects cross-run or wrong-model receipts before saving or collecting them', async () => {
    const { env, storage } = harness();
    const renderer = 'rookie-two-atlas-v1';
    const planId = getTemplateAtlasPlanIds(renderer, ['idle'])[0];
    const valid = receipt(planId);
    await expect(saveTemplateAtlasReceipt(env, job, renderer, planId,
      { ...valid, requestScope: 'job:another-run:atlas:same-plan' })).rejects.toThrow('identity');
    await expect(saveTemplateAtlasReceipt(env, job, renderer, planId,
      { ...valid, provenance: { ...valid.provenance, model: 'alien-model' as typeof TEMPLATE_ATLAS_MODEL } })).rejects.toThrow('identity');
    expect(storage.objects.size).toBe(0);
  });

  it('rehashes restored RAW and verifies an already-existing immutable object before checkpointing it', async () => {
    const { env, storage } = harness();
    const renderer = 'rookie-two-atlas-v1';
    const planId = getTemplateAtlasPlanIds(renderer, ['idle'])[0];
    const verified = receipt(planId);
    const hash = await hashString(raw);
    const saved = await saveTemplateAtlasRaw(env, job, renderer, planId, verified, raw, hash, 4096, 4096);
    expect(saved.sizeBytes).toBe(raw.byteLength);
    expect(await loadTemplateAtlasRaw(env, job, renderer, planId)).toEqual(saved);
    const corrupt = new Uint8Array(raw.slice(0));
    corrupt[10] = 123;
    storage.objects.set(saved.rawKey, corrupt);
    await expect(loadTemplateAtlasRaw(env, job, renderer, planId)).rejects.toThrow('checksum');
    storage.objects.delete([...storage.objects.keys()].find(key => key.endsWith('/raw.json'))!);
    await expect(saveTemplateAtlasRaw(env, job, renderer, planId, verified, raw, hash, 4096, 4096)).rejects.toThrow('checksum');
    expect([...storage.objects.keys()].some(key => key.endsWith('/raw.json'))).toBe(false);
  });

  it('uses run identity across a new continuation job and rejects oversized RAW before reading it', async () => {
    const { env, storage } = harness();
    const renderer = 'rookie-two-atlas-v1';
    const planId = getTemplateAtlasPlanIds(renderer, ['idle'])[0];
    const saved = await saveTemplateAtlasRaw(env, job, renderer, planId, receipt(planId), raw, await hashString(raw), 4096, 4096);
    const continuation = { ...job, id: '9'.repeat(32), provider_session_id: '8'.repeat(32) };
    expect(await loadTemplateAtlasRaw(env, continuation, renderer, planId)).toEqual(saved);
    const originalGet = env.SPRITES.get.bind(env.SPRITES);
    const bodyRead = vi.fn();
    env.SPRITES.get = vi.fn(async (key: string) => key === saved.rawKey
      ? { size: 33 * 1024 * 1024, arrayBuffer: bodyRead }
      : originalGet(key)) as typeof env.SPRITES.get;
    await expect(loadTemplateAtlasRaw(env, continuation, renderer, planId)).rejects.toThrow('size');
    expect(bodyRead).not.toHaveBeenCalled();
    expect(storage.objects.get(saved.rawKey)).toEqual(new Uint8Array(raw));
  });
});
