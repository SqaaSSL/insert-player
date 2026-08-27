export type CheckoutStatus = 'success' | 'cancelled';

const CHECKOUT_STATUS_PREFIX = 'ai-street-fighter:checkout-status:v1:';
const CHECKOUT_PENDING_PREFIX = 'ai-street-fighter:pending-checkout:v1:';
const LEGACY_CHECKOUT_STATUS_KEY = 'ai-street-fighter:checkout-status';
const LEGACY_CHECKOUT_PENDING_KEY = 'ai-street-fighter:pending-checkout';
const CHECKOUT_STATUS_TTL_MS = 3_000;
const CHECKOUT_PENDING_TTL_MS = 30 * 60_000;

export interface PendingCheckout {
  packId: string;
  credits: number;
  balanceBefore: number | null;
}

function isCheckoutStatus(value: string | null): value is CheckoutStatus {
  return value === 'success' || value === 'cancelled';
}

function validAuthSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
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
    typeof pending.packId === 'string' &&
    pending.packId.length > 0 &&
    pending.packId.length <= 80 &&
    typeof pending.credits === 'number' &&
    Number.isSafeInteger(pending.credits) &&
    pending.credits > 0 &&
    pending.credits <= 100_000 &&
    (
      pending.balanceBefore === null
      || (
        typeof pending.balanceBefore === 'number'
        && Number.isSafeInteger(pending.balanceBefore)
        && pending.balanceBefore >= 0
      )
    ),
  );
}

function takeStoredStatus(
  authSessionKey: string,
  storage: Storage | null = browserSessionStorage(),
  now = Date.now(),
): CheckoutStatus | null {
  if (!storage || !validAuthSessionKey(authSessionKey)) return null;
  try {
    removeLegacyCheckoutState(storage);
    const key = scopedKey(CHECKOUT_STATUS_PREFIX, authSessionKey);
    const raw = storage.getItem(key);
    if (!raw) return null;
    storage.removeItem(key);
    const stored = JSON.parse(raw) as { status?: string; createdAt?: number; authSessionKey?: string };
    const age = typeof stored.createdAt === 'number' ? now - stored.createdAt : Number.POSITIVE_INFINITY;
    const fresh = age >= -60_000 && age <= CHECKOUT_STATUS_TTL_MS;
    const status = stored.status ?? null;
    return fresh && stored.authSessionKey === authSessionKey && isCheckoutStatus(status) ? status : null;
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
      ? { packId: stored.packId, credits: stored.credits, balanceBefore: stored.balanceBefore }
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
      return { packId: stored.packId, credits: stored.credits, balanceBefore: stored.balanceBefore };
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

function rememberStatus(status: CheckoutStatus, authSessionKey: string): void {
  const storage = browserSessionStorage();
  if (!storage || !validAuthSessionKey(authSessionKey)) return;
  try {
    removeLegacyCheckoutState(storage);
    const key = scopedKey(CHECKOUT_STATUS_PREFIX, authSessionKey);
    const payload = JSON.stringify({ status, authSessionKey, createdAt: Date.now() });
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

export function consumeCheckoutStatus(authSessionKey: string): CheckoutStatus | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const status = url.searchParams.get('checkout');
  if (!isCheckoutStatus(status)) return takeStoredStatus(authSessionKey);

  url.searchParams.delete('checkout');
  url.searchParams.delete('session_id');
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, '', nextUrl || '/menu');
  if (status === 'cancelled') clearPendingCheckout(authSessionKey);
  rememberStatus(status, authSessionKey);
  return status;
}

export function expectedCheckoutBalance(pending: PendingCheckout | null): number | null {
  return pending && pending.balanceBefore !== null
    ? pending.balanceBefore + pending.credits
    : null;
}

export function checkoutStatusMessage(status: CheckoutStatus): string {
  return status === 'success'
    ? 'Checkout complete. Credits update after Stripe confirms payment.'
    : 'Checkout cancelled. No credits were charged.';
}
