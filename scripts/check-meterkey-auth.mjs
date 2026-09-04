import {
  meterkeyAuthExpectations,
  validateMeterkeyAnalyticsIdentity,
  validateMeterkeyApiKeyFingerprint,
} from './meterkey-auth-context.mjs';

const APPROVED_ORIGIN = 'https://meter.hilo.cx';
const key = process.env.METERKEY_API_KEY?.trim() ?? '';
const rawBaseUrl = process.env.METERKEY_BASE_URL?.trim() || APPROVED_ORIGIN;

if (!key) {
  console.error('Meterkey auth preflight failed: METERKEY_API_KEY is missing.');
  process.exit(1);
}

let baseUrl;
try {
  baseUrl = new URL(rawBaseUrl);
} catch {
  console.error('Meterkey auth preflight failed: METERKEY_BASE_URL is invalid.');
  process.exit(1);
}
if (
  baseUrl.origin !== APPROVED_ORIGIN
  || (baseUrl.pathname !== '/' && baseUrl.pathname !== '')
  || baseUrl.username
  || baseUrl.password
  || baseUrl.search
  || baseUrl.hash
) {
  console.error(`Meterkey auth preflight failed: base URL must be exactly ${APPROVED_ORIGIN}.`);
  process.exit(1);
}

let expectations;
try {
  expectations = meterkeyAuthExpectations();
  validateMeterkeyApiKeyFingerprint(key, expectations);
} catch {
  console.error('Meterkey auth preflight failed: the credential fingerprint does not match the approved key.');
  process.exit(1);
}

const analyticsUrl = new URL('/v1/analytics/summary', baseUrl);
analyticsUrl.searchParams.set('key_id', expectations.keyId);
analyticsUrl.searchParams.set('window', '7d');

const signal = AbortSignal.timeout(15_000);
let response;
try {
  response = await fetch(analyticsUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    signal,
  });
} catch (error) {
  const detail = signal.aborted ? 'request timed out' : 'request failed';
  console.error(`Meterkey auth preflight failed: ${detail}.`);
  process.exit(1);
}

if (response.status !== 200) {
  await response.body?.cancel().catch(() => {});
  console.error(`Meterkey auth preflight failed with HTTP ${response.status}.`);
  process.exit(1);
}

let analytics;
try {
  analytics = await response.json();
  validateMeterkeyAnalyticsIdentity(analytics, expectations);
} catch {
  console.error('Meterkey auth preflight failed: authenticated key or owner does not match the approved contract.');
  process.exit(1);
}

console.log('Meterkey auth preflight passed (exact credential and authenticated owner verified; no inference performed).');
