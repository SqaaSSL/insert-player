import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const expected = {
  rookie: {
    label: 'Rookie',
    creditCost: 2,
    animationRetryCreditCost: 1,
    priceLabel: '2 credits',
    estimatedUsdCost: 1.43,
    pipeline: 'sheet',
    model: 'flash',
    animationBgRemoval: 'chroma',
    spriteMode: 'sheet',
    geminiAnimModelOverride: 'gemini-3.1-flash-image',
    enableDnnBgRemoval: false,
  },
  contender: {
    label: 'Contender',
    creditCost: 11,
    animationRetryCreditCost: 2,
    priceLabel: '11 credits',
    estimatedUsdCost: 7.88,
    pipeline: 'sheet_refined',
    model: 'flash',
    animationBgRemoval: 'birefnet',
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3.1-flash-image',
    enableDnnBgRemoval: true,
  },
  champion: {
    label: 'Champion',
    creditCost: 18,
    animationRetryCreditCost: 4,
    priceLabel: '18 credits',
    estimatedUsdCost: 12.64,
    pipeline: 'sheet_refined',
    model: 'pro',
    animationBgRemoval: 'birefnet',
    spriteMode: 'sheet_refined',
    geminiAnimModelOverride: 'gemini-3-pro-image',
    enableDnnBgRemoval: true,
  },
};

const expectedPacks = {
  starter: { credits: 11, amountCents: 1499, currency: 'eur' },
  versus: { credits: 20, amountCents: 2499, currency: 'eur' },
  arcade: { credits: 47, amountCents: 5699, currency: 'eur' },
};
const retryEconomics = {
  source: { credits: 1, conservativeUsdCost: 0.75 },
  rookie: { credits: 1, conservativeUsdCost: 0.50 },
  contender: { credits: 2, conservativeUsdCost: 1.00 },
  champion: { credits: 4, conservativeUsdCost: 2.64 },
};
const CLEAN_COVERAGE_FLOOR = 1.30;
const RETRY_COVERAGE_FLOOR = 1.25;
const OBSERVED_QA_COVERAGE_FLOOR = 1.10;
const SPAIN_VAT_RATE = 0.21;
const STRIPE_EEA_CARD_RATE = 0.015;
const STRIPE_FIXED_FEE_EUR = 0.25;
const STRIPE_TAX_RATE = 0.005;

const sourceModelKeys = [
  'VITE_GEMINI_IMAGE_MODEL_REPOSE',
  'VITE_GEMINI_IMAGE_MODEL_UPRIGHT',
  'VITE_GEMINI_IMAGE_MODEL_CROUCH',
];
const forbiddenAnimationModelKeys = [
  'VITE_GEMINI_IMAGE_MODEL_SPRITE',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_IDLE',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_WALK',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_HIGH_PUNCH',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_LOW_PUNCH',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_HIGH_KICK',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_LOW_KICK',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_JUMP',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_CROUCH',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_HIT',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_KO',
  'VITE_GEMINI_IMAGE_MODEL_ANIM_VICTORY',
];

const errors = [];

function fail(message) {
  errors.push(message);
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function extractBalancedObject(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${marker}`);
  const start = text.indexOf('{', markerIndex);
  if (start < 0) throw new Error(`Could not find object start for ${marker}`);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find object end for ${marker}`);
}

function sliceBalancedObjectFrom(text, start) {
  if (start < 0 || text[start] !== '{') throw new Error('Balanced object slice must start on an object');
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('Could not find balanced object end');
}

function extractRecordTierBlock(recordText, tier) {
  return extractBalancedObject(recordText, `${tier}:`);
}

function extractFrontendTierBlock(listText, tier) {
  const marker = `id: '${tier}'`;
  const markerIndex = listText.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${marker}`);
  return sliceBalancedObjectFrom(listText, listText.lastIndexOf('{', markerIndex));
}

function readString(block, key) {
  const match = block.match(new RegExp(`${key}:\\s*'([^']+)'`));
  return match?.[1] ?? null;
}

function readNumber(block, key) {
  const match = block.match(new RegExp(`${key}:\\s*([0-9]+(?:\\.[0-9]+)?)`));
  return match ? Number(match[1]) : null;
}

function readBoolean(block, key) {
  const match = block.match(new RegExp(`${key}:\\s*(true|false)`));
  return match ? match[1] === 'true' : null;
}

function assertEqual(actual, expectedValue, label) {
  if (actual !== expectedValue) {
    fail(`${label} expected ${String(expectedValue)}, got ${String(actual ?? 'missing')}`);
  }
}

function assertApprox(actual, expectedValue, label) {
  if (typeof actual !== 'number' || Math.abs(actual - expectedValue) > 0.001) {
    fail(`${label} expected ${expectedValue}, got ${String(actual ?? 'missing')}`);
  }
}

const frontendTiers = read('src/services/QualityTiers.ts');
const workerTiers = read('worker/src/tiers.ts');
const workerBilling = read('worker/src/billing.ts');
const workerFighters = read('worker/src/fighters.ts');
const pipeline = read('src/services/CharacterPipeline.ts');
const gemini = read('src/services/GeminiApi.ts');
const envExample = read('.env.example');
const envProductionExample = read('.env.production.example');
const readiness = read('PRODUCTION_READINESS.md');
const providerSessions = read('worker/src/providerSessions.ts');
const providerCostEventsMigration = read('worker/migrations/0017_provider_cost_events.sql');
const rateLimits = read('worker/src/rateLimit.ts');
const fightScene = read('src/game/scenes/FightScene.ts');
const productionWrangler = read('worker/wrangler.toml');
const sandboxWrangler = read('worker/wrangler.sandbox.toml');

const workerTierRecord = extractBalancedObject(workerTiers, 'TIER_DEFINITIONS');
const workerPackRecord = extractBalancedObject(workerBilling, 'CREDIT_PACKS');
const pipelineTierRecord = extractBalancedObject(pipeline, 'TIER_CONFIGS');

for (const [tier, definition] of Object.entries(expected)) {
  const frontendBlock = extractFrontendTierBlock(frontendTiers, tier);
  const workerBlock = extractRecordTierBlock(workerTierRecord, tier);
  const pipelineBlock = extractRecordTierBlock(pipelineTierRecord, tier);

  assertEqual(readString(frontendBlock, 'label'), definition.label, `frontend ${tier} label`);
  assertEqual(readString(frontendBlock, 'priceLabel'), definition.priceLabel, `frontend ${tier} priceLabel`);
  assertEqual(readNumber(frontendBlock, 'creditCost'), definition.creditCost, `frontend ${tier} creditCost`);
  assertEqual(
    readNumber(frontendBlock, 'animationRetryCreditCost'),
    definition.animationRetryCreditCost,
    `frontend ${tier} animation retry creditCost`,
  );

  assertEqual(readString(workerBlock, 'label'), definition.label, `Worker ${tier} label`);
  assertEqual(readNumber(workerBlock, 'creditCost'), definition.creditCost, `Worker ${tier} creditCost`);
  assertEqual(
    readNumber(workerBlock, 'animationRetryCreditCost'),
    definition.animationRetryCreditCost,
    `Worker ${tier} animation retry creditCost`,
  );
  assertApprox(readNumber(workerBlock, 'estimatedUsdCost'), definition.estimatedUsdCost, `Worker ${tier} estimatedUsdCost`);
  assertEqual(readString(workerBlock, 'pipeline'), definition.pipeline, `Worker ${tier} pipeline`);
  assertEqual(readString(workerBlock, 'model'), definition.model, `Worker ${tier} model`);
  assertEqual(readString(workerBlock, 'animationBgRemoval'), definition.animationBgRemoval, `Worker ${tier} animationBgRemoval`);

  assertEqual(readString(pipelineBlock, 'spriteMode'), definition.spriteMode, `pipeline ${tier} spriteMode`);
  assertEqual(
    readString(pipelineBlock, 'geminiAnimModelOverride'),
    definition.geminiAnimModelOverride,
    `pipeline ${tier} Gemini animation model`,
  );
  assertEqual(
    readBoolean(pipelineBlock, 'enableDnnBgRemoval'),
    definition.enableDnnBgRemoval,
    `pipeline ${tier} DNN background removal`,
  );
}

const netEurPerCredit = [];
function netPackRevenueEur(amountCents) {
  const gross = amountCents / 100;
  return (
    gross / (1 + SPAIN_VAT_RATE) -
    gross * STRIPE_EEA_CARD_RATE -
    STRIPE_FIXED_FEE_EUR -
    gross * STRIPE_TAX_RATE
  );
}

for (const [pack, definition] of Object.entries(expectedPacks)) {
  const block = extractRecordTierBlock(workerPackRecord, pack);
  const credits = readNumber(block, 'credits');
  const amountCents = readNumber(block, 'amountCents');
  assertEqual(credits, definition.credits, `Worker ${pack} pack credits`);
  assertEqual(amountCents, definition.amountCents, `Worker ${pack} pack amount`);
  assertEqual(readString(block, 'currency'), definition.currency, `Worker ${pack} pack currency`);
  if (typeof credits === 'number' && credits > 0 && typeof amountCents === 'number') {
    netEurPerCredit.push(netPackRevenueEur(amountCents) / credits);
  }
}

assertEqual(expectedPacks.starter.credits, expected.contender.creditCost, 'Starter buys one Contender');
assertEqual(
  expectedPacks.versus.credits,
  expected.champion.creditCost + expected.rookie.creditCost,
  'Versus buys one Champion plus one Rookie',
);
assertEqual(
  expectedPacks.arcade.credits,
  2 * expected.champion.creditCost + expected.contender.creditCost,
  'Arcade buys two Champions plus one Contender',
);

const conservativeNetEurPerCredit = Math.min(...netEurPerCredit);
for (const [tier, definition] of Object.entries(expected)) {
  const conservativeNetRevenue = conservativeNetEurPerCredit * definition.creditCost;
  const coverage = conservativeNetRevenue / definition.estimatedUsdCost;
  if (coverage < CLEAN_COVERAGE_FLOOR) {
    fail(
      `${tier} pricing covers ${coverage.toFixed(2)}x estimated provider cost; ` +
      `the launch floor is ${CLEAN_COVERAGE_FLOOR.toFixed(2)}x after VAT, Stripe card fees, ` +
      'Stripe Tax, and net EUR treated as USD at parity',
    );
  }
}

for (const [operation, definition] of Object.entries(retryEconomics)) {
  const coverage = conservativeNetEurPerCredit * definition.credits / definition.conservativeUsdCost;
  if (coverage < RETRY_COVERAGE_FLOOR) {
    fail(
      `${operation} retry pricing covers ${coverage.toFixed(2)}x conservative provider cost; ` +
      `the retry floor is ${RETRY_COVERAGE_FLOOR.toFixed(2)}x`,
    );
  }
}

if (!frontendTiers.includes('export const SOURCE_RETRY_CREDIT_COST = 1;') ||
    !workerTiers.includes('export const SOURCE_RETRY_CREDIT_COST = 1;')) {
  fail('Source retry pricing must remain one credit in both frontend and Worker definitions.');
}

// This is the actual 2026-08-18 QA sequence: one free Rookie, a Contender
// upgrade, two refunded Champion failures, one completed Champion, two
// Champion animation retries, and the measured stage call.
const observedQaProviderCostUsd = 32.64;
const observedQaPaidCredits = 11 + 18 + 4 + 4;
const observedQaCoverage = conservativeNetEurPerCredit * observedQaPaidCredits / observedQaProviderCostUsd;
if (observedQaCoverage < OBSERVED_QA_COVERAGE_FLOOR) {
  fail(
    `Measured failure-heavy QA sequence covers only ${observedQaCoverage.toFixed(2)}x provider spend; ` +
    `the floor is ${OBSERVED_QA_COVERAGE_FLOOR.toFixed(2)}x`,
  );
}

for (const required of [
  'provider_cost_used_cents',
  'provider_cost_limit_cents',
  'provider_spend_months',
  'PROVIDER_MONTHLY_BUDGET_USD_CENTS',
  'provider_monthly_budget_exhausted',
  'provider_cost_events',
  'billing_operation',
]) {
  if (!`${providerSessions}\n${providerCostEventsMigration}\n${productionWrangler}\n${sandboxWrangler}`.includes(required)) {
    fail(`Profitable pricing is missing provider spend accounting/control: ${required}`);
  }
}

for (const [source, required, label] of [
  [providerSessions, 'stage_background: 1', 'one-call AI stage provider session'],
  [providerSessions, 'stage_background: 10', 'AI stage provider cost ceiling'],
  [rateLimits, "'provider:session:stage_background'", 'purpose-specific AI stage rate limit'],
  [rateLimits, 'signedIn: { limit: 5, windowSeconds: 24 * 60 * 60 }', 'daily AI stage account limit'],
  [fightScene, 'const cacheScope = "stage";', 'per-theme AI stage cache'],
  [fightScene, 'beforeFirstExchangeOnly', 'no mid-round AI stage replacement'],
]) {
  if (!source.includes(required)) {
    fail(`Bounded gameplay extras are missing ${label}: ${required}`);
  }
}

const tiersResponseBlock = workerFighters.slice(
  workerFighters.indexOf('export function tiersResponse'),
  workerFighters.indexOf('export async function listFighters'),
);
if (tiersResponseBlock.includes('estimatedUsdCost')) {
  fail('/api/tiers must not expose internal provider cost estimates');
}

const combinedEnvDocs = `${envExample}\n${envProductionExample}\n${readiness}`;
for (const key of sourceModelKeys) {
  const matches = [...combinedEnvDocs.matchAll(new RegExp(`${key}=([^\\s#]+)`, 'g'))].map((match) => match[1]);
  if (matches.length === 0) {
    fail(`${key} is missing from source-view production docs/env examples`);
    continue;
  }
  for (const value of matches) {
    if (!/pro/i.test(value)) fail(`${key} must stay on a Pro source-view model, got ${value}`);
  }
}

for (const key of forbiddenAnimationModelKeys) {
  if (combinedEnvDocs.includes(key)) {
    fail(`${key} must not be documented as a production override; animation models are tier-controlled`);
  }
}

if (!gemini.includes("if (options?.modelOverride && (options.operation === 'sprite' || options.animationName))")) {
  fail('Gemini animation model overrides must stay explicit and scoped to sprite operations.');
}

if (!gemini.includes("!value.toLowerCase().includes('pro')") || !gemini.includes('DEFAULT_GEMINI_SOURCE_MODEL')) {
  fail('Gemini source views must fail closed to a Pro model when env configuration is invalid.');
}

if (gemini.includes('runtimeAnimModelOverride') || gemini.includes('setGeminiAnimModelOverride')) {
  fail('Gemini animation model selection must not use mutable global state.');
}

for (const required of [
  "const scaffoldModel = renderModel.toLowerCase().includes('pro')",
  '? DEFAULT_GEMINI_IMAGE_MODEL',
  ': renderModel',
  "if (renderModel.toLowerCase().includes('pro'))",
]) {
  if (!gemini.includes(required)) {
    fail(`Champion generation must keep a Flash scaffold and Pro final-frame renderer: ${required}`);
  }
}

if (errors.length > 0) {
  console.error(`Tier parity checks failed:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

console.log('Tier parity checks passed.');
