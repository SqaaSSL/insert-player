import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  apiFetch,
  deleteCachedStageBackground,
  getAllCachedStageBackgrounds,
  getCachedStageBackground,
  setCachedStageBackground,
} = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  deleteCachedStageBackground: vi.fn(),
  getAllCachedStageBackgrounds: vi.fn(),
  getCachedStageBackground: vi.fn(),
  setCachedStageBackground: vi.fn(),
}));

vi.mock('./ApiClient.ts', () => ({
  apiFetch,
  captureApiRequestContext: () => ({ authRevision: 1, tokenGetter: null, providerSessionId: null }),
}));
vi.mock('./SpriteCache.ts', () => ({
  deleteCachedStageBackground,
  getAllCachedStageBackgrounds,
  getActiveSpriteCacheScope: () => 'clerk:user_one',
  getCachedStageBackground,
  setCachedStageBackground,
}));

import {
  cachePendingCrewStageUpload,
  crewStageCacheKey,
  findPendingCrewStageUpload,
  isStageVisibleToActiveCrew,
  resumePendingCrewStageUpload,
  saveCrewStage,
  syncCrewStageToLocal,
} from './CrewStages.ts';
import type { CachedStageBackground } from './SpriteCache.ts';

const crew = { id: 'org_alpha', name: 'Alpha Crew' };
const remote = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  label: 'THE OLD PARK',
  kind: 'photo' as const,
  contentHash: 'a'.repeat(64),
  assetUrl: 'https://api.insertplayer.ai/api/crew/stage/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset',
  createdAt: '2026-09-15T20:00:00.000Z',
  updatedAt: '2026-09-15T20:00:00.000Z',
};

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
  apiFetch.mockReset();
  deleteCachedStageBackground.mockReset();
  getAllCachedStageBackgrounds.mockReset();
  getCachedStageBackground.mockReset();
  setCachedStageBackground.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe('Crew stage cloud cache', () => {
  it('uploads the final derivative and marks the cached copy as Crew-managed', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ stage: remote }, { status: 201 }));
    const local = {
      stageKey: 'personal-stage',
      prompt: 'forged',
      pngBlob: new Blob(['png'], { type: 'image/png' }),
      createdAt: Date.now(),
      kind: 'photo' as const,
      label: 'THE OLD PARK',
    };
    const saved = await saveCrewStage(local, crew, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    const [, request] = apiFetch.mock.calls[0];
    expect(request).toMatchObject({ method: 'POST' });
    const form = request.body as FormData;
    expect(form.get('purchaseId')).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(form.get('kind')).toBe('photo');
    expect(saved).toMatchObject({
      stageKey: crewStageCacheKey(crew.id, remote.id),
      cloudManagement: 'crew',
      cloudCrewId: crew.id,
      cloudCrewName: crew.name,
      cloudContentHash: remote.contentHash,
    });
    expect(setCachedStageBackground).toHaveBeenCalledOnce();
  });

  it('downloads a ready Crew stage once and hides cached stages from another active Crew', async () => {
    getCachedStageBackground.mockResolvedValueOnce(null);
    apiFetch
      .mockResolvedValueOnce(Response.json({ claimState: 'ready', canCreate: false, stage: remote }))
      .mockResolvedValueOnce(new Response(new Blob(['shared'], { type: 'image/png' }), {
        headers: { 'Content-Type': 'image/png' },
      }));
    await expect(syncCrewStageToLocal(crew)).resolves.toBe(true);
    const cached = setCachedStageBackground.mock.calls[0][0] as CachedStageBackground;
    expect(isStageVisibleToActiveCrew(cached, crew)).toBe(true);
    expect(isStageVisibleToActiveCrew(cached, { id: 'org_beta' })).toBe(false);
    expect(isStageVisibleToActiveCrew(cached, null)).toBe(false);
  });

  it('keeps an interrupted forged stage hidden and resumes the same Crew claim without regenerating it', async () => {
    const generated: CachedStageBackground = {
      stageKey: 'generated-stage',
      prompt: 'forged',
      pngBlob: new Blob(['png'], { type: 'image/png' }),
      createdAt: Date.now(),
      kind: 'photo',
      label: 'THE OLD PARK',
    };
    const pending = await cachePendingCrewStageUpload(
      generated,
      crew,
      remote.id,
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    expect(pending).toMatchObject({
      stageKey: crewStageCacheKey(crew.id, remote.id),
      cloudUploadPending: true,
      cloudUploadPurchaseId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(isStageVisibleToActiveCrew(pending, crew)).toBe(false);

    getAllCachedStageBackgrounds.mockResolvedValueOnce([pending]);
    await expect(findPendingCrewStageUpload(crew)).resolves.toBe(pending);

    apiFetch
      .mockResolvedValueOnce(Response.json({ claimState: 'reserved', canCreate: false, stage: null }))
      .mockResolvedValueOnce(Response.json({ stage: remote }, { status: 201 }));
    const resumed = await resumePendingCrewStageUpload(pending, crew);
    expect(resumed).toMatchObject({
      cloudManagement: 'crew',
      cloudStageId: remote.id,
    });
    expect(resumed?.cloudUploadPending).toBeUndefined();
    const uploadForm = apiFetch.mock.calls[1][1].body as FormData;
    expect(uploadForm.get('purchaseId')).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });
});
