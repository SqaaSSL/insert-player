#!/usr/bin/env node

import { createHmac } from 'node:crypto';

const USER_ID = 'mk_usr_P47kwJ4xFO6ahsEkHmT8';
const KEY_ID = 'mk_key_5fHQP8UDzxXdNFbXKdsH';
const REQUIRED_MODELS = [
  'fal-ai/lyria3/pro',
  'gemini-3.1-flash-tts-preview',
];

const apply = process.argv.includes('--apply');
const baseUrl = (process.env.METERKEY_BASE_URL ?? 'https://meter.hilo.cx').replace(/\/$/, '');
const hmacSecret = process.env.METERKEY_HMAC_SECRET
  ?? process.env.METERKEY_INTERNAL_HMAC_SECRET
  ?? process.env.INTERNAL_HMAC_SECRET;

if (!hmacSecret) {
  throw new Error('Meterkey admin HMAC secret is not available in this environment');
}

const keysResponse = await adminRequest(
  `/admin/v1/users/${encodeURIComponent(USER_ID)}/keys`,
  undefined,
  'GET',
);
const key = keysResponse.keys?.find((candidate) => candidate.id === KEY_ID);

if (!key) {
  throw new Error(`Meterkey key ${KEY_ID} was not found for ${USER_ID}`);
}
if (key.status !== 'active') {
  throw new Error(`Refusing to update a non-active Meterkey key (${key.status})`);
}

const currentModels = Array.isArray(key.scope?.models) ? key.scope.models : [];
const nextModels = [...new Set([...currentModels, ...REQUIRED_MODELS])].sort();
const addedModels = nextModels.filter((model) => !currentModels.includes(model));

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  keyId: KEY_ID,
  currentModels: [...currentModels].sort(),
  addedModels,
  preservedScopeFields: Object.keys(key.scope ?? {}).filter((field) => field !== 'models').sort(),
}, null, 2));

if (!apply || addedModels.length === 0) {
  process.exit(0);
}

const result = await adminRequest(
  `/admin/v1/users/${encodeURIComponent(USER_ID)}/keys/${encodeURIComponent(KEY_ID)}`,
  {
    scope: { ...key.scope, models: nextModels },
    idempotency_key: 'insert-player:creative-media-models:v1',
  },
  'PATCH',
);

for (const model of REQUIRED_MODELS) {
  if (!result.scope?.models?.includes(model)) {
    throw new Error(`Meterkey did not persist required model ${model}`);
  }
}

console.log(JSON.stringify({
  updated: true,
  keyId: result.key_id,
  addedModels,
  modelCount: result.scope.models.length,
}, null, 2));

async function adminRequest(path, body, method) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', hmacSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-meterkey-timestamp': String(timestamp),
      'x-meterkey-signature': `v1=${signature}`,
    },
    body: body === undefined ? undefined : rawBody,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${responseText.slice(0, 300)}`);
  }
  return responseText ? JSON.parse(responseText) : null;
}
