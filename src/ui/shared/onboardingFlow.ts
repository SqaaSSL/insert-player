import {
  isQualityTier,
  type QualityTier,
} from '../../services/QualityTiers.ts';

export type CreationReturnTarget = 'gallery' | 'arcade';
export type CreationEntrySource = 'trial' | 'landing' | 'arcade' | 'menu' | 'gallery' | 'roster';

export interface CreationNavigationContext {
  tier: QualityTier | null;
  returnTo: CreationReturnTarget;
  source: CreationEntrySource | null;
}

export interface CreationSearchOptions {
  tier?: QualityTier;
  returnTo?: CreationReturnTarget;
  source?: CreationEntrySource;
}

export interface CreationPurchaseIntent {
  tier: QualityTier;
  returnTo: CreationReturnTarget;
  source: CreationEntrySource;
  createdAt: number;
}

const CREATION_ENTRY_SOURCES = new Set<CreationEntrySource>([
  'trial',
  'landing',
  'arcade',
  'menu',
  'gallery',
  'roster',
]);

const GENERATED_PHOTO_HASH_PATTERN = /^[a-f0-9]{64}$/;
const CREATION_PURCHASE_INTENT_PREFIX = 'asf:creation-purchase-intent:';
const CREATION_PURCHASE_INTENT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const POST_SIGN_UP_TRIAL_INTENT_KEY = 'asf:onboarding:post-sign-up-trial';
const POST_SIGN_UP_TRIAL_INTENT_MAX_AGE_MS = 30 * 60 * 1_000;

function searchParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

export function isGeneratedPhotoHash(value: unknown): value is string {
  return typeof value === 'string' && GENERATED_PHOTO_HASH_PATTERN.test(value);
}

/** Parses only known values; arbitrary return URLs are never accepted. */
export function readCreationNavigationContext(search: string): CreationNavigationContext {
  const params = searchParams(search);
  const requestedTier = params.get('tier');
  const requestedSource = params.get('source');
  return {
    tier: isQualityTier(requestedTier) ? requestedTier : null,
    returnTo: params.get('return') === 'arcade' ? 'arcade' : 'gallery',
    source: CREATION_ENTRY_SOURCES.has(requestedSource as CreationEntrySource)
      ? requestedSource as CreationEntrySource
      : null,
  };
}

/** Returns a query string without `?`, matching App.navigate's search argument. */
export function buildCreationSearch(options: CreationSearchOptions = {}): string {
  const params = new URLSearchParams();
  if (options.tier) params.set('tier', options.tier);
  if (options.returnTo === 'arcade') params.set('return', 'arcade');
  if (options.source) params.set('source', options.source);
  return params.toString();
}

export function parseCreationPurchaseIntent(
  value: unknown,
  now = Date.now(),
): CreationPurchaseIntent | null {
  if (!value || typeof value !== 'object') return null;
  const intent = value as Partial<CreationPurchaseIntent>;
  if (
    !isQualityTier(intent.tier)
    || (intent.returnTo !== 'gallery' && intent.returnTo !== 'arcade')
    || !CREATION_ENTRY_SOURCES.has(intent.source as CreationEntrySource)
    || typeof intent.createdAt !== 'number'
    || !Number.isFinite(intent.createdAt)
    || intent.createdAt > now + 60_000
    || now - intent.createdAt > CREATION_PURCHASE_INTENT_MAX_AGE_MS
  ) return null;
  return intent as CreationPurchaseIntent;
}

function creationPurchaseIntentKey(authSessionKey: string): string {
  return `${CREATION_PURCHASE_INTENT_PREFIX}${encodeURIComponent(authSessionKey)}`;
}

export function rememberCreationPurchaseIntent(
  authSessionKey: string,
  intent: Omit<CreationPurchaseIntent, 'createdAt'>,
): boolean {
  try {
    window.sessionStorage.setItem(
      creationPurchaseIntentKey(authSessionKey),
      JSON.stringify({ ...intent, createdAt: Date.now() }),
    );
    return true;
  } catch {
    return false;
  }
}

export function readCreationPurchaseIntent(authSessionKey: string): CreationPurchaseIntent | null {
  try {
    const key = creationPurchaseIntentKey(authSessionKey);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const intent = parseCreationPurchaseIntent(JSON.parse(raw));
    if (!intent) window.sessionStorage.removeItem(key);
    return intent;
  } catch {
    return null;
  }
}

export function clearCreationPurchaseIntent(authSessionKey: string): void {
  try {
    window.sessionStorage.removeItem(creationPurchaseIntentKey(authSessionKey));
  } catch {
    // A blocked storage surface should not trap the user in billing.
  }
}

export function isFreshPostSignUpTrialIntent(value: unknown, now = Date.now()): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return value <= now + 60_000 && now - value <= POST_SIGN_UP_TRIAL_INTENT_MAX_AGE_MS;
}

export function isNewAccountForOnboarding(value: unknown, now = Date.now()): boolean {
  if (!(value instanceof Date)) return false;
  return isFreshPostSignUpTrialIntent(value.getTime(), now);
}

export function rememberPostSignUpTrialIntent(): void {
  try {
    window.sessionStorage.setItem(POST_SIGN_UP_TRIAL_INTENT_KEY, String(Date.now()));
  } catch {
    // Clerk still works when session storage is blocked; only the automatic handoff degrades.
  }
}

export function clearPostSignUpTrialIntent(): void {
  try {
    window.sessionStorage.removeItem(POST_SIGN_UP_TRIAL_INTENT_KEY);
  } catch {
    // Best effort: a blocked storage surface cannot hold a usable intent anyway.
  }
}

/** Consumes the marker before launch so StrictMode, reloads, and retries cannot replay it. */
export function consumePostSignUpTrialIntent(now = Date.now()): boolean {
  try {
    const raw = window.sessionStorage.getItem(POST_SIGN_UP_TRIAL_INTENT_KEY);
    window.sessionStorage.removeItem(POST_SIGN_UP_TRIAL_INTENT_KEY);
    if (!raw) return false;
    return isFreshPostSignUpTrialIntent(Number(raw), now);
  } catch {
    return false;
  }
}

export function readPreferredArcadePlayerPhotoHash(search: string): string | null {
  const candidate = searchParams(search).get('player');
  return isGeneratedPhotoHash(candidate) ? candidate : null;
}

/** Returns a query string without `?` for the post-creation Arcade handoff. */
export function buildArcadeSelectionSearch(photoHash: string): string {
  if (!isGeneratedPhotoHash(photoHash)) {
    throw new Error('Arcade player selection requires a generated fighter photo hash.');
  }
  const params = new URLSearchParams();
  params.set('player', photoHash);
  params.set('source', 'creation');
  return params.toString();
}
