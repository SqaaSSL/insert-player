export type CheckoutStatus = 'success' | 'cancelled';

const CHECKOUT_STATUS_KEY = 'ai-street-fighter:checkout-status';
const CHECKOUT_PENDING_KEY = 'ai-street-fighter:pending-checkout';
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

function isPendingCheckout(value: unknown): value is PendingCheckout {
  if (!value || typeof value !== 'object') return false;
  const pending = value as Partial<PendingCheckout>;
  return Boolean(
    typeof pending.packId === 'string' &&
    typeof pending.credits === 'number' &&
    Number.isFinite(pending.credits) &&
    (pending.balanceBefore === null || typeof pending.balanceBefore === 'number'),
  );
}

function takeStoredStatus(): CheckoutStatus | null {
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_STATUS_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(CHECKOUT_STATUS_KEY);
    const stored = JSON.parse(raw) as { status?: string; createdAt?: number };
    const fresh = typeof stored.createdAt === 'number' && Date.now() - stored.createdAt <= CHECKOUT_STATUS_TTL_MS;
    const status = stored.status ?? null;
    return fresh && isCheckoutStatus(status) ? status : null;
  } catch {
    return null;
  }
}

export function rememberPendingCheckout(pending: PendingCheckout): void {
  try {
    window.sessionStorage.setItem(
      CHECKOUT_PENDING_KEY,
      JSON.stringify({ ...pending, createdAt: Date.now() }),
    );
  } catch {
    // best effort only
  }
}

export function consumePendingCheckout(): PendingCheckout | null {
  try {
    const raw = window.sessionStorage.getItem(CHECKOUT_PENDING_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(CHECKOUT_PENDING_KEY);
    const stored = JSON.parse(raw) as PendingCheckout & { createdAt?: number };
    const fresh = typeof stored.createdAt === 'number' && Date.now() - stored.createdAt <= CHECKOUT_PENDING_TTL_MS;
    return fresh && isPendingCheckout(stored)
      ? { packId: stored.packId, credits: stored.credits, balanceBefore: stored.balanceBefore }
      : null;
  } catch {
    return null;
  }
}

export function clearPendingCheckout(): void {
  try {
    window.sessionStorage.removeItem(CHECKOUT_PENDING_KEY);
  } catch {
    // best effort only
  }
}

function rememberStatus(status: CheckoutStatus): void {
  try {
    const payload = JSON.stringify({ status, createdAt: Date.now() });
    window.sessionStorage.setItem(CHECKOUT_STATUS_KEY, payload);
    window.setTimeout(() => {
      try {
        if (window.sessionStorage.getItem(CHECKOUT_STATUS_KEY) === payload) {
          window.sessionStorage.removeItem(CHECKOUT_STATUS_KEY);
        }
      } catch {
        // best effort only
      }
    }, CHECKOUT_STATUS_TTL_MS);
  } catch {
    // best effort only
  }
}

export function consumeCheckoutStatus(): CheckoutStatus | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const status = url.searchParams.get('checkout');
  if (!isCheckoutStatus(status)) return takeStoredStatus();

  url.searchParams.delete('checkout');
  url.searchParams.delete('session_id');
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, '', nextUrl || '/menu');
  if (status === 'cancelled') clearPendingCheckout();
  rememberStatus(status);
  return status;
}

export function checkoutStatusMessage(status: CheckoutStatus): string {
  return status === 'success'
    ? 'Checkout complete. Credits update after Stripe confirms payment.'
    : 'Checkout cancelled. No credits were charged.';
}
