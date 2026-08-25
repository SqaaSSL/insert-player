import { describe, expect, it } from 'vitest';
import {
  meterkeyAuthExpectations,
  validateMeterkeyAuthContext,
} from './meterkey-auth-context.mjs';

const expected = {
  keyId: 'mk_key_insert_player',
  userId: 'mk_usr_insert_player',
  walletId: 'mk_wal_insert_player',
  minimumAvailableUc: 100_000_000,
  perRequestCapUc: 5_000_000,
};

const approvedScope = {
  providers: ['fal', 'google-ai-studio'],
  models: [
    'bytedance/seedream/v5/pro/edit',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.1-flash-image',
    'gemini-3-pro-image',
    'xai/grok-imagine-image/v2.0/edit',
  ],
  endpoints: ['/fal/*', '/fal', '/v1/chat/completions', '/google-ai-studio/v1beta/models/*'],
  block_streaming: true,
  block_websocket: true,
  per_request_cap_uc: 5_000_000,
};

function validContext() {
  return {
    object: 'auth_context',
    key_id: expected.keyId,
    user_id: expected.userId,
    wallet_id: expected.walletId,
    environment: 'prod',
    plan_id: 'free',
    status: 'active',
    scope: structuredClone(approvedScope),
    balances: {
      available_uc: 1_000_000_000,
      reserved_uc: 0,
    },
    available_uc: 1_000_000_000,
  };
}

describe('Meterkey Insert Player auth contract', () => {
  it('accepts the exact dedicated production key, scope, wallet, and limits', () => {
    expect(() => validateMeterkeyAuthContext(validContext(), expected)).not.toThrow();
  });

  it('loads every required expectation from explicit deployment variables', () => {
    expect(meterkeyAuthExpectations({
      ASF_METERKEY_EXPECTED_KEY_ID: expected.keyId,
      ASF_METERKEY_EXPECTED_USER_ID: expected.userId,
      ASF_METERKEY_EXPECTED_WALLET_ID: expected.walletId,
      ASF_METERKEY_MIN_AVAILABLE_UC: String(expected.minimumAvailableUc),
      ASF_METERKEY_EXPECTED_PER_REQUEST_CAP_UC: String(expected.perRequestCapUc),
    })).toEqual(expected);
    expect(() => meterkeyAuthExpectations({})).toThrow('ASF_METERKEY_EXPECTED_KEY_ID');
  });

  it.each([
    ['key id', (context: ReturnType<typeof validContext>) => { context.key_id = 'mk_key_other'; }],
    ['user id', (context: ReturnType<typeof validContext>) => { context.user_id = 'mk_usr_other'; }],
    ['wallet id', (context: ReturnType<typeof validContext>) => { context.wallet_id = 'mk_wal_other'; }],
    ['environment', (context: ReturnType<typeof validContext>) => { context.environment = 'test'; }],
    ['status', (context: ReturnType<typeof validContext>) => { context.status = 'inactive'; }],
    ['per-request cap', (context: ReturnType<typeof validContext>) => { context.scope.per_request_cap_uc = 4_999_999; }],
    ['wallet reservation', (context: ReturnType<typeof validContext>) => { context.balances.reserved_uc = 1; }],
    ['wallet floor', (context: ReturnType<typeof validContext>) => { context.available_uc = expected.minimumAvailableUc - 1; }],
  ])('rejects a mismatched %s', (_label, mutate) => {
    const context = validContext();
    mutate(context);
    expect(() => validateMeterkeyAuthContext(context, expected)).toThrow();
  });

  it.each([
    ['provider', (context: ReturnType<typeof validContext>) => { context.scope.providers.push('openrouter'); }],
    ['model', (context: ReturnType<typeof validContext>) => { context.scope.models.push('unapproved-model'); }],
    ['endpoint', (context: ReturnType<typeof validContext>) => { context.scope.endpoints.push('*'); }],
    ['scope control', (context: ReturnType<typeof validContext>) => {
      (context.scope as Record<string, unknown>).daily_cap_uc = 10_000_000;
    }],
  ])('rejects an additional %s outside the approved contract', (_label, mutate) => {
    const context = validContext();
    mutate(context);
    expect(() => validateMeterkeyAuthContext(context, expected)).toThrow();
  });

  it('rejects a FAL-only key and a key missing any approved model', () => {
    const falOnly = validContext();
    falOnly.scope.providers = ['fal'];
    expect(() => validateMeterkeyAuthContext(falOnly, expected)).toThrow();

    for (const model of approvedScope.models) {
      const missingModel = validContext();
      missingModel.scope.models = missingModel.scope.models.filter((candidate) => candidate !== model);
      expect(() => validateMeterkeyAuthContext(missingModel, expected)).toThrow();
    }
  });
});
