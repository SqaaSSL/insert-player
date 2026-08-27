import type { Env } from './types';

export const EXPECTED_WORKER_SHA_HEADER = 'X-Insert-Player-Expected-Worker-Sha';

function json(data: unknown, status: number): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function requireReviewedProductionWorkerPin(request: Request, env: Env): Response | null {
  if (env.ENVIRONMENT !== 'production') return null;
  const expectedSha = request.headers.get(EXPECTED_WORKER_SHA_HEADER)?.trim() ?? '';
  const deployedTag = env.WORKER_VERSION_METADATA?.tag?.trim() ?? '';
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) {
    return json({ error: 'The full expected production Worker SHA is required' }, 428);
  }
  const exactTag = new RegExp(`^prod-${expectedSha}-[1-9][0-9]*$`);
  if (!exactTag.test(deployedTag)) {
    return json({
      error: 'The request is pinned to a different production Worker deployment',
      code: 'reviewed_worker_version_mismatch',
    }, 409);
  }
  return null;
}

export function validateOptionalReviewedProductionWorkerPin(
  request: Request,
  env: Env,
): Response | null {
  if (!request.headers.has(EXPECTED_WORKER_SHA_HEADER)) return null;
  return requireReviewedProductionWorkerPin(request, env);
}
