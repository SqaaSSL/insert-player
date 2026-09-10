import { apiFetch, apiUrl, assertApiRequestContextCurrent, captureApiRequestContext } from './ApiClient.ts';
import type { AuraChallenge } from '../game/aura/AuraChallenge.ts';
import type { AuraChallengeShareData } from '../ui/shared/auraChallengeShare.ts';

export const AURA_CLIP_MAX_BYTES = 64 * 1024 * 1024;
const CLIP_ID = /^[A-Za-z0-9_-]{32}$/;
const OWNER_KEY = 'insert-player:aura-clip-owners:v1';

export interface AuraClip {
  id: string;
  challengeToken: string;
  videoUrl: string;
  downloadUrl: string;
  shareUrl: string;
  ogImageUrl: string;
  posterUrl?: string;
  createdAt: string;
  expiresAt: string;
  contentType: string;
  byteLength: number;
}
export interface AuraClipUpload {
  id: string;
  uploadUrl: string;
  uploadToken: string;
  deleteToken: string;
  expiresAt: string;
}
export class AuraClipError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = 'AuraClipError'; }
}

export function isAuraClipId(value: string): boolean { return CLIP_ID.test(value); }

export function validateAuraClipFile(file: File): void {
  if (!['video/mp4', 'video/webm'].includes(file.type)) throw new Error('This video format cannot be published. Download it instead.');
  if (file.size === 0 || file.size > AURA_CLIP_MAX_BYTES) throw new Error('This video is too large to publish (64 MB maximum). You can still download it.');
}

async function responseError(response: Response): Promise<AuraClipError> {
  let message = '';
  let code: string | undefined;
  try { const body = await response.json() as { error?: unknown; message?: unknown; code?: unknown }; message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : ''; code = typeof body.code === 'string' ? body.code : undefined; } catch { /* Use a useful public fallback. */ }
  return new AuraClipError(message || (response.status === 429 ? 'Your daily sharing limit is reached. Download this battle or share its challenge link.'
    : response.status === 403 ? 'Verification expired. Verify again and retry.'
      : response.status === 413 ? 'This video is too large to publish. You can still download it.'
        : response.status === 404 || response.status === 410 ? 'This battle link has expired or was removed.'
          : 'Your battle could not be published. Your local video is still available.'), response.status, code);
}

export async function getAuraClip(id: string, signal?: AbortSignal, uploadToken?: string): Promise<AuraClip> {
  if (!isAuraClipId(id)) throw new AuraClipError('This battle link is incomplete.', 404);
  const response = await apiFetch(`/api/aura/clips/${id}`, { signal, ...(uploadToken ? { headers: { Authorization: `Bearer ${uploadToken}` } } : {}) });
  if (!response.ok) throw await responseError(response);
  const body = await response.json() as AuraClip | { clip: AuraClip };
  return 'clip' in body ? body.clip : body;
}

/** Check the current account, not an old rendered auth flag. The backend still
 * authenticates the publish request and remains the authority after this hint. */
export async function hasAuthenticatedAuraClipSession(): Promise<boolean> {
  const context = captureApiRequestContext();
  try {
    const token = await context.tokenGetter?.();
    assertApiRequestContextCurrent(context);
    return Boolean(token);
  } catch { return false; }
}

export async function prepareAuraClip(file: File, challengeToken: string, turnstileToken?: string): Promise<AuraClipUpload> {
  validateAuraClipFile(file);
  const posterBase64 = await auraClipPoster(file);
  const response = await apiFetch('/api/aura/clips', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, byteLength: file.size, contentType: file.type, turnstileToken, posterBase64 }) });
  if (!response.ok) throw await responseError(response);
  const upload = await response.json() as AuraClipUpload;
  if (!isAuraClipId(upload.id)) throw new Error('The upload could not be prepared. Try again.');
  rememberAuraClipOwner(upload.id, upload.deleteToken, upload.expiresAt);
  return upload;
}

/** Read a real intro frame only when the player explicitly publishes. A browser
 * unable to decode its own recording still gets a playable/downloadable clip. */
export function auraClipPoster(file: File): Promise<string | undefined> {
  if (typeof document === 'undefined') return Promise.resolve(undefined);
  return new Promise(resolve => {
    let video: HTMLVideoElement | undefined;
    let url: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (poster?: string) => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      try {
        if (video) { video.onloadedmetadata = null; video.onloadeddata = null; video.onseeked = null; video.onerror = null; video.removeAttribute('src'); video.load(); }
        if (url) URL.revokeObjectURL(url);
      } catch { /* Decoding cleanup cannot block publishing. */ }
      resolve(poster);
    };
    try {
      video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.preload = 'auto';
      const capture = () => {
        if (!video || finished || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        try {
          const scale = Math.min(1, 384 / video.videoWidth, 768 / video.videoHeight);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          const context = canvas.getContext('2d');
          if (!context) { finish(); return; }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/jpeg', 0.8);
          const prefix = 'data:image/jpeg;base64,';
          const poster = data.startsWith(prefix) ? data.slice(prefix.length) : undefined;
          finish(poster && poster.length <= Math.ceil(256 * 1024 / 3) * 4 ? poster : undefined);
        } catch { finish(); }
      };
      video.onloadedmetadata = () => {
        if (!video) return;
        try { video.currentTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(0.05, video.duration / 2) : 0.05; }
        catch { capture(); }
      };
      video.onloadeddata = () => { if (video && !video.seeking) capture(); };
      video.onseeked = capture;
      video.onerror = () => finish();
      timeout = setTimeout(() => finish(), 5_000);
      url = URL.createObjectURL(file); video.src = url; video.load();
    } catch { finish(); }
  });
}

/** Capabilities only go to the configured API and this exact upload route. */
export function auraClipUploadUrl(upload: AuraClipUpload): string {
  const base = typeof window === 'undefined' ? 'http://localhost' : window.location.href;
  const expected = new URL(apiUrl(`/api/aura/clips/${upload.id}/video`), base);
  const supplied = new URL(apiUrl(upload.uploadUrl), base);
  if (!isAuraClipId(upload.id) || supplied.href !== expected.href) throw new Error('The upload destination is invalid. Try again.');
  return supplied.href;
}

export function uploadAuraClip(file: File, upload: AuraClipUpload, onProgress: (percent: number) => void, signal?: AbortSignal): Promise<AuraClip> {
  const url = auraClipUploadUrl(upload);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => signal?.removeEventListener('abort', abort);
    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', `Bearer ${upload.uploadToken}`);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.timeout = 180_000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      done();
      if (xhr.status < 200 || xhr.status >= 300) {
        void responseError(new Response(xhr.responseText || null, { status: xhr.status || 500 })).then(reject);
        return;
      }
      try {
        const body = JSON.parse(xhr.responseText) as { clip?: AuraClip };
        if (!body.clip || body.clip.id !== upload.id) throw new Error('Invalid clip response');
        resolve(body.clip);
      }
      catch { reject(new Error('The upload finished but could not be confirmed. Retry to recover your link.')); }
    };
    xhr.onerror = xhr.ontimeout = () => { done(); reject(new Error('The upload was interrupted. Retry to recover your link.')); };
    xhr.onabort = () => { done(); reject(new DOMException('Upload cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { done(); reject(new DOMException('Upload cancelled', 'AbortError')); return; }
    xhr.send(file);
  });
}

export async function deleteAuraClip(id: string, deleteToken: string): Promise<void> {
  if (!isAuraClipId(id)) throw new Error('This battle link is invalid.');
  const response = await apiFetch(`/api/aura/clips/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteToken }) });
  if (!response.ok && response.status !== 404 && response.status !== 410) throw await responseError(response);
  const owners = readOwners(); delete owners[id]; writeOwners(owners);
}

export function auraClipShareData(clip: AuraClip, challenge?: AuraChallenge | null): AuraChallengeShareData {
  return {
    title: challenge ? `${challenge.score.toLocaleString('en-US')} AURA · Insert Player` : 'Aura Battle · Insert Player',
    text: challenge ? `${challenge.name} set ${challenge.score.toLocaleString('en-US')} AURA. Watch my battle on Insert Player, then try the same challenge.`
      : 'Watch this Aura battle on Insert Player, then take your turn.',
    url: clip.shareUrl,
  };
}

type Owners = Record<string, { token: string; expiresAt: string }>;
function readOwners(): Owners {
  try {
    const value = JSON.parse(localStorage.getItem(OWNER_KEY) || '{}') as Owners;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, entry]) => isAuraClipId(id) && entry && typeof entry.token === 'string' && Date.parse(entry.expiresAt) > Date.now()));
  } catch { return {}; }
}
function writeOwners(owners: Owners): void { try { localStorage.setItem(OWNER_KEY, JSON.stringify(owners)); } catch { /* Sharing also works with storage disabled. */ } }
export function rememberAuraClipOwner(id: string, token: string, expiresAt: string): void {
  const owners = readOwners(); owners[id] = { token, expiresAt }; writeOwners(owners);
}
export function auraClipOwnerToken(id: string): string | null { return readOwners()[id]?.token ?? null; }
