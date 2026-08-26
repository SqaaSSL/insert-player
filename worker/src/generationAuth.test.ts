import { describe, expect, it } from 'vitest';
import {
  generationCreationFlowFromAuth,
  generationJobIdFromAuth,
  mintGenerationJobToken,
  optionalGenerationJobAuth,
} from './generationAuth';
import type { Env, PublicAuthContext } from './types';

const JOB_ID = '11111111111111111111111111111111';
const SESSION_ID = '22222222222222222222222222222222';
const USER_ID = 'user-generation';

function fakeEnv(status = 'running', creationFlow: 'original' | 'video' = 'original'): Env {
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM generation_jobs')) {
                const [jobId, userId, providerSessionId] = values;
                if (jobId !== JOB_ID || userId !== USER_ID || providerSessionId !== SESSION_ID) {
                  return null;
                }
                return {
                  id: JOB_ID,
                  user_id: USER_ID,
                  provider_session_id: SESSION_ID,
                  status,
                  creation_flow: creationFlow,
                };
              }
              if (sql.includes('FROM users')) {
                return {
                  id: USER_ID,
                  clerk_user_id: 'clerk-generation',
                  display_name: 'Generation Player',
                };
              }
              return null;
            },
          };
        },
      };
    },
  };
  return {
    DB: database as unknown as D1Database,
    ENVIRONMENT: 'production',
    CORS_ORIGIN: 'https://insertplayer.ai',
    GENERATION_JOB_SIGNING_SECRET: 'test-generation-signing-secret-with-enough-entropy',
  } as Env;
}

async function token(env: Env, nowSeconds = 1_000): Promise<string> {
  return mintGenerationJobToken(env, {
    jobId: JOB_ID,
    userId: USER_ID,
    providerSessionId: SESSION_ID,
  }, nowSeconds);
}

function request(value: string): Request {
  return new Request('https://api.insertplayer.ai/proxy/gemini/v1beta/models/gemini-3-pro-image:generateContent', {
    headers: { Authorization: `Generation ${value}` },
  });
}

describe('generation job authorization', () => {
  it('accepts a valid active token and exposes only its scoped job', async () => {
    const env = fakeEnv();
    const result = await optionalGenerationJobAuth(request(await token(env)), env, 1_001);

    expect(result).not.toBeInstanceOf(Response);
    expect(result).not.toBeNull();
    const auth = result as PublicAuthContext;
    expect(auth.userId).toBe(USER_ID);
    expect(auth.rateLimitKey).toBe(`user:${USER_ID}`);
    expect(generationJobIdFromAuth(auth)).toBe(JOB_ID);
    expect(auth.claims?.generation_provider_session_id).toBe(SESSION_ID);
    expect(generationCreationFlowFromAuth(auth)).toBe('original');
  });

  it('binds an explicit video token to a video job', async () => {
    const env = fakeEnv('running', 'video');
    const videoToken = await mintGenerationJobToken(env, {
      jobId: JOB_ID,
      userId: USER_ID,
      providerSessionId: SESSION_ID,
      creationFlow: 'video',
    }, 1_000);
    const result = await optionalGenerationJobAuth(request(videoToken), env, 1_001);

    expect(result).not.toBeInstanceOf(Response);
    expect(generationCreationFlowFromAuth(result as PublicAuthContext)).toBe('video');

    const wrongFlow = await optionalGenerationJobAuth(
      request(await token(fakeEnv('running', 'video'))),
      fakeEnv('running', 'video'),
      1_001,
    );
    expect(wrongFlow).toBeInstanceOf(Response);
    expect((wrongFlow as Response).status).toBe(401);
  });

  it('rejects tampered, expired, and no-longer-active tokens', async () => {
    const env = fakeEnv();
    const valid = await token(env);
    const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`;

    const tamperedResult = await optionalGenerationJobAuth(request(tampered), env, 1_001);
    expect(tamperedResult).toBeInstanceOf(Response);
    expect((tamperedResult as Response).status).toBe(401);

    const expiredResult = await optionalGenerationJobAuth(request(valid), env, 8_200);
    expect(expiredResult).toBeInstanceOf(Response);
    expect((expiredResult as Response).status).toBe(401);
    expect(await (expiredResult as Response).json()).toEqual({
      error: 'Generation job authorization expired',
    });

    const inactiveResult = await optionalGenerationJobAuth(
      request(await token(fakeEnv('succeeded'))),
      fakeEnv('succeeded'),
      1_001,
    );
    expect(inactiveResult).toBeInstanceOf(Response);
    expect((inactiveResult as Response).status).toBe(401);
  });

  it('ignores requests that do not use the Generation scheme', async () => {
    const result = await optionalGenerationJobAuth(
      new Request('https://api.insertplayer.ai/proxy/gemini/test'),
      fakeEnv(),
    );
    expect(result).toBeNull();
  });
});
