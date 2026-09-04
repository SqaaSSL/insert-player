import {
  apiFetch,
  captureApiRequestContext,
  type ApiRequestContext,
} from './ApiClient.ts';
import type { CachedStageSource } from './SpriteCache.ts';

const MAPS_SCRIPT_ID = 'insert-player-google-maps';
const MAPS_LOAD_TIMEOUT_MS = 20_000;

let mapsPromise: Promise<typeof google.maps> | null = null;

export interface StreetViewCaptureFrame {
  panoId: string;
  latitude: number;
  longitude: number;
  heading: number;
  pitch: number;
  fov: number;
  locationLabel?: string;
  imageDate?: string | null;
  copyright?: string | null;
}

function configuredBrowserKey(): string {
  return String(import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY ?? '').trim();
}

export function hasGoogleMapsBrowserKey(): boolean {
  const key = configuredBrowserKey();
  return Boolean(key && !/replace_me|your_key/i.test(key));
}

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (mapsImportLibraryAvailable()) {
    return Promise.resolve(google.maps);
  }
  if (mapsPromise) return mapsPromise;

  const key = configuredBrowserKey();
  if (!key || /replace_me|your_key/i.test(key)) {
    return Promise.reject(new Error('Google Maps is not configured for this environment.'));
  }

  mapsPromise = new Promise((resolve, reject) => {
    const callbackName = `__insertPlayerMapsReady_${Date.now().toString(36)}`;
    const callbackTarget = window as unknown as Record<string, unknown>;
    callbackTarget.gm_authFailure = () => {
      window.dispatchEvent(new Event('insert-player:maps-auth-failure'));
    };
    const existingScript = document.getElementById(MAPS_SCRIPT_ID) as HTMLScriptElement | null;
    const timeout = window.setTimeout(() => {
      cleanup();
      mapsPromise = null;
      reject(new Error('Google Maps took too long to load. Check the key restrictions and network.'));
    }, MAPS_LOAD_TIMEOUT_MS);

    const cleanup = () => {
      window.clearTimeout(timeout);
      delete callbackTarget[callbackName];
    };

    callbackTarget[callbackName] = () => {
      cleanup();
      if (!mapsImportLibraryAvailable()) {
        mapsPromise = null;
        reject(new Error('Google Maps loaded without the required JavaScript API.'));
        return;
      }
      resolve(google.maps);
    };

    if (existingScript) {
      existingScript.addEventListener('load', () => {
        const callback = callbackTarget[callbackName];
        if (typeof callback === 'function') callback();
      }, { once: true });
      existingScript.addEventListener('error', () => {
        cleanup();
        mapsPromise = null;
        reject(new Error('Google Maps could not be loaded.'));
      }, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = MAPS_SCRIPT_ID;
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}` +
      `&loading=async&callback=${encodeURIComponent(callbackName)}&v=weekly&auth_referrer_policy=origin`;
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce;
    if (nonce) script.nonce = nonce;
    script.onerror = () => {
      cleanup();
      mapsPromise = null;
      script.remove();
      reject(new Error('Google Maps could not be loaded. Check the browser key and allowed referrers.'));
    };
    document.head.appendChild(script);
  });

  return mapsPromise;
}

function mapsImportLibraryAvailable(): boolean {
  if (typeof google === 'undefined') return false;
  const maps = google.maps as unknown as { importLibrary?: unknown };
  return typeof maps.importLibrary === 'function';
}

export function streetViewFovForZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 90;
  return clamp(180 / (2 ** zoom), 10, 120);
}

export function normalizeStreetViewCaptureFrame(
  frame: StreetViewCaptureFrame,
): StreetViewCaptureFrame {
  const panoId = frame.panoId.trim();
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(panoId)) {
    throw new Error('Street View returned an invalid panorama identifier.');
  }
  const latitude = finiteInRange(frame.latitude, -90, 90, 'latitude');
  const longitude = finiteInRange(frame.longitude, -180, 180, 'longitude');
  const heading = ((finiteInRange(frame.heading, -3600, 3600, 'heading') % 360) + 360) % 360;
  const pitch = finiteInRange(frame.pitch, -90, 90, 'pitch');
  const fov = finiteInRange(frame.fov, 10, 120, 'field of view');
  return {
    panoId,
    latitude,
    longitude,
    heading: round(heading),
    pitch: round(pitch),
    fov: round(fov),
    locationLabel: cleanOptional(frame.locationLabel, 160),
    imageDate: cleanOptional(frame.imageDate ?? undefined, 40) ?? null,
    copyright: cleanOptional(frame.copyright ?? undefined, 300) ?? null,
  };
}

export function streetViewStageLabel(locationLabel?: string): string {
  const firstPart = locationLabel?.split(',')[0]?.trim();
  if (!firstPart) return 'STREET VIEW STAGE';
  return firstPart.slice(0, 42).toUpperCase();
}

export function streetViewStageSource(frame: StreetViewCaptureFrame): CachedStageSource {
  const normalized = normalizeStreetViewCaptureFrame(frame);
  return {
    provider: 'google-street-view',
    ...normalized,
    capturedAt: Date.now(),
  };
}

export async function captureGoogleStreetView(
  frame: StreetViewCaptureFrame,
  context: ApiRequestContext = captureApiRequestContext(),
): Promise<Blob> {
  const normalized = normalizeStreetViewCaptureFrame(frame);
  const response = await apiFetch('/api/maps/street-view/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalized),
  }, context);

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error || `Street View capture failed (${response.status}).`);
  }
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) {
    throw new Error('Street View capture returned an unexpected response.');
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('Street View capture was empty.');
  return blob;
}

function finiteInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Street View ${label} is outside the supported range.`);
  }
  return value;
}

function cleanOptional(value: string | undefined, maxLength: number): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
