import {
  meterkeyAuthExpectations,
  validateMeterkeyAuthContext,
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

const signal = AbortSignal.timeout(15_000);
let response;
try {
  response = await fetch(new URL('/v1/auth/context', baseUrl), {
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

let context;
try {
  context = await response.json();
  validateMeterkeyAuthContext(context, meterkeyAuthExpectations());
} catch {
  console.error('Meterkey auth preflight failed: key scope, wallet, or limits do not match the approved contract.');
  process.exit(1);
}

console.log('Meterkey auth preflight passed (dedicated scope and wallet verified; no inference performed).');
