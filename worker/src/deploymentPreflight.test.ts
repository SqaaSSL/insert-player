import { beforeEach, describe, expect, it, vi } from 'vitest';

const arcadeGeneration = vi.hoisted(() => ({
  readImageProcessorGenerationContract: vi.fn(),
}));

vi.mock('./arcadeGeneration', () => arcadeGeneration);

import { readDeploymentImageProcessorContract } from './deploymentPreflight';
import type { Env } from './types';

const BRIDGE_SECRET = 'deployment-preflight-bridge-secret-long-enough';
const env = {
  CLERK_BACKEND_AUTH_BRIDGE_SECRET: BRIDGE_SECRET,
} as unknown as Env;

function request(bridge?: string): Request {
  return new Request('https://api.insertplayer.ai/api/internal/deploy/image-processor-contract', {
    headers: bridge
      ? { 'X-Insert-Player-Clerk-Backend-Auth': bridge }
      : {},
  });
}

beforeEach(() => {
  arcadeGeneration.readImageProcessorGenerationContract.mockReset();
});

describe('deployment image processor preflight', () => {
  it.each([undefined, `${BRIDGE_SECRET}-wrong`])(
    'rejects a missing or invalid machine credential',
    async (bridge) => {
      const response = await readDeploymentImageProcessorContract(request(bridge), env);
      expect(response.status).toBe(401);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(arcadeGeneration.readImageProcessorGenerationContract).not.toHaveBeenCalled();
    },
  );

  it('returns the deployed processor contract with a valid machine credential', async () => {
    arcadeGeneration.readImageProcessorGenerationContract.mockResolvedValue(Response.json({ ready: true }));
    const response = await readDeploymentImageProcessorContract(request(BRIDGE_SECRET), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ready: true });
    expect(arcadeGeneration.readImageProcessorGenerationContract).toHaveBeenCalledOnce();
    expect(arcadeGeneration.readImageProcessorGenerationContract).toHaveBeenCalledWith(env);
  });
});
