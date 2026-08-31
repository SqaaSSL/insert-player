// Meterkey is an internal platform shared with other products. Its key may gain
// explicit models without changing Insert Player's runtime permissions: the
// Worker still authorizes every provider operation and model separately.
const REQUIRED_PROVIDERS = ['fal', 'google-ai-studio'];
const REQUIRED_MODELS = [
  'bytedance/seedream/v5/pro/edit',
  'fal-ai/lyria3/pro',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-tts-preview',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'xai/grok-imagine-image/v2.0/edit',
  'xai/grok-imagine-video/v1.5/image-to-video',
];
const REQUIRED_ENDPOINTS = [
  '/fal',
  '/fal/*',
  '/google-ai-studio/v1beta/models/*',
  '/v1/chat/completions',
];

function requiredString(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

function sortedStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return [...value].sort();
}

function requireExactStrings(value, required, label) {
  const actual = sortedStrings(value, label);
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} does not match the approved Insert Player contract.`);
  }
  return actual;
}

export function meterkeyAuthExpectations(env = process.env) {
  return {
    keyId: requiredString(env.ASF_METERKEY_EXPECTED_KEY_ID, 'ASF_METERKEY_EXPECTED_KEY_ID'),
    userId: requiredString(env.ASF_METERKEY_EXPECTED_USER_ID, 'ASF_METERKEY_EXPECTED_USER_ID'),
    walletId: requiredString(env.ASF_METERKEY_EXPECTED_WALLET_ID, 'ASF_METERKEY_EXPECTED_WALLET_ID'),
    minimumAvailableUc: requiredInteger(
      env.ASF_METERKEY_MIN_AVAILABLE_UC,
      'ASF_METERKEY_MIN_AVAILABLE_UC',
    ),
    perRequestCapUc: requiredInteger(
      env.ASF_METERKEY_EXPECTED_PER_REQUEST_CAP_UC,
      'ASF_METERKEY_EXPECTED_PER_REQUEST_CAP_UC',
    ),
  };
}

export function validateMeterkeyAuthContext(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Meterkey auth context must be a JSON object.');
  }
  if (value.key_id !== expected.keyId) throw new Error('Meterkey key id is not the dedicated Insert Player key.');
  if (value.user_id !== expected.userId) throw new Error('Meterkey user id is not the dedicated Insert Player user.');
  if (value.wallet_id !== expected.walletId) throw new Error('Meterkey wallet id is not the dedicated Insert Player wallet.');
  if (value.environment !== 'prod') throw new Error('Meterkey key is not a production credential.');
  if (value.status !== 'active') throw new Error('Meterkey user is not active.');
  if (!value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)) {
    throw new Error('Meterkey scope is missing.');
  }
  requireExactStrings(value.scope.providers, REQUIRED_PROVIDERS, 'Meterkey providers');
  const scopedModels = sortedStrings(value.scope.models, 'Meterkey models');
  if (new Set(scopedModels).size !== scopedModels.length) {
    throw new Error('Meterkey models contain duplicates.');
  }
  if (scopedModels.some((model) => !model.trim() || model.includes('*'))) {
    throw new Error('Meterkey models must be explicit model ids.');
  }
  for (const model of REQUIRED_MODELS) {
    if (!scopedModels.includes(model)) {
      throw new Error(`Meterkey scope is missing required model ${model}.`);
    }
  }
  requireExactStrings(value.scope.endpoints, REQUIRED_ENDPOINTS, 'Meterkey endpoints');
  if (value.scope.block_streaming !== true) {
    throw new Error('Meterkey streaming policy is not fail-closed.');
  }
  if (value.scope.block_websocket !== true) {
    throw new Error('Meterkey websocket policy is not fail-closed.');
  }
  if (value.scope.per_request_cap_uc !== expected.perRequestCapUc) {
    throw new Error('Meterkey per-request cap does not match the approved limit.');
  }
  if (!value.balances || typeof value.balances !== 'object' || Array.isArray(value.balances)) {
    throw new Error('Meterkey wallet balances are missing.');
  }
  if (value.balances.reserved_uc !== 0) {
    throw new Error('Meterkey wallet has an active reservation; rollout requires an idle wallet.');
  }
  if (!Number.isSafeInteger(value.available_uc) || value.available_uc < expected.minimumAvailableUc) {
    throw new Error('Meterkey wallet available balance is below the production floor.');
  }
}
