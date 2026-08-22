const workerUrl = (
  process.env.ASF_SANDBOX_WORKER_URL ||
  'https://insert-player-api-sandbox.shellbot.workers.dev'
).replace(/\/+$/, '');
const sandboxOrigin = (
  process.env.ASF_SANDBOX_FRONTEND_URL ||
  'https://insert-player-sandbox.pages.dev'
).replace(/\/+$/, '');
const productionOrigin = 'https://insertplayer.ai';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fetchJson(label, path, origin = sandboxOrigin, options = {}) {
  const response = await fetch(`${workerUrl}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Origin: origin,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  return { response, body };
}

async function main() {
  assert(/^https:\/\//.test(workerUrl), 'Sandbox Worker URL must be HTTPS.');
  assert(!workerUrl.includes('api.insertplayer.ai'), 'Sandbox smoke refuses the production API origin.');

  const health = await fetchJson('sandbox health', `/health?smoke=${Date.now()}`);
  assert(health.response.ok, `Sandbox health returned HTTP ${health.response.status}.`);
  assert(health.body.status === 'ok', 'Sandbox health did not report status=ok.');
  assert(health.body.version === '0.17.0', `Expected Worker 0.17.0, got ${health.body.version}.`);
  assert(health.body.environment === 'sandbox', `Expected sandbox environment, got ${health.body.environment}.`);
  assert(health.body.storage?.d1 === 'bound' && health.body.storage?.r2 === 'bound', 'Sandbox D1/R2 bindings are not healthy.');
  assert(health.body.privacy === 'pseudonymized', 'Sandbox anonymous identifiers are not pseudonymized.');
  assert(health.body.providers === 'configured', 'Sandbox provider secrets are incomplete.');
  assert(health.body.providerBudget === 'configured', 'Sandbox provider spend ceiling is missing.');
  assert(health.body.providerSpendRate === 'configured', 'Sandbox Gemini rolling spend-rate guard is missing.');
  assert(health.body.durableGeneration === 'configured', 'Sandbox durable generation bindings or signing are incomplete.');
  assert(health.body.turnstile === 'disabled', 'Sandbox Turnstile should remain disabled for deterministic QA.');
  assert(health.body.anonymousRookie === 'disabled', 'Sandbox must disable public anonymous Rookie generation.');
  assert(health.body.billing !== 'stripe', 'Sandbox must never report live Stripe billing.');
  assert(
    health.response.headers.get('Access-Control-Allow-Origin') === sandboxOrigin,
    'Sandbox frontend origin was not reflected by CORS.',
  );

  const tiers = await fetchJson('sandbox tiers', '/api/tiers');
  assert(tiers.response.ok, `Sandbox tiers returned HTTP ${tiers.response.status}.`);
  const tierCosts = Object.fromEntries((tiers.body.tiers ?? []).map((tier) => [tier.id, tier.creditCost]));
  assert(tierCosts.rookie === 2 && tierCosts.contender === 11 && tierCosts.champion === 18, 'Sandbox tier costs drifted from 2/11/18 credits.');

  const signedOut = await fetchJson('sandbox signed-out fighters', '/api/fighters');
  assert(signedOut.response.status === 401, `Signed-out fighters expected 401, got ${signedOut.response.status}.`);

  const forbiddenCors = await fetchJson('sandbox production-origin CORS', '/api/tiers', productionOrigin);
  assert(forbiddenCors.response.ok, `Sandbox production-origin request returned HTTP ${forbiddenCors.response.status}.`);
  const forbiddenAllowOrigin = forbiddenCors.response.headers.get('Access-Control-Allow-Origin');
  assert(
    forbiddenAllowOrigin !== productionOrigin,
    'Sandbox Worker reflected the production frontend origin.',
  );

  console.log(`Sandbox smoke passed: ${workerUrl}`);
  console.log(`Health ${health.body.version}; durable generation and providers configured; anonymous Rookie blocked; D1/R2 bound; tiers 2/11/18; live Stripe absent.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
