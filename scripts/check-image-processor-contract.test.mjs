import { describe, expect, it, vi } from 'vitest';
import {
  assertProductionWorkerUrl,
  APPROVED_TEMPLATE_ATLAS_COMPILER,
  assertApprovedTemplateAtlasCompiler,
  waitForCompatibleImageProcessor,
} from './check-image-processor-contract.mjs';
import { TEMPLATE_ATLAS_COMPILER_CONTRACT } from '../src/services/TemplateAtlasContract.ts';
import { readFileSync } from 'node:fs';

const WORKER_URL = 'https://api.insertplayer.ai';
const BRIDGE_SECRET = 'deployment-preflight-bridge-secret-long-enough';
const approvedContract = {
  ready: true,
  runtime: 'canvas-skia',
  templateAtlasCompiler: APPROVED_TEMPLATE_ATLAS_COMPILER,
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
  videoSpriteCompiler: {
    schemaVersion: 1,
    processingVersion: 6,
  },
};

describe('production image processor contract check', () => {
  it('keeps deployment and typed Template Atlas contracts identical', () => {
    expect(APPROVED_TEMPLATE_ATLAS_COMPILER).toEqual(TEMPLATE_ATLAS_COMPILER_CONTRACT);
  });
  it.each([
    undefined, { ...APPROVED_TEMPLATE_ATLAS_COMPILER, rendererVersions: ['rookie-two-atlas-v1'] },
    { ...APPROVED_TEMPLATE_ATLAS_COMPILER, processingVersion: 5 },
    { ...APPROVED_TEMPLATE_ATLAS_COMPILER, templateVersion: 'template-zero-v2' },
    { ...APPROVED_TEMPLATE_ATLAS_COMPILER, templateManifestSha256: '0'.repeat(64) },
    { ...APPROVED_TEMPLATE_ATLAS_COMPILER, templateManifestSha256: undefined },
    { ...APPROVED_TEMPLATE_ATLAS_COMPILER, animationCount: 11 },
    { ...APPROVED_TEMPLATE_ATLAS_COMPILER, transport: 'fal-direct' },
  ])('fails closed for an old or mismatched Template Atlas compiler (%j)', candidate => {
    expect(() => assertApprovedTemplateAtlasCompiler({ templateAtlasCompiler: candidate })).toThrow(/Pages deployment blocked/);
  });
  it('requires the processor probe before Pages in full and frontend-only releases', () => {
    for (const path of ['deploy-production.yml', 'deploy-frontend-production.yml']) {
      const workflow = readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), 'utf8');
      const probe = workflow.indexOf('run: npm run check:image-processor-contract');
      const pages = workflow.indexOf('run: npm run deploy:frontend');
      expect(probe).toBeGreaterThan(0); expect(pages).toBeGreaterThan(probe);
    }
  });
  it('is pinned to the canonical production Worker', () => {
    expect(assertProductionWorkerUrl(`${WORKER_URL}/`)).toBe(WORKER_URL);
    expect(() => assertProductionWorkerUrl('https://attacker.example')).toThrow(/pinned/);
  });

  it('uses the machine credential and accepts the exact approved contract', async () => {
    const request = vi.fn(async (_url, init) => {
      expect(init.headers['X-Insert-Player-Clerk-Backend-Auth']).toBe(BRIDGE_SECRET);
      expect(init.redirect).toBe('error');
      return Response.json(approvedContract);
    });
    await expect(waitForCompatibleImageProcessor({
      workerUrl: WORKER_URL,
      bridgeSecret: BRIDGE_SECRET,
      attempts: 1,
      intervalMs: 0,
      request,
    })).resolves.toEqual(approvedContract);
    expect(request).toHaveBeenCalledOnce();
  });

  it('retries transient processor startup responses', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ reason: 'processor_starting' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(approvedContract));
    const wait = vi.fn(async () => {});
    await expect(waitForCompatibleImageProcessor({
      workerUrl: WORKER_URL,
      bridgeSecret: BRIDGE_SECRET,
      attempts: 2,
      intervalMs: 0,
      request,
      wait,
    })).resolves.toEqual(approvedContract);
    expect(wait).toHaveBeenCalledOnce();
  });

  it('fails immediately on a permanent authentication error', async () => {
    const request = vi.fn(async () => Response.json({ error: 'Unauthorized' }, { status: 401 }));
    const wait = vi.fn(async () => {});
    await expect(waitForCompatibleImageProcessor({
      workerUrl: WORKER_URL,
      bridgeSecret: BRIDGE_SECRET,
      attempts: 30,
      intervalMs: 0,
      request,
      wait,
    })).rejects.toThrow(/rejected \(HTTP 401/);
    expect(request).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it('fails closed when a successful response advertises another provider', async () => {
    const incompatible = structuredClone(approvedContract);
    incompatible.contract.allowedGenerationProviders = ['fal'];
    await expect(waitForCompatibleImageProcessor({
      workerUrl: WORKER_URL,
      bridgeSecret: BRIDGE_SECRET,
      attempts: 1,
      intervalMs: 0,
      request: async () => Response.json(incompatible),
    })).rejects.toThrow(/Gemini-only contract/);
  });
  it('blocks a successful old Worker response that does not advertise Template Atlas', async () => {
    const { templateAtlasCompiler: _missing, ...old } = approvedContract;
    await expect(waitForCompatibleImageProcessor({
      workerUrl: WORKER_URL, bridgeSecret: BRIDGE_SECRET, attempts: 1, intervalMs: 0,
      request: async () => Response.json(old),
    })).rejects.toThrow(/Template Atlas compiler/);
  });
});
