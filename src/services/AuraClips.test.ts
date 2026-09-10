import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiUrl, configureApiAuth } from './ApiClient.ts';
import { AURA_CLIP_MAX_BYTES, AuraClipError, auraClipOwnerToken, auraClipShareData, auraClipUploadUrl, deleteAuraClip, getAuraClip,
  auraClipPoster, hasAuthenticatedAuraClipSession, isAuraClipId, prepareAuraClip, rememberAuraClipOwner, uploadAuraClip, validateAuraClipFile, type AuraClip, type AuraClipUpload } from './AuraClips.ts';
import { createAuraChallenge, createAuraChallengeRoutine } from '../game/aura/AuraChallenge.ts';
import { DEFAULT_AURA_TRACK } from '../game/aura/AuraTracks.ts';
import { shareAuraChallenge } from '../ui/shared/auraChallengeShare.ts';
vi.mock('./ApiClient.ts', async original => ({ ...await original<typeof import('./ApiClient.ts')>(), apiFetch: vi.fn(), apiUrl: vi.fn((path: string) => /^https?:/.test(path) ? path : `https://api.insertplayer.ai${path}`) }));
const id = 'AbcDef01234567_-AbcDef0123456789';
const file = new File([new Uint8Array([1, 2, 3])], 'match.mp4', { type: 'video/mp4' });
const intent: AuraClipUpload = { id, uploadToken: 'secret-upload', deleteToken: 'secret-delete', uploadUrl: `https://api.insertplayer.ai/api/aura/clips/${id}/video`, expiresAt: '2099-01-01T00:00:00Z' };
const clip: AuraClip = { id, challengeToken: 'public-challenge', videoUrl: `${intent.uploadUrl}`, downloadUrl: `${intent.uploadUrl}?download=1`,
  shareUrl: `https://insertplayer.ai/watch/${id}`, ogImageUrl: `https://api.insertplayer.ai/watch/${id}/og.png`,
  createdAt: '2026-09-11T00:00:00Z', expiresAt: '2099-02-01T00:00:00Z', contentType: 'video/mp4', byteLength: 3 };
let values: Map<string, string>;
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  configureApiAuth(null);
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.insertplayer.ai');
  vi.stubGlobal('window', { location: { href: 'https://insertplayer.ai/aura' } });
  values = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { configureApiAuth(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('hosted Aura clip requests', () => {
  it('prepares only the chosen public challenge, length, type and verification; stores the private removal token locally', async () => {
    vi.mocked(apiFetch).mockResolvedValue(Response.json(intent, { status: 201 }));
    expect(await prepareAuraClip(file, 'chosen-token', 'verification')).toEqual(intent);
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/aura/clips', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ challengeToken: 'chosen-token', byteLength: 3, contentType: 'video/mp4', turnstileToken: 'verification' }) }));
    expect(auraClipOwnerToken(id)).toBe('secret-delete');
  });
  it('reads ready metadata and asks authenticated pending status only with its explicit upload capability', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(Response.json(clip)).mockResolvedValueOnce(Response.json({ error: 'Still uploading', code: 'clip_uploading' }, { status: 409 }));
    expect(await getAuraClip(id)).toEqual(clip);
    await expect(getAuraClip(id, undefined, intent.uploadToken)).rejects.toMatchObject({ status: 409, code: 'clip_uploading' });
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/aura/clips/${id}`, { signal: undefined, headers: { Authorization: 'Bearer secret-upload' } });
  });
  it('refuses unknown/empty/oversize files before making a request', async () => {
    expect(() => validateAuraClipFile(new File([], 'empty.mp4', { type: 'video/mp4' }))).toThrow();
    expect(() => validateAuraClipFile(new File(['bad'], 'bad.html', { type: 'text/html' }))).toThrow();
    const oversized = new File(['video'], 'large.webm', { type: 'video/webm' });
    Object.defineProperty(oversized, 'size', { value: AURA_CLIP_MAX_BYTES + 1 });
    await expect(prepareAuraClip(oversized, 'token')).rejects.toThrow('64 MB');
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('never sends upload capabilities to a foreign origin, a credentialed URL or another upload ID', () => {
    expect(apiUrl(`/api/aura/clips/${id}/video`)).toBe(intent.uploadUrl);
    expect(auraClipUploadUrl(intent)).toBe(intent.uploadUrl);
    for (const uploadUrl of ['https://evil.test/api/aura/clips/' + id + '/video', intent.uploadUrl + '?token=leak', intent.uploadUrl.replace(id, 'x'.repeat(32)), intent.uploadUrl.replace('https://', 'https://secret@')]) {
      expect(() => auraClipUploadUrl({ ...intent, uploadUrl })).toThrow('destination');
    }
  });
  it('retains removal credentials on a failed delete and clears them only after revocation', async () => {
    rememberAuraClipOwner(id, 'secret-delete', clip.expiresAt);
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(deleteAuraClip(id, 'secret-delete')).rejects.toBeInstanceOf(AuraClipError);
    expect(auraClipOwnerToken(id)).toBe('secret-delete');
    await deleteAuraClip(id, 'secret-delete');
    expect(auraClipOwnerToken(id)).toBeNull();
    expect(apiFetch).toHaveBeenLastCalledWith(`/api/aura/clips/${id}`, expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ deleteToken: 'secret-delete' }) }));
  });
  it('only recognizes unguessable 32-character IDs and handles storage unavailable/expired tokens', async () => {
    expect(isAuraClipId(id)).toBe(true);
    expect(isAuraClipId('../private')).toBe(false);
    expect(isAuraClipId('a'.repeat(31))).toBe(false);
    rememberAuraClipOwner(id, 'old', '2000-01-01T00:00:00Z');
    expect(auraClipOwnerToken(id)).toBeNull();
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
    expect(() => rememberAuraClipOwner(id, 'new', clip.expiresAt)).not.toThrow();
    expect(auraClipOwnerToken(id)).toBeNull();
    await expect(getAuraClip('../private')).rejects.toMatchObject({ status: 404 });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('Aura link handoff', () => {
  it('shares the branded watch URL only, never the raw video or a removal/upload capability', async () => {
    const routine = createAuraChallengeRoutine(34, 'lowkey', DEFAULT_AURA_TRACK.id, 'insert-player-arena')!;
    const challenge = createAuraChallenge(routine, 'Alex', 1200);
    const data = auraClipShareData(clip, challenge);
    const share = vi.fn().mockResolvedValue(undefined);
    expect(await shareAuraChallenge(data, { share, copy: vi.fn() })).toBe('shared');
    expect(share).toHaveBeenCalledExactlyOnceWith({ title: '1,200 AURA · Insert Player', text: expect.stringContaining('Alex'), url: clip.shareUrl });
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(data).not.toHaveProperty('files');
    expect(data.url).not.toBe(clip.videoUrl);
  });
  it('retains a published link after native share cancellation without copying it unexpectedly', async () => {
    const copy = vi.fn();
    const result = await shareAuraChallenge(auraClipShareData(clip), { share: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')), copy });
    expect(result).toBe('cancelled'); expect(copy).not.toHaveBeenCalled();
  });
});

describe('video upload transport', () => {
  it('sends the original file, reports actual byte progress, and only returns confirmed metadata', async () => {
    let request: any;
    class FakeXhr {
      upload: any = {}; timeout = 0; status = 201; responseText = JSON.stringify({ clip });
      open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn(); abort = vi.fn();
      constructor() { request = this; }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const progress = vi.fn();
    const promise = uploadAuraClip(file, intent, progress);
    expect(request.open).toHaveBeenCalledWith('PUT', intent.uploadUrl);
    expect(request.setRequestHeader).toHaveBeenCalledWith('Authorization', 'Bearer secret-upload');
    expect(request.send).toHaveBeenCalledExactlyOnceWith(file);
    request.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
    expect(progress).toHaveBeenCalledWith(25);
    request.onload();
    expect(await promise).toEqual(clip);
  });
  it('does not claim a link exists after a lost or malformed upload response', async () => {
    let request: any;
    class FakeXhr { upload = {}; status = 201; responseText = '{}'; open() {} setRequestHeader() {} send() {} abort() {} constructor() { request = this; } }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const promise = uploadAuraClip(file, intent, vi.fn()); request.onload();
    await expect(promise).rejects.toThrow('could not be confirmed');
    const lost = uploadAuraClip(file, intent, vi.fn()); request.onerror();
    await expect(lost).rejects.toThrow('interrupted');
  });
});


describe('real recording poster', () => {
  it('extracts a bounded real intro frame and releases its local media URL', async () => {
    let video: any;
    const context = { drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: vi.fn(() => 'data:image/jpeg;base64,/9j/AA==') };
    video = { readyState: 2, videoWidth: 576, videoHeight: 1024, duration: 59, currentTime: 0, load: vi.fn(), removeAttribute: vi.fn() };
    vi.stubGlobal('document', { createElement: (tag: string) => tag === 'video' ? video : canvas });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const poster = auraClipPoster(file);
    video.onloadedmetadata();
    expect(video.currentTime).toBe(0.05);
    video.onseeked();
    expect(await poster).toBe('/9j/AA==');
    expect(canvas.width).toBe(384); expect(canvas.height).toBe(683);
    expect(context.drawImage).toHaveBeenCalledWith(video, 0, 0, 384, 683);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:recording');
  });
  it('omits a poster when decoding times out instead of blocking a valid recording', async () => {
    vi.useFakeTimers();
    const video = { load: vi.fn(), removeAttribute: vi.fn() };
    vi.stubGlobal('document', { createElement: () => video });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const poster = auraClipPoster(file);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await poster).toBeUndefined();
    vi.useRealTimers();
  });
});


describe('publication identity and creator controls', () => {
  it('skips guest verification only with a token from the still-current API session', async () => {
    expect(await hasAuthenticatedAuraClipSession()).toBe(false);
    configureApiAuth(async () => 'current-session-token');
    expect(await hasAuthenticatedAuraClipSession()).toBe(true);
    configureApiAuth(async () => null);
    expect(await hasAuthenticatedAuraClipSession()).toBe(false);
    configureApiAuth(async () => { throw new Error('Session unavailable'); });
    expect(await hasAuthenticatedAuraClipSession()).toBe(false);
  });
  it('does not trust a token that arrives after sign-out or account change', async () => {
    let resolve!: (token: string) => void;
    configureApiAuth(() => new Promise(done => { resolve = done; }));
    const authenticated = hasAuthenticatedAuraClipSession();
    configureApiAuth(null); resolve('previous-account-token');
    expect(await authenticated).toBe(false);
  });
  it('retains active removal tokens beyond fifty publications until each expires', () => {
    const first = '0'.repeat(32);
    for (let index = 0; index < 100; index += 1) rememberAuraClipOwner(String(index).padStart(32, '0'), `owner-${index}`, clip.expiresAt);
    expect(auraClipOwnerToken(first)).toBe('owner-0');
    expect(auraClipOwnerToken('99'.padStart(32, '0'))).toBe('owner-99');
  });
});
