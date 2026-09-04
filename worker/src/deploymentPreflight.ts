import { hasValidClerkBackendAuthBridge } from './auth';
import { readImageProcessorGenerationContract } from './arcadeGeneration';
import type { Env } from './types';

function json(data: unknown, status: number): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Machine-only, read-only deployment probe. It deliberately does not create a
 * Clerk session: production delivery must not depend on a human browser session.
 */
export async function readDeploymentImageProcessorContract(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!(await hasValidClerkBackendAuthBridge(request, env))) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return noStore(await readImageProcessorGenerationContract(env));
}
