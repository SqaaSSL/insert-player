import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertApprovedArcadeGenerationContract } from './seed-arcade-roster.mjs';

const PRODUCTION_WORKER_URL = 'https://api.insertplayer.ai';
const PREFLIGHT_PATH = '/api/internal/deploy/image-processor-contract';
const BRIDGE_HEADER = 'X-Insert-Player-Clerk-Backend-Auth';
const DEFAULT_ATTEMPTS = 30;
const DEFAULT_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;

function normalizedWorkerUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function assertProductionWorkerUrl(value) {
  const normalized = normalizedWorkerUrl(value);
  if (normalized !== PRODUCTION_WORKER_URL) {
    throw new Error(`Image processor deployment preflight is pinned to ${PRODUCTION_WORKER_URL}.`);
  }
  return normalized;
}

function safeReason(body, status) {
  const candidate = typeof body?.reason === 'string' ? body.reason : `http_${status}`;
  return candidate.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 80) || `http_${status}`;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function waitForCompatibleImageProcessor({
  workerUrl,
  bridgeSecret,
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
  request = fetch,
  wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
}) {
  const baseUrl = assertProductionWorkerUrl(workerUrl);
  const secret = String(bridgeSecret ?? '').trim();
  if (secret.length < 32) throw new Error('Image processor deployment preflight credential is invalid.');
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 60) {
    throw new Error('Image processor deployment preflight attempts must be between 1 and 60.');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
    throw new Error('Image processor deployment preflight interval is invalid.');
  }

  let lastReason = 'not_attempted';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await request(`${baseUrl}${PREFLIGHT_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          [BRIDGE_HEADER]: secret,
        },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      lastReason = 'network_error';
      if (attempt < attempts) await wait(intervalMs);
      continue;
    }

    const body = await responseJson(response);
    if (response.ok) {
      assertApprovedArcadeGenerationContract(body);
      console.log(`\u2713 compatible image processor contract verified on attempt ${attempt}`);
      return body;
    }

    lastReason = safeReason(body, response.status);
    const retryable = response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500;
    if (!retryable) {
      throw new Error(
        `Image processor deployment preflight was rejected (HTTP ${response.status}, ${lastReason}).`,
      );
    }
    console.log(`Image processor not ready (attempt ${attempt}/${attempts}, ${lastReason}).`);
    if (attempt < attempts) await wait(intervalMs);
  }

  throw new Error(
    `Compatible image processor did not become ready after ${attempts} attempts (${lastReason}).`,
  );
}

async function main() {
  await waitForCompatibleImageProcessor({
    workerUrl: process.env.ASF_WORKER_URL,
    bridgeSecret: process.env.CLERK_BACKEND_AUTH_BRIDGE_SECRET,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
