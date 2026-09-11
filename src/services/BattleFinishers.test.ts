import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, configureApiAuth } from './ApiClient.ts';
import { battleMediaUrl, generateBattleFinisher, getSavedBattle, loadBattleMedia, publishSavedBattle, saveBattleCapture, savedBattleShareData, validateBattleCapture, type BattleCaptureDetail, type SavedBattle } from './BattleFinishers.ts';
import { currentGenerationLegalAttestation } from '../ui/legal.ts';
vi.mock('./ApiClient.ts', async original => ({ ...await original<typeof import('./ApiClient.ts')>(), apiFetch: vi.fn(), apiUrl: (path: string) => /^https?:/.test(path) ? path : `https://api.insertplayer.ai${path}` }));
const id = 'a'.repeat(32);
const clientBattleId = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const summary = { game: 'aura' as const, winner: 'p1' as const, p1Name: 'Trump', p2Name: 'Lamine', stageLabel: 'Aura plaza', durationSeconds: 90 };
const battle: SavedBattle = { id, summary, createdAt: '2026-09-11T18:00:00Z', published: false, isOwner: true, stillUrl: `https://api.insertplayer.ai/api/battles/${id}/still`, shareUrl: `https://insertplayer.ai/battles/${id}`, finisherShareUrl: `https://insertplayer.ai/battles/${id}/finisher`, ogImageUrl: `https://api.insertplayer.ai/share/battles/${id}/og.png` };
const capture: BattleCaptureDetail = { clientBattleId, summary, stillBase64: 'data:image/jpeg;base64,/9j/AA==' };
beforeEach(() => { vi.mocked(apiFetch).mockReset(); configureApiAuth(null); vi.stubGlobal('window', { location: { href: 'https://insertplayer.ai/aura' } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); configureApiAuth(null); });

describe('battle persistence and generation boundary', () => {
  it('stores the final frame privately, normalizes its data URL and never implicitly generates or publishes', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ battle }));
    expect(await saveBattleCapture(capture)).toEqual(battle);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/battles', expect.objectContaining({ method: 'POST', body: JSON.stringify({ clientBattleId, summary, stillBase64: '/9j/AA==' }) }), expect.anything());
  });
  it('uploads the complete local recording before returning a saved battle, and reuses an already uploaded recording', async () => {
    const file = new File(['video'], 'battle.mp4', { type: 'video/mp4' });
    const withRecording = { ...battle, recordingUrl: `https://api.insertplayer.ai/api/battles/${id}/recording` };
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ battle })).mockResolvedValueOnce(Response.json({ battle: withRecording }));
    expect(await saveBattleCapture({ ...capture, recording: file })).toEqual(withRecording);
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/battles/${id}/recording`, expect.objectContaining({ method: 'PUT', body: file, headers: { 'Content-Type': 'video/mp4' } }), expect.anything());
    vi.mocked(apiFetch).mockClear().mockResolvedValue(Response.json({ battle: withRecording }));
    await saveBattleCapture({ ...capture, recording: file }); expect(apiFetch).toHaveBeenCalledTimes(1);
  });
  it('does not continue generation when saving the recording failed', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json({ battle })).mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(saveBattleCapture({ ...capture, recording: new File(['v'], 'battle.webm', { type: 'video/webm' }) })).rejects.toMatchObject({ status: 503 });
    expect(vi.mocked(apiFetch).mock.calls.every(([url]) => !url.includes('/finisher'))).toBe(true);
  });
  it('sends one explicit consented generation using the caller’s stable request ID', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ battle }));
    const legal = currentGenerationLegalAttestation();
    await generateBattleFinisher(id, requestId, legal);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(`/api/battles/${id}/finisher`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId, legal }) }), undefined);
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('fal'), expect.anything());
  });
  it.each([401, 402, 428, 503])('keeps recoverable status %i instead of treating it as a generated video', async status => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status }));
    await expect(generateBattleFinisher(id, requestId, currentGenerationLegalAttestation())).rejects.toMatchObject({ status });
  });
  it('rejects malformed captures and route traversal before sending media', async () => {
    expect(() => validateBattleCapture({ ...capture, stillBase64: 'data:text/html,unsafe' })).toThrow();
    expect(() => validateBattleCapture({ ...capture, clientBattleId: 'broken' })).toThrow();
    await expect(getSavedBattle('../private')).rejects.toMatchObject({ status: 404 });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('owned media and branded sharing', () => {
  it('only loads media from this exact battle on the configured API', async () => {
    expect(battleMediaUrl(battle, 'still')).toBe(battle.stillUrl);
    for (const stillUrl of ['https://fal.media/output.jpg', `${battle.stillUrl}?token=secret`, battle.stillUrl.replace(id, 'b'.repeat(32)), battle.stillUrl.replace('https://', 'https://secret@')]) {
      expect(() => battleMediaUrl({ ...battle, stillUrl }, 'still')).toThrow('verified');
    }
    vi.mocked(apiFetch).mockResolvedValue(new Response(new Blob(['jpeg'], { type: 'image/jpeg' })));
    expect((await loadBattleMedia(battle, 'still')).type).toBe('image/jpeg');
    expect(apiFetch).toHaveBeenCalledWith(battle.stillUrl, { signal: undefined });
  });
  it('rejects an HTML response masquerading as a ready video', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('<html>', { headers: { 'Content-Type': 'text/html' } }));
    await expect(loadBattleMedia({ ...battle, finisher: { id: requestId, status: 'ready', creditRefunded: false, videoUrl: `https://api.insertplayer.ai/api/battles/${id}/finisher` } }, 'finisher')).rejects.toThrow('media');
  });
  it('requires explicit publication and shares battle / finisher URLs rather than media or provider URLs', async () => {
    expect(() => savedBattleShareData(battle)).toThrow('Publish');
    const published = { ...battle, published: true };
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ battle: published }));
    expect(await publishSavedBattle(id)).toEqual(published);
    expect(savedBattleShareData(published).url).toBe(battle.shareUrl);
    expect(savedBattleShareData(published, true).url).toBe(battle.finisherShareUrl);
    expect(savedBattleShareData(published)).not.toHaveProperty('files');
    expect(() => savedBattleShareData({ ...published, shareUrl: `https://evil.test/battles/${id}` })).toThrow();
  });
});
