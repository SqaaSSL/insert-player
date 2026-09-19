import { productChannelFromSearch, sanitizeProductEvent, type ProductChannel, type ProductEventName, type ProductEventProperties } from './ProductEventContract.ts';
export type { ProductEventName, ProductEventProperties } from './ProductEventContract.ts';
export interface ProductEvent { name: ProductEventName; at: number; properties: ProductEventProperties }
const KEY = 'ip:product-diagnostics:v1';
let pageChannel: ProductChannel | undefined;
let sentThisPage = 0;

function aggregateMeasurementAllowed(): boolean {
  if (typeof navigator === 'undefined') return false;
  const browser = navigator as Navigator & { globalPrivacyControl?: boolean };
  return browser.doNotTrack !== '1' && browser.globalPrivacyControl !== true;
}

function sendAggregateEvent(event: ProductEvent): void {
  const base = String(import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!base || !aggregateMeasurementAllowed() || sentThisPage >= 100) return;
  sentThisPage += 1;
  // No tokens, cookies, referrer, event timestamp, retry queue or visitor ID.
  // Delivery is best effort: analytics failure must not affect a game or purchase.
  try {
    void fetch(`${base}/api/product-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: event.name, properties: event.properties }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    }).catch(() => {});
  } catch { /* Unavailable fetch is harmless. */ }
}

/** Local diagnostics plus first-party anonymous daily counts; no user/session IDs. */
export function trackProductEvent(name: ProductEventName, properties: ProductEventProperties = {}): void {
  if (typeof window === 'undefined') return;
  pageChannel ??= productChannelFromSearch(window.location?.search ?? '');
  const sanitized = sanitizeProductEvent({ name, properties: { channel: pageChannel, ...properties } });
  if (!sanitized) return;
  const event: ProductEvent = { ...sanitized, at: Date.now() };
  try {
    const previous: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    const events = Array.isArray(previous) ? previous.slice(-199) : [];
    localStorage.setItem(KEY, JSON.stringify([...events, event]));
  } catch { /* Diagnostics must never interrupt gameplay or purchases. */ }
  sendAggregateEvent(event);
}

export function readProductEvents(): ProductEvent[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.slice(-200) : [];
  } catch { return []; }
}
