import type { CreditCheckoutVerification } from '../../services/Billing.ts';

export type CheckoutStatus = 'success' | 'cancelled';

export interface CheckoutReturn {
  status: CheckoutStatus;
  sessionId: string | null;
}

export function checkoutReturnFromUrl(href: string): CheckoutReturn | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const status = url.searchParams.get('checkout');
  if (!isCheckoutStatus(status)) return null;
  const rawSessionId = url.searchParams.get('session_id')?.trim() ?? null;
  return {
    status,
    sessionId: validStripeCheckoutSessionId(rawSessionId) ? rawSessionId : null,
  };
}

const CHECKOUT_STATUS_PREFIX = 'ai-street-fighter:checkout-status:v1:';
const CHECKOUT_PENDING_PREFIX = 'ai-street-fighter:pending-checkout:v1:';
const LEGACY_CHECKOUT_STATUS_KEY = 'ai-street-fighter:checkout-status';
const LEGACY_CHECKOUT_PENDING_KEY = 'ai-street-fighter:pending-checkout';
const CHECKOUT_STATUS_TTL_MS = 3_000;
const CHECKOUT_PENDING_TTL_MS = 30 * 60_000;

export interface PendingCheckout {
  sessionId: string;
  packId: string;
  credits: number;
}

function isCheckoutStatus(value: string | null): value is CheckoutStatus {
  return value === 'success' || value === 'cancelled';
}

function validAuthSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function validStripeCheckoutSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^cs_[A-Za-z0-9_]+$/.test(value);
}

function scopedKey(prefix: string, authSessionKey: string): string {
  return `${prefix}${encodeURIComponent(authSessionKey)}`;
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function removeLegacyCheckoutState(storage: Storage): void {
  storage.removeItem(LEGACY_CHECKOUT_STATUS_KEY);
  storage.removeItem(LEGACY_CHECKOUT_PENDING_KEY);
}

function isPendingCheckout(value: unknown): value is PendingCheckout {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingCheckout>;
  return Boolean(
    validStripeCheckoutSessionId(pending.sessionId) &&
    typeof pending.packId === 'string' &&
    pending.packId.length > 0 &&
    pending.packId.length <= 80 &&
    typeof pending.credits === 'number' &&
    Number.isSafeInteger(pending.credits) &&
    pending.credits > 0 &&
    pending.credits <= 100_000,
  );
}

function takeStoredStatus(
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): CheckoutReturn | null {
  if (!storage || !validAuthSessionKey(authSessionKey)) return null;
  try {
    removeLegacyCheckoutState(storage);
    const key = scopedKey(CHECKOUT_STATUS_PREFIX, authSessionKey);
    const raw = storage.getItem(key);
    if (!raw) return null;
    storage.removeItem(key);
    const stored = JSON.parse(raw) as {
      status?: string;
      sessionId?: unknown;
      createdAt?: number;
      authSessionKey?: string;
    };
    const age = typeof stored.createdAt === 'number' ? now - stored.createdAt : Number.POSITIVE_INFINITY;
    const fresh = age >= -60_000 && age <= CHECKOUT_STATUS_TTL_MS;
    const status = stored.status ?? null;
    return fresh && stored.authSessionKey === authSessionKey && isCheckoutStatus(status)
      ? {
        status,
        sessionId: validStripeCheckoutSessionId(stored.sessionId) ? stored.sessionId : null,
      }
      : null;
  } catch {
    return null;
  }
}

export function rememberPendingCheckout(
  pending: PendingCheckout,
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): void {
  if (!storage || !validAuthSessionKey(authSessionKey)) return;
  try {
    removeLegacyCheckoutState(storage);
    storage.setItem(
      scopedKey(CHECKOUT_PENDING_PREFIX, authSessionKey),
      JSON.stringify({ ...pending, authSessionKey, createdAt: now }),
    );
  } catch {
    // best effort only
  }
}

export function consumePendingCheckout(
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): PendingCheckout | null {
  if (!storage || !validAuthSessionKey(authSessionKey)) return null;
  try {
    removeLegacyCheckoutState(storage);
    const key = scopedKey(CHECKOUT_PENDING_PREFIX, authSessionKey);
    const raw = storage.getItem(key);
    if (!raw) return null;
    storage.removeItem(key);
    const stored = JSON.parse(raw) as PendingCheckout & { createdAt?: number; authSessionKey?: string };
    const age = typeof stored.createdAt === 'number' ? now - stored.createdAt : Number.POSITIVE_INFINITY;
    const fresh = age >= -60_000 && age <= CHECKOUT_PENDING_TTL_MS;
    return fresh && stored.authSessionKey === authSessionKey && isPendingCheckout(stored)
      ? {
        sessionId: stored.sessionId,
        packId: stored.packId,
        credits: stored.credits,
      }
      : null;
  } catch {
    return null;
  }
}

export function readPendingCheckout(
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): PendingCheckout | null {
  if (!storage || !validAuthSessionKey(authSessionKey)) return null;
  try {
    removeLegacyCheckoutState(storage);
    const key = scopedKey(CHECKOUT_PENDING_PREFIX, authSessionKey);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as PendingCheckout & { createdAt?: number; authSessionKey?: string };
    const age = typeof stored.createdAt === 'number' ? now - stored.createdAt : Number.POSITIVE_INFINITY;
    const fresh = age >= -60_000 && age <= CHECKOUT_PENDING_TTL_MS;
    if (fresh && stored.authSessionKey === authSessionKey && isPendingCheckout(stored)) {
      return {
        sessionId: stored.sessionId,
        packId: stored.packId,
        credits: stored.credits,
      };
    }
    storage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

export function clearPendingCheckout(
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
): void {
  if (!storage || !validAuthSessionKey(authSessionKey)) return;
  try {
    removeLegacyCheckoutState(storage);
    storage.removeItem(scopedKey(CHECKOUT_PENDING_PREFIX, authSessionKey));
  } catch {
    // best effort only
  }
}

export function clearPendingCheckoutForSession(
  authSessionKey: string,
  sessionId: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): void {
  const pending = readPendingCheckout(authSessionKey, storage, now);
  if (pending?.sessionId === sessionId) clearPendingCheckout(authSessionKey, storage);
}

function rememberStatus(checkoutReturn: CheckoutReturn, authSessionKey: string): void {
  const storage = browserSessionStorage();
  if (!storage || !validAuthSessionKey(authSessionKey)) return;
  try {
    removeLegacyCheckoutState(storage);
    const key = scopedKey(CHECKOUT_STATUS_PREFIX, authSessionKey);
    const payload = JSON.stringify({ ...checkoutReturn, authSessionKey, createdAt: Date.now() });
    storage.setItem(key, payload);
    window.setTimeout(() => {
      try {
        if (storage.getItem(key) === payload) {
          storage.removeItem(key);
        }
      } catch {
        // best effort only
      }
    }, CHECKOUT_STATUS_TTL_MS);
  } catch {
    // best effort only
  }
}

export function consumeCheckoutReturn(authSessionKey: string): CheckoutReturn | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const checkoutReturn = checkoutReturnFromUrl(url.href);
  if (!checkoutReturn) return takeStoredStatus(authSessionKey);

  url.searchParams.delete('checkout');
  url.searchParams.delete('session_id');
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, '', nextUrl || '/menu');
  if (checkoutReturn.status === 'cancelled') clearPendingCheckout(authSessionKey);
  rememberStatus(checkoutReturn, authSessionKey);
  return checkoutReturn;
}

export function consumeCheckoutStatus(authSessionKey: string): CheckoutStatus | null {
  return consumeCheckoutReturn(authSessionKey)?.status ?? null;
}

export function checkoutStatusMessage(status: CheckoutStatus): string {
  return status === 'success'
    ? 'Returned from Stripe. The exact checkout session still needs verification.'
    : 'Checkout cancelled. No credits were charged.';
}

export function checkoutVerificationMessage(checkout: CreditCheckoutVerification): string {
  if (checkout.state === 'complete') {
    return `${checkout.creditsBalance} credits ready · Stripe session confirmed for ${checkout.credits} credits.`;
  }
  if (checkout.state === 'pending') {
    return `Stripe session is still confirming. Current balance: ${checkout.creditsBalance} (balance alone does not confirm it).`;
  }
  if (checkout.processorStatus === 'refunded') {
    return `This checkout was refunded. Current balance: ${checkout.creditsBalance}.`;
  }
  if (checkout.processorStatus === 'partially_refunded') {
    return `This checkout was partially refunded. Current balance: ${checkout.creditsBalance}.`;
  }
  if (checkout.processorStatus === 'disputed') {
    return `This checkout is disputed, so its credits are unavailable. Current balance: ${checkout.creditsBalance}.`;
  }
  return `This Stripe session did not complete. Current balance: ${checkout.creditsBalance}.`;
}
