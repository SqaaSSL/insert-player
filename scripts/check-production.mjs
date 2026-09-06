import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { frontendHeadersForTarget } from './frontend-security-headers.mjs';
import { readImageSize } from './image-dimensions.mjs';
import { textReferencesHostname, textReferencesOrigin } from './url-reference.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;
const sqlite = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3';

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map((part) => Number(part));
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Node ${process.versions.node} is too old for production checks; use Node >=22.12.0.`);
  }
}

function run(label, command, args, cwd = root, envOverrides = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...envOverrides },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runCapture(label, command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else {
      files.push(path);
    }
  }
  return files;
}

function assertGeminiImageModelsAreGa() {
  const envFiles = ['.env', '.env.production', '.env.sandbox', '.env.development'];
  const offenders = [];
  for (const envFile of envFiles) {
    const path = join(root, envFile);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/^VITE_GEMINI_IMAGE_MODEL(?:_[A-Z0-9_]+)?=.*-preview\s*$/i.test(line.trim())) {
        offenders.push(`${envFile}:${index + 1}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Retired Gemini image preview model configured in ${offenders.join(', ')}.`);
  }
}

function assertNoLegacyApiRoutes() {
  const forbidden = [
    'auth/google',
    'auth/logout',
    '/api/characters',
    'src/api/client.ts',
    'worker/src/sprites.ts',
  ];
  const allowedFiles = new Set([
    'scripts/check-production.mjs',
  ]);
  const checkedExtensions = new Set(['.ts', '.tsx', '.md', '.mjs']);
  const offenders = [];

  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (allowedFiles.has(rel)) continue;
    if (![...checkedExtensions].some((ext) => rel.endsWith(ext))) continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      if (text.includes(pattern)) {
        offenders.push(`${rel}: ${pattern}`);
      }
    }
  }

  if (offenders.length > 0) {
    throw new Error(`Legacy API references found:\n${offenders.join('\n')}`);
  }
}

function assertBillingUsesRequestOrigin() {
  const billing = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const billingIntegrationTest = readFileSync(join(root, 'worker/src/billing.integration.test.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const billingClient = readFileSync(join(root, 'src/services/Billing.ts'), 'utf8');
  const cloudFighters = readFileSync(join(root, 'src/services/CloudFighters.ts'), 'utf8');
  const spriteCache = readFileSync(join(root, 'src/services/SpriteCache.ts'), 'utf8');
  const createPage = readFileSync(join(root, 'src/ui/routes/CreateFighterPage.tsx'), 'utf8');
  const galleryPage = readFileSync(join(root, 'src/ui/routes/GalleryPage.tsx'), 'utf8');
  const homePage = readFileSync(join(root, 'src/ui/routes/HomePage.tsx'), 'utf8');
  const checkoutStatus = readFileSync(join(root, 'src/ui/shared/checkoutStatus.ts'), 'utf8');
  const required = [
    "request.headers.get('Origin')",
    'configured.includes(requestOrigin)',
    'success_url',
    '/menu?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    'cancel_url',
    'async function resolveOwnedFighterId',
    'SELECT id FROM fighters WHERE id = ? AND owner_user_id = ?',
    'Fighter does not belong to this user',
    'const ownedFighterId = await resolveOwnedFighterId(env, auth.user.id, body.fighterId)',
    'const operation = normalizeGenerationBillingOperation(body.operation, body.reason);',
    'const requiredCredits = generationCreditCost(tier, operation);',
    'const reason = operation;',
    'const [quotaResult] = await env.DB.batch([',
    'const [spendResult] = await env.DB.batch([',
    'WHERE id = ? AND changes() = 1',
    'SELECT ?, user_id, credit_cost, ?, fighter_id',
    'return Boolean(claim.results?.[0]);',
    'const ownedFighterId = await resolveOwnedFighterId(env, auth.userId, body.fighterId)',
    'export async function settleGenerationPurchase',
    "charge.status === 'committed'",
    'fighterId && !charge.fighter_id',
    'fighterId?: string | null',
    'function formatBillingError',
    "'Not enough credits'",
    "body.requiredCredits === 1 ? 'credit' : 'credits'",
    'Not enough credits. ${body.requiredCredits} ${unit} required.',
    "typeof body.creditsBalance === 'number'",
    'return body.error.trim()',
    'formatBillingError(json, `Checkout failed (${res.status})`)',
    'formatBillingError(json, `Generation authorization failed (${res.status})`)',
    'rememberPendingCheckout',
    'consumePendingCheckout',
    "authStatus === 'loading'",
    "authStatus !== 'signed-in'",
    'export async function getCreditCheckoutStatus',
    'WHERE checkout_sessions.stripe_session_id = ?',
    'AND checkout_sessions.user_id = ?',
    "path === '/api/billing/checkout-status' && method === 'GET'",
    'export async function verifyCreditCheckoutSession',
    'checkout.sessionId !== expectedSessionId',
    'Confirming the exact Stripe session...',
    'CHECKOUT_SESSION_REFRESH_DELAYS_MS',
    'balance alone does not confirm it',
    'no credit success was assumed',
    'providerCallLimit?: number',
    'providerCallLimit: providerSession.providerCallLimit',
    "'fighter_upgrade'",
    'pendingGenerationPurchaseId?: string | null',
    'cached.meta.pendingGenerationPurchaseId = purchaseId',
    'meta.pendingGenerationPurchaseId',
    'meta.pendingGenerationPurchaseId = null',
    'Billing history will finish linking on the next cloud sync.',
    'links a committed purchase after cloud creation and remains idempotent',
    'function billingConfigurationError',
    'verifyStripeCheckoutConfiguration(env, pack)',
    'AbortSignal.timeout(STRIPE_FETCH_TIMEOUT_MS)',
    "'Idempotency-Key': `insert-player-checkout-${sessionToken}`",
    'stripe_account_id: env.STRIPE_ACCOUNT_ID',
    'payment_intent_data[metadata][${key}]',
    "appendForm(form, 'line_items[0][price]', stripePriceId)",
    'insert_player_pack_id',
    'stripeAccountId !== expectedStripeAccountId',
    'eventAccountId !== expectedStripeAccountId',
    "return 'Billing is not configured'",
    "env.ENVIRONMENT === 'production' && !/^sk_live_/i.test(stripeSecret)",
    'if (billingError) return json({ error: billingError }, 503)',
    'async function creditPaidCheckoutSession',
    'const pendingStripeSessionId = `pending:${sessionToken}`;',
    'session_token: sessionToken',
    'SET status = \'failed\'',
    'SET status = \'crediting\'',
    'function checkoutCreditExpectation',
    'session.amount_total',
    'session.client_reference_id',
    'WHERE (stripe_session_id = ? OR id = ?)',
    'AND user_id = ?',
    'AND pack_id = ?',
    'AND credits = ?',
    'AND amount_cents = ?',
    'AND lower(currency) = ?',
    "WHERE stripe_session_id = ? AND status = 'crediting'",
    'session.metadata?.session_token',
    "INSERT OR IGNORE INTO credit_ledger",
    'INSERT OR IGNORE INTO stripe_events',
    'stripeEventAuditPayload',
    'INSERT OR IGNORE INTO stripe_events (id, type, payload, user_id)',
    "creditStatus === 'credited' || creditStatus === 'duplicate'",
    "event.type === 'charge.refunded'",
    "event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed'",
    'creditsForStripeAdjustment',
    'stripe_credit_adjustments',
    'Stripe test event rejected in production',
    "status IN ('open', 'failed')",
    'reverses refunds once and restores credits after a won dispute',
    'withholds refunded credits when refund delivery precedes checkout completion',
  ];
  const combined = `${billing}\n${billingIntegrationTest}\n${workerIndex}\n${billingClient}\n${cloudFighters}\n${spriteCache}\n${createPage}\n${galleryPage}\n${homePage}\n${checkoutStatus}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Billing checkout origin handling is missing: ${missing.join(', ')}`);
  }
}

function assertProxyIsProductionScoped() {
  const proxy = readFileSync(join(root, 'worker/src/proxy.ts'), 'utf8');
  const proxyTests = readFileSync(join(root, 'worker/src/proxy.test.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const apiClient = readFileSync(join(root, 'src/services/ApiClient.ts'), 'utf8');
  const providerSessions = readFileSync(join(root, 'worker/src/providerSessions.ts'), 'utf8');
  const providerLimits = readFileSync(join(root, 'worker/src/providerLimits.ts'), 'utf8');
  const streamLimits = readFileSync(join(root, 'worker/src/streamLimits.ts'), 'utf8');
  const providerSessionIntegrationTests = readFileSync(join(root, 'worker/src/providerSessions.integration.test.ts'), 'utf8');
  const billingClient = readFileSync(join(root, 'src/services/Billing.ts'), 'utf8');
  const forbidden = [
    'catbox.moe',
    'litterbox',
    "return method === 'POST' && (",
    "if (path === '/proxy/image') {\n    const limited = await enforceRateLimit(env, 'proxy:default', auth);",
    "if (path === '/proxy/media') {\n    const limited = await enforceRateLimit(env, 'proxy:default', auth);",
    'response.clone().arrayBuffer()',
  ];
  const required = [
    'env.SPRITES.put(`temp/${id}.${format.ext}`',
    'const PROVIDER_ROUTE_ALLOWLIST',
    'function enforceProviderRouteAllowlist',
    'Provider proxy route is not allowed',
    "enforceProviderRouteAllowlist('gemini'",
    "enforceProviderRouteAllowlist('fal'",
    "enforceProviderRouteAllowlist('pixcli'",
    'function detectImageFormat',
    "const TEMP_ASSET_PATH_PREFIX = '/temp-assets/';",
    'Invalid temp asset path',
    'const MAX_TEMP_ASSET_BYTES',
    'function isBase64TempAssetTooLarge',
    'Temp image is too large',
    "async function handleTempUpload(request: Request, env: Env, auth: PublicAuthContext)",
    "const sessionError = await requireProviderResultSession(request, env, auth);\n  if (sessionError) return sessionError;\n  const limited = await enforceRateLimit(env, 'proxy:default', auth);",
    'function isBlockedHostname',
    "redirect: 'manual'",
    'const MAX_RESULT_REDIRECTS',
    'function isRedirectStatus',
    'fetchPublicResult',
    'readResponseBytes',
    'ResponseBodyTooLargeError',
    'PROVIDER_REQUEST_BODY_LIMITS',
    'PROVIDER_RESPONSE_BODY_LIMITS',
    'createBoundedRequestStream(request, maxRequestBytes)',
    'createBoundedByteStream(upstream.body, maxResponseBytes)',
    'async function providerRequestHash',
    "new DigestStream('SHA-256')",
    'async function storeProviderResponseStream',
    'bucket.createMultipartUpload(key, options)',
    'PROVIDER_CACHE_MULTIPART_BYTES',
    'PROVIDER_CACHE_MAX_RESPONSE_BYTES',
    'provider_response_too_large',
    'Provider request body is too large',
    "it('rejects a declared oversized provider body before fetch'",
    "it('aborts a chunked provider body as soon as its streaming cap is crossed'",
    "it('streams provider responses through a byte cap instead of buffering them'",
    "it('rejects a declared oversized durable request before reserving provider spend'",
    "it('fails an oversized response without buffering it or releasing incurred provider spend'",
    'Upstream did not return an image',
    'function handleMediaProxy',
    "path === '/proxy/media'",
    'Upstream did not return supported media',
    'Only HTTPS result URLs are allowed',
    'const MAX_PROXIED_IMAGE_BYTES',
    'Upstream image is too large',
    'MAX_PROXIED_MEDIA_BYTES',
    "headers.set('X-Content-Type-Options', 'nosniff')",
    'requireProviderResultSession',
    'return handleImageProxy(request, env, auth, url)',
    'return handleMediaProxy(request, env, auth, url)',
    "const sessionError = await requireProviderResultSession(request, env, auth);\n  if (sessionError) return sessionError;\n  const limited = await enforceRateLimit(env, 'proxy:default', auth);",
    "request_id is required",
    'function shouldAttachAuth',
    "export const PROVIDER_SESSION_HEADER = 'X-ASF-Provider-Session'",
    'function requiresProviderSession',
    "if (request.method === 'GET' || request.method === 'HEAD') return null;",
    "await requireProviderSession(request, env, auth, { provider: 'gemini', path }, providerState)",
    "await requireProviderSession(request, env, auth, { provider: 'freepik', path }, providerState)",
    "await requireProviderSession(request, env, auth, { provider: 'fal', path }, providerState)",
    'requireUnmeteredProviderSession',
    "generationCreationFlowFromAuth(auth) !== 'video'",
    "path === '/proxy/pixcli/api/v1/video/advanced') return 33",
    'Provider session is not valid for this provider route',
    'function isAllowedProviderUse',
    "purpose === 'intro_video'",
    "purpose === 'stage_background'",
    'const FIGHTER_GENERATION_CALL_LIMITS',
    'const FIGHTER_RETRY_CALL_LIMITS',
    'rookie: 48',
    'contender: 280',
    'champion: 320',
    'function providerCallLimitFor',
    'function providerSessionLimitResponse',
    'const latest = await env.DB.prepare(`',
    'providerSessionId',
    'runWithProviderSession',
    "headers.set('X-ASF-Provider-Session', context.providerSessionId)",
    "'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ASF-Provider-Session, X-Insert-Player-Provider-Request-Key'",
    'Provider session required',
    "it('revalidates every redirect and blocks a public URL redirecting private'",
    "it('cancels an upstream body as soon as the streamed byte cap is crossed'",
    "it('proxies an allowlisted PixCLI poll without forwarding client credentials'",
    "it('caches a PixCLI upload without consuming spend or committing the charge'",
    "it('reserves exactly 33 cents for one PixCLI video submission'",
  ];
  const combined = `${proxy}\n${proxyTests}\n${workerIndex}\n${apiClient}\n${providerSessions}\n${providerLimits}\n${streamLimits}\n${providerSessionIntegrationTests}\n${billingClient}`;
  const foundForbidden = forbidden.filter((snippet) => combined.includes(snippet));
  if (foundForbidden.length > 0) {
    throw new Error(`Production proxy must not use third-party temp hosts: ${foundForbidden.join(', ')}`);
  }
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Production proxy/client hardening is missing: ${missing.join(', ')}`);
  }
}

function assertWorkerRequestBodiesAreBounded() {
  const requestBody = readFileSync(join(root, 'worker/src/requestBody.ts'), 'utf8');
  const requestBodyTests = readFileSync(join(root, 'worker/src/requestBody.test.ts'), 'utf8');
  const billing = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const clerkWebhooks = readFileSync(join(root, 'worker/src/clerkWebhooks.ts'), 'utf8');
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const generationJobs = readFileSync(join(root, 'worker/src/generationJobs.ts'), 'utf8');
  const providerSessions = readFileSync(join(root, 'worker/src/providerSessions.ts'), 'utf8');
  const proxy = readFileSync(join(root, 'worker/src/proxy.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const workerSources = [billing, clerkWebhooks, fighters, generationJobs, providerSessions, proxy, workerIndex];
  const directBodyReads = workerSources.flatMap((source, index) => {
    const matches = source.match(/request\.(?:json|text|formData|arrayBuffer)\s*\(/g) ?? [];
    return matches.map((match) => `${index}:${match}`);
  });
  if (directBodyReads.length > 0) {
    throw new Error(`Worker routes bypass bounded request-body readers: ${directBodyReads.join(', ')}`);
  }

  const combined = [requestBody, requestBodyTests, billing, clerkWebhooks, fighters, generationJobs, providerSessions, proxy, workerIndex].join('\n');
  const required = [
    'class RequestBodyTooLargeError',
    'class InvalidJsonBodyError',
    'class InvalidMultipartBodyError',
    'totalBytes > maxBytes',
    'await reader.cancel()',
    'readMultipartFormData',
    'request.body.pipeThrough(new TransformStream',
    'createBoundedRequestStream',
    'didExceedLimit',
    'MAX_STRIPE_WEBHOOK_BODY_BYTES',
    'MAX_CLERK_WEBHOOK_BODY_BYTES',
    'MAX_SOURCE_MULTIPART_BODY_BYTES',
    'MAX_SPRITE_MULTIPART_BODY_BYTES',
    'MAX_JOB_BODY_BYTES',
    'readMultipartFormData(request, MAX_SOURCE_MULTIPART_BODY_BYTES)',
    'readMultipartFormData(request, MAX_SPRITE_MULTIPART_BODY_BYTES)',
    'readJsonBody<{',
    "it('rejects chunked multipart bytes over the cap before parsing'",
    "it('stops a forwarded request stream when a chunk crosses the cap'",
    'readJsonBody<Record<string, unknown>>(request, MAX_MATCH_REPORT_BODY_BYTES)',
    "json({ error: 'Request body is too large' }, 413)",
    "json({ error: 'Invalid JSON request body' }, 400)",
    "json({ error: 'Invalid multipart request body' }, 400)",
  ];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Worker request-body limits are missing: ${missing.join(', ')}`);
  }
}

function assertOperationalDataRetentionIsSafe() {
  const billing = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const billingTests = readFileSync(join(root, 'worker/src/billing.test.ts'), 'utf8');
  const clerkWebhook = readFileSync(join(root, 'worker/src/clerkWebhooks.ts'), 'utf8');
  const maintenance = readFileSync(join(root, 'worker/src/maintenance.ts'), 'utf8');
  const maintenanceTests = readFileSync(join(root, 'worker/src/maintenance.test.ts'), 'utf8');
  const migration = readFileSync(join(root, 'worker/migrations/0010_operational_data_retention.sql'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const wrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const combined = [
    billing,
    billingTests,
    clerkWebhook,
    maintenance,
    maintenanceTests,
    migration,
    workerIndex,
    wrangler,
  ].join('\n');
  const required = [
    'ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE',
    'UPDATE stripe_events SET payload = \'{"legacy":true}\'',
    'stripeEventAuditPayload',
    'customer_details',
    "expect(payload).not.toContain('player@example.com')",
    'DELETE FROM stripe_events',
    'WHERE user_id = ? OR instr(payload, ?) > 0 OR instr(payload, ?) > 0',
    'export async function cleanupOperationalData',
    "datetime(expires_at) <= datetime('now', '-7 days')",
    "datetime(created_at) <= datetime('now', '-180 days')",
    "datetime(processed_at) <= datetime('now', '-180 days')",
    "status IN ('open', 'failed')",
    "datetime(updated_at) <= datetime('now', '-30 days')",
    "datetime(created_at) <= datetime('now', '-6 years')",
    'DELETE FROM provider_spend_reservations',
    "created_at_epoch <= unixepoch('now', '-1 day')",
    'DELETE FROM provider_request_cache',
    'DELETE FROM generation_jobs',
    'response_blob_key IS NULL',
    'await env.SPRITES.delete',
    "datetime(updated_at) <= datetime('now', '-4 days')",
    'settleGenerationPurchase(env, job.user_id, job.charge_id, false, job.fighter_id)',
    "datetime(finished_at) <= datetime('now', '-7 days')",
    'generation_jobs.provider_session_id = provider_sessions.id',
    'async scheduled(_controller: ScheduledController, env: Env)',
    'await cleanupOperationalData(env)',
    '[triggers]',
    'crons = ["0 4 * * *"]',
    "expect(combined).not.toContain('fighters')",
    "expect(combined).not.toContain('credit_ledger')",
    "expect(combined).not.toContain('clerk_user_tombstones')",
  ];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Operational data minimization/retention is missing: ${missing.join(', ')}`);
  }

  const forbiddenDeletes = [
    'DELETE FROM fighters',
    'DELETE FROM sprites',
    'DELETE FROM sprite_versions',
    'DELETE FROM source_versions',
    'DELETE FROM credit_ledger',
    'DELETE FROM clerk_user_tombstones',
    'DELETE FROM users',
  ];
  const unsafe = forbiddenDeletes.filter((statement) => maintenance.includes(statement));
  if (unsafe.length > 0) {
    throw new Error(`Scheduled maintenance must never delete durable user data: ${unsafe.join(', ')}`);
  }
}

function assertApiOperationsAreSessionScoped() {
  const apiClient = readFileSync(join(root, 'src/services/ApiClient.ts'), 'utf8');
  const apiClientTests = readFileSync(join(root, 'src/services/ApiClient.test.ts'), 'utf8');
  const createPage = readFileSync(join(root, 'src/ui/routes/CreateFighterPage.tsx'), 'utf8');
  const galleryPage = readFileSync(join(root, 'src/ui/routes/GalleryPage.tsx'), 'utf8');
  const cloudFighters = readFileSync(join(root, 'src/services/CloudFighters.ts'), 'utf8');
  const gemini = readFileSync(join(root, 'src/services/GeminiApi.ts'), 'utf8');
  const providerSessions = readFileSync(join(root, 'worker/src/providerSessions.ts'), 'utf8');
  const providerSessionTests = readFileSync(join(root, 'worker/src/providerSessions.test.ts'), 'utf8');
  const providerSessionIntegrationTests = readFileSync(join(root, 'worker/src/providerSessions.integration.test.ts'), 'utf8');
  const providerSpendMigration = readFileSync(join(root, 'worker/migrations/0014_provider_spend_budgets.sql'), 'utf8');
  const providerSpendRateMigration = readFileSync(join(root, 'worker/migrations/0016_provider_spend_rate_window.sql'), 'utf8');
  const providerCostEventsMigration = readFileSync(join(root, 'worker/migrations/0017_provider_cost_events.sql'), 'utf8');
  const zeroCostEventsMigration = readFileSync(join(root, 'worker/migrations/0026_zero_cost_not_dispatched_events.sql'), 'utf8');
  const geminiPolicy = readFileSync(join(root, 'src/services/GeminiRequestPolicy.ts'), 'utf8');
  const geminiPolicyTests = readFileSync(join(root, 'src/services/GeminiRequestPolicy.test.ts'), 'utf8');
  const productionWrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const sandboxWrangler = readFileSync(join(root, 'worker/wrangler.sandbox.toml'), 'utf8');
  const required = [
    'export interface ApiRequestContext',
    'export class ApiSessionChangedError',
    'export function captureApiRequestContext',
    'export function assertApiRequestContextCurrent',
    'context.authRevision !== authRevision',
    'context.tokenGetter !== tokenGetter',
    'action(withProviderSession(baseContext, sessionId))',
    'assertApiRequestContextCurrent(context)',
    "headers.set('X-ASF-Provider-Session', context.providerSessionId)",
    "it('keeps concurrent provider sessions attached to their own requests'",
    "it('rejects an operation context after the Clerk session changes'",
    'const apiContext = captureApiRequestContext()',
    'apiContext: providerContext',
    'const requestContext = context ?? captureApiRequestContext()',
    'if (err instanceof ApiSessionChangedError) throw err',
    'modelOverride?: string',
    "const GEMINI_FLASH_IMAGE_MODEL = 'gemini-3.1-flash-image'",
    "const GEMINI_PRO_IMAGE_MODEL = 'gemini-3-pro-image'",
    'provider_cost_used_cents',
    'provider_cost_limit_cents',
    'provider_spend_months',
    'INSERT INTO provider_spend_months',
    'ON CONFLICT(period) DO UPDATE SET',
    'provider_cost_events',
    'estimated_cost_cents >= 0',
    'billing_operation',
    'export async function finalizeProviderRequest',
    "SET status = 'committed', updated_at = datetime('now')",
    "it('keeps attempted provider spend after an upstream failure'",
    "it('keeps the committed charge and provider spend after an upstream failure'",
    "it('records spend without blocking a valid session after high aggregate usage'",
    "it('fails closed when durable monthly accounting cannot be recorded'",
    "it('fails closed without cost residue when the charge was released concurrently'",
    'PRO_REQUEST_START_INTERVAL_MS = 11_000',
    'err instanceof GeminiRequestError && err.retryable',
    'maxAttempts ?? 5',
    "it('honors Google RetryInfo and identifies spend-based limits'",
  ];
  const forbidden = [
    'let providerSessionId',
    'runtimeAnimModelOverride',
    'setGeminiAnimModelOverride',
    'releaseProviderSpend(env, reservation, providerStatus)',
    'PROVIDER_MONTHLY_BUDGET_USD_CENTS',
    'GEMINI_SPEND_RATE_LIMIT_USD_CENTS',
    'provider_monthly_budget_exhausted',
    'provider_global_spend_rate',
  ];
  const combined = `${apiClient}\n${apiClientTests}\n${createPage}\n${galleryPage}\n${cloudFighters}\n${gemini}\n${geminiPolicy}\n${geminiPolicyTests}\n${providerSessions}\n${providerSessionTests}\n${providerSessionIntegrationTests}\n${providerSpendMigration}\n${providerSpendRateMigration}\n${providerCostEventsMigration}\n${productionWrangler}\n${sandboxWrangler}`;
  const migrationCombined = `${combined}\n${zeroCostEventsMigration}`;
  const missing = required.filter((snippet) => !migrationCombined.includes(snippet));
  const foundForbidden = forbidden.filter((snippet) => combined.includes(snippet));
  if (missing.length > 0 || foundForbidden.length > 0) {
    throw new Error([
      missing.length > 0 ? `session-scoped API operations are missing: ${missing.join(', ')}` : '',
      foundForbidden.length > 0 ? `obsolete or mutable provider state remains: ${foundForbidden.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

function assertFrontendDeployIsProductionScoped() {
  if (existsSync(join(root, 'public/_redirects'))) {
    throw new Error('Cloudflare Pages must use its native SPA fallback; public/_redirects causes an index rewrite loop.');
  }
  if (existsSync(join(root, 'public/404.html'))) {
    throw new Error('Cloudflare Pages native SPA fallback requires no top-level public/404.html.');
  }
  if (existsSync(join(root, 'public/test-gemini.html'))) {
    throw new Error('public/test-gemini.html must not be shipped to production.');
  }

  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const frontendSmoke = readFileSync(join(root, 'scripts/smoke-frontend-live.mjs'), 'utf8');
  const runbook = readFileSync(join(root, 'PRODUCTION_READINESS.md'), 'utf8');
  const required = [
    '"smoke:frontend-live": "node scripts/smoke-frontend-live.mjs"',
    'Set ASF_FRONTEND_URL or ASF_FRONTEND_ORIGIN',
    "'/menu?checkout=success&session_id=smoke-checkout'",
    "'/menu?checkout=cancelled'",
    'checkout-return routes',
    'native SPA rendering',
    'DEFAULT_FRONTEND_URL',
    "const DEFAULT_FRONTEND_URL = isSandbox ? 'https://insert-player-sandbox.pages.dev' : '';",
    'function readEnvValues',
    "envValue(env, isSandbox ? 'ASF_SANDBOX_FRONTEND_URL' : 'ASF_FRONTEND_URL')",
    "envValue(env, 'VITE_API_BASE_URL')",
    'FETCH_TIMEOUT_MS',
    'FRONTEND_READY_TIMEOUT_MS',
    'ASF_FRONTEND_READY_TIMEOUT_MS',
    'ASF_EXPECTED_FRONTEND_ASSET_PATH',
    'FRONTEND_RETRY_DELAY_MS',
    'function fetchWithTimeout',
    'function waitForFrontendText',
    'readinessError',
    'still serves a previous deployment',
    'frontendShellReadinessError',
    'function isTransientFrontendStatus',
    '${label} did not become ready after',
    '${label} failed for ${target}',
    'AbortSignal.timeout(FETCH_TIMEOUT_MS)',
    "jsBundle.includes(workerUrl)",
    'pk_live_',
    'old Gemini test page is not publicly exposed',
    '"deploy:frontend": "node scripts/deploy-frontend-pages.mjs"',
    "isSandbox ? 'ASF_SANDBOX_PAGES_PROJECT_NAME' : 'ASF_PAGES_PROJECT_NAME'",
    'must use the cleared public brand, not the internal project name or a placeholder',
    '../scripts/wrangler-workspace-log.mjs',
    "'pages'",
    "'deploy'",
    "'../dist'",
    "'--project-name'",
    'projectName',
    "'--branch'",
    'builtFrontendAssetPath',
    'Frontend release asset:',
    'CANONICAL_SMOKE_READY_TIMEOUT_MS = 240_000',
    'String(CANONICAL_SMOKE_READY_TIMEOUT_MS)',
    'npm run smoke:frontend-live',
  ];
  const deployFrontend = readFileSync(join(root, 'scripts/deploy-frontend-pages.mjs'), 'utf8');
  const combined = `${packageJson}\n${frontendSmoke}\n${deployFrontend}\n${runbook}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Frontend deploy smoke/fallback wiring is missing: ${missing.join(', ')}`);
  }
}

function assertNoClientProviderSecrets() {
  const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
  const forbidden = [
    'VITE_GEMINI_API_KEY',
    'VITE_FAL_API_KEY',
    'VITE_RUNWAY_API_KEY',
    'VITE_FREEPIK_API_KEY',
    'VITE_LUDO_API_KEY',
    'VITE_STRIPE_SECRET_KEY',
    'VITE_STRIPE_WEBHOOK_SECRET',
    'VITE_GOOGLE_MAPS_SERVER_KEY',
  ];
  const offenders = [];
  for (const file of [
    ...walk(join(root, 'src')),
    join(root, 'vite.config.ts'),
  ]) {
    const rel = relative(root, file);
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const snippet of forbidden) {
      if (text.includes(snippet)) offenders.push(`${rel}: ${snippet}`);
    }
  }
  for (const envFile of ['.env.example', '.env.production.example']) {
    const text = readFileSync(join(root, envFile), 'utf8');
    for (const snippet of forbidden) {
      if (text.includes(snippet)) offenders.push(`${envFile}: ${snippet}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Provider API keys must not be Vite/client-exposed:\n${offenders.join('\n')}`);
  }

  const requiredDevProxyRedaction = [
    'function sanitizeProxyUrlForLog',
    "url.searchParams.set(key, '<redacted>')",
    'const safeTargetUrl = sanitizeProxyUrlForLog(targetUrl)',
    'const configured = (key: string) => key ? \'configured\' : \'missing\'',
  ];
  const forbiddenDevProxyLogs = [
    'slice(0, 4)}...${',
    '${publicUrl}',
    '${targetUrl} (body:',
    '${targetUrl} ->',
    '${targetUrl} →',
  ];
  const missingDevProxyRedaction = requiredDevProxyRedaction.filter((snippet) => !viteConfig.includes(snippet));
  const foundDevProxyLeaks = forbiddenDevProxyLogs.filter((snippet) => viteConfig.includes(snippet));
  if (missingDevProxyRedaction.length > 0 || foundDevProxyLeaks.length > 0) {
    throw new Error([
      missingDevProxyRedaction.length > 0 ? `Vite dev proxy secret redaction is missing: ${missingDevProxyRedaction.join(', ')}` : '',
      foundDevProxyLeaks.length > 0 ? `Vite dev proxy may log secret-bearing values: ${foundDevProxyLeaks.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }

  const clientLogLeakHints = ['publicUrl', 'resultUrl', 'apiKey', 'API_KEY', 'Authorization', 'Bearer '];
  const clientLogPattern = /\b(debugInfo|debugWarn|console\.(log|info|warn|error))\b/;
  const clientLogLeaks = [];
  for (const file of walk(join(root, 'src'))) {
    const rel = relative(root, file);
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!clientLogPattern.test(line)) return;
      const hint = clientLogLeakHints.find((snippet) => line.includes(snippet));
      if (hint) clientLogLeaks.push(`${rel}:${index + 1}: ${hint}`);
    });
  }
  if (clientLogLeaks.length > 0) {
    throw new Error(`Client debug logs may expose temp URLs or secrets:\n${clientLogLeaks.join('\n')}`);
  }
}

function assertLiveConfigHelperIsWired() {
  const helper = readFileSync(join(root, 'scripts/apply-live-config.mjs'), 'utf8');
  const frontendLiveEnv = readFileSync(join(root, 'scripts/check-frontend-live-env.mjs'), 'utf8');
  const deployFrontend = readFileSync(join(root, 'scripts/deploy-frontend-pages.mjs'), 'utf8');
  const liveReadiness = readFileSync(join(root, 'scripts/check-live-readiness.mjs'), 'utf8');
  const stripeBootstrap = readFileSync(join(root, 'scripts/bootstrap-stripe-catalog.mjs'), 'utf8');
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const workerPackageJson = readFileSync(join(root, 'worker/package.json'), 'utf8');
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const envProductionExample = readFileSync(join(root, '.env.production.example'), 'utf8');
  const workerDevVarsExample = readFileSync(join(root, 'worker/.dev.vars.example'), 'utf8');
  const runbook = readFileSync(join(root, 'PRODUCTION_READINESS.md'), 'utf8');
  const required = [
    "'.env.production.local'",
    "'worker/.prod.vars'",
    "'STRIPE_SECRET_KEY'",
    "'STRIPE_WEBHOOK_SECRET'",
    "'STRIPE_ACCOUNT_ID'",
    "'STRIPE_PRICE_STARTER'",
    "'STRIPE_PRICE_VERSUS'",
    "'STRIPE_PRICE_ARCADE'",
    "'CLERK_WEBHOOK_SIGNING_SECRET'",
    "'ANONYMIZATION_SECRET'",
    "'GENERATION_JOB_SIGNING_SECRET'",
    "'CLERK_ISSUER'",
    "'CLERK_AUTHORIZED_PARTIES'",
    "'VITE_CLERK_PUBLISHABLE_KEY'",
    "'VITE_PUBLIC_APP_NAME'",
    "'VITE_PUBLIC_APP_SHORT_NAME'",
    "'VITE_GOOGLE_MAPS_BROWSER_KEY'",
    "'GOOGLE_MAPS_SERVER_KEY'",
    'ASF_FRONTEND_ORIGIN',
    'ASF_BRAND_CLEARANCE_FILE',
    'CLERK_ISSUER',
    'must be an HTTPS Clerk issuer URL',
    "spawnSync(npx, ['wrangler', 'secret', 'put', key]",
    "'--no-install',\n      'wrangler',\n      'deploy',\n      '--keep-vars',\n      '--strict'",
    "'--containers-rollout',\n      'immediate'",
    "args.has('--dry-run-worker-deploy')",
    'mkdtempSync',
    'rmSync(tempDirectory, { recursive: true, force: true })',
    'SECRET_PUT_TIMEOUT_MS',
    'DEPLOY_TIMEOUT_MS',
    'PRODUCTION_CHECK_TIMEOUT_MS',
    'WRANGLER_LOG_PATH',
    "'.wrangler-logs'",
    'function wranglerEnv',
    'timeout: SECRET_PUT_TIMEOUT_MS',
    'timeout: DEPLOY_TIMEOUT_MS',
    'timeout: PRODUCTION_CHECK_TIMEOUT_MS',
    "args.has('--require-complete')",
    "args.has('--deploy-worker')",
    "args.has('--skip-production-check')",
    'function runProductionCheck',
    "spawnSync(npm, ['run', 'check:production']",
    'Production checks failed; live config was not applied.',
    'function configuredOrigins',
    'function isHttpsUrl',
    'Live config validation failed',
    'pk_test_',
    'sk_test_',
    'must be a live Clerk publishable key starting with pk_live_',
    'must be a live Stripe secret key starting with sk_live_',
    'STRIPE_SECRET_KEY does not belong to STRIPE_ACCOUNT_ID. Refusing to mix billing accounts.',
    'ASF_FORBIDDEN_STRIPE_ACCOUNT_IDS',
    'fetchStripeAccount',
    'fetchStripePrice',
    'stripeBusinessProfileIssues',
    'Stripe live business profile is incomplete',
    'CLERK_AUTHORIZED_PARTIES must include every frontend origin',
    'must use the cleared public brand domain, not the internal project domain',
    'VITE_API_BASE_URL must be the deployed HTTPS Worker/API URL for the cleared public brand',
    'VITE_API_BASE_URL/ASF_WORKER_URL',
    'Production frontend VITE_API_BASE_URL must use the cleared public brand Worker/API URL',
    'ASF_WORKER_HEALTH_URL/ASF_WORKER_URL/VITE_API_BASE_URL must use the cleared public brand Worker/API URL',
    'must be the cleared public brand, not the internal name or placeholder',
    'Brand clearance clearanceStatus must be "cleared_for_launch"',
    'VITE_PUBLIC_APP_NAME must match brand clearance publicBrandName',
    'Frontend live env checks failed',
    'DEFAULT_COMMAND_TIMEOUT_MS',
    "CURL_TIMEOUT_ARGS = ['--connect-timeout', '10', '--max-time', '30']",
    'function curl',
    'function curlHttpsWithPublicDnsFallback',
    "resolver.setServers(['1.1.1.1', '8.8.8.8'])",
    "'--resolve'",
    'WRANGLER_LOG_PATH',
    "'.wrangler-logs'",
    'DEFAULT_FRONTEND_READY_TIMEOUT_MS',
    'DEFAULT_FRONTEND_RETRY_DELAY_MS',
    'function curlFrontendRoute',
    'ASF_FRONTEND_READY_TIMEOUT_MS',
    'Production frontend route ${frontendUrl}${path} did not become ready after',
    'timeout: DEFAULT_COMMAND_TIMEOUT_MS',
    'wranglerAuthIssue',
    'expectedAccountId: process.env.CLOUDFLARE_ACCOUNT_ID',
    'Wrangler is not authenticated for the expected account',
    "'VITE_API_BASE_URL'",
    "'VITE_CLERK_PUBLISHABLE_KEY'",
    'pk_live_',
    'providerSecretKeys',
    "r2', 'bucket', 'lifecycle', 'list'",
    "lifecycleArgs.push('--jurisdiction', jurisdiction)",
    "'d1',",
    "'execute',",
    'Remote D1 database ${databaseName} is missing tables',
    'function assertFrontendDeployment',
    'Production frontend route ${frontendUrl}${path} did not serve the app shell',
    '/menu?checkout=success&session_id=readiness',
    '/menu?checkout=cancelled',
    '/community?fighter=readiness',
    'function resolveWorkerHealthUrl',
    'ASF_WORKER_HEALTH_URL, ASF_WORKER_URL, or VITE_API_BASE_URL',
    'Live health ${key} should be ${value}',
    "['accountLifecycle', 'clerk_webhook']",
    'Live health must report D1 and R2 bindings as bound',
    'function assertClerkJwksReachable',
    'Clerk JWKS check returned no keys',
    'CLERK_AUTHORIZED_PARTIES must include every CORS_ORIGIN',
    'prefix:\\s*temp\\/',
    'Expire objects after 1 days',
    '"config:live": "node scripts/apply-live-config.mjs --require-complete --deploy-worker"',
    '"stripe:bootstrap": "node scripts/bootstrap-stripe-catalog.mjs"',
    'Live Stripe mutation requires the explicit --allow-live flag.',
    'Refusing to bootstrap Stripe inside a forbidden shared account.',
    "'metadata[insert_player_pack_id]'",
    "'enabled_events[0]': '*'",
    'records unsupported types as ignored audit entries',
    '"check:frontend-live": "node scripts/check-frontend-live-env.mjs"',
    '"deploy:frontend": "node scripts/deploy-frontend-pages.mjs"',
    '"release:guard": "node scripts/production-deploy-guard.mjs"',
    '"deploy:worker": "npm run release:guard && npm run check:production && cd worker && npm run deploy"',
    'ASF_PAGES_PROJECT_NAME=insert-player',
    'Frontend Pages deploy target:',
    '"db:migrate": "node ../scripts/wrangler-workspace-log.mjs d1 migrations apply insert-player-db --remote"',
    '"db:execute:0008": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0008_provider_sessions.sql"',
    '"db:execute:0009": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0009_clerk_user_lifecycle.sql"',
    '"db:execute:0010": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0010_operational_data_retention.sql"',
    '"db:execute:0011": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0011_legal_consent_and_checkout_tax.sql"',
    '"db:execute:0012": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0012_stripe_refund_and_dispute_adjustments.sql"',
    '"db:execute:0013": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0013_community_moderation.sql"',
    '"db:execute:0014": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0014_provider_spend_budgets.sql"',
    '"db:execute:0015": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0015_asset_lookup_indexes.sql"',
    '"db:execute:0016": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0016_provider_spend_rate_window.sql"',
    '"db:execute:0017": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0017_provider_cost_events.sql"',
    '"db:execute:0018": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0018_durable_generation_jobs.sql"',
    '"db:execute:0019": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0019_durable_retry_jobs.sql"',
    '"db:execute:0020": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0020_official_arcade.sql"',
    '"db:execute:0021": "node ../scripts/wrangler-workspace-log.mjs d1 execute insert-player-db --file=./migrations/0021_arcade_generation_prompts.sql"',
    'scripts/wrangler-workspace-log.mjs',
    '"wrangler": "^4.125.0"',
    '.env.*',
    'worker/.prod.vars',
    '.wrangler-logs/',
    'STRIPE_SECRET_KEY=sk_live_replace_me',
    'STRIPE_ACCOUNT_ID=acct_replace_me',
    'STRIPE_PRICE_STARTER=price_replace_me',
    'STRIPE_WEBHOOK_SECRET=whsec_replace_me',
    'CLERK_WEBHOOK_SIGNING_SECRET=whsec_replace_me',
    'ANONYMIZATION_SECRET=replace_me_with_at_least_32_random_bytes',
    'GENERATION_JOB_SIGNING_SECRET=replace_me_with_at_least_32_random_bytes',
    'ENVIRONMENT=development',
    'npm run stripe:bootstrap:sandbox',
    '.env.sandbox.local',
    '`ENVIRONMENT=sandbox` accepts `sk_test_...`',
    'npm run config:live',
  ];
  const combined = `${helper}\n${frontendLiveEnv}\n${deployFrontend}\n${liveReadiness}\n${stripeBootstrap}\n${packageJson}\n${workerPackageJson}\n${gitignore}\n${envProductionExample}\n${workerDevVarsExample}\n${runbook}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`live config helper wiring is missing: ${missing.join(', ')}`);
  }
}

function assertSandboxIsolationIsWired() {
  const productionConfig = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const sandboxConfig = readFileSync(join(root, 'worker/wrangler.sandbox.toml'), 'utf8');
  const sandboxConfigHelper = readFileSync(join(root, 'scripts/apply-sandbox-config.mjs'), 'utf8');
  const stripeBootstrap = readFileSync(join(root, 'scripts/bootstrap-stripe-catalog.mjs'), 'utf8');
  const sandboxSmoke = readFileSync(join(root, 'scripts/smoke-sandbox.mjs'), 'utf8');
  const sandboxFrontendEnv = readFileSync(join(root, 'scripts/check-frontend-sandbox-env.mjs'), 'utf8');
  const frontendDeploy = readFileSync(join(root, 'scripts/deploy-frontend-pages.mjs'), 'utf8');
  const frontendSmoke = readFileSync(join(root, 'scripts/smoke-frontend-live.mjs'), 'utf8');
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const workerPackageJson = readFileSync(join(root, 'worker/package.json'), 'utf8');
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const sandboxExample = readFileSync(join(root, '.env.sandbox.example'), 'utf8');
  const required = [
    'name = "insert-player-api-sandbox"',
    'ENVIRONMENT = "sandbox"',
    'https://insert-player-sandbox.pages.dev',
    'TURNSTILE_REQUIRED = "false"',
    'ANONYMOUS_ROOKIE_ENABLED = "false"',
    'database_name = "insert-player-sandbox-db"',
    'database_id = "f60b6e22-d262-4e46-a7d9-ca095e49d102"',
    'bucket_name = "insert-player-sandbox-assets"',
    'workers_dev = true',
    'preview_urls = false',
    "'.env.sandbox.local'",
    "'https://insert-player-api-sandbox.shellbot.workers.dev/api/billing/stripe-webhook'",
    "target === 'sandbox' && !/^sk_test_",
    "target === 'live' && !/^sk_live_",
    "target === 'sandbox' && args.has('--allow-live')",
    "'metadata[insert_player_environment]'",
    'Stripe sandbox business profile is incomplete',
    'new URL(url).origin !== new URL(environment.webhookUrl).origin',
    '"stripe:bootstrap:sandbox": "node scripts/bootstrap-stripe-catalog.mjs --target=sandbox"',
    '"config:sandbox": "node scripts/apply-sandbox-config.mjs --require-complete --deploy-worker"',
    '"deploy:worker:sandbox": "npm run sandbox:guard && npm run check:production && npm --prefix worker run deploy:sandbox"',
    '"db:migrate:sandbox": "npm --prefix worker run db:migrate:sandbox"',
    '"smoke:sandbox": "node scripts/smoke-sandbox.mjs"',
    '"check:frontend-sandbox": "node scripts/check-frontend-sandbox-env.mjs"',
    '"deploy:frontend:sandbox": "node scripts/deploy-frontend-pages.mjs --target=sandbox"',
    '"smoke:frontend-sandbox": "node scripts/smoke-frontend-live.mjs --target=sandbox"',
    '"build:sandbox": "npm run check:frontend && tsc && vite build --mode sandbox"',
    '"deploy:sandbox": "node ../scripts/wrangler-workspace-log.mjs deploy --config wrangler.sandbox.toml --keep-vars"',
    '"deploy": "node ../scripts/wrangler-workspace-log.mjs deploy --keep-vars"',
    '"db:migrate:sandbox": "node ../scripts/wrangler-workspace-log.mjs d1 migrations apply insert-player-sandbox-db --remote --config wrangler.sandbox.toml"',
    '!.env.sandbox.example',
    'STRIPE_SECRET_KEY=sk_test_replace_me',
    'ASF_STRIPE_WEBHOOK_URL=https://insert-player-api-sandbox.shellbot.workers.dev/api/billing/stripe-webhook',
    "health.body.environment === 'sandbox'",
    "health.body.billing !== 'stripe'",
    "health.body.anonymousRookie === 'disabled'",
    'forbiddenAllowOrigin !== productionOrigin',
    "['.env.sandbox', '.env.sandbox.local']",
    "VITE_CLERK_PUBLISHABLE_KEY must be the isolated Clerk development pk_test_ key.",
    'const files = isSandbox',
    "['.env.sandbox.local', '.env.sandbox']",
    "isSandbox ? 'check:frontend-sandbox' : 'check:frontend-live'",
    "isSandbox ? 'build:sandbox' : 'build'",
    "isSandbox ? 'smoke:frontend-sandbox' : 'smoke:frontend-live'",
    "const isSandbox = smokeTarget === 'sandbox'",
    'const expectedClerkPrefix = isSandbox ? /pk_test_/ : /pk_live_/',
    "for (const file of ['.env.sandbox', '.env.sandbox.local'])",
    "['wrangler', 'secret', 'bulk', '--config', 'wrangler.sandbox.toml']",
    'Refusing to configure the sandbox with a forbidden shared Stripe account.',
    'metadata.insert_player_environment !== \'sandbox\'',
    "run('sandbox Worker smoke', npm, ['run', 'smoke:sandbox'], root)",
    'assertDevelopmentDeployAllowed({ root })',
    'ASF_CANONICAL_DEVELOPMENT_ATTESTED_SHA',
    'Production Worker, D1, R2, env, and webhooks were not touched.',
  ];
  const combined = [
    sandboxConfig,
    sandboxConfigHelper,
    stripeBootstrap,
    sandboxSmoke,
    sandboxFrontendEnv,
    frontendDeploy,
    frontendSmoke,
    packageJson,
    workerPackageJson,
    gitignore,
    sandboxExample,
  ].join('\n');
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Sandbox isolation wiring is missing: ${missing.join(', ')}`);
  }

  const productionDatabaseId = productionConfig.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
  const sandboxDatabaseId = sandboxConfig.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
  const productionBucket = productionConfig.match(/bucket_name\s*=\s*"([^"]+)"/)?.[1];
  const sandboxBucket = sandboxConfig.match(/bucket_name\s*=\s*"([^"]+)"/)?.[1];
  const sandboxDatabaseName = sandboxConfig.match(/database_name\s*=\s*"([^"]+)"/)?.[1];
  if (!productionDatabaseId || !sandboxDatabaseId || productionDatabaseId === sandboxDatabaseId) {
    throw new Error('Production and sandbox must use different D1 database ids.');
  }
  if (!productionBucket || !sandboxBucket || productionBucket === sandboxBucket) {
    throw new Error('Production and sandbox must use different R2 buckets.');
  }
  if (
    textReferencesOrigin(sandboxConfig, 'https://api.insertplayer.ai')
    || sandboxDatabaseName === 'insert-player-db'
  ) {
    throw new Error('Sandbox Wrangler config references a production origin or database.');
  }
  const secretKeys = [
    'GEMINI_API_KEY',
    'FAL_API_KEY',
    'RUNWAY_API_KEY',
    'FREEPIK_API_KEY',
    'LUDO_API_KEY',
    'PIXCLI_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'CLERK_WEBHOOK_SIGNING_SECRET',
    'ANONYMIZATION_SECRET',
    'GENERATION_JOB_SIGNING_SECRET',
    'GOOGLE_MAPS_SERVER_KEY',
  ];
  const inlineSecrets = secretKeys.filter((key) => new RegExp(`^\\s*${key}\\s*=`, 'm').test(sandboxConfig));
  if (inlineSecrets.length > 0) {
    throw new Error(`Sandbox secrets must not be committed in Wrangler config: ${inlineSecrets.join(', ')}`);
  }
}

function assertLegalConsentAndPrivacyIsWired() {
  const legal = readFileSync(join(root, 'worker/src/legal.ts'), 'utf8');
  const auth = readFileSync(join(root, 'worker/src/auth.ts'), 'utf8');
  const billing = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const providerSessions = readFileSync(join(root, 'worker/src/providerSessions.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const migration = readFileSync(join(root, 'worker/migrations/0011_legal_consent_and_checkout_tax.sql'), 'utf8');
  const refundMigration = readFileSync(join(root, 'worker/migrations/0012_stripe_refund_and_dispute_adjustments.sql'), 'utf8');
  const billingClient = readFileSync(join(root, 'src/services/Billing.ts'), 'utf8');
  const consent = readFileSync(join(root, 'src/ui/components/LegalConsent.tsx'), 'utf8');
  const home = readFileSync(join(root, 'src/ui/routes/HomePage.tsx'), 'utf8');
  const create = readFileSync(join(root, 'src/ui/routes/CreateFighterPage.tsx'), 'utf8');
  const gallery = readFileSync(join(root, 'src/ui/routes/GalleryPage.tsx'), 'utf8');
  const legalConfig = readFileSync(join(root, 'src/ui/legal.ts'), 'utf8');
  const legalPage = readFileSync(join(root, 'src/ui/routes/LegalPage.tsx'), 'utf8');
  const legalFooter = readFileSync(join(root, 'src/ui/components/LegalFooter.tsx'), 'utf8');
  const communityPage = readFileSync(join(root, 'src/ui/routes/CommunityPage.tsx'), 'utf8');
  const characterPipeline = readFileSync(join(root, 'src/services/CharacterPipeline.ts'), 'utf8');
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const stripeBootstrap = readFileSync(join(root, 'scripts/bootstrap-stripe-catalog.mjs'), 'utf8');
  const liveSmoke = readFileSync(join(root, 'scripts/smoke-live.mjs'), 'utf8');
  const liveReadiness = readFileSync(join(root, 'scripts/check-live-readiness.mjs'), 'utf8');
  const wrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const combined = [
    legal,
    auth,
    billing,
    providerSessions,
    workerIndex,
    migration,
    refundMigration,
    billingClient,
    consent,
    home,
    create,
    gallery,
    legalConfig,
    legalPage,
    legalFooter,
    communityPage,
    fighters,
    stripeBootstrap,
    liveSmoke,
    liveReadiness,
  ].join('\n');
  const required = [
    "CURRENT_LEGAL_VERSION = '2026-08-23.1'",
    "LEGAL_VERSION = '2026-08-23.1'",
    "Paseo de la Castellana 126, 8th floor right, Madrid, Spain",
    "Registro Mercantil de Madrid, section 8, sheet M-784524",
    "type LegalPageKind = 'legal' | 'privacy' | 'terms' | 'refunds'",
    '>Legal Notice</a>',
    'href={`mailto:${SUPPORT_EMAIL}`}>Contact</a>',
    'AI-generated playable fighter',
    'parseGenerationLegalAttestation',
    'parseCheckoutLegalAttestation',
    'prepareLegalAcceptance',
    'CREATE TABLE IF NOT EXISTS legal_acceptances',
    'withdrawal_loss_acknowledged',
    "return json({ error: 'Current generation consent is required' }, 428)",
    "return json({ error: 'Current checkout consent is required' }, 428)",
    "appendForm(form, 'automatic_tax[enabled]', 'true')",
    "appendForm(form, 'consent_collection[terms_of_service]', 'none')",
    "appendForm(form, 'customer_update[address]', 'auto')",
    "price.tax_behavior !== 'inclusive'",
    "productTaxCode !== 'txcd_10201000'",
    "const PRODUCT_TAX_CODE = 'txcd_10201000'",
    "tax_behavior: 'inclusive'",
    'CREATE TABLE IF NOT EXISTS stripe_credit_adjustments',
    'stripe_payment_intent_id',
    'refunded_credits',
    'disputed_credits',
    'reversed_credits',
    'currentGenerationLegalAttestation()',
    'currentCheckoutLegalAttestation()',
    '<GenerationConsent',
    '<CheckoutConsent',
    'storedGenerationLegalAttestation()',
    'Process this photo only for my private fighter.',
    'process it solely to create and',
    'privately store this fighter in my Insert Player account.',
    'Neither my photo nor generated',
    'fighter will be visible to other players unless I later choose Publish.',
    'separate action and makes only the clean generated assets of that fighter public',
    'original photo, Clerk account identity, RAW files, or private generation history.',
    'not a licence to reuse my photo or private fighter.',
    'Player will not sell them, use',
    'them in advertising, or use them to train models.',
    "only to Google Gemini to create the fighter you requested",
    "Clerk and Stripe do not receive that uploaded photo",
    "generated frames, but not the original upload, to fal or Freepik",
    "Google does not use paid-service prompts, uploaded files, or responses to improve its products",
    'does not sell your photo or private fighter assets',
    'use either in advertising or promotion',
    'Your original photo remains private and is never published',
    'use either to train its own models',
    'Any permission needed to process and host your inputs is limited',
    'Publishing is optional and requires a separate confirmation.',
    'Clerk profile photos',
    'neutral author label Player',
    'A future public handle will require a separate opt-in.',
    "request.headers.get('CF-Connecting-IP')",
    "return `anon:${await hmacString(secret, address)}`",
    "throw new Error('ANONYMIZATION_SECRET is required')",
    "privacy: anonymousIdentifiersProtected ? 'pseudonymized' : 'not_configured'",
    'legalVersion: CURRENT_LEGAL_VERSION',
    "['privacy', 'pseudonymized']",
    "health.privacy === 'pseudonymized'",
  ];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Legal consent, checkout tax, or privacy protection is missing: ${missing.join(', ')}`);
  }
  if (/^\s*ANONYMIZATION_SECRET\s*=/m.test(wrangler)) {
    throw new Error('ANONYMIZATION_SECRET must remain a Worker secret, not a wrangler.toml var.');
  }
  const forbiddenProviderFallbacks = [
    "from './LudoApi'",
    'reposeWithFreepik',
    'generateSpriteWithLudo',
    'falling back to Freepik+Ludo',
    'falling back to Ludo',
    'using side view:',
    'using standing view as fallback',
  ].filter((snippet) => characterPipeline.includes(snippet));
  if (forbiddenProviderFallbacks.length > 0) {
    throw new Error(`Fighter generation must not change AI provider silently: ${forbiddenProviderFallbacks.join(', ')}`);
  }
}

function assertClerkAuthIsWired() {
  // The Clerk buttons render in AuthDock.tsx, which main.tsx mounts inside
  // ClerkProvider; both files together form the auth/user bridge.
  const main = [
    readFileSync(join(root, 'src/main.tsx'), 'utf8'),
    readFileSync(join(root, 'src/ui/App.tsx'), 'utf8'),
    readFileSync(join(root, 'src/ui/components/AuthDock.tsx'), 'utf8'),
    readFileSync(join(root, 'src/ui/shared/onboardingFlow.ts'), 'utf8'),
  ].join('\n');
  const apiClient = readFileSync(join(root, 'src/services/ApiClient.ts'), 'utf8');
  const auth = readFileSync(join(root, 'worker/src/auth.ts'), 'utf8');
  const index = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const required = [
    'ClerkProvider',
    'SignInButton',
    'SignUpButton',
    'onBeginSignUp={rememberPostSignUpTrialIntent}',
    'onBeginSignIn={clearPostSignUpTrialIntent}',
    'isNewAccountForOnboarding(user?.createdAt)',
    'consumePostSignUpTrialIntent()',
    'void startTrial()',
    'UserButton',
    'isLoaded',
    "'loading'",
    'configureApiAuth(isLoaded && isSignedIn ? () => getToken() : null)',
    "headers.set('Authorization', `${context.authorizationScheme ?? 'Bearer'} ${token}`)",
    'jwtVerify(token, getJwks(env)',
    'function getClerkIssuer',
    "throw new Error('CLERK_ISSUER is required')",
    'const verifyOptions = { issuer }',
    'const MAX_PUBLIC_NAME_CHARS',
    'function normalizePublicDisplayName',
    'function normalizeOptionalHttpsUrl',
    'function normalizeOptionalEmail',
    "avatarUrl: readStringClaim(claims, ['picture', 'image_url', 'avatar_url'])",
    'upsertClerkUserProfile(env, clerkUserId',
    'function decodePathParam',
    "return json({ error: 'Invalid path parameter' }, 400)",
    'function configuredAuthorizedParties',
    'function assertAuthorizedParty',
    "readStringClaim(claims, ['azp'])",
    'assertAuthorizedParty(claims, env, options)',
    'upsertClerkUser(env, clerkUserId, claims)',
    "if (path === '/auth/me' && method === 'GET')",
    'function healthResponse',
    "authConfigured ? 'clerk' : 'not_configured'",
    'stripeLiveConfigured',
    'stripeAccountPinned',
    'stripeCatalogPinned',
    'stripeTestConfigured',
    "billing: stripeLiveConfigured ? 'stripe' : stripeTestConfigured ? 'stripe_test' : 'not_configured'",
    "providers: allProvidersConfigured ? 'configured' : 'partial'",
    'creditsBalance: user.credits_balance',
    'freeRookieGenerationsUsed: user.free_rookie_generations_used',
  ];
  const combined = `${main}\n${apiClient}\n${auth}\n${index}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Clerk auth/user bridge is missing: ${missing.join(', ')}`);
  }
}

function assertClerkUserLifecycleIsWired() {
  const webhook = readFileSync(join(root, 'worker/src/clerkWebhooks.ts'), 'utf8');
  const webhookTests = readFileSync(join(root, 'worker/src/clerkWebhooks.test.ts'), 'utf8');
  const migration = readFileSync(join(root, 'worker/migrations/0009_clerk_user_lifecycle.sql'), 'utf8');
  const auth = readFileSync(join(root, 'worker/src/auth.ts'), 'utf8');
  const index = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const types = readFileSync(join(root, 'worker/src/types.ts'), 'utf8');
  const generatedTypes = readFileSync(join(root, 'worker/worker-configuration.d.ts'), 'utf8');
  const wrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const required = [
    "from '@clerk/backend/webhooks'",
    'verifyWebhook(verifiedRequest, { signingSecret: env.CLERK_WEBHOOK_SIGNING_SECRET })',
    'CLERK_WEBHOOK_SIGNING_SECRET: string',
    "path === '/api/clerk/webhook' && method === 'POST'",
    "accountLifecycle: env.CLERK_WEBHOOK_SIGNING_SECRET ? 'clerk_webhook' : 'not_configured'",
    'CREATE TABLE IF NOT EXISTS clerk_webhook_events',
    'CREATE TABLE IF NOT EXISTS clerk_user_tombstones',
    'subject_hash TEXT PRIMARY KEY',
    'export async function purgeR2Prefix',
    'bucket.list({ prefix, limit: R2_DELETE_BATCH_SIZE })',
    'await bucket.delete(keys)',
    'MAX_R2_DELETE_BATCHES_PER_DELIVERY',
    "DELETE FROM matches",
    "DELETE FROM users WHERE clerk_user_id = ?",
    'export async function deleteStripeCustomerProfile',
    "fetch('https://api.stripe.com/v1/account'",
    "method: 'DELETE'",
    'Stripe credentials do not match the configured Insert Player account',
    'stripeCustomerDeleted',
    'INSERT INTO clerk_user_tombstones',
    'WHERE NOT EXISTS (',
    'SELECT 1 FROM clerk_user_tombstones WHERE subject_hash = ?',
    "it('verifies, syncs, and de-duplicates a signed user event'",
    "it('deletes every R2 page, tombstones the subject, and removes the user'",
    "it('deletes the account-scoped Stripe Customer before removing local account rows'",
    "it('bounds a single R2 purge attempt so webhook retries can continue large deletions'",
  ];
  const combined = `${webhook}\n${webhookTests}\n${migration}\n${auth}\n${index}\n${types}\n${generatedTypes}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Clerk user lifecycle handling is missing: ${missing.join(', ')}`);
  }
  if (/^\s*CLERK_WEBHOOK_SIGNING_SECRET\s*=/m.test(wrangler)) {
    throw new Error('CLERK_WEBHOOK_SIGNING_SECRET must remain a Worker secret, not a wrangler.toml var.');
  }
}

function assertCommunityAssetsAreSanitized() {
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const assetIndexes = readFileSync(join(root, 'worker/migrations/0015_asset_lookup_indexes.sql'), 'utf8');
  const fighterIntegrationTests = readFileSync(join(root, 'worker/src/fighters.integration.test.ts'), 'utf8');
  const gallery = readFileSync(join(root, 'src/ui/routes/GalleryPage.tsx'), 'utf8');
  const community = readFileSync(join(root, 'src/ui/routes/CommunityPage.tsx'), 'utf8');
  const communityState = readFileSync(join(root, 'src/ui/shared/communityState.ts'), 'utf8');
  const communityStateTests = readFileSync(join(root, 'src/ui/shared/communityState.test.ts'), 'utf8');
  const share = readFileSync(join(root, 'src/ui/shared/communityShare.ts'), 'utf8');
  const index = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const liveSmoke = readFileSync(join(root, 'scripts/smoke-live.mjs'), 'utf8');
  const forbidden = [
    'for (const kind of SOURCE_KINDS)',
    'copyR2Object(env, sprite.raw_blob_key',
    '...serialized,\n    sources:',
    'public, max-age=31536000, immutable',
    "'unsafe-inline'",
  ];
  const required = [
    'function serializeCommunityFighter',
    'ownerUserId: _ownerUserId',
    'photoHash: _photoHash',
    "name: 'Player'",
    '...publicFighter',
    'sprites: sprites.map',
    'function publicSourceAssetUrl',
    'function publicSpriteAssetUrl',
    '/public-assets/fighters/',
    'export async function getCommunityFighter',
    'export async function listOwnedCommunityFighterIds',
    "path === '/api/community/ownership'",
    'JOIN fighters owned',
    'listOwnedCommunityFighterIds(apiContext)',
    'getCommunityFighter(featuredId, apiContext)',
    "setLoadState({ phase: 'not-found' })",
    'resolveFeaturedCommunityFighter(fighters, featuredId)',
    'Fighter Not Found',
    'This shared fighter is no longer public.',
    'never substitutes the first fighter for an invalid shared id',
    'PUBLIC_CLONE_SOURCE_KINDS',
    "['side', 'upright', 'crouch']",
    'for (const kind of PUBLIC_CLONE_SOURCE_KINDS)',
    'original: null',
    'sideRaw: null',
    'rawUrl: null',
    'function copyCommunitySpritesToFighter',
    'function copiedSourceVersionStatements',
    'INSERT INTO sprite_versions',
    'ON CONFLICT(fighter_id, animation_name, quality_tier) DO NOTHING',
    'rethrowAfterCopiedAssetCleanup',
    'getOwnedFighterByPhotoHash',
    'maxTier(existing.quality_tier, source.quality_tier)',
    'COALESCE(side_view_blob_key, ?)',
    'export async function shareCommunityFighterPage',
    "path.match(/^\\/share\\/([^/]+)$/)",
    'meta property="og:image"',
    'meta property="og:image:alt"',
    'meta name="twitter:image:alt"',
    'link rel="canonical"',
    'const HTML_SECURITY_HEADERS',
    "'Content-Security-Policy'",
    "script-src 'none'",
    "script-src 'nonce-${redirectScriptNonce}'",
    'const redirectScriptNonce = generateId()',
    'nonce="${escapeHtml(redirectScriptNonce)}"',
    "frame-ancestors 'none'",
    'window.location.replace',
    'apiUrl(sharePath)',
    'communityDeepLinkUrl',
    'PUBLIC_COMMUNITY_CACHE_HEADERS',
    's-maxage=300',
    'function readCommunityLimit',
    'Number.isFinite(parsed)',
    'Math.min(Math.max(Math.round(parsed), 1), 96)',
    'PUBLIC_SHARE_CACHE_HEADERS',
    's-maxage=900',
    'NO_STORE_HEADERS',
    'PLAYABLE_ANIMATION_NAMES',
    'PLAYABLE_ANIMATION_COUNT',
    'AURA_ANIMATION_NAMES',
    'AURA_ANIMATION_SQL_LIST',
    'function getAvailableAnimationNames',
    'function animationPackSpriteSetSql',
    'function auraSpriteSetSql',
    'function anyPlayableSpriteSetSql',
    'COUNT(DISTINCT s.animation_name)',
    's.animation_name IN (${animationSqlList})',
    'function resolvePublicFlag',
    'Upload a complete Fight or Aura animation pack before publishing',
    'assetPacks: [',
    'missingAnimations',
    'const MAX_FIGHTER_NAME_CHARS',
    'function cleanFighterNameString',
    'function normalizeFighterName',
    "replace(/[\\u0000-\\u001f\\u007f]/g, ' ')",
    'Array.from(normalized).slice(0, MAX_FIGHTER_NAME_CHARS).join',
    'playableSpriteSetSql',
    'function decodeAssetKey',
    "!decodedKey.startsWith('users/')",
    'segments.some((segment) => !segment',
    'function namespacedAssetOwner',
    '!auth.userId || namespaceOwner !== auth.userId',
    'function publicAssetRevision',
    'export async function getPublicFighterSourceAsset',
    'export async function getPublicFighterSpriteAsset',
    'PUBLIC_ASSET_CACHE_HEADERS',
    'public, max-age=60, s-maxage=300, must-revalidate',
    'publicSourceAssetMatch = path.match',
    'publicSpriteAssetMatch = path.match',
    "serves owner assets across devices and keeps namespaced asset keys owner-only",
    "not.toContain('/assets/users/')",
    "not.toContain('user-target')",
    'const revokedSource = await getPublicFighterSourceAsset',
    'function assertOpaqueCommunityAssets',
    "expectStatus('revoked public sprite'",
    'unpublishing revokes opaque public assets and community detail',
    'private, no-store',
    'X-Content-Type-Options',
    'communityFighterUrl',
    'copyToClipboard',
    'shareCommunityFighter',
    'navigator.share',
    "get('fighter')",
    'Share Link',
  ];
  if (
    fighters.includes('owner_avatar_url') ||
    /\bowner_name\b/.test(fighters) ||
    fighters.includes('JOIN users u ON u.id = f.owner_user_id') ||
    fighters.includes('avatarUrl: normalizeOptionalHttpsUrl')
  ) {
    throw new Error('Community payloads must not expose Clerk account profile fields.');
  }
  const implementationCombined = `${fighters}\n${assetIndexes}\n${fighterIntegrationTests}\n${gallery}\n${community}\n${communityState}\n${communityStateTests}\n${share}\n${index}`;
  const combined = `${implementationCombined}\n${liveSmoke}`;
  const foundForbidden = forbidden.filter((snippet) => implementationCombined.includes(snippet));
  if (foundForbidden.length > 0) {
    throw new Error(`Community clone privacy must not copy private intermediates: ${foundForbidden.join(', ')}`);
  }
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Community asset privacy hardening is missing: ${missing.join(', ')}`);
  }
}

function assertCommunityModerationIsWired() {
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const moderation = readFileSync(join(root, 'worker/src/moderation.ts'), 'utf8');
  const rateLimit = readFileSync(join(root, 'worker/src/rateLimit.ts'), 'utf8');
  const index = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const migration = readFileSync(join(root, 'worker/migrations/0013_community_moderation.sql'), 'utf8');
  const tests = readFileSync(join(root, 'worker/src/communityReports.integration.test.ts'), 'utf8');
  const client = readFileSync(join(root, 'src/services/CommunityModeration.ts'), 'utf8');
  const page = readFileSync(join(root, 'src/ui/routes/ModerationPage.tsx'), 'utf8');
  const homePage = readFileSync(join(root, 'src/ui/routes/HomePage.tsx'), 'utf8');
  const communityPage = readFileSync(join(root, 'src/ui/routes/CommunityPage.tsx'), 'utf8');
  const maintenance = readFileSync(join(root, 'worker/src/maintenance.ts'), 'utf8');
  const clerkWebhooks = readFileSync(join(root, 'worker/src/clerkWebhooks.ts'), 'utf8');
  const clerkWebhookTests = readFileSync(join(root, 'worker/src/clerkWebhooks.test.ts'), 'utf8');
  const authIntegrationTests = readFileSync(join(root, 'worker/src/auth.integration.test.ts'), 'utf8');
  const required = [
    'export async function reportCommunityFighter',
    'MAX_COMMUNITY_REPORT_BODY_BYTES',
    'MAX_COMMUNITY_REPORT_DETAILS_CHARS',
    'COMMUNITY_REPORT_REASONS',
    "fighter.owner_user_id === auth.userId",
    'ON CONFLICT(fighter_id, reporter_user_id) DO UPDATE SET',
    "status = 'open'",
    'submission_count = community_reports.submission_count + 1',
    "'community:report'",
    'signedIn: { limit: 10, windowSeconds: 24 * 60 * 60 }',
    "path.match(/^\\/api\\/community\\/([^/]+)\\/report$/)",
    'CREATE TABLE IF NOT EXISTS community_reports',
    'UNIQUE(fighter_id, reporter_user_id)',
    'reviewed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL',
    'export async function listCommunityReports',
    'export async function moderateCommunityReport',
    "auth.user.plan_tier === 'admin'",
    "data.private_metadata?.insert_player_role === 'admin'",
    "WHEN plan_tier = 'admin' THEN 'free'",
    "status === 'actioned'",
    "UPDATE fighters\n      SET public_flag = 0",
    "path === '/api/admin/community-reports'",
    "path.match(/^\\/api\\/admin\\/community-reports\\/([^/]+)$/)",
    'export async function listCommunityModerationReports',
    'export async function updateCommunityModerationReport',
    'export function ModerationPage',
    'billingProfile?.planTier === \'admin\'',
    'Person shown without consent',
    'Sign in to report a public fighter',
    'Report sent for review',
    'Remove Fighter',
    "DELETE FROM community_reports",
    "status IN ('dismissed', 'actioned')",
    "it('keeps the queue admin-only and requires an audited note for closing actions'",
    "it('grants and revokes moderation access from signed Clerk private metadata only'",
    "it('persists Clerk private-metadata admin grants and safe revocation in real D1'",
  ];
  const combined = [
    fighters,
    moderation,
    rateLimit,
    index,
    migration,
    tests,
    client,
    page,
    homePage,
    communityPage,
    maintenance,
    clerkWebhooks,
    clerkWebhookTests,
    authIntegrationTests,
  ].join('\n');
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Community moderation hardening is missing: ${missing.join(', ')}`);
  }
}

function assertUploadAbuseLimits() {
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const proxy = readFileSync(join(root, 'worker/src/proxy.ts'), 'utf8');
  const required = [
    'const MAX_SOURCE_UPLOAD_BYTES',
    'const MAX_SPRITE_UPLOAD_BYTES',
    'const MAX_SPRITE_FRAME_DIMENSION',
    'const MAX_SPRITE_FRAME_COUNT',
    'const ALLOWED_UPLOAD_IMAGE_TYPES',
    'function rejectOversizedUpload',
    'function validateUploadedImageBytes',
    '`${label} is too large`',
    "'Source image'",
    "'Sprite sheet'",
    "'Raw sprite sheet'",
    'content type does not match the uploaded bytes',
    'roundedFrameCount > MAX_SPRITE_FRAME_COUNT',
    'roundedProcessingVersion > MAX_PROCESSING_VERSION',
    'const MAX_TEMP_ASSET_BYTES',
    'function isBase64TempAssetTooLarge',
    'Temp image is too large',
  ];
  const combined = `${fighters}\n${proxy}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Upload abuse controls are missing: ${missing.join(', ')}`);
  }
}

function assertAppConsoleLogsAreDebugGated() {
  const allowedFiles = new Set(['src/services/DebugLog.ts']);
  const offenders = [];
  for (const file of walk(join(root, 'src'))) {
    const rel = relative(root, file);
    if (allowedFiles.has(rel)) continue;
    if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue;
    const text = readFileSync(file, 'utf8');
    const matches = text.match(/console\.(log|info|warn)\s*\(/g);
    if (matches) {
      offenders.push(`${rel}: ${matches.join(', ')}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Production app console logs must use DebugLog helpers:\n${offenders.join('\n')}`);
  }

  const debugLog = readFileSync(join(root, 'src/services/DebugLog.ts'), 'utf8');
  const required = [
    'export function debugInfo',
    'export function debugWarn',
    'metaEnv?.DEV',
    "typeof window !== 'undefined'",
    "window.localStorage.getItem('asf:debug')",
    'window.__ASF_DEBUG_LOGS__',
  ];
  const missing = required.filter((snippet) => !debugLog.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Debug logging gate is missing: ${missing.join(', ')}`);
  }
}

function assertMatchReportingIsWired() {
  // GamePage owns the match-complete listener; App.tsx routes to it.
  const app = [
    readFileSync(join(root, 'src/ui/App.tsx'), 'utf8'),
    readFileSync(join(root, 'src/ui/routes/GamePage.tsx'), 'utf8'),
  ].join('\n');
  const fightScene = readFileSync(join(root, 'src/game/scenes/FightScene.ts'), 'utf8');
  const matchConfig = readFileSync(join(root, 'src/game/match/MatchConfig.ts'), 'utf8');
  const reporting = readFileSync(join(root, 'src/services/MatchReporting.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const workerMatchReporting = readFileSync(join(root, 'worker/src/matchReporting.ts'), 'utf8');
  const leaderboard = readFileSync(join(root, 'worker/src/leaderboard.ts'), 'utf8');
  const smoke = readFileSync(join(root, 'scripts/smoke-live.mjs'), 'utf8');
  const combined = `${app}\n${fightScene}\n${matchConfig}\n${reporting}\n${workerIndex}\n${workerMatchReporting}\n${leaderboard}\n${smoke}`;
  const required = [
    "MATCH_COMPLETE_EVENT = 'asf-match-complete'",
    'window.dispatchEvent(new CustomEvent(MATCH_COMPLETE_EVENT',
    'reportMatchCompletion(event.detail)',
    "apiFetch('/api/matches'",
    'ensureSystemUser',
    "opponentKind === 'local' ? 'local' : 'cpu'",
    'const MAX_MATCH_ROUNDS = 5',
    'const MAX_MATCH_DURATION_SECONDS = 20 * 60',
    'function readBoundedInteger',
    'function readOptionalId',
    'readMatchFighterId',
    "f.public_flag = 1 AND arcade.status = 'active'",
    'Match fighter is not owned or an active Arcade fighter',
    'isAttractModeMatchReport(body)',
    'recorded: false',
    'const player2Id = systemOpponentId',
    "const winnerId = winnerSlot === 'p2' ? player2Id : auth.userId",
    'Stats are private',
    'signed-out /api/stats/:userId is protected',
    'const p1FighterId = await readMatchFighterId(env, auth.userId, body.p1FighterId)',
    'const p2FighterId = await readMatchFighterId(env, auth.userId, body.p2FighterId)',
    'roundsP1: readBoundedInteger(body.roundsP1, 0, MAX_MATCH_ROUNDS)',
    'duration: readBoundedInteger(body.duration, 0, MAX_MATCH_DURATION_SECONDS)',
    'p1FighterId,\n            p2FighterId',
    'isRanked: false',
    "'match report'",
    'function updateUnrankedRecord',
    'wins = wins + 1',
    'match reporting updates signed-in record',
    'match reporting rejects foreign community fighter ids',
    "'authenticated Arcade roster'",
    'const activeArcadeFighterId = authenticatedArcadeBody.fighters[0]?.id ?? null',
    'Attract Mode does not persist history or change personal W/L',
    'match reporting accepts active published Arcade fighter ids',
  ];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Match reporting persistence is missing: ${missing.join(', ')}`);
  }
}

function assertLeaderboardSurfaceIsWired() {
  const leaderboardService = readFileSync(join(root, 'src/services/Leaderboard.ts'), 'utf8');
  const homePage = readFileSync(join(root, 'src/ui/routes/HomePage.tsx'), 'utf8');
  const styles = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
  const workerLeaderboard = readFileSync(join(root, 'worker/src/leaderboard.ts'), 'utf8');
  const smoke = readFileSync(join(root, 'scripts/smoke-live.mjs'), 'utf8');
  const required = [
    "apiFetch('/api/leaderboard')",
    "apiFetch('/api/stats')",
    'getLeaderboard(5)',
    "authStatus === 'signed-in' ? getMyStats()",
    'home-dashboard',
    'home-board__row',
    "WHERE oauth_provider != 'system' AND (wins + losses) > 0",
    'ORDER BY wins DESC, win_rate DESC, elo_rating DESC, updated_at DESC',
    'id: `rank:${index + 1}`',
    'display_name: normalizePublicDisplayName(row.display_name)',
    'avatar_url: normalizeOptionalHttpsUrl(row.avatar_url)',
    'p1_name: normalizePublicDisplayName(match.p1_name)',
    'p2_name: normalizePublicDisplayName(match.p2_name)',
    'function assertLeaderboardProfile',
    "assertLeaderboardProfile(entry, 'Leaderboard')",
    '/api/leaderboard exposed raw Clerk user ids',
    '/api/leaderboard exposes public fight board',
  ];
  const combined = `${leaderboardService}\n${homePage}\n${styles}\n${workerLeaderboard}\n${smoke}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Leaderboard/stats product surface is missing: ${missing.join(', ')}`);
  }
}

function assertLiveSmokeCoversCriticalPaths() {
  const smoke = readFileSync(join(root, 'scripts/smoke-live.mjs'), 'utf8');
  const smokeFetch = readFileSync(join(root, 'scripts/live-smoke-fetch.mjs'), 'utf8');
  const smokeFetchTests = readFileSync(join(root, 'scripts/live-smoke-fetch.test.mjs'), 'utf8');
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const runbook = readFileSync(join(root, 'PRODUCTION_READINESS.md'), 'utf8');
  const required = [
    '"smoke:live:launch": "node scripts/smoke-live.mjs --require-auth --require-clone"',
    'function readEnvValues',
    "'.env.production.local'",
    "envValue(env, 'ASF_WORKER_URL')",
    "envValue(env, 'VITE_API_BASE_URL')",
    "envValue(env, 'ASF_FRONTEND_ORIGIN')",
    "envValue(env, 'ASF_FRONTEND_URL')",
    "envValue(env, 'ASF_CLERK_JWT')",
    'FETCH_TIMEOUT_MS',
    'ASF_LIVE_SMOKE_TIMEOUT_MS',
    'fetchWithTransientNetworkRetry',
    'ASF_LIVE_SMOKE_SAFE_FETCH_ATTEMPTS',
    'ASF_LIVE_SMOKE_SAFE_FETCH_RETRY_DELAY_MS',
    "const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])",
    'const retryable = RETRYABLE_METHODS.has(method) && !init.signal',
    'signal: init.signal ?? AbortSignal.timeout(timeoutMs)',
    "it('never retries a mutating request'",
    "it('does not retry when the caller owns the abort signal'",
    'Request failed for ${target}',
    'ASF_SMOKE_REQUIRE_AUTH',
    'ASF_SMOKE_REQUIRE_CLONE',
    "process.argv.includes('--require-auth')",
    "process.argv.includes('--require-clone')",
    'function assertDistinctCloneSmokeUser',
    'ASF_CLERK_JWT must be set when ASF_CLERK_JWT_CLONE is set.',
    'ASF_CLERK_JWT_CLONE must come from a second Clerk user, not the primary smoke user.',
    'ASF_CLERK_JWT_CLONE must use a different Clerk user subject than ASF_CLERK_JWT.',
    'launch smoke tokens identify two different Clerk users',
    'ASF_CLERK_JWT is required for launch smoke',
    'ASF_CLERK_JWT_CLONE is required for launch clone/privacy smoke',
    'npm run smoke:live:launch',
    'ASF_SMOKE_RATE_LIMIT',
    'Retry-After',
    'Anonymous proxy rate limit did not return 429',
    'const firstSourceUpload = await uploadSource(smokeFighterId)',
    'const secondSourceUpload = await uploadSource(smokeFighterId)',
    'Duplicate source upload did not reuse the archived content-addressed asset',
    'const firstSpriteUpload = await uploadSprite(smokeFighterId)',
    'const secondSpriteUpload = await uploadSprite(smokeFighterId)',
    'Duplicate sprite upload did not reuse the archived content-addressed asset',
    'Owned fighter detail did not include spriteVersions',
    'Owned fighter list should not include bulky spriteVersions',
    'assertAuthenticatedGenerationBilling',
    '/health did not report production environment',
    '/health did not report D1 binding',
    '/health did not report configured provider secrets',
    '/health reports test Stripe on the production Worker',
    'Launch smoke requires /health to report Clerk auth; got',
    'Launch smoke requires /health to report live Stripe billing; got',
    'launchHealthErrors.join',
    'Public smoke warning: /health reports auth=',
    'Use npm run check:launch for launch readiness.',
    'live_smoke_rookie_release',
    'authenticated Rookie generation releases an unused reservation idempotently',
    'live_smoke_contender_release',
    'authenticated paid-tier generation enforces credits',
    'authenticated paid-tier generation releases an unused reservation',
    'live_smoke_foreign_fighter_guard',
    'generation authorization rejects foreign fighter ids before reservation',
    'provider proxy blocks non-allowlisted routes',
    'provider proxy requires an authorized provider session',
    'provider-session CORS preflight allows browser provider calls',
    'Provider-session CORS preflight did not allow X-ASF-Provider-Session',
    'CORS preflight reflected an unconfigured origin',
    'CORS preflight does not reflect unconfigured origins',
    'provider proxy blocks broad result listing',
    'signed-out Rookie generation authorization is rate-limited',
    'signed-out Rookie generation requires a server-verified Turnstile token',
    'signed-out /api/billing/checkout is protected',
    'signed-out community reporting is protected',
    'signed-out moderation queue is protected',
    'invalid bearer generation auth is not downgraded to anonymous',
    'Invalid bearer generation auth should not mint a provider session',
    'Signed-out Rookie without Turnstile minted a provider session',
    'Signed-in Rookie generation did not expose the Rookie provider call limit',
    'Signed-in Contender generation did not expose the Contender provider call limit',
    '/proxy/image requires an authorized provider session',
    '/proxy/media requires an authorized provider session',
    'temp upload session requirement',
    '/proxy/upload-temp requires an authorized provider session before R2 writes',
    'missing community share page',
    'missing community detail',
    'function assertSharePageSecurityHeaders',
    "assertSharePageSecurityHeaders(missingShare, 'Missing share page')",
    'community feed cache headers',
    'community feed invalid limit fallback',
    'malformed public route parameters return 400',
    'malformed temp asset paths return 400',
    'Community feed is missing short shared-cache headers',
    'Community feed exposed ownerUserId',
    'Community feed exposed photoHash',
    'Community detail is missing short shared-cache headers',
    'public feed fighter share page',
    'Public feed share page missing Open Graph image alt text',
    'Public feed share page redirect script missing CSP nonce',
    "assertSharePageSecurityHeaders(sharePage, 'Public feed share page')",
    'public feed share page exposes crawler-ready fighter metadata',
    'Community listing exposed ownerUserId',
    'Community detail exposed ownerUserId',
    'Community listing exposed photoHash',
    'Community detail exposed photoHash',
    'function assertCommunityOwner',
    "assertCommunityOwner(fighter.owner, 'Community feed')",
    "assertCommunityOwner(published.owner, 'Community listing')",
    "assertCommunityOwner(detail.fighter.owner, 'Community detail')",
    'Created fighter name retained control characters',
    'Created fighter name exceeded the public metadata cap',
    'Share page is missing shared-cache headers',
    'community fighter detail',
    'Community detail did not return the published fighter',
    'published fighter share page',
    'Share page missing Open Graph image',
    "assertSharePageSecurityHeaders(sharePage, 'Share page')",
    'Share page missing Open Graph image alt text',
    'Share page missing Twitter image alt text',
    'Share page missing canonical community link',
    'Share page redirect script missing CSP nonce',
    'CSP allows unsafe inline script',
    'partial fighter publish should be blocked',
    'Partial publish response did not list missing launch animations',
    'community publishing requires the full launch animation set',
    'Community listing did not include the full launch animation set',
    'Community detail did not include the full launch animation set',
    'const requiredProductionArcadeSlugs',
    "'donald-trump'",
    "'lamine-yamal'",
    "'rosalia-v2'",
    "'elon-musk'",
    'Official Arcade is missing required production fighter',
    'Official Arcade still exposes the superseded Rosalía fighter',
    'Promoted Rosalía has the wrong public display name',
    'Promoted Rosalía did not inherit the legacy roster rank',
    'Official Arcade fighter ${fighter.arcade.slug} is missing playable animation ${animationName}',
    'Official Arcade fighter ${fighter.arcade.slug} has no immutable hash for ${animationName}',
    'Official Arcade fighter ${fighter.arcade.slug} has invalid playback metadata for ${animationName}',
    'create same-photo clone target',
    'Community clone did not merge into the existing same-photo fighter',
    'Same-photo community clone merge should return cloned=false',
    'same-photo community clone merge copies only public playable assets',
  ];
  const combined = `${smoke}\n${smokeFetch}\n${smokeFetchTests}\n${packageJson}\n${runbook}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Live smoke coverage is missing: ${missing.join(', ')}`);
  }
}

function assertLiveSmokeHasNoUndefinedNames() {
  const smokePath = join(root, 'scripts/smoke-live.mjs');
  const program = ts.createProgram([smokePath], {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const undefinedNameDiagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.code === 2304 || diagnostic.code === 2552);
  if (undefinedNameDiagnostics.length === 0) return;

  const offenders = undefinedNameDiagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (!diagnostic.file || diagnostic.start === undefined) return message;
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${relative(root, diagnostic.file.fileName)}:${position.line + 1}:${position.character + 1}: ${message}`;
  });
  throw new Error(`Live smoke contains undefined names:\n${offenders.join('\n')}`);
}

function assertLaunchGateIsWired() {
  const launchGate = readFileSync(join(root, 'scripts/check-launch.mjs'), 'utf8');
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const runbook = readFileSync(join(root, 'PRODUCTION_READINESS.md'), 'utf8');
  const audit = readFileSync(join(root, 'PRODUCTION_AUDIT.md'), 'utf8');
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const example = readFileSync(join(root, 'launch-validation.example.json'), 'utf8');
  const brandExample = readFileSync(join(root, 'brand-clearance.example.json'), 'utf8');
  const brandingRunbook = readFileSync(join(root, 'BRANDING.md'), 'utf8');
  const brandScript = readFileSync(join(root, 'scripts/apply-public-brand.mjs'), 'utf8');
  const required = [
    '"check:launch": "node scripts/check-launch.mjs"',
    '"brand:apply": "node scripts/apply-public-brand.mjs"',
    '"brand:rasterize": "node scripts/rasterize-public-assets.mjs"',
    "'.env.production.local'",
    "'.launch-validation.json'",
    "'.brand-clearance.json'",
    'launch-validation.example.json',
    'brand-clearance.example.json',
    'BRANDING.md',
    'ASF_LAUNCH_VALIDATION_FILE',
    'ASF_BRAND_CLEARANCE_FILE',
    'ASF_PUBLIC_APP_NAME',
    'BRAND_CLEARANCE_MAX_AGE_DAYS',
    'evidence_replace_me',
    'MANUAL_VALIDATION_MAX_AGE_DAYS',
    'DEFAULT_MANUAL_VALIDATION_FILE',
    'DEFAULT_BRAND_CLEARANCE_FILE',
    'REQUIRED_MANUAL_CHECKS',
    'function assertBrandClearance',
    'function assertNoInternalBrandOnPublicSurfaces',
    'const staticBrandFiles',
    'const dynamicBrandFiles',
    'const dynamicBrandChecks',
    'Dynamic public brand surface ${file} must read the cleared public brand',
    'clearanceStatus must be "cleared_for_launch"',
    'publicBrandName must not use "AI Street Fighter", "Street Fighter", or Capcom-adjacent wording',
    'productionOrigin must use the cleared public brand domain',
    'Public brand surface ${file} still contains the internal/Capcom-adjacent "Street Fighter" name.',
    'Brand clearance file is required',
    'function assertManualLaunchValidation',
    'function assertEvidenceCheck',
    'Manual launch validation file is required',
    'Manual launch validation checks.${checkId}.evidence must describe concrete evidence.',
    'schemaVersion',
    'CURRENT_LEGAL_VERSION',
    'legalVersion must match',
    'publicBrandName',
    'publicShortName',
    'brand_metadata_social_preview',
    'Manual launch validation publicBrandName must match brand clearance publicBrandName.',
    'Manual launch validation checks.brand_metadata_social_preview.evidence must mention the cleared public brand name.',
    'tierFighterIds',
    'primaryClerkUserId',
    'secondaryClerkUserId',
    'primaryClerkUserId must match ASF_CLERK_JWT subject',
    'secondaryClerkUserId must match ASF_CLERK_JWT_CLONE subject',
    'signed_out_rookie_policy',
    'legal_pages_and_generation_consent',
    'support_email_delivery',
    'stripe_test_checkout_credit',
    'stripe_checkout_consent_tax_customer',
    'stripe_live_checkout_credit',
    'champion_generation_commit_cloud_sync',
    'second_device_import_and_play',
    'version_preservation_after_upgrade',
    'source_views_pro_all_tiers',
    'bg_removal_face_integrity',
    'function readEnvValues',
    'function resolveEnv',
    'Object.fromEntries(envValues)',
    'normalizedHttpsUrl',
    'ASF_WORKER_URL',
    'ASF_WORKER_URL/VITE_API_BASE_URL must use the cleared public brand Worker/API URL',
    'ASF_FRONTEND_URL or ASF_FRONTEND_ORIGIN',
    'ASF_CLERK_JWT',
    'ASF_CLERK_JWT_CLONE',
    'must be a JWT-like Clerk session token',
    'function decodeJwtPayload',
    'function jwtSubject',
    'function assertJwtFresh',
    'DEFAULT_LAUNCH_TIMEOUTS_MS',
    'function resolveNumberEnv',
    'function launchTimeoutFor',
    'timeout: timeoutMs',
    'timed out after',
    'ASF_LAUNCH_CHECK_PRODUCTION_TIMEOUT_MS',
    'ASF_LAUNCH_CHECK_LIVE_READINESS_TIMEOUT_MS',
    'ASF_LAUNCH_SMOKE_FRONTEND_LIVE_TIMEOUT_MS',
    'ASF_LAUNCH_SMOKE_LIVE_LAUNCH_TIMEOUT_MS',
    'MIN_JWT_TTL_SECONDS',
    'must include a Clerk subject claim',
    'must include a numeric expiration claim',
    'expires too soon for launch smoke',
    'ASF_CLERK_JWT_CLONE must come from a second Clerk user',
    'ASF_CLERK_JWT_CLONE must use a different Clerk user subject',
    'ASF_WORKER_HEALTH_URL',
    'ASF_SMOKE_REQUIRE_AUTH',
    'ASF_SMOKE_REQUIRE_CLONE',
    "run('check:production', launchEnv, launchTimeoutFor(envValues, 'check:production'))",
    "run('check:live-readiness', launchEnv, launchTimeoutFor(envValues, 'check:live-readiness'))",
    "run('smoke:frontend-live', launchEnv, launchTimeoutFor(envValues, 'smoke:frontend-live'))",
    "run('smoke:live:launch', launchEnv, launchTimeoutFor(envValues, 'smoke:live:launch'))",
    'npm run check:launch',
    'brand clearance, manual validation evidence, production checks, live readiness, Pages smoke, and authenticated Worker smoke all succeeded',
  ];
  const combined = `${launchGate}\n${packageJson}\n${runbook}\n${audit}\n${gitignore}\n${example}\n${brandExample}\n${brandingRunbook}\n${brandScript}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Final launch gate wiring is missing: ${missing.join(', ')}`);
  }
}

function assertBrandingPlumbingIsWired() {
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const applyBrand = readFileSync(join(root, 'scripts/apply-public-brand.mjs'), 'utf8');
  const rasterizeBrand = readFileSync(join(root, 'scripts/rasterize-public-assets.mjs'), 'utf8');
  const uiBrand = readFileSync(join(root, 'src/ui/publicBrand.ts'), 'utf8');
  const homePage = readFileSync(join(root, 'src/ui/routes/HomePage.tsx'), 'utf8');
  const communityShare = readFileSync(join(root, 'src/ui/shared/communityShare.ts'), 'utf8');
  const workerBrand = readFileSync(join(root, 'worker/src/branding.ts'), 'utf8');
  const workerTypes = readFileSync(join(root, 'worker/src/types.ts'), 'utf8');
  const workerFighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const workerBilling = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const stripeBootstrap = readFileSync(join(root, 'scripts/bootstrap-stripe-catalog.mjs'), 'utf8');
  const liveConfig = readFileSync(join(root, 'scripts/apply-live-config.mjs'), 'utf8');
  const envExample = readFileSync(join(root, '.env.example'), 'utf8');
  const envProductionExample = readFileSync(join(root, '.env.production.example'), 'utf8');
  const workerDevVars = readFileSync(join(root, 'worker/.dev.vars.example'), 'utf8');
  const wrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const required = [
    '"brand:apply": "node scripts/apply-public-brand.mjs"',
    'function cleanBrandText',
    'must not use existing fighting-game franchise wording',
    'updateHtml',
    'updateManifest',
    'updateSocialCardTemplate',
    'updateSocialSvg',
    'run npm run brand:rasterize before launch',
    'const assets = [',
    'PNG32:',
    'VITE_PUBLIC_APP_NAME',
    'VITE_PUBLIC_APP_SHORT_NAME',
    'PUBLIC_APP_NAME',
    'PUBLIC_APP_SHORT_NAME',
    'PUBLIC_SOCIAL_CARD_PATH',
    'export const PUBLIC_APP_NAME',
    '<h1>{PUBLIC_APP_NAME}</h1>',
    'Challenge ${fighterName} in ${PUBLIC_APP_NAME}.',
    'function publicAppName',
    'function publicSocialCardUrl',
    'const appName = publicAppName(env)',
    '${brandName} ${pack.label}',
  ];
  const combined = [
    packageJson,
    applyBrand,
    rasterizeBrand,
    uiBrand,
    homePage,
    communityShare,
    workerBrand,
    workerTypes,
    workerFighters,
    workerBilling,
    stripeBootstrap,
    liveConfig,
    envExample,
    envProductionExample,
    workerDevVars,
    wrangler,
  ].join('\n');
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Public brand plumbing is missing: ${missing.join(', ')}`);
  }

  const productionCode = [
    readFileSync(join(root, 'src/services/FreepikApi.ts'), 'utf8'),
    readFileSync(join(root, 'src/services/GeminiApi.ts'), 'utf8'),
    readFileSync(join(root, 'src/services/IntroVideoService.ts'), 'utf8'),
    workerFighters,
    workerBilling,
    homePage,
    communityShare,
  ].join('\n');
  if (/\b(Mortal\s+Kombat|Street\s+Fighter|Capcom)\b/i.test(productionCode)) {
    throw new Error('Production code still references existing fighting-game franchise branding.');
  }
}

function assertRateLimitingIsWired() {
  const rateLimit = readFileSync(join(root, 'worker/src/rateLimit.ts'), 'utf8');
  const index = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const proxy = readFileSync(join(root, 'worker/src/proxy.ts'), 'utf8');
  const auth = readFileSync(join(root, 'worker/src/auth.ts'), 'utf8');
  const required = [
    "rateLimitKey: `user:${auth.userId}`",
    'rateLimitKey: await anonymousRateLimitKey(request, env)',
    'proxy:gemini',
    'proxy:fal',
    'proxy:default',
    'generation:authorize',
    'billing:checkout',
    'provider:session',
    'community:clone',
    'fighters:upload',
    'fighters:write',
    'matches:report',
    "'generation:authorize': {\n    anonymous: { limit: 1, windowSeconds: 24 * 60 * 60 }",
    'function authenticatedLimited',
    'function authAsPublicContext',
    'function sensitiveOptionalAuth',
    'if (publicAuth.user || !hasBearerAuth(request)) return publicAuth',
    'const auth = await requireAuth(request, env)',
    'auth.userId ? route.signedIn : route.anonymous',
    'plan === \'admin\' || plan === \'studio\'',
    'const [counter] = await env.DB.batch([',
    'ON CONFLICT(key) DO UPDATE SET',
    'ELSE rate_limits.count + 1',
    'RETURNING count',
    "WHERE datetime(expires_at) <= datetime('now') AND key <> ?",
    'return count > rule.limit ? rateLimitResponse(window.retryAfterSeconds) : null;',
    "headers: { 'Retry-After': String(retryAfterSeconds) }",
    "await enforceRateLimit(env, 'proxy:gemini', auth)",
    "await enforceRateLimit(env, 'proxy:fal', auth)",
    "await enforceRateLimit(env, 'proxy:default', auth)",
    "await enforceRateLimit(env, 'generation:authorize', generationAuth)",
    "authenticatedLimited(\n            request,\n            env,\n            'billing:checkout'",
    "authenticatedLimited(\n            request,\n            env,\n            'provider:session'",
    "authenticatedLimited(\n            request,\n            env,\n            'community:clone'",
    "authenticatedLimited(\n              request,\n              env,\n              'fighters:upload'",
    "authenticatedLimited(\n            request,\n            env,\n            'fighters:write'",
    "authenticatedLimited(request, env, 'matches:report'",
  ];
  const combined = `${rateLimit}\n${index}\n${proxy}\n${auth}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  const forbidden = [
    "if (publicAuth.user) {\n          const limited = await enforceRateLimit(env, 'generation:authorize', publicAuth);",
    'env.RATE_LIMITS',
    'KVNamespace',
    'rateLimitKey: `ip:${ip}`',
  ];
  const foundForbidden = forbidden.filter((snippet) => combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Rate limiting is missing: ${missing.join(', ')}`);
  }
  if (foundForbidden.length > 0) {
    throw new Error(`Rate-limit security regression found: ${foundForbidden.join(', ')}`);
  }
}

function assertCrossDeviceRosterImportIsWired() {
  const cloud = readFileSync(join(root, 'src/services/CloudFighters.ts'), 'utf8');
  const gallery = readFileSync(join(root, 'src/ui/routes/GalleryPage.tsx'), 'utf8');
  const roster = readFileSync(join(root, 'src/ui/routes/RosterPage.tsx'), 'utf8');
  const cloudFirstRename = readFileSync(join(root, 'src/ui/shared/cloudFirstRename.ts'), 'utf8');
  const cloudFirstDelete = readFileSync(join(root, 'src/ui/shared/cloudFirstDelete.ts'), 'utf8');
  const forbidden = [
    'createBody.public = meta.cloudPublic',
    'res.status === 401 || res.status === 503',
  ];
  const required = [
    'export async function importMissingCloudFighters',
    'export async function syncCloudFightersToLocal',
    'export async function renameCloudFighter',
    'export async function deleteCloudFighter',
    'export class CloudFighterRequestError',
    'this.retryable = status === 503',
    'if (res.status === 404) return null',
    "return { status: 'synced', fighterId, message: 'Cloud fighter was already deleted.' }",
    'export async function getCloudFighter',
    'const detailed = await getCloudFighter(fighter.id, requestContext)',
    'await downloadCloudFighterToLocal(detailed ?? fighter, requestContext)',
    'function shouldRefreshLocalFighter',
    'existing.cloudFighterId !== fighter.id',
    'TIER_RANK[fighter.qualityTier] > TIER_RANK[getMetaTier(existing)]',
    'const remoteAnimationCount = new Set(fighter.sprites.map',
    'const localAnimationCount = new Set(existing.animationsReady ?? []).size',
    'remoteUpdatedAt > (existing.updatedAt ?? 0) + 1000',
    'const remoteUpdatedAt = cloudTimestampMs(fighter)',
    'staleSourceKinds.size > 0 || spritesSkipped > 0',
    ': remoteUpdatedAt || now',
    'interface CloudImportResult',
    'interface CloudRosterSyncSummary',
    'function fetchOptionalBlob',
    'Optional asset skipped',
    'Sprite skipped',
    'const spritePlan = buildSpriteDownloadPlan(spriteVersions, localFingerprints, options)',
    'const playableRefs = cloudPlayableSpriteRefs(spriteVersions)',
    'selectPlayableCachedSprites(refreshedVersions, playableRefs)',
    'remoteRosterComplete && allRemoteCurrentSpritesAvailable',
    'await setCloudPlayableSpriteRefs(photoHash, playableRefs, ownerScope)',
    'const initialPlayableRefs = fingerprintedPlayableSpriteRefs(',
    'meta.cloudPlayableSpriteRefs = initialPlayableRefs',
    'spritesImported,',
    'animationsReady: Array.from(availableCurrentAnimations)',
    '...(existingMeta ?? {})',
    'Cloud fighter ${fighter.name} has no complete animation pack (',
    'isCompleteCloudFighterRoster(fighter)',
    'inferFighterAssetPacks(fighter.sprites).some((pack) => pack.complete)',
    'fighterAssetPacks: cachedAssetPackMetadata(exactPlayableSprites)',
    'Archived sprite versions cannot be imported into the playable cache',
    'let imported = 0',
    'imported += 1',
    'summary.updated += 1',
    'Fighter import skipped',
    'Fighter sync skipped',
    'cloudFighterId: fighter.id',
    'cloudPublic: fighter.public',
    'const targetPublic = meta.cloudPublic === true',
    'function apiErrorMessage',
    'missingAnimations?: string[]',
    'Generate these animations before publishing',
    'json.missingAnimations.map(formatMissingAnimationName)',
    "throw new Error(`Share update failed (${res.status}): ${await apiErrorMessage(res, 'Publish update failed')}`)",
    'setCloudFighterPublic(fighterId, true, requestContext)',
    'await renameFighterCloudFirst(meta, trimmedName, {',
    'const updated = await dependencies.renameCloud(fighter.cloudFighterId, name)',
    'await dependencies.renameCache(fighter.photoHash, name)',
    'The cloud rename could not be confirmed. Your fighter name was not changed.',
    'const cloudDelete = await deleteCloudFighter(meta.cloudFighterId, apiContext)',
    'await deleteFighterCacheAfterCloudConfirmation(',
    "cloudDelete.status !== 'synced'",
    'The local fighter was preserved.',
    'Fighter renamed in cloud. The preview cache will refresh when Gallery reloads.',
    'syncCloudFightersToLocal(all, apiContext)',
    'const cloudSync = await syncCloudFightersToLocal(allMetas, apiContext)',
    'p1CloudFighterId: selectedP1.cloudFighterId',
    'p2CloudFighterId: selectedP2.cloudFighterId',
  ];
  const combined = `${cloud}\n${gallery}\n${roster}\n${cloudFirstRename}\n${cloudFirstDelete}`;
  const foundForbidden = forbidden.filter((snippet) => combined.includes(snippet));
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0 || foundForbidden.length > 0) {
    throw new Error([
      missing.length > 0 ? `missing cross-device cloud roster import/play wiring: ${missing.join(', ')}` : '',
      foundForbidden.length > 0 ? `cloud sync publishes before uploads: ${foundForbidden.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

function assertRuntimeSpriteFallbacksAreSafe() {
  const loader = readFileSync(join(root, 'src/game/sprites/AiSpriteLoader.ts'), 'utf8');
  const required = [
    'type LoadedAnimation',
    'if (loadedAnims.size === 0) return false',
    'function resolveLoadedAnimationForState',
    'const directAnim = loadedAnims.get(directName)',
    'const fallbackState = FALLBACK_MAP[state]',
    "const idleAnim = loadedAnims.get('idle')",
    'const firstLoaded = loadedAnims.entries().next().value',
    'fallbackFillCount',
    'fallback-filled states',
  ];
  const forbidden = [
    'if (!anim) continue;',
  ];
  const missing = required.filter((snippet) => !loader.includes(snippet));
  const foundForbidden = forbidden.filter((snippet) => loader.includes(snippet));
  if (missing.length > 0 || foundForbidden.length > 0) {
    throw new Error([
      missing.length > 0 ? `runtime sprite fallback coverage is missing: ${missing.join(', ')}` : '',
      foundForbidden.length > 0 ? `runtime sprite loader may leave transparent states: ${foundForbidden.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }
}

function assertSourceViewsStayProScoped() {
  const gemini = readFileSync(join(root, 'src/services/GeminiApi.ts'), 'utf8');
  const pipeline = readFileSync(join(root, 'src/services/CharacterPipeline.ts'), 'utf8');
  const envExample = readFileSync(join(root, '.env.example'), 'utf8');
  const envProduction = readFileSync(join(root, '.env.production.example'), 'utf8');
  const localEnvProductionPath = join(root, '.env.production');
  const localEnvProduction = existsSync(localEnvProductionPath)
    ? readFileSync(localEnvProductionPath, 'utf8')
    : '';
  const required = [
    "if (options?.modelOverride && (options.operation === 'sprite' || options.animationName))",
    "!value.toLowerCase().includes('pro')",
    "const DEFAULT_GEMINI_SOURCE_MODEL = 'gemini-3-pro-image'",
    "resolveGeminiImageModel({ operation: 'repose' })",
    "resolveGeminiImageModel({ operation: 'upright' })",
    "resolveGeminiImageModel({ operation: 'crouch' })",
    'tierConfig.geminiAnimModelOverride',
    'VITE_GEMINI_IMAGE_MODEL_REPOSE=gemini-3-pro-image',
    'VITE_GEMINI_IMAGE_MODEL_UPRIGHT=gemini-3-pro-image',
    'VITE_GEMINI_IMAGE_MODEL_CROUCH=gemini-3-pro-image',
  ];
  const forbidden = [
    'VITE_GEMINI_IMAGE_MODEL_SPRITE=gemini-3-pro',
    'VITE_GEMINI_IMAGE_MODEL_ANIM_IDLE=gemini-3-pro',
    'runtimeAnimModelOverride',
    'setGeminiAnimModelOverride',
  ];
  const combined = `${gemini}\n${pipeline}\n${envExample}\n${envProduction}\n${localEnvProduction}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  const foundForbidden = forbidden.filter((snippet) => combined.includes(snippet));
  if (missing.length > 0 || foundForbidden.length > 0) {
    throw new Error([
      missing.length > 0 ? `missing source-view Pro guard snippets: ${missing.join(', ')}` : '',
      foundForbidden.length > 0 ? `found production Pro animation env overrides: ${foundForbidden.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

function assertTierPricingAndPipelineParity() {
  const frontendTiers = readFileSync(join(root, 'src/services/QualityTiers.ts'), 'utf8');
  const workerTiers = readFileSync(join(root, 'worker/src/tiers.ts'), 'utf8');
  const pipeline = readFileSync(join(root, 'src/services/CharacterPipeline.ts'), 'utf8');
  const gemini = readFileSync(join(root, 'src/services/GeminiApi.ts'), 'utf8');
  const spritePostProcess = readFileSync(join(root, 'src/services/SpritePostProcess.ts'), 'utf8');
  const generationWorkflow = readFileSync(join(root, 'worker/src/generationWorkflow.ts'), 'utf8');
  const authState = readFileSync(join(root, 'src/ui/authState.ts'), 'utf8');
  const createFighter = readFileSync(join(root, 'src/ui/routes/CreateFighterPage.tsx'), 'utf8');
  const gallery = readFileSync(join(root, 'src/ui/routes/GalleryPage.tsx'), 'utf8');
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const tierParity = readFileSync(join(root, 'scripts/check-tier-parity.mjs'), 'utf8');
  const required = [
    '"check:tiers": "node scripts/check-tier-parity.mjs"',
    'Tier parity checks passed',
    'estimatedUsdCost: 12.64',
    'VITE_GEMINI_IMAGE_MODEL_ANIM_VICTORY',
    'animation models are tier-controlled',
    "id: 'rookie'",
    "priceLabel: '2 credits'",
    'creditCost: 2',
    'animationRetryCreditCost: 1',
    "pipeline: 'sheet'",
    "model: 'flash'",
    "animationBgRemoval: 'chroma'",
    "id: 'contender'",
    "priceLabel: '11 credits'",
    'creditCost: 11',
    'animationRetryCreditCost: 2',
    "pipeline: 'sheet_refined'",
    "animationBgRemoval: 'birefnet'",
    "id: 'champion'",
    "priceLabel: '18 credits'",
    'creditCost: 18',
    'animationRetryCreditCost: 4',
    "model: 'pro'",
    "geminiAnimModelOverride: 'gemini-3.1-flash-image'",
    "geminiAnimModelOverride: 'gemini-3-pro-image'",
    'enableDnnBgRemoval: false',
    'enableDnnBgRemoval: true',
    'function isLocalDevWithoutApi',
    "authStatus !== 'signed-in' && !isLocalDevWithoutApi()",
    'const lockPaidTiers = paidTiersLocked(authStatus)',
    "setTier('rookie')",
    'setPendingUpgradeTier(tier.id)',
    // Upgrade confirmation runs through the shared ConfirmDialog (Modal sets
    // aria-modal + aria-label from the title) with the QUALITY_TIERS copy.
    'Upgrade to ${pendingUpgrade.label}',
    'animations are kept in cache and remain accessible.',
    'tier: currentTier,',
    'syncFighterToCloud(updatedMeta, updatedSprites, intro, apiContext)',
    "setStatus('Done and synced')",
    "animationName === 'ko' && frames === 8",
    'computeRequestedSpriteGrid(animName, genFrames)',
    "if (animName === 'ko') return 8",
    "name: 'ko',         motion: 'eight clear key poses",
    "name: 'ko', motion: 'eight clear key poses",
  ];
  const combined = `${frontendTiers}\n${workerTiers}\n${pipeline}\n${gemini}\n${spritePostProcess}\n${generationWorkflow}\n${authState}\n${createFighter}\n${gallery}\n${packageJson}\n${tierParity}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  const forbidden = ['setSpriteMode(', 'Mode: Refined', 'spriteMode,'];
  const foundForbidden = forbidden.filter((snippet) => gallery.includes(snippet));
  if (missing.length > 0 || foundForbidden.length > 0) {
    throw new Error([
      missing.length > 0 ? `Tier pricing/pipeline parity is missing: ${missing.join(', ')}` : '',
      foundForbidden.length > 0 ? `Gallery exposes tier-bypassing sprite controls: ${foundForbidden.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }
}

function replayMigrations() {
  const dbPath = join(tmpdir(), `asf-production-check-${Date.now()}.db`);
  const migrationArgs = [
    dbPath,
    '.read worker/migrations/0001_init.sql',
    '.read worker/migrations/0002_prod_foundation.sql',
    '.read worker/migrations/0003_stripe_credits.sql',
    '.read worker/migrations/0004_sprite_versions.sql',
    '.read worker/migrations/0005_generation_charges.sql',
    "INSERT INTO users (id, display_name, oauth_provider, oauth_id) VALUES ('u1', 'Migration Test', 'legacy', 'u1');",
    "INSERT INTO fighters (id, owner_user_id, name, photo_hash, quality_tier) VALUES ('f1', 'u1', 'Fighter', 'photo-hash', 'rookie');",
    "INSERT INTO sprite_versions (id, fighter_id, animation_name, quality_tier, blob_key, frame_w, frame_h, frame_count, processing_version) VALUES ('legacy1', 'f1', 'idle', 'rookie', 'legacy1.png', 192, 256, 4, 3);",
    "INSERT INTO sprite_versions (id, fighter_id, animation_name, quality_tier, blob_key, frame_w, frame_h, frame_count, processing_version) VALUES ('legacy2', 'f1', 'idle', 'rookie', 'legacy2.png', 192, 256, 4, 3);",
    '.read worker/migrations/0006_sprite_content_hash.sql',
    '.read worker/migrations/0007_source_versions.sql',
    '.read worker/migrations/0008_provider_sessions.sql',
    '.read worker/migrations/0009_clerk_user_lifecycle.sql',
    '.read worker/migrations/0010_operational_data_retention.sql',
    '.read worker/migrations/0011_legal_consent_and_checkout_tax.sql',
    '.read worker/migrations/0012_stripe_refund_and_dispute_adjustments.sql',
    '.read worker/migrations/0013_community_moderation.sql',
    '.read worker/migrations/0014_provider_spend_budgets.sql',
    '.read worker/migrations/0015_asset_lookup_indexes.sql',
    '.read worker/migrations/0016_provider_spend_rate_window.sql',
    '.read worker/migrations/0017_provider_cost_events.sql',
    '.read worker/migrations/0018_durable_generation_jobs.sql',
    '.read worker/migrations/0019_durable_retry_jobs.sql',
    '.read worker/migrations/0020_official_arcade.sql',
    '.read worker/migrations/0021_arcade_generation_prompts.sql',
    '.read worker/migrations/0022_provider_capacity_windows.sql',
    '.read worker/migrations/0023_durable_artifact_resume.sql',
    '.read worker/migrations/0024_durable_asset_deletions.sql',
    '.read worker/migrations/0025_meterkey_capacity_windows.sql',
    '.read worker/migrations/0026_zero_cost_not_dispatched_events.sql',
    '.read worker/migrations/0027_immutable_arcade_experiments.sql',
    "INSERT INTO sprites (id, fighter_id, animation_name, quality_tier, blob_key, frame_w, frame_h, frame_count, processing_version) VALUES ('legacy-current', 'f1', 'idle', 'rookie', 'legacy-current.png', 192, 256, 4, 3);",
    '.read worker/migrations/0028_sprite_animation_format.sql',
    '.read worker/migrations/0029_generation_creation_flow.sql',
    'SELECT name FROM sqlite_master WHERE type = "table" AND name IN ("fighters", "sprites", "sprite_versions", "source_versions", "generation_charges", "provider_sessions", "provider_spend_months", "provider_spend_reservations", "provider_cost_events", "generation_jobs", "generation_job_events", "provider_request_cache", "checkout_sessions", "clerk_webhook_events", "clerk_user_tombstones", "legal_acceptances", "stripe_credit_adjustments", "community_reports", "arcade_fighters", "arcade_generation_experiments", "arcade_generation_experiment_slots", "arcade_generation_experiment_artifacts");',
  ];
  try {
    run('D1 migration replay', sqlite, migrationArgs);
    const legacyCount = runCapture('D1 legacy sprite archive check', sqlite, [
      dbPath,
      "SELECT COUNT(*) FROM sprite_versions WHERE fighter_id = 'f1' AND animation_name = 'idle' AND content_hash IS NULL;",
    ]);
    if (legacyCount !== '2') {
      throw new Error(`Legacy sprite archive rows were not preserved through 0006; got ${legacyCount}`);
    }

    const legacyAnimationFormatCount = runCapture('D1 sprite animation format backfill check', sqlite, [
      dbPath,
      "SELECT COUNT(*) FROM sprite_versions WHERE fighter_id = 'f1' AND animation_format = 'legacy';",
    ]);
    if (legacyAnimationFormatCount !== '2') {
      throw new Error(`Legacy sprite versions were not backfilled with animation_format=legacy; got ${legacyAnimationFormatCount}`);
    }
    const legacyCurrentAnimationFormat = runCapture('D1 current sprite animation format backfill check', sqlite, [
      dbPath,
      "SELECT animation_format FROM sprites WHERE id = 'legacy-current';",
    ]);
    if (legacyCurrentAnimationFormat !== 'legacy') {
      throw new Error(`Current sprites were not backfilled with animation_format=legacy; got ${legacyCurrentAnimationFormat}`);
    }
    const checkpointAnimationFormatColumn = runCapture('D1 sprite checkpoint animation format check', sqlite, [
      dbPath,
      "SELECT COUNT(*) FROM pragma_table_info('generation_artifact_checkpoints') WHERE name = 'animation_format' AND dflt_value = \"'legacy'\";",
    ]);
    if (checkpointAnimationFormatColumn !== '1') {
      throw new Error('Durable sprite checkpoints are missing the legacy-default animation format contract');
    }

    const generationCreationFlowColumns = runCapture('D1 generation creation flow check', sqlite, [
      dbPath,
      `
        SELECT COUNT(*)
        FROM (
          SELECT name, dflt_value FROM pragma_table_info('generation_charges') WHERE name = 'creation_flow'
          UNION ALL
          SELECT name, dflt_value FROM pragma_table_info('provider_sessions') WHERE name = 'creation_flow'
          UNION ALL
          SELECT name, dflt_value FROM pragma_table_info('generation_jobs') WHERE name = 'creation_flow'
          UNION ALL
          SELECT name, dflt_value FROM pragma_table_info('generation_artifact_runs') WHERE name = 'creation_flow'
        )
        WHERE name = 'creation_flow' AND dflt_value = "'original'";
      `,
    ]);
    if (generationCreationFlowColumns !== '4') {
      throw new Error(`Generation creation flow was not sealed across all durable records; got ${generationCreationFlowColumns}/4`);
    }

    const duplicateCount = runCapture('D1 sprite content index check', sqlite, [
      dbPath,
      `
        INSERT INTO sprite_versions (
          id, fighter_id, animation_name, quality_tier, blob_key, content_hash, raw_content_hash,
          frame_w, frame_h, frame_count, processing_version
        ) VALUES (
          'hashed1', 'f1', 'walk', 'rookie', 'hashed1.png', 'same-content', NULL,
          192, 256, 4, 3
        );
        INSERT OR IGNORE INTO sprite_versions (
          id, fighter_id, animation_name, quality_tier, blob_key, content_hash, raw_content_hash,
          frame_w, frame_h, frame_count, processing_version
        ) VALUES (
          'hashed2', 'f1', 'walk', 'rookie', 'hashed2.png', 'same-content', NULL,
          192, 256, 4, 3
        );
        SELECT COUNT(*) FROM sprite_versions
        WHERE fighter_id = 'f1'
          AND animation_name = 'walk'
          AND quality_tier = 'rookie'
          AND content_hash = 'same-content';
      `,
    ]);
    if (duplicateCount !== '1') {
      throw new Error(`Sprite content unique index did not collapse duplicate uploads; got ${duplicateCount}`);
    }


    const distinctAnimationFormatCount = runCapture('D1 sprite animation format identity check', sqlite, [
      dbPath,
      `
        INSERT INTO sprite_versions (
          id, fighter_id, animation_name, quality_tier, blob_key, content_hash, raw_content_hash,
          frame_w, frame_h, frame_count, processing_version, animation_format
        ) VALUES (
          'hashed-dense', 'f1', 'walk', 'rookie', 'hashed-dense.png', 'same-content', NULL,
          192, 256, 4, 3, 'video-dense-v1'
        );
        SELECT COUNT(*) FROM sprite_versions
        WHERE fighter_id = 'f1'
          AND animation_name = 'walk'
          AND quality_tier = 'rookie'
          AND content_hash = 'same-content';
      `,
    ]);
    if (distinctAnimationFormatCount !== '2') {
      throw new Error(`Sprite animation formats did not remain distinct in immutable history; got ${distinctAnimationFormatCount}`);
    }

    const sourceDuplicateCount = runCapture('D1 source content index check', sqlite, [
      dbPath,
      `
        INSERT INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
        VALUES ('source1', 'f1', 'side', 'source1.png', 'same-source');
        INSERT OR IGNORE INTO source_versions (id, fighter_id, kind, blob_key, content_hash)
        VALUES ('source2', 'f1', 'side', 'source2.png', 'same-source');
        SELECT COUNT(*) FROM source_versions
        WHERE fighter_id = 'f1'
          AND kind = 'side'
          AND content_hash = 'same-source';
      `,
    ]);
    if (sourceDuplicateCount !== '1') {
      throw new Error(`Source content unique index did not collapse duplicate uploads; got ${sourceDuplicateCount}`);
    }

    const durableGenerationIndexCount = runCapture('D1 durable generation index check', sqlite, [
      dbPath,
      `
        SELECT COUNT(*) FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_generation_jobs_active_fighter',
            'idx_generation_job_events_job',
            'idx_provider_request_cache_job'
          );
      `,
    ]);
    if (durableGenerationIndexCount !== '3') {
      throw new Error(`Durable generation indexes are incomplete; got ${durableGenerationIndexCount}/3`);
    }

	    const communityPublishState = runCapture('D1 community publishable asset filter check', sqlite, [
	      dbPath,
	      `
	        UPDATE fighters SET public_flag = 1 WHERE id = 'f1';
	        SELECT
	          (SELECT COUNT(*) FROM fighters f
	           WHERE f.public_flag = 1
	             AND (
	               SELECT COUNT(DISTINCT s.animation_name)
	               FROM sprites s
	               WHERE s.fighter_id = f.id
	                 AND s.animation_name IN ('idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick', 'jump', 'crouch', 'hit', 'ko', 'victory')
	             ) = 11) || '|';
	        SELECT
	          (SELECT COUNT(*) FROM fighters f
	           WHERE f.public_flag = 1
	             AND (
	               SELECT COUNT(DISTINCT s.animation_name)
	               FROM sprites s
	               WHERE s.fighter_id = f.id
	                 AND s.animation_name IN ('idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick', 'jump', 'crouch', 'hit', 'ko', 'victory')
	             ) = 11) || '|';
	        INSERT INTO sprites (
	          id, fighter_id, animation_name, quality_tier, blob_key, raw_blob_key,
	          content_hash, raw_content_hash, frame_w, frame_h, frame_count, processing_version
	        ) VALUES
	          ('community-sprite-2', 'f1', 'walk', 'rookie', 'community-sprite-2.png', NULL, 'community-sprite-content-2', NULL, 192, 256, 4, 3),
	          ('community-sprite-3', 'f1', 'high_punch', 'rookie', 'community-sprite-3.png', NULL, 'community-sprite-content-3', NULL, 192, 256, 4, 3),
	          ('community-sprite-4', 'f1', 'low_punch', 'rookie', 'community-sprite-4.png', NULL, 'community-sprite-content-4', NULL, 192, 256, 4, 3),
	          ('community-sprite-5', 'f1', 'high_kick', 'rookie', 'community-sprite-5.png', NULL, 'community-sprite-content-5', NULL, 192, 256, 4, 3),
	          ('community-sprite-6', 'f1', 'low_kick', 'rookie', 'community-sprite-6.png', NULL, 'community-sprite-content-6', NULL, 192, 256, 4, 3),
	          ('community-sprite-7', 'f1', 'jump', 'rookie', 'community-sprite-7.png', NULL, 'community-sprite-content-7', NULL, 192, 256, 4, 3),
	          ('community-sprite-8', 'f1', 'crouch', 'rookie', 'community-sprite-8.png', NULL, 'community-sprite-content-8', NULL, 192, 256, 4, 3),
	          ('community-sprite-9', 'f1', 'hit', 'rookie', 'community-sprite-9.png', NULL, 'community-sprite-content-9', NULL, 192, 256, 4, 3),
	          ('community-sprite-10', 'f1', 'ko', 'rookie', 'community-sprite-10.png', NULL, 'community-sprite-content-10', NULL, 192, 256, 4, 3),
	          ('community-sprite-11', 'f1', 'victory', 'rookie', 'community-sprite-11.png', NULL, 'community-sprite-content-11', NULL, 192, 256, 4, 3);
	        SELECT COUNT(*) FROM fighters f
	        WHERE f.public_flag = 1
	          AND (
	            SELECT COUNT(DISTINCT s.animation_name)
	            FROM sprites s
	            WHERE s.fighter_id = f.id
	              AND s.animation_name IN ('idle', 'walk', 'high_punch', 'low_punch', 'high_kick', 'low_kick', 'jump', 'crouch', 'hit', 'ko', 'victory')
	          ) = 11;
	      `,
	    ]);
	    if (communityPublishState !== '0|\n0|\n1' && communityPublishState !== '0|0|1') {
	      throw new Error(`Community publishable asset filter failed; got ${communityPublishState}`);
	    }

    const providerSessionState = runCapture('D1 provider session call budget check', sqlite, [
      dbPath,
      `
        INSERT INTO provider_sessions (
          id, user_id, rate_limit_key, tier, purpose, charge_id, provider_call_limit, expires_at
        ) VALUES (
          'ps1', 'u1', 'user:u1', 'rookie', 'fighter_generation', NULL, 1, datetime('now', '+1 hour')
        );
        UPDATE provider_sessions
        SET provider_calls_used = provider_calls_used + 1
        WHERE id = 'ps1'
          AND status = 'active'
          AND datetime(expires_at) > datetime('now')
          AND provider_calls_used < provider_call_limit
          AND user_id = 'u1'
        RETURNING provider_calls_used || '/' || provider_call_limit;
        UPDATE provider_sessions
        SET provider_calls_used = provider_calls_used + 1
        WHERE id = 'ps1'
          AND status = 'active'
          AND datetime(expires_at) > datetime('now')
          AND provider_calls_used < provider_call_limit
          AND user_id = 'u1'
        RETURNING provider_calls_used;
      `,
    ]);
    if (providerSessionState !== '1/1') {
      throw new Error(`Provider session call budget was not enforced; got ${providerSessionState}`);
    }

    const providerSessionPurposeState = runCapture('D1 provider session purpose check', sqlite, [
      dbPath,
      `
        INSERT INTO provider_sessions (
          id, user_id, rate_limit_key, tier, purpose, charge_id, provider_call_limit, expires_at
        ) VALUES (
          'ps-stage', 'u1', 'user:u1', 'rookie', 'stage_background', NULL, 8, datetime('now', '+1 hour')
        );
        SELECT purpose || '|gemini-only'
        FROM provider_sessions
        WHERE id = 'ps-stage'
          AND purpose = 'stage_background'
          AND provider_calls_used = 0;
      `,
    ]);
    if (providerSessionPurposeState !== 'stage_background|gemini-only') {
      throw new Error(`Provider session purpose fixture was not preserved; got ${providerSessionPurposeState}`);
    }

    const paidGenerationChargeState = runCapture('D1 paid generation charge atomicity check', sqlite, [
      dbPath,
      `
        INSERT INTO users (
          id, display_name, oauth_provider, oauth_id, credits_balance
        ) VALUES (
          'billing-paid', 'Billing Paid', 'test', 'billing-paid', 15
        );
        BEGIN;
        UPDATE users
        SET credits_balance = credits_balance - 15
        WHERE id = 'billing-paid' AND credits_balance >= 15;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'paid-ledger-1', id, -15, 'champion_generation', NULL
        FROM users
        WHERE id = 'billing-paid' AND changes() = 1;
        INSERT INTO generation_charges (
          id, user_id, tier, credit_cost, free_quota_delta, status,
          reason, fighter_id, ledger_id, expires_at
        )
        SELECT 'paid-charge-1', user_id, 'champion', 15, 0, 'reserved',
          'champion_generation', NULL, id, datetime('now', '+1 hour')
        FROM credit_ledger
        WHERE id = 'paid-ledger-1' AND user_id = 'billing-paid';
        COMMIT;

        BEGIN;
        UPDATE users
        SET credits_balance = credits_balance - 15
        WHERE id = 'billing-paid' AND credits_balance >= 15;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'paid-ledger-overdraw', id, -15, 'champion_generation', NULL
        FROM users
        WHERE id = 'billing-paid' AND changes() = 1;
        INSERT INTO generation_charges (
          id, user_id, tier, credit_cost, free_quota_delta, status,
          reason, fighter_id, ledger_id, expires_at
        )
        SELECT 'paid-charge-overdraw', user_id, 'champion', 15, 0, 'reserved',
          'champion_generation', NULL, id, datetime('now', '+1 hour')
        FROM credit_ledger
        WHERE id = 'paid-ledger-overdraw' AND user_id = 'billing-paid';
        COMMIT;

        BEGIN;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'paid-release-1', user_id, credit_cost, 'generation_reservation_release:paid-charge-1', fighter_id
        FROM generation_charges
        WHERE id = 'paid-charge-1' AND user_id = 'billing-paid' AND status = 'reserved';
        UPDATE users
        SET credits_balance = credits_balance + COALESCE(
              (SELECT delta FROM credit_ledger WHERE id = 'paid-release-1'),
              0
            )
        WHERE id = 'billing-paid' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'paid-release-1'
        );
        UPDATE generation_charges
        SET status = 'refunded', refund_ledger_id = 'paid-release-1'
        WHERE id = 'paid-charge-1' AND user_id = 'billing-paid' AND status = 'reserved' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'paid-release-1'
        );
        COMMIT;

        BEGIN;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'paid-release-duplicate', user_id, credit_cost, 'generation_reservation_release:paid-charge-1', fighter_id
        FROM generation_charges
        WHERE id = 'paid-charge-1' AND user_id = 'billing-paid' AND status = 'reserved';
        UPDATE users
        SET credits_balance = credits_balance + COALESCE(
              (SELECT delta FROM credit_ledger WHERE id = 'paid-release-duplicate'),
              0
            )
        WHERE id = 'billing-paid' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'paid-release-duplicate'
        );
        UPDATE generation_charges
        SET status = 'refunded', refund_ledger_id = 'paid-release-duplicate'
        WHERE id = 'paid-charge-1' AND user_id = 'billing-paid' AND status = 'reserved' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'paid-release-duplicate'
        );
        COMMIT;

        SELECT
          (SELECT credits_balance FROM users WHERE id = 'billing-paid') || '|' ||
          (SELECT COUNT(*) FROM generation_charges WHERE user_id = 'billing-paid') || '|' ||
          (SELECT COUNT(*) FROM credit_ledger WHERE user_id = 'billing-paid') || '|' ||
          (SELECT COUNT(*) FROM credit_ledger WHERE user_id = 'billing-paid' AND reason LIKE 'generation_reservation_release:%') || '|' ||
          (SELECT status FROM generation_charges WHERE id = 'paid-charge-1');
      `,
    ]);
    if (paidGenerationChargeState !== '15|1|2|1|refunded') {
      throw new Error(`Paid generation reservation release was not atomic and idempotent; got ${paidGenerationChargeState}`);
    }

    const freeGenerationChargeState = runCapture('D1 free Rookie charge atomicity check', sqlite, [
      dbPath,
      `
        INSERT INTO users (
          id, display_name, oauth_provider, oauth_id, free_rookie_generations_used
        ) VALUES (
          'billing-free', 'Billing Free', 'test', 'billing-free', 0
        );
        BEGIN;
        UPDATE users
        SET free_rookie_generations_used = free_rookie_generations_used + 1
        WHERE id = 'billing-free' AND free_rookie_generations_used < 1;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'free-ledger-1', id, 0, 'free_rookie_generation', NULL
        FROM users
        WHERE id = 'billing-free' AND changes() = 1;
        INSERT INTO generation_charges (
          id, user_id, tier, credit_cost, free_quota_delta, status,
          reason, fighter_id, ledger_id, expires_at
        )
        SELECT 'free-charge-1', user_id, 'rookie', 0, 1, 'reserved',
          'free_rookie_generation', NULL, id, datetime('now', '+1 hour')
        FROM credit_ledger
        WHERE id = 'free-ledger-1' AND user_id = 'billing-free';
        COMMIT;

        BEGIN;
        UPDATE users
        SET free_rookie_generations_used = free_rookie_generations_used + 1
        WHERE id = 'billing-free' AND free_rookie_generations_used < 1;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'free-ledger-overuse', id, 0, 'free_rookie_generation', NULL
        FROM users
        WHERE id = 'billing-free' AND changes() = 1;
        INSERT INTO generation_charges (
          id, user_id, tier, credit_cost, free_quota_delta, status,
          reason, fighter_id, ledger_id, expires_at
        )
        SELECT 'free-charge-overuse', user_id, 'rookie', 0, 1, 'reserved',
          'free_rookie_generation', NULL, id, datetime('now', '+1 hour')
        FROM credit_ledger
        WHERE id = 'free-ledger-overuse' AND user_id = 'billing-free';
        COMMIT;

        BEGIN;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'free-release-1', user_id, credit_cost, 'generation_reservation_release:free-charge-1', fighter_id
        FROM generation_charges
        WHERE id = 'free-charge-1' AND user_id = 'billing-free' AND status = 'reserved';
        UPDATE users
        SET free_rookie_generations_used = CASE
              WHEN free_rookie_generations_used >= COALESCE(
                (SELECT free_quota_delta FROM generation_charges
                 WHERE id = 'free-charge-1' AND user_id = 'billing-free' AND status = 'reserved'),
                0
              ) THEN free_rookie_generations_used - COALESCE(
                (SELECT free_quota_delta FROM generation_charges
                 WHERE id = 'free-charge-1' AND user_id = 'billing-free' AND status = 'reserved'),
                0
              )
              ELSE 0
            END
        WHERE id = 'billing-free' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'free-release-1'
        );
        UPDATE generation_charges
        SET status = 'refunded', refund_ledger_id = 'free-release-1'
        WHERE id = 'free-charge-1' AND user_id = 'billing-free' AND status = 'reserved' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'free-release-1'
        );
        COMMIT;

        BEGIN;
        INSERT INTO credit_ledger (id, user_id, delta, reason, fighter_id)
        SELECT 'free-release-duplicate', user_id, credit_cost, 'generation_reservation_release:free-charge-1', fighter_id
        FROM generation_charges
        WHERE id = 'free-charge-1' AND user_id = 'billing-free' AND status = 'reserved';
        UPDATE users
        SET free_rookie_generations_used = free_rookie_generations_used - 1
        WHERE id = 'billing-free' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'free-release-duplicate'
        );
        UPDATE generation_charges
        SET status = 'refunded', refund_ledger_id = 'free-release-duplicate'
        WHERE id = 'free-charge-1' AND user_id = 'billing-free' AND status = 'reserved' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'free-release-duplicate'
        );
        COMMIT;

        SELECT
          (SELECT free_rookie_generations_used FROM users WHERE id = 'billing-free') || '|' ||
          (SELECT COUNT(*) FROM generation_charges WHERE user_id = 'billing-free') || '|' ||
          (SELECT COUNT(*) FROM credit_ledger WHERE user_id = 'billing-free') || '|' ||
          (SELECT COUNT(*) FROM credit_ledger WHERE user_id = 'billing-free' AND reason LIKE 'generation_reservation_release:%') || '|' ||
          (SELECT status FROM generation_charges WHERE id = 'free-charge-1');
      `,
    ]);
    if (freeGenerationChargeState !== '0|1|2|1|refunded') {
      throw new Error(`Free Rookie reservation release was not atomic and idempotent; got ${freeGenerationChargeState}`);
    }

    const firstStripeClaim = runCapture('D1 Stripe checkout first claim check', sqlite, [
      dbPath,
      `
        INSERT INTO checkout_sessions (
          id, stripe_session_id, user_id, pack_id, credits, amount_cents, currency, status
        ) VALUES (
          'checkout-local-1', 'pending:checkout-local-1', 'u1', 'versus', 20, 2499, 'eur', 'open'
        );
        UPDATE checkout_sessions
        SET status = 'crediting',
            stripe_session_id = 'cs_local_idempotent',
            updated_at = datetime('now')
        WHERE (stripe_session_id = 'cs_local_idempotent' OR id = 'checkout-local-1')
          AND status = 'open'
          AND user_id = 'u1'
          AND pack_id = 'versus'
          AND credits = 20
          AND amount_cents = 2499
          AND lower(currency) = 'eur'
        RETURNING user_id || '|' || pack_id || '|' || credits;
      `,
    ]);
    if (firstStripeClaim !== 'u1|versus|20') {
      throw new Error(`Stripe checkout first claim did not return the expected credit payload; got ${firstStripeClaim}`);
    }

    const mismatchedStripeClaim = runCapture('D1 Stripe checkout mismatch claim check', sqlite, [
      dbPath,
      `
        INSERT INTO checkout_sessions (
          id, stripe_session_id, user_id, pack_id, credits, amount_cents, currency, status
        ) VALUES (
          'checkout-local-mismatch', 'pending:checkout-local-mismatch', 'u1', 'versus', 20, 2499, 'eur', 'open'
        );
        UPDATE checkout_sessions
        SET status = 'crediting',
            stripe_session_id = 'cs_local_mismatch',
            updated_at = datetime('now')
        WHERE (stripe_session_id = 'cs_local_mismatch' OR id = 'checkout-local-mismatch')
          AND status = 'open'
          AND user_id = 'u1'
          AND pack_id = 'versus'
          AND credits = 20
          AND amount_cents = 2498
          AND lower(currency) = 'eur'
        RETURNING user_id || '|' || pack_id || '|' || credits;
      `,
    ]);
    if (mismatchedStripeClaim !== '') {
      throw new Error(`Stripe checkout mismatch should not claim a local row; got ${mismatchedStripeClaim}`);
    }

    const stripeCreditState = runCapture('D1 Stripe checkout credit grant check', sqlite, [
      dbPath,
      `
        INSERT OR IGNORE INTO credit_ledger (id, user_id, delta, reason, fighter_id, stripe_session_id)
        SELECT 'ledger-stripe-1', user_id, credits, 'stripe_credit_pack:' || COALESCE(pack_id, 'unknown'), NULL, 'cs_local_idempotent'
        FROM checkout_sessions
        WHERE stripe_session_id = 'cs_local_idempotent' AND status = 'crediting';
        UPDATE users
        SET credits_balance = credits_balance + COALESCE((SELECT delta FROM credit_ledger WHERE id = 'ledger-stripe-1'), 0),
            updated_at = datetime('now')
        WHERE id = (SELECT user_id FROM credit_ledger WHERE id = 'ledger-stripe-1');
        UPDATE checkout_sessions
        SET status = 'paid',
            updated_at = datetime('now')
        WHERE stripe_session_id = 'cs_local_idempotent' AND status = 'crediting' AND EXISTS (
          SELECT 1 FROM credit_ledger WHERE id = 'ledger-stripe-1'
        );
        INSERT OR IGNORE INTO credit_ledger (id, user_id, delta, reason, fighter_id, stripe_session_id)
        SELECT 'ledger-stripe-duplicate', user_id, credits, 'stripe_credit_pack:' || COALESCE(pack_id, 'unknown'), NULL, 'cs_local_idempotent'
        FROM checkout_sessions
        WHERE stripe_session_id = 'cs_local_idempotent';
        UPDATE users
        SET credits_balance = credits_balance + COALESCE((SELECT delta FROM credit_ledger WHERE id = 'ledger-stripe-duplicate'), 0),
            updated_at = datetime('now')
        WHERE id = (SELECT user_id FROM credit_ledger WHERE id = 'ledger-stripe-duplicate');
        SELECT
          (SELECT credits_balance FROM users WHERE id = 'u1') || '|' ||
          (SELECT COUNT(*) FROM credit_ledger WHERE stripe_session_id = 'cs_local_idempotent') || '|' ||
          (SELECT status FROM checkout_sessions WHERE stripe_session_id = 'cs_local_idempotent');
      `,
    ]);
    if (stripeCreditState !== '20|1|paid') {
      throw new Error(`Stripe checkout credit grant was not idempotent; got ${stripeCreditState}`);
    }

    const duplicateStripeClaim = runCapture('D1 Stripe checkout duplicate claim check', sqlite, [
      dbPath,
      `
        UPDATE checkout_sessions
        SET status = 'crediting',
            stripe_session_id = 'cs_local_idempotent',
            updated_at = datetime('now')
        WHERE (stripe_session_id = 'cs_local_idempotent' OR id = 'checkout-local-1') AND status = 'open'
        RETURNING user_id || '|' || pack_id || '|' || credits;
      `,
    ]);
    if (duplicateStripeClaim !== '') {
      throw new Error(`Stripe checkout duplicate claim should return no rows; got ${duplicateStripeClaim}`);
    }

    const stripeEventCount = runCapture('D1 Stripe event idempotency check', sqlite, [
      dbPath,
      `
        INSERT OR IGNORE INTO stripe_events (id, type, payload)
        VALUES ('evt_local_idempotent', 'checkout.session.completed', '{}');
        INSERT OR IGNORE INTO stripe_events (id, type, payload)
        VALUES ('evt_local_idempotent', 'checkout.session.completed', '{}');
        SELECT COUNT(*) FROM stripe_events WHERE id = 'evt_local_idempotent';
      `,
    ]);
    if (stripeEventCount !== '1') {
      throw new Error(`Stripe event unique index did not collapse duplicate webhooks; got ${stripeEventCount}`);
    }

    const rateLimitState = runCapture('D1 rate limit fallback behavior check', sqlite, [
      dbPath,
      `
        INSERT INTO rate_limits (key, count, expires_at)
        VALUES ('proxy:default:ip:203_0_113_10:local-window', 79, datetime('now', '+1 hour'));
        INSERT INTO rate_limits (key, count, expires_at)
        VALUES ('proxy:default:ip:203_0_113_10:local-window', 1, datetime('now', '+1 hour'))
        ON CONFLICT(key) DO UPDATE SET
          count = CASE
            WHEN datetime(rate_limits.expires_at) <= datetime('now') THEN 1
            ELSE rate_limits.count + 1
          END,
          expires_at = excluded.expires_at;
        SELECT CASE WHEN count > 80 THEN 'blocked' ELSE 'allowed' END || '|'
        FROM rate_limits
        WHERE key = 'proxy:default:ip:203_0_113_10:local-window';
        INSERT INTO rate_limits (key, count, expires_at)
        VALUES ('proxy:default:ip:203_0_113_10:local-window', 1, datetime('now', '+1 hour'))
        ON CONFLICT(key) DO UPDATE SET
          count = CASE
            WHEN datetime(rate_limits.expires_at) <= datetime('now') THEN 1
            ELSE rate_limits.count + 1
          END,
          expires_at = excluded.expires_at;
        INSERT INTO rate_limits (key, count, expires_at)
        VALUES ('proxy:default:ip:203_0_113_10:expired-window', 80, datetime('now', '-1 hour'));
        DELETE FROM rate_limits
        WHERE key IN (
          SELECT key FROM rate_limits
          WHERE datetime(expires_at) <= datetime('now')
          ORDER BY expires_at ASC
          LIMIT 10
        );
        SELECT
          (SELECT count FROM rate_limits WHERE key = 'proxy:default:ip:203_0_113_10:local-window' AND expires_at > datetime('now')) || '|' ||
          (SELECT CASE WHEN count > 80 THEN 'blocked' ELSE 'allowed' END FROM rate_limits WHERE key = 'proxy:default:ip:203_0_113_10:local-window' AND expires_at > datetime('now')) || '|' ||
          (SELECT COUNT(*) FROM rate_limits WHERE key = 'proxy:default:ip:203_0_113_10:expired-window' AND expires_at > datetime('now'));
      `,
    ]);
    if (rateLimitState !== 'allowed|\n81|blocked|0' && rateLimitState !== 'allowed|81|blocked|0') {
      throw new Error(`Atomic D1 rate limit behavior was not enforced; got ${rateLimitState}`);
    }
  } finally {
    if (existsSync(dbPath)) rmSync(dbPath);
  }
}

function assertSourceUploadsAreVersioned() {
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const integrationTests = readFileSync(join(root, 'worker/src/fighters.integration.test.ts'), 'utf8');
  const types = readFileSync(join(root, 'worker/src/types.ts'), 'utf8');
  const migration = readFileSync(join(root, 'worker/migrations/0007_source_versions.sql'), 'utf8');
  const workerPackage = readFileSync(join(root, 'worker/package.json'), 'utf8');
  const required = [
    'CREATE TABLE IF NOT EXISTS source_versions',
    'idx_source_versions_content',
    'WHERE content_hash IS NOT NULL',
    'export interface SourceVersion',
    'getSourceVersionsForFighter',
    'const sourceBytes = await sourceFile.arrayBuffer()',
    'const contentHash = await hashString(sourceBytes)',
    'const duplicateVersion = await env.DB.prepare',
    'INSERT OR IGNORE INTO source_versions',
    'sourceResults = await env.DB.batch',
    'SELECT blob_key FROM source_versions',
    'batchContainsRow(sourceResults[2])',
    'deleteUncommittedAssets(env, [key])',
    'sources/${sourceKind}_${versionId}.png',
    "it('collapses concurrent identical source uploads without orphaning R2 objects'",
    '"db:execute:0007"',
  ];
  const combined = `${fighters}\n${integrationTests}\n${types}\n${migration}\n${workerPackage}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Source upload versioning is missing: ${missing.join(', ')}`);
  }
}

function assertSpriteUploadsAreIdempotent() {
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const index = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const integrationTests = readFileSync(join(root, 'worker/src/fighters.integration.test.ts'), 'utf8');
  const types = readFileSync(join(root, 'worker/src/types.ts'), 'utf8');
  const migration = readFileSync(join(root, 'worker/migrations/0006_sprite_content_hash.sql'), 'utf8');
  const required = [
    'content_hash TEXT',
    'raw_content_hash TEXT',
    'idx_sprite_versions_content',
    'WHERE content_hash IS NOT NULL',
    'content_hash: string | null',
    'raw_content_hash: string | null',
    'hashString',
    'const contentHash = await hashString(spriteBytes)',
    'const rawContentHash = rawSpriteBytes ? await hashString(rawSpriteBytes) : null',
    'const duplicateVersion = await env.DB.prepare',
    'COALESCE(raw_content_hash, \'\') = COALESCE(?, \'\')',
    'INSERT OR IGNORE INTO sprite_versions',
    'function upsertCurrentSpriteFromVersionStatement',
    'spriteResults = await env.DB.batch',
    'batchContainsRow(spriteResults[spriteResults.length - 1])',
    'deleteUncommittedAssets(env, stagedKeys)',
    "it('collapses concurrent identical sprite uploads and keeps current on the archived version'",
    "it('archives historical sprite uploads without changing current until explicitly requested'",
    'export async function promoteFighterSpriteVersion',
    "action === 'sprites' && method === 'PATCH'",
    "const setCurrent = setCurrentValue !== 'false'",
    'content_hash = excluded.content_hash',
    'raw_content_hash = excluded.raw_content_hash',
  ];
  const combined = `${fighters}\n${index}\n${integrationTests}\n${types}\n${migration}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Sprite upload idempotency is missing: ${missing.join(', ')}`);
  }
}

function assertLocalCachePreservesSpriteVersions() {
  const spriteCache = readFileSync(join(root, 'src/services/SpriteCache.ts'), 'utf8');
  const cloudFighters = readFileSync(join(root, 'src/services/CloudFighters.ts'), 'utf8');
  const characterPipeline = readFileSync(join(root, 'src/services/CharacterPipeline.ts'), 'utf8');
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const cacheTests = readFileSync(join(root, 'src/services/SpriteCache.test.ts'), 'utf8');
  const cloudTests = readFileSync(join(root, 'src/services/CloudFighters.test.ts'), 'utf8');
  const main = readFileSync(join(root, 'src/main.tsx'), 'utf8');
  const required = [
    'const DB_VERSION = 5',
    "const LOCAL_CACHE_SCOPE = 'local'",
    'ownerScope?: string',
    "versionId?: string",
    "keyPath: ['ownerScope', 'versionId']",
    "createIndex('byScopeHashAnimTier'",
    'function createSpriteVersionId',
    'options: { preserveVersionId?: boolean; ownerScope?: string }',
    'createSpriteVersionId(normalized)',
    'export function configureSpriteCacheOwner',
    'export function spriteCacheScopeForOwner',
    'export function getActiveSpriteCacheScope',
    'export function claimLocalSpriteCacheForCurrentOwner',
    'assertActiveCacheScope(scope)',
    'spriteStore.delete([LOCAL_CACHE_SCOPE, sprite.versionId])',
    'claimLocalSpriteCacheForCurrentOwner,',
    "it('claims every local sprite version and hides account data from other users'",
    "it('migrates the unscoped v4 cache into local ownership without deleting versions'",
    "it('merges a local collision without dropping either sprite version'",
    "it('clears only the active account scope'",
    "it('rejects a stale write after the active Clerk user changes'",
    'spriteVersions?: CloudSprite[]',
    'Archived sprite versions cannot be imported into the playable cache',
    'return selectPlayableCloudSprites(fighter.sprites)',
    'preserveVersionId: Boolean(sprite.id)',
    'buildSpriteUploadPlan(',
    'created.fighter?.spriteVersions ?? []',
    'created.fighter?.sprites ?? []',
    "form.append('setCurrent', String(setCurrent))",
    'sourceHashes: serializeCurrentSourceHashes',
    'contentHash: sprite.content_hash',
    'contentHash?: string | null',
    'cloudSourceHashes?: Record<string, string | null>',
    'cloudSpriteVersionCount?: number',
    'cloudPlayableSpriteRefs?: Record<string, CachedPlayableSpriteRef>',
    'export function selectPlayableCachedSprites',
    'const refs = meta?.cloudPlayableSpriteRefs ?? (meta?.cloudFighterId ? {} : undefined)',
    'export async function setCachedArchivedSprite',
    'await setCachedArchivedSprite(sprite, { preserveVersionId: true })',
    'const contentHash = await hashPhoto(sprite.pngBlob)',
    'await setCloudPlayableSpriteRefs(photoHash, playableRefs, ownerScope)',
    'buildSpriteDownloadPlan(',
    'selectPlayableCloudSprites',
    'includeArchivedVersions?: boolean',
    'includeRawAssets?: boolean',
    'includeArchivedVersions: false,',
    'includeRawAssets: false',
    'const localFingerprints = await fingerprintSprites(localSpriteVersions)',
    'meta.cloudSourceHashes = remoteSourceHashes',
    "it('skips remote versions already present by content hash'",
    "it('downloads only a missing RAW blob for an imported version id'",
    "it('downloads both blobs for a genuinely missing remote version'",
    "it('does no writes when cloud history and current pointers already match'",
    "it('accepts a complete current capability pack and never counts archived private versions'",
    "it('plays the exact remote-current sprite while keeping a newer archived candidate'",
    "it('fails closed for a cloud fighter without an exact current binding'",
    "it('keeps historical best-version selection for an Original local fighter'",
    "it('never promotes a newer higher-tier candidate outside the authoritative playable set'",
    "it('keeps Original sprites playable when the first sprite upload fails after cloud creation'",
    "it('keeps successful first sync pinned to the exact authoritative sprite hash'",
    'const requestedTierAnimations = new Set(requestedTierSprites.map((sprite) => sprite.animationName))',
    'requestedTierAnimations.size >= ANIMATIONS.length',
    'spriteVersions: spriteVersions.map',
    'const spriteVersions = await getSpriteVersionsForFighter(env, fighterId)',
    'serializeFighter(request, fighter, sprites, spriteVersions, sourceVersions)',
  ];
  const combined = `${spriteCache}\n${cacheTests}\n${cloudTests}\n${main}\n${cloudFighters}\n${characterPipeline}\n${fighters}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Local/cloud sprite version preservation is missing: ${missing.join(', ')}`);
  }
}

function assertWorkerErrorsDoNotLeakInProduction() {
  const index = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const auth = readFileSync(join(root, 'worker/src/auth.ts'), 'utf8');
  const billing = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const required = [
    "const isProduction = env.ENVIRONMENT === 'production'",
    "isProduction\n          ? { error: 'Internal server error' }",
    ": { error: 'Internal server error', message }",
    "if (env.ENVIRONMENT === 'production') return json({ error }, status)",
    "return json({ error, message }, status)",
    "const message = env.ENVIRONMENT === 'production'\n      ? 'Webhook verification failed'",
  ];
  const combined = `${index}\n${auth}\n${billing}`;
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Worker production error responses may leak internals: ${missing.join(', ')}`);
  }
}

function assertAnonymousRookieTurnstileIsWired() {
  const turnstile = readFileSync(join(root, 'worker/src/turnstile.ts'), 'utf8');
  const turnstileTest = readFileSync(join(root, 'worker/src/turnstile.test.ts'), 'utf8');
  const billing = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const billingClient = readFileSync(join(root, 'src/services/Billing.ts'), 'utf8');
  const createPage = readFileSync(join(root, 'src/ui/routes/CreateFighterPage.tsx'), 'utf8');
  const widget = readFileSync(join(root, 'src/ui/components/TurnstileChallenge.tsx'), 'utf8');
  const wrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const liveReadiness = readFileSync(join(root, 'scripts/check-live-readiness.mjs'), 'utf8');
  const liveSmoke = readFileSync(join(root, 'scripts/smoke-live.mjs'), 'utf8');
  const required = [
    "env.ENVIRONMENT === 'production' || env.TURNSTILE_REQUIRED === 'true'",
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    "request.headers.get('CF-Connecting-IP')",
    'result.action !== expectedAction',
    '!configuredHostnames(env).has(hostname)',
    'AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS)',
    'const turnstileError = await enforceAnonymousRookieTurnstile(request, env, body.turnstileToken)',
    'if (turnstileError) return turnstileError',
    'turnstileToken: turnstileToken ?? null',
    '<TurnstileChallenge',
    'disabled={running || creditCheckPending || (insufficientCredits',
    ': !file || !name.trim() || !turnstileReady || !legalAccepted || !recoveryReady)}',
    'if (insufficientCredits)',
    'onGetCredits?.(tier)',
    'window.turnstile.reset(widgetId)',
    'TURNSTILE_REQUIRED = "true"',
    'TURNSTILE_ACTION = "anonymous_rookie"',
    'TURNSTILE_HOSTNAMES = "insertplayer.ai,www.insertplayer.ai"',
    'ANONYMOUS_ROOKIE_ENABLED = "true"',
    "return env.ANONYMOUS_ROOKIE_ENABLED !== 'false'",
    'if (!anonymousRookieIsEnabled(env)) return anonymousRookieDisabledError()',
    "code: 'anonymous_rookie_disabled'",
    "'TURNSTILE_SECRET_KEY'",
    "['turnstile', 'configured']",
    "['anonymousRookie', 'enabled']",
    "health.anonymousRookie === 'enabled'",
    "rookieAuth.code === 'turnstile_required'",
    "it('accepts a valid token with the expected action and hostname'",
    "it('blocks anonymous provider sessions when an isolated environment disables Rookie'",
  ];
  const combined = [
    turnstile,
    turnstileTest,
    billing,
    workerIndex,
    billingClient,
    createPage,
    widget,
    wrangler,
    liveReadiness,
    liveSmoke,
  ].join('\n');
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Anonymous Rookie Turnstile protection is missing: ${missing.join(', ')}`);
  }
  if (/^\s*TURNSTILE_SECRET_KEY\s*=/m.test(wrangler)) {
    throw new Error('TURNSTILE_SECRET_KEY must remain a Worker secret, not a wrangler.toml var.');
  }
}

function assertHeavyRoutesStayLazy() {
  const app = readFileSync(join(root, 'src/ui/App.tsx'), 'utf8');
  const heavyRoutes = [
    'GalleryPage',
    'RosterPage',
    'CreateFighterPage',
    'StageScoutPage',
    'CommunityPage',
    'ModerationPage',
  ];
  const missingLazyImports = heavyRoutes.filter(
    (route) => !app.includes(`const ${route} = lazy(() => import('./routes/${route}.tsx')`),
  );
  const staticImports = heavyRoutes.filter((route) => new RegExp(
    `import\\s+\\{[^}]*\\b${route}\\b[^}]*\\}\\s+from\\s+['\"]\\.\\/routes\\/${route}\\.tsx['\"]`,
    's',
  ).test(app));

  if (missingLazyImports.length > 0 || staticImports.length > 0 || !app.includes('<Suspense')) {
    throw new Error([
      missingLazyImports.length > 0
        ? `Heavy routes must remain lazy-loaded: ${missingLazyImports.join(', ')}`
        : '',
      staticImports.length > 0
        ? `Heavy routes must not use static App imports: ${staticImports.join(', ')}`
        : '',
      !app.includes('<Suspense') ? 'Lazy route rendering must retain a Suspense fallback.' : '',
    ].filter(Boolean).join('\n'));
  }
}

function assertLaunchMetadataIsWired() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const main = readFileSync(join(root, 'src/main.tsx'), 'utf8');
  const styles = readFileSync(join(root, 'src/ui/styles.css'), 'utf8');
  const manifest = readFileSync(join(root, 'public/site.webmanifest'), 'utf8');
  const headers = readFileSync(join(root, 'public/_headers'), 'utf8');
  const frontendSmoke = readFileSync(join(root, 'scripts/smoke-frontend-live.mjs'), 'utf8');
  const frontendDeploy = readFileSync(join(root, 'scripts/deploy-frontend-pages.mjs'), 'utf8');
  const requiredHtml = [
    'name="description"',
    'name="theme-color"',
    'rel="manifest" href="/site.webmanifest"',
    'rel="icon" href="/assets/app-icon.svg"',
    'rel="apple-touch-icon" href="/assets/app-icon-192.png"',
    'property="og:title"',
    'property="og:image"',
    'property="og:image:secure_url"',
    'property="og:image:type" content="image/jpeg"',
    'property="og:image:width" content="1200"',
    'property="og:image:height" content="630"',
    'name="twitter:card" content="summary_large_image"',
    'rel="canonical" href="https://insertplayer.ai/"',
  ];
  const requiredManifest = [
    '"name":',
    '"id": "/"',
    '"start_url": "/menu"',
    '"display": "standalone"',
    '"orientation": "any"',
    '"/assets/app-icon-192.png"',
    '"/assets/app-icon-512.png"',
    '"/assets/app-maskable-512.png"',
  ];
  const requiredFiles = [
    'public/_headers',
    'public/assets/app-icon.svg',
    'public/assets/app-icon-192.png',
    'public/assets/app-icon-512.png',
    'public/assets/app-maskable-512.png',
    'public/assets/social-card-v6.png',
    'public/assets/social-card-v7.jpg',
    'public/assets/social-card-v7.webp',
    'public/assets/social-card.svg',
    'public/assets/social-card-visual-v3.png',
    'scripts/assets/social-card.html',
    'scripts/assets/social-card.css',
    'public/robots.txt',
    'public/sitemap.xml',
    'scripts/frontend-security-headers.mjs',
    'scripts/frontend-smoke-readiness.mjs',
    'scripts/configure-frontend-dist.mjs',
    'scripts/build-prelaunch.mjs',
    'scripts/deploy-prelaunch-pages.mjs',
    'scripts/smoke-frontend-prelaunch.mjs',
    'src/prelaunch.tsx',
    'src/ui/PrelaunchApp.tsx',
  ];
  const requiredHeaders = [
    'X-Content-Type-Options: nosniff',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'X-Frame-Options: DENY',
    "Content-Security-Policy: default-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
    'Permissions-Policy: camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security: max-age=31536000; includeSubDomains',
    '/assets/*',
    'Cache-Control: public, max-age=31536000, immutable',
    '/site.webmanifest',
    '/robots.txt',
    '/sitemap.xml',
  ];
  const requiredSmoke = [
    "home.res.headers.get('X-Content-Type-Options') === 'nosniff'",
    "home.res.headers.get('Referrer-Policy') === 'strict-origin-when-cross-origin'",
    "home.res.headers.get('X-Frame-Options') === 'DENY'",
    "home.res.headers.get('Content-Security-Policy')",
    'parseContentSecurityPolicy',
    'frontendShellReadinessError',
    'expectedAssetPath',
    'ASF_EXPECTED_FRONTEND_ASSET_PATH',
    'assertCspSource',
    "['script-src', 'https://challenges.cloudflare.com']",
    "['script-src', expectedClerkOrigin]",
    "['frame-src', 'https://*.protect.clerk.com']",
    'forbiddenCspSources',
    'must not trust',
    "csp.has('upgrade-insecure-requests')",
    "home.res.headers.get('Permissions-Policy') === 'camera=(), microphone=(), geolocation=()'",
    "home.res.headers.get('Strict-Transport-Security') === 'max-age=31536000; includeSubDomains'",
    "home.res.headers.get('Cache-Control') === 'public, max-age=0, must-revalidate'",
    'expectedAppName',
    "manifestJson.name === expectedAppName",
    'expectedSocialCardPath',
    'expectedSocialCardMime',
    'property="og:image:secure_url"',
    'property="og:image:type"',
    'socialCardBytes <= 300_000',
    'Home HTML missing canonical production origin',
    'robots.txt missing canonical sitemap',
    'Sitemap must not publish private roster routes',
    "const cacheControl = res.headers.get('Cache-Control')",
    'expected JavaScript',
  ];
  const requiredDeploy = [
    "'frontend environment CSP'",
    "'scripts/configure-frontend-dist.mjs'",
    "`--target=${isSandbox ? 'sandbox' : 'live'}`",
  ];
  const missingHtml = requiredHtml.filter((snippet) => !html.includes(snippet));
  if (textReferencesHostname(html, ['fonts.googleapis.com', 'fonts.gstatic.com'])) {
    throw new Error('Launch HTML must self-host fonts instead of sending player requests to Google Fonts.');
  }
  if (!main.includes("import '@fontsource/press-start-2p/latin-400.css'")) {
    throw new Error('Launch frontend must bundle the arcade font locally.');
  }
  if (
    !styles.includes('.legal-footer nav a,') ||
    !styles.includes('.legal-page__toolbar nav a,') ||
    !styles.includes('.legal-consent__links a {') ||
    !styles.includes('@apply inline-flex min-h-11 min-w-11 items-center justify-center;')
  ) {
    throw new Error('Independent legal and consent links must retain 44px mobile tap targets.');
  }
  const missingManifest = requiredManifest.filter((snippet) => !manifest.includes(snippet));
  const missingFiles = requiredFiles.filter((file) => !existsSync(join(root, file)));
  const missingHeaders = requiredHeaders.filter((snippet) => !headers.includes(snippet));
  const missingSmoke = requiredSmoke.filter((snippet) => !frontendSmoke.includes(snippet));
  const missingDeploy = requiredDeploy.filter((snippet) => !frontendDeploy.includes(snippet));
  const prelaunchHeaders = frontendHeadersForTarget({ target: 'prelaunch' });
  if (headers !== prelaunchHeaders) {
    throw new Error('public/_headers must remain the self-only fallback; deployment generates exact live or sandbox CSP allowlists.');
  }
  if (
    missingHtml.length > 0 ||
    missingManifest.length > 0 ||
    missingFiles.length > 0 ||
    missingHeaders.length > 0 ||
    missingSmoke.length > 0 ||
    missingDeploy.length > 0
  ) {
    throw new Error([
      missingHtml.length > 0 ? `missing launch HTML metadata: ${missingHtml.join(', ')}` : '',
      missingManifest.length > 0 ? `missing manifest metadata: ${missingManifest.join(', ')}` : '',
      missingFiles.length > 0 ? `missing launch image assets: ${missingFiles.join(', ')}` : '',
      missingHeaders.length > 0 ? `missing Pages headers: ${missingHeaders.join(', ')}` : '',
      missingSmoke.length > 0 ? `missing frontend header smoke coverage: ${missingSmoke.join(', ')}` : '',
      missingDeploy.length > 0 ? `missing environment-specific Pages deployment wiring: ${missingDeploy.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
  }
}

function assertLaunchRasterAssetsAreFresh() {
  const assets = [
    ['scripts/assets/social-card.html', 'public/assets/social-card-v7.jpg', 1200, 630, 300_000],
    ['scripts/assets/social-card.css', 'public/assets/social-card-v7.jpg', 1200, 630, 300_000],
    ['public/assets/social-card-visual-v3.png', 'public/assets/social-card-v7.jpg', 1200, 630, 300_000],
    ['scripts/assets/social-card.html', 'public/assets/social-card-v7.webp', 1200, 630, 150_000],
    ['scripts/assets/social-card.css', 'public/assets/social-card-v7.webp', 1200, 630, 150_000],
    ['public/assets/social-card-visual-v3.png', 'public/assets/social-card-v7.webp', 1200, 630, 150_000],
    ['public/assets/app-icon.svg', 'public/assets/app-icon-192.png', 192, 192],
    ['public/assets/app-icon.svg', 'public/assets/app-icon-512.png', 512, 512],
    ['public/assets/app-icon.svg', 'public/assets/app-maskable-512.png', 512, 512],
  ];

  for (const [sourcePath, rasterPath, expectedWidth, expectedHeight, maxBytes] of assets) {
    const source = statSync(join(root, sourcePath));
    const raster = statSync(join(root, rasterPath));
    if (raster.mtimeMs + 1000 < source.mtimeMs) {
      throw new Error(`${rasterPath} is older than ${sourcePath}. Run npm run brand:rasterize.`);
    }
    const { width, height } = readImageSize(join(root, rasterPath));
    if (width !== expectedWidth || height !== expectedHeight) {
      throw new Error(`${rasterPath} is ${width}x${height}; expected ${expectedWidth}x${expectedHeight}.`);
    }
    if (maxBytes && raster.size > maxBytes) {
      throw new Error(`${rasterPath} is ${raster.size} bytes; expected no more than ${maxBytes}.`);
    }
  }
}

function assertDurableGenerationIsWired() {
  const migration = readFileSync(join(root, 'worker/migrations/0018_durable_generation_jobs.sql'), 'utf8');
  const retryMigration = readFileSync(join(root, 'worker/migrations/0019_durable_retry_jobs.sql'), 'utf8');
  const billing = readFileSync(join(root, 'worker/src/billing.ts'), 'utf8');
  const jobs = readFileSync(join(root, 'worker/src/generationJobs.ts'), 'utf8');
  const workflow = readFileSync(join(root, 'worker/src/generationWorkflow.ts'), 'utf8');
  const auth = readFileSync(join(root, 'worker/src/generationAuth.ts'), 'utf8');
  const assets = readFileSync(join(root, 'worker/src/generatedAssets.ts'), 'utf8');
  const imageProcessorContainer = readFileSync(join(root, 'worker/src/imageProcessorContainer.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const processor = readFileSync(join(root, 'processor/src/server.ts'), 'utf8');
  const processorDockerfile = readFileSync(join(root, 'Dockerfile.processor'), 'utf8');
  const frontendJobs = readFileSync(join(root, 'src/services/GenerationJobs.ts'), 'utf8');
  const apiClientTests = readFileSync(join(root, 'src/services/ApiClient.test.ts'), 'utf8');
  const createPage = readFileSync(join(root, 'src/ui/routes/CreateFighterPage.tsx'), 'utf8');
  const galleryPage = readFileSync(join(root, 'src/ui/routes/GalleryPage.tsx'), 'utf8');
  const rateLimit = readFileSync(join(root, 'worker/src/rateLimit.ts'), 'utf8');
  const productionWrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  const sandboxWrangler = readFileSync(join(root, 'worker/wrangler.sandbox.toml'), 'utf8');
  const workerPackage = readFileSync(join(root, 'worker/package.json'), 'utf8');
  const authTests = readFileSync(join(root, 'worker/src/generationAuth.test.ts'), 'utf8');
  const jobTests = readFileSync(join(root, 'worker/src/generationJobs.integration.test.ts'), 'utf8');
  const assetTests = readFileSync(join(root, 'worker/src/generatedAssets.integration.test.ts'), 'utf8');
  const providerTests = readFileSync(join(root, 'worker/src/providerSessions.integration.test.ts'), 'utf8');
  const billingTests = readFileSync(join(root, 'worker/src/billing.integration.test.ts'), 'utf8');
  const combined = [
    migration,
    retryMigration,
    billing,
    jobs,
    workflow,
    auth,
    assets,
    imageProcessorContainer,
    workerIndex,
    processor,
    processorDockerfile,
    frontendJobs,
    apiClientTests,
    createPage,
    galleryPage,
    rateLimit,
    productionWrangler,
    sandboxWrangler,
    workerPackage,
    authTests,
    jobTests,
    assetTests,
    providerTests,
    billingTests,
  ].join('\n');
  const required = [
    'CREATE TABLE IF NOT EXISTS generation_jobs',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_active_fighter',
    'CREATE TABLE IF NOT EXISTS generation_job_events',
    'CREATE TABLE IF NOT EXISTS provider_request_cache',
    'UNIQUE(job_id, provider, method, request_path, request_hash)',
    "'fighter_retry_animation'",
    "'fighter_retry_source'",
    'target_kind TEXT',
    'target_name TEXT',
    'export async function settleGenerationPurchase',
    'successStatements: D1PreparedStatement[] = []',
    '...successStatements',
    'export async function createGenerationJob',
    "retention: { successRetention: '30 days', errorRetention: '30 days' }",
    "locationHint: 'weur'",
    "status IN ('queued', 'running')",
    'unused reservation was released',
    'export class FighterGenerationWorkflow extends WorkflowEntrypoint',
    "retries: { limit: 5, delay: '30 seconds'",
    "timeout: '3 hours'",
    "step.do('commit generation purchase'",
    'INSERT OR IGNORE INTO generation_job_events',
    'GENERATION_JOB_SIGNING_SECRET is required',
    '[secrets]',
    '"GENERATION_JOB_SIGNING_SECRET"',
    '"types:check": "node ../scripts/wrangler-workspace-log.mjs types worker-configuration.d.ts --strict-vars false --check"',
    'Generation job is not active',
    'export class ImageProcessorContainer extends Container',
    "path === '/api/generation-jobs' && method === 'POST'",
    "path === '/api/generation-jobs' && method === 'GET'",
    'durableGeneration: env.FIGHTER_GENERATION',
    "image = \"../Dockerfile.processor\"",
    'jurisdiction = "eu"',
    'FROM node:22-bookworm-slim',
    'USER node',
    'export async function startGenerationJob',
    'export async function waitForGenerationJob',
    'listGenerationJobs',
    "'generation:job':",
    'backendOwnsPurchase = true',
    'targetKind: target.kind',
    "Connection lost. The cloud job is still running; reconnecting...",
    "step.do('retry canonical side source'",
    "step.do('retry canonical upright source'",
    "step.do('retry canonical crouch source'",
    'preparing your private cloud fighter',
    'deduplicates exact source retries while preserving every distinct version',
    'replays a completed provider response without another call reservation',
    'keys parallel calls by semantic scope plus body and blocks exact concurrent duplicates',
    'uses a stable semantic request key for parallel durable provider calls',
    'starts one idempotent workflow and extends its backend-owned reservation',
    'keeps one reserved purchase when identical job requests race',
    'starts an idempotent one-target animation retry in the durable workflow',
    'starts a one-target canonical source retry with the source scope',
    'releases a retry reservation when its target is outside the scoped animation set',
    'keeps a reservation uncommitted when the durable completion batch fails',
  ];
  const missing = required.filter((snippet) => !combined.toLowerCase().includes(snippet.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`Durable generation wiring is incomplete: ${missing.join(', ')}`);
  }
  for (const [label, config] of [['production', productionWrangler], ['sandbox', sandboxWrangler]]) {
    if (/^\s*GENERATION_JOB_SIGNING_SECRET\s*=/m.test(config)) {
      throw new Error(`${label} generation job signing key must remain a Worker secret.`);
    }
  }
}

function assertVideoSpriteProductionToolchainGate() {
  const dockerfile = readFileSync(join(root, 'Dockerfile.processor'), 'utf8');
  const dockerRequired = [
    'AS media-runtime',
    'ENV VIDEO_SPRITE_APPROVED_FFMPEG_VERSION=5.1.9-0+deb12u1',
    'ffmpeg=7:5.1.9-0+deb12u1',
    'ffmpeg version 5.1.9-0+deb12u1',
    'ffprobe version 5.1.9-0+deb12u1',
    'FROM media-runtime AS video-sprite-test',
    'COPY --from=build /app /app',
    'VIDEO_SPRITE_TEST_FFMPEG=1 npm --prefix processor run test:video-sprite',
    'FROM media-runtime AS runtime',
  ];
  const missingDocker = dockerRequired.filter((snippet) => !dockerfile.includes(snippet));
  if (missingDocker.length > 0) {
    throw new Error(`Video sprite production toolchain is incomplete: ${missingDocker.join(', ')}`);
  }
  for (const [label, path] of [
    ['reusable validation', '.github/workflows/validate.yml'],
    ['production Arcade seed', '.github/workflows/seed-arcade-production.yml'],
  ]) {
    const validation = readFileSync(join(root, path), 'utf8');
    const toolchainStep = validation.indexOf('--target video-sprite-test');
    const productionGate = validation.indexOf('run: npm run check:production');
    if (toolchainStep < 0 || productionGate < 0 || toolchainStep >= productionGate) {
      throw new Error(`${label} must test the production video-sprite image before check:production.`);
    }
    if (!validation.includes('VIDEO_SPRITE_PRODUCTION_TOOLCHAIN_VALIDATED: "1"')) {
      throw new Error(`${label} must mark the exact media test before the host production gate.`);
    }
  }

  const productionDeploy = readFileSync(join(root, '.github/workflows/deploy-production.yml'), 'utf8');
  const frontendDeploy = readFileSync(join(root, '.github/workflows/deploy-frontend-production.yml'), 'utf8');
  if (!/^\s{4}needs: validate$/m.test(productionDeploy)) {
    throw new Error('Production deploy must remain blocked on the reusable validation job.');
  }
  const pagesStepStart = productionDeploy.indexOf('- name: Build, deploy, and smoke Pages');
  const pagesStepEnd = productionDeploy.indexOf('\n      - name:', pagesStepStart + 1);
  const pagesStep = pagesStepStart >= 0
    ? productionDeploy.slice(pagesStepStart, pagesStepEnd >= 0 ? pagesStepEnd : undefined)
    : '';
  const proofAssignments = productionDeploy.match(/VIDEO_SPRITE_PRODUCTION_TOOLCHAIN_VALIDATED:\s*"1"/g) ?? [];
  if (proofAssignments.length !== 1 ||
      !pagesStep.includes('VIDEO_SPRITE_PRODUCTION_TOOLCHAIN_VALIDATED: "1"') ||
      !pagesStep.includes('run: npm run deploy:frontend')) {
    throw new Error('Only the Pages deploy step may inherit the exact media-toolchain proof from validation.');
  }
  for (const snippet of [
    'CHANGED=worker-version-tag-missing',
    'ACKNOWLEDGE_WORKER_DRIFT',
    'Frontend/Worker drift explicitly acknowledged:',
  ]) {
    if (!frontendDeploy.includes(snippet)) {
      throw new Error(`Frontend-only deploy must fail closed or explicitly acknowledge Worker drift: ${snippet}`);
    }
  }
}

function assertOfficialArcadeIsWired() {
  const migration = readFileSync(join(root, 'worker/migrations/0020_official_arcade.sql'), 'utf8');
  const promptMigration = readFileSync(join(root, 'worker/migrations/0021_arcade_generation_prompts.sql'), 'utf8');
  const fighters = readFileSync(join(root, 'worker/src/fighters.ts'), 'utf8');
  const arcadeAssets = readFileSync(join(root, 'worker/src/arcadeAssets.ts'), 'utf8');
  const generation = readFileSync(join(root, 'worker/src/arcadeGeneration.ts'), 'utf8');
  const workflow = readFileSync(join(root, 'worker/src/generationWorkflow.ts'), 'utf8');
  const processor = readFileSync(join(root, 'processor/src/server.ts'), 'utf8');
  const gemini = readFileSync(join(root, 'src/services/GeminiApi.ts'), 'utf8');
  const workerIndex = readFileSync(join(root, 'worker/src/index.ts'), 'utf8');
  const cloudFighters = readFileSync(join(root, 'src/services/CloudFighters.ts'), 'utf8');
  const legalPage = readFileSync(join(root, 'src/ui/routes/LegalPage.tsx'), 'utf8');
  const rosterPage = readFileSync(join(root, 'src/ui/routes/RosterPage.tsx'), 'utf8');
  const seeder = readFileSync(join(root, 'scripts/seed-arcade-roster.mjs'), 'utf8');
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'arcade/roster-2026.json'), 'utf8'));
  const expectedSlugs = [
    'donald-trump',
    'lamine-yamal',
    'ibai-llanos',
    'aitana',
    'rosalia',
    'bad-bunny',
    'mrbeast',
    'ishowspeed',
    'elon-musk',
    'cristiano-ronaldo',
    'javier-milei',
    'lionel-messi',
    'perro-sanxe',
    'rosalia-v2',
    'player-one',
  ];
  if (manifest.qualityTier !== 'champion') {
    throw new Error('The official Arcade manifest must stay Champion-only.');
  }
  if (!Array.isArray(manifest.fighters) || manifest.fighters.length !== expectedSlugs.length) {
    throw new Error(`The official Arcade manifest must contain exactly ${expectedSlugs.length} launch fighters.`);
  }
  const actualSlugs = manifest.fighters.map((fighter) => fighter.slug);
  const missingSlugs = expectedSlugs.filter((slug) => !actualSlugs.includes(slug));
  if (missingSlugs.length > 0 || new Set(actualSlugs).size !== actualSlugs.length) {
    throw new Error(`The official Arcade manifest is missing or duplicating launch fighters: ${missingSlugs.join(', ')}`);
  }
  if (!/unofficial/i.test(manifest.disclosure ?? '') || !/endorse/i.test(manifest.disclosure ?? '')) {
    throw new Error('The official Arcade manifest must retain its unofficial/no-endorsement disclosure.');
  }
  const invalidReferences = manifest.fighters.filter((fighter) => {
    const reference = fighter.reference ?? manifest.reference;
    return (
      reference?.kind !== 'licensed'
      || typeof reference.sourceUrl !== 'string'
      || !reference.sourceUrl.startsWith('https://')
      || typeof reference.licenseUrl !== 'string'
      || !reference.licenseUrl.startsWith('https://')
      || !reference.license
      || !reference.credit
      || !reference.author
      || !reference.sourceDate
      || !reference.verification
      || !/^[a-f0-9]{64}$/.test(reference.sourceSha256 ?? '')
    );
  });
  if (invalidReferences.length > 0) {
    throw new Error(`Every launch fighter needs approved licensed-photo provenance: ${invalidReferences.map((fighter) => fighter.slug).join(', ')}`);
  }
  const sourceUrls = manifest.fighters.map((fighter) => (fighter.reference ?? manifest.reference).sourceUrl);
  if (new Set(sourceUrls).size !== sourceUrls.length) {
    throw new Error('Each launch fighter must use a distinct licensed source photo.');
  }
  if (manifest.fighters.some((fighter) => !fighter.referencePrompt || fighter.referencePrompt.length < 180)) {
    throw new Error('Every official Arcade fighter needs a detailed transformation prompt.');
  }

  const combined = [
    migration,
    promptMigration,
    fighters,
    arcadeAssets,
    generation,
    workflow,
    processor,
    gemini,
    workerIndex,
    cloudFighters,
    legalPage,
    rosterPage,
    seeder,
    packageJson,
    gitignore,
  ].join('\n');
  const required = [
    'CREATE TABLE IF NOT EXISTS arcade_fighters',
    'ADD COLUMN generation_prompt TEXT',
    "WHERE status IN ('draft', 'active')",
    "af.status = 'active'",
    'AND f.public_flag = 1',
    'Generate the full playable animation set before activating this fighter',
    'export async function startAdminArcadeGeneration',
    "'arcade_seed_generation'",
    "VALUES (?, ?, 'champion', 0, 0, 'reserved'",
    'return createGenerationJob',
    "path === '/api/arcade' && method === 'GET'",
    '/api/admin/arcade/',
    'downloadArcadeFighterToLocal',
    'arcadeFighterPhotoHash',
    'Photo: {fighter.cloud.arcade.reference.credit}',
    'makes that artwork available under the same CC BY-SA version',
    'sourceSha256',
    'Licensed source hash mismatch',
    'ASF_ARCADE_CLERK_SECRET_KEY',
    'expires_in_seconds: CLERK_TOKEN_TTL_SECONDS',
    'Use the Clerk secret-key flow for long jobs',
    'generationPrompt: fighter.referencePrompt',
    "SELECT generation_prompt",
    "provider_content_blocked",
    'new NonRetryableError',
    'GeminiContentBlockedError',
    "ARCADE_ADMIN_SEED_HEADER = 'X-Insert-Player-Admin-Seed'",
    'allowMissingAuthorizedParty: isArcadeAdminSeed',
    "auth.user.plan_tier !== 'admin'",
    "type RosterFilter = 'official' | 'yours' | 'all'",
    "playableSpriteSetSql('f', 'champion')",
    'length(s.content_hash) = 64',
    "s.content_hash NOT GLOB '*[^0-9A-Fa-f]*'",
    "typeof(s.frame_w) = 'integer'",
    's.frame_count BETWEEN 1 AND ${MAX_SPRITE_FRAME_COUNT}',
    'FROM sprites higher',
    'higher.animation_name = s.animation_name',
    'SHA256_PATTERN.test(sprite.content_hash)',
    'SHA256_PATTERN.test(sprite.raw_content_hash)',
    'sprite:${animationName}:frame-metadata',
    '"arcade:seed": "node scripts/seed-arcade-roster.mjs"',
    '--confirm-production',
    '.arcade-sources/',
    '.arcade-state.json',
  ];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Official Arcade wiring is incomplete: ${missing.join(', ')}`);
  }
}

function assertStageScoutIsWired() {
  const requiredByFile = {
    'src/ui/App.tsx': [
      "import('./routes/StageScoutPage.tsx')",
      "'/stages/new'",
      "navigate('/gallery', 'tab=stages')",
    ],
    'src/ui/routes/StageScoutPage.tsx': [
      'StreetViewCoverageLayer',
      'captureGoogleStreetView',
      'Forge Stage',
      'Use Photo',
      'Stage Ready',
      'STAGE_FORGE_CREDIT_COST',
    ],
    'src/services/GoogleMapsPlatform.ts': [
      'VITE_GOOGLE_MAPS_BROWSER_KEY',
      "'/api/maps/street-view/capture'",
      'auth_referrer_policy=origin',
    ],
    'src/services/StageBackgroundService.ts': [
      'authorizeStageForge(apiContext)',
      'finishGenerationPurchase',
      'STAGE_GAMEPLAY_CLEARANCE_PROMPT_MARKER',
      'createDirectPhotoStage',
    ],
    'src/services/StageBackgroundPrompt.ts': [
      'STAGE_GAMEPLAY_CLEARANCE_PROMPT_MARKER',
      'lower 38%',
      'Edit only the minimum set of objects',
    ],
    'src/shared/StageForgePricing.ts': [
      'STAGE_FORGE_CREDIT_COST = 1',
    ],
    'worker/src/index.ts': [
      "path === '/api/maps/street-view/capture'",
      "path === '/api/billing/stage-forge'",
      "mapsCapture: env.GOOGLE_MAPS_SERVER_KEY ? 'configured' : 'not_configured'",
    ],
    'worker/src/googleMaps.ts': [
      'GOOGLE_MAPS_SERVER_KEY',
      "upstreamUrl.searchParams.set('pano'",
      "locationUrl.searchParams.set('location'",
      "'Cache-Control': 'private, no-store'",
      'MAX_CAPTURE_BYTES',
    ],
    'worker/src/billing.ts': [
      'authorizeStageForgePurchase',
      "'stage_forge'",
      "purpose: 'stage_background'",
      'STAGE_FORGE_CREDIT_COST',
    ],
    'worker/src/rateLimit.ts': [
      "'maps:capture'",
      "'billing:stage-forge'",
    ],
    'scripts/frontend-security-headers.mjs': [
      'https://*.googleapis.com',
      'https://*.gstatic.com',
      'https://*.google.com',
    ],
    'scripts/check-live-readiness.mjs': [
      "'GOOGLE_MAPS_SERVER_KEY'",
      "'VITE_GOOGLE_MAPS_BROWSER_KEY'",
      "['mapsCapture', 'configured']",
    ],
    '.github/workflows/deploy-production.yml': [
      'VITE_GOOGLE_MAPS_BROWSER_KEY: ${{ vars.VITE_GOOGLE_MAPS_BROWSER_KEY }}',
      'GOOGLE_MAPS_SERVER_KEY: ${{ secrets.GOOGLE_MAPS_SERVER_KEY }}',
    ],
    '.github/workflows/deploy-development.yml': [
      'VITE_GOOGLE_MAPS_BROWSER_KEY: ${{ vars.VITE_GOOGLE_MAPS_BROWSER_KEY }}',
      'GOOGLE_MAPS_SERVER_KEY: ${{ secrets.GOOGLE_MAPS_SERVER_KEY }}',
    ],
  };
  const missing = [];
  for (const [path, snippets] of Object.entries(requiredByFile)) {
    if (!existsSync(join(root, path))) {
      missing.push(`${path}: file missing`);
      continue;
    }
    const source = readFileSync(join(root, path), 'utf8');
    for (const snippet of snippets) {
      if (!source.includes(snippet)) missing.push(`${path}: ${snippet}`);
    }
  }

  const productionWrangler = readFileSync(join(root, 'worker/wrangler.toml'), 'utf8');
  if (/^\s*GOOGLE_MAPS_SERVER_KEY\s*=/m.test(productionWrangler)) {
    missing.push('worker/wrangler.toml: GOOGLE_MAPS_SERVER_KEY must remain a secret');
  }
  for (const file of walk(join(root, 'src'))) {
    const source = readFileSync(file, 'utf8');
    if (source.includes('VITE_GOOGLE_MAPS_SERVER_KEY')) {
      missing.push(`${relative(root, file)}: server key exposed to Vite`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Stage Scout production wiring is incomplete:\n- ${missing.join('\n- ')}`);
  }
}

function assertCanonicalProductionReleaseIsWired() {
  const requiredByFile = {
    'scripts/production-deploy-guard-lib.mjs': [
      'Routine production deploys are CI-only',
      "githubRef !== 'refs/heads/main'",
      "const ATTESTED_CI_GENERATED_PATHS = new Set(['worker/wrangler.toml'])",
      'export function isProductionWranglerMutation',
      'export function statusOutsideAttestedCiGeneration',
    ],
    'scripts/production-deploy-guard.mjs': [
      "['ls-remote', '--exit-code', 'origin', 'refs/heads/main']",
      'ASF_CANONICAL_RELEASE_ATTESTED_SHA',
      'ASF_PRODUCTION_BREAK_GLASS_REASON',
    ],
    'scripts/wrangler-workspace-log.mjs': [
      'isProductionWranglerMutation(wranglerArgs)',
      'assertProductionDeployAllowed({ root })',
    ],
    'scripts/apply-live-config.mjs': [
      'const mutatesProduction =',
      'assertProductionDeployAllowed({ root })',
    ],
    'scripts/worker-version-rollout.mjs': [
      "['rollback', 'stage', 'promote'].includes(action)",
      'assertProductionDeployAllowed({ root })',
    ],
    'scripts/deploy-prelaunch-pages.mjs': [
      'assertProductionDeployAllowed({ root })',
    ],
    'scripts/deploy-frontend-pages.mjs': [
      'writeFrontendReleaseManifest',
      'ASF_EXPECTED_FRONTEND_GIT_SHA',
      'assertProductionDeployAllowed({ root })',
    ],
    'scripts/smoke-frontend-live.mjs': [
      'ASF_EXPECTED_FRONTEND_GIT_SHA',
      "'/release.json'",
      'frontendReleaseManifestIssue',
    ],
    'scripts/release-provenance.mjs': [
      "environment: 'production'",
      "join(distDir, 'release.json')",
      'entryAssetPath',
    ],
    '.github/workflows/deploy-production.yml': [
      'Attest canonical production source',
      'node scripts/production-deploy-guard.mjs',
      'ASF_CANONICAL_RELEASE_ATTESTED_SHA=%s',
    ],
    '.github/workflows/deploy-frontend-production.yml': [
      'Attest canonical production source',
      'node scripts/production-deploy-guard.mjs',
      'ASF_CANONICAL_RELEASE_ATTESTED_SHA=%s',
    ],
    '.github/DEPLOYMENT.md': [
      'GitHub Actions is the only routine production deployment path',
      '`/release.json`',
      'ASF_PRODUCTION_BREAK_GLASS=1',
      'remotely verified',
    ],
  };
  const missing = [];
  for (const [path, snippets] of Object.entries(requiredByFile)) {
    if (!existsSync(join(root, path))) {
      missing.push(`${path}: file missing`);
      continue;
    }
    const source = readFileSync(join(root, path), 'utf8');
    for (const snippet of snippets) {
      if (!source.includes(snippet)) missing.push(`${path}: ${snippet}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Canonical production release guard is incomplete:\n- ${missing.join('\n- ')}`);
  }
}

function assertGithubActionsAreWired() {
  const files = {
    validation: '.github/workflows/validate.yml',
    ci: '.github/workflows/ci.yml',
    development: '.github/workflows/deploy-development.yml',
    production: '.github/workflows/deploy-production.yml',
    frontendProduction: '.github/workflows/deploy-frontend-production.yml',
    xaiCanary: '.github/workflows/arcade-side-xai-canary-production.yml',
    xaiGlobal: '.github/workflows/arcade-side-xai-global-production.yml',
    xaiHighKick: '.github/workflows/arcade-high-kick-xai-canary-production.yml',
    xaiQaMotion: '.github/workflows/arcade-qa-motion-xai-canary-production.yml',
    codeql: '.github/workflows/codeql.yml',
    dependencySecurity: '.github/workflows/dependency-security.yml',
    dependabot: '.github/dependabot.yml',
    codeowners: '.github/CODEOWNERS',
    runbook: '.github/DEPLOYMENT.md',
    processorDeployCheck: 'scripts/check-image-processor-contract.mjs',
    processorDeployRoute: 'worker/src/deploymentPreflight.ts',
    workerIndex: 'worker/src/index.ts',
  };
  const missingFiles = Object.values(files).filter((path) => !existsSync(join(root, path)));
  if (missingFiles.length > 0) {
    throw new Error(`Missing GitHub delivery files: ${missingFiles.join(', ')}`);
  }

  const text = Object.fromEntries(
    Object.entries(files).map(([key, path]) => [key, readFileSync(join(root, path), 'utf8')]),
  );
  const required = {
    validation: [
      'workflow_call:',
      'actions/checkout@v6',
      'actions/setup-node@v6',
      'npm run check:production',
      'npm run build:sandbox',
      'npm --prefix worker run deploy -- --dry-run',
      'npm --prefix worker run deploy:sandbox -- --dry-run',
      'vulnerability-alerts: read',
      'dependabot/alerts',
      'security_advisory.severity',
    ],
    ci: [
      'pull_request:',
      '- develop',
      '- main',
      'uses: ./.github/workflows/validate.yml',
      'vulnerability-alerts: read',
    ],
    development: [
      'group: deploy-development',
      'cancel-in-progress: true',
      'name: development',
      'ASF_SANDBOX_PAGES_BRANCH: develop',
      'npm run config:sandbox',
      'npm run deploy:frontend:sandbox',
      'secrets.CLOUDFLARE_API_TOKEN',
      'secrets.ANONYMIZATION_SECRET',
      'secrets.GENERATION_JOB_SIGNING_SECRET',
      'secrets.CLERK_BACKEND_AUTH_BRIDGE_SECRET',
      'vulnerability-alerts: read',
    ],
    production: [
      'group: production-worker-mutations',
      'cancel-in-progress: false',
      'name: production',
      'BRAND_CLEARANCE_JSON',
      'ASF_BRAND_CLEARANCE_FILE=$ASF_BRAND_CLEARANCE_FILE" >> "$GITHUB_ENV',
      'npm run check:meterkey-auth',
      'ASF_METERKEY_EXPECTED_KEY_ID:',
      'ASF_METERKEY_EXPECTED_KEY_FINGERPRINT:',
      'ASF_METERKEY_EXPECTED_USER_ID:',
      'ASF_METERKEY_EXPECTED_WALLET_ID:',
      'ASF_METERKEY_MIN_AVAILABLE_UC:',
      'ASF_METERKEY_EXPECTED_PER_REQUEST_CAP_UC:',
      'node scripts/worker-version-rollout.mjs guard-full',
      'node scripts/apply-live-config.mjs --skip-production-check --dry-run-worker-deploy',
      'npm --prefix worker run db:migrate',
      'node scripts/check-generation-idle.mjs',
      'node scripts/apply-live-config.mjs --skip-production-check --deploy-worker',
      'ASF_EXPECTED_WORKER_VERSION_TAG:',
      'npm run check:image-processor-contract',
      'node scripts/worker-version-rollout.mjs rollback',
      'npm run smoke:live',
      'npm run deploy:frontend',
      'npm run check:live-readiness',
      'secrets.CLOUDFLARE_API_TOKEN',
      'secrets.CLERK_WEBHOOK_SIGNING_SECRET',
      'secrets.GENERATION_JOB_SIGNING_SECRET',
      'secrets.CLERK_BACKEND_AUTH_BRIDGE_SECRET',
      'vulnerability-alerts: read',
    ],
    frontendProduction: [
      'workflow_dispatch:',
      'group: production-worker-mutations',
      'name: production',
      'Attest canonical production source',
      'node scripts/production-deploy-guard.mjs',
      'ASF_CANONICAL_RELEASE_ATTESTED_SHA=%s',
      'Guard frontend/Worker contract drift',
      'npm run deploy:frontend',
    ],
    xaiCanary: [
      'workflow_dispatch:',
      'ARCADE_SIDE_XAI_TRUMP_POSE_TRANSFER_V2',
      'authorize exactly one paid two-reference SIDE call',
      'group: production-worker-mutations',
      'cancel-in-progress: false',
      'npm --prefix worker ci',
      'npm run test:arcade:xai-canary',
      '--slug=donald-trump',
      'npm run arcade:pose-master',
      '--master=xai-milei-side-v1',
      'npm run arcade:canary:xai-side',
      '--state=.arcade-side-xai-pose-transfer-canary-state.json',
      '--pose-master-upload-state=.arcade-xai-pose-master-upload-state.json',
      'arcade-side-xai-trump-pose-transfer-v2-state',
      'secrets.PIXCLI_API_KEY',
      'secrets.CLOUDFLARE_API_TOKEN',
    ],
    xaiGlobal: [
      'workflow_dispatch:',
      'ARCADE_SIDE_XAI_GLOBAL_4_V1',
      'authorize exactly four paid two-reference SIDE calls',
      'group: production-worker-mutations',
      'cancel-in-progress: false',
      'npm --prefix worker ci',
      'npm run test:arcade:xai-global',
      'for slug in cristiano-ronaldo lionel-messi bad-bunny mrbeast',
      'npm run arcade:pose-master',
      '--master=xai-milei-side-v1',
      'npm run arcade:batch:xai-global-sides',
      '--state=.arcade-side-xai-global-pose-transfer-state.json',
      '--pose-master-upload-state=.arcade-xai-pose-master-upload-state.json',
      'arcade-side-xai-global-pose-transfer-v1-state',
      'secrets.PIXCLI_API_KEY',
      'secrets.CLOUDFLARE_API_TOKEN',
    ],
    xaiHighKick: [
      'workflow_dispatch:',
      'ARCADE_HIGH_KICK_XAI_TRUMP_IMPACT_V1',
      'authorize exactly one paid three-reference frame',
      'group: production-worker-mutations',
      'cancel-in-progress: false',
      'npm run test:arcade:xai-high-kick',
      'gh run download "32889507819"',
      'arcade-side-xai-trump-pose-transfer-v2-state',
      '--slug=donald-trump',
      'npm run arcade:motion-master',
      '--master=xai-high-kick-impact-v1',
      'npm run arcade:canary:xai-high-kick',
      '--state=.arcade-high-kick-xai-trump-impact-state.json',
      '--motion-master-upload-state=.arcade-xai-high-kick-impact-upload-state.json',
      '--canonical-upload-state=.arcade-xai-trump-canonical-upload-state.json',
      'arcade-high-kick-xai-trump-impact-v1-state',
      'secrets.PIXCLI_API_KEY',
      'secrets.CLOUDFLARE_API_TOKEN',
    ],
    xaiQaMotion: [
      'workflow_dispatch:',
      'ARCADE_QA_MILEI_HIGH_PUNCH_F4_XAI_V1',
      'authorize exactly one paid three-reference frame (estimated USD 0.07)',
      'group: production-worker-mutations',
      'cancel-in-progress: false',
      'npm run test:arcade:xai-qa-motion',
      '--slug=javier-milei',
      'npm run arcade:qa-motion-references',
      '--candidate=arcade-qa-milei-high-punch-f4-xai-v1',
      'npm run arcade:canary:xai-qa-motion',
      '--state=.arcade-qa-milei-high-punch-f4-xai-state.json',
      '--pose-upload-state=.arcade-qa-high-punch-f4-upload-state.json',
      '--canonical-upload-state=.arcade-qa-milei-canonical-upload-state.json',
      'arcade-qa-milei-high-punch-f4-xai-v1-state',
      'secrets.PIXCLI_API_KEY',
      'secrets.CLOUDFLARE_API_TOKEN',
    ],
    codeql: [
      'github/codeql-action/init@v4',
      'github/codeql-action/analyze@v4',
      'security-events: write',
    ],
    dependencySecurity: [
      'pull_request:',
      'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
      'fail-on-severity: high',
      'fail-on-scopes: runtime, development, unknown',
      'license-check: false',
      'show-openssf-scorecard: false',
    ],
    dependabot: [
      'package-ecosystem: npm',
      'directory: /worker',
      'directory: /processor',
      'package-ecosystem: github-actions',
    ],
    codeowners: [
      '* @SqaaSSL/sqaas',
    ],
    runbook: [
      '## GitHub Environments',
      '## Required Branch Rules',
      '`development`',
      '`production`',
      'does not depend on an operator retaining an active Clerk browser session',
    ],
    processorDeployCheck: [
      "const PRODUCTION_WORKER_URL = 'https://api.insertplayer.ai'",
      "const PREFLIGHT_PATH = '/api/internal/deploy/image-processor-contract'",
      'assertApprovedArcadeGenerationContract',
      'X-Insert-Player-Clerk-Backend-Auth',
    ],
    processorDeployRoute: [
      'hasValidClerkBackendAuthBridge',
      'readImageProcessorGenerationContract',
      "'Cache-Control': 'private, no-store'",
    ],
    workerIndex: [
      "path === '/api/internal/deploy/image-processor-contract' && method === 'GET'",
      'readDeploymentImageProcessorContract(request, env)',
    ],
  };
  const missingSnippets = [];
  for (const [fileKey, snippets] of Object.entries(required)) {
    for (const snippet of snippets) {
      if (!text[fileKey].includes(snippet)) missingSnippets.push(`${files[fileKey]}: ${snippet}`);
    }
  }
  if (missingSnippets.length > 0) {
    throw new Error(`GitHub delivery wiring is incomplete:\n- ${missingSnippets.join('\n- ')}`);
  }
  if (
    text.production.includes('ASF_ARCADE_PREFLIGHT_KEY:')
    || text.production.includes('ASF_ARCADE_ADMIN_CLERK_USER_ID:')
  ) {
    throw new Error('Production deploy processor readiness must not depend on an active human Clerk session.');
  }

  const backendBridgeEnv = 'CLERK_BACKEND_AUTH_BRIDGE_SECRET: ${{ secrets.CLERK_BACKEND_AUTH_BRIDGE_SECRET }}';
  const productionBridgeUses = text.production.split(backendBridgeEnv).length - 1;
  const developmentBridgeUses = text.development.split(backendBridgeEnv).length - 1;
  if (productionBridgeUses < 2 || developmentBridgeUses < 1) {
    throw new Error(
      'GitHub deploy workflows must pass CLERK_BACKEND_AUTH_BRIDGE_SECRET to validation and Worker upload steps.',
    );
  }

  const githubText = Object.values(text).join('\n');
  if (
    /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/.test(githubText)
    || /whsec_[A-Za-z0-9+/=_-]{20,}/.test(githubText)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(githubText)
    || githubText.includes('CLERK_SECRET_KEY')
  ) {
    throw new Error('GitHub delivery files must reference environment secrets by name and must not contain raw credentials.');
  }
}

function assertXaiArcadeSidePromptIsProviderScoped() {
  const prompts = readFileSync(join(root, 'scripts/arcade-provider-prompts.mjs'), 'utf8');
  const promptTests = readFileSync(join(root, 'scripts/arcade-provider-prompts.test.mjs'), 'utf8');
  const canary = readFileSync(join(root, 'scripts/arcade-side-xai-canary.mjs'), 'utf8');
  const canaryTests = readFileSync(join(root, 'scripts/arcade-side-xai-canary.test.mjs'), 'utf8');
  const globalBatch = readFileSync(join(root, 'scripts/arcade-side-xai-global-batch.mjs'), 'utf8');
  const globalBatchTests = readFileSync(join(root, 'scripts/arcade-side-xai-global-batch.test.mjs'), 'utf8');
  const highKickCanary = readFileSync(join(root, 'scripts/arcade-high-kick-xai-canary.mjs'), 'utf8');
  const highKickCanaryTests = readFileSync(join(root, 'scripts/arcade-high-kick-xai-canary.test.mjs'), 'utf8');
  const qaMotionCandidate = readFileSync(join(root, 'arcade/qa-motion-canary-2026.json'), 'utf8');
  const qaMotionCandidateCode = readFileSync(join(root, 'scripts/arcade-qa-motion-candidate.mjs'), 'utf8');
  const qaMotionCandidateTests = readFileSync(join(root, 'scripts/arcade-qa-motion-candidate.test.mjs'), 'utf8');
  const qaMotionCanary = readFileSync(join(root, 'scripts/arcade-motion-xai-canary.mjs'), 'utf8');
  const qaMotionCanaryTests = readFileSync(join(root, 'scripts/arcade-motion-xai-canary.test.mjs'), 'utf8');
  const qaMotionReferenceFetch = readFileSync(join(root, 'scripts/fetch-arcade-qa-motion-references.mjs'), 'utf8');
  const poseMasterFetch = readFileSync(join(root, 'scripts/fetch-arcade-pose-master.mjs'), 'utf8');
  const motionMasterFetch = readFileSync(join(root, 'scripts/fetch-arcade-motion-master.mjs'), 'utf8');
  const sealedRunner = readFileSync(join(root, 'scripts/arcade-side-bakeoff.mjs'), 'utf8');
  const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
  const combined = [
    prompts,
    promptTests,
    canary,
    canaryTests,
    globalBatch,
    globalBatchTests,
    highKickCanary,
    highKickCanaryTests,
    qaMotionCandidate,
    qaMotionCandidateCode,
    qaMotionCandidateTests,
    qaMotionCanary,
    qaMotionCanaryTests,
    qaMotionReferenceFetch,
    poseMasterFetch,
    motionMasterFetch,
    sealedRunner,
    packageJson,
  ].join('\n');
  const required = [
    "canonical: 'canonical-v1'",
    "xaiRealisticAdult: 'xai-realistic-adult-v1'",
    "xaiIdentityPoseTransfer: 'xai-identity-pose-transfer-v1'",
    "xaiCanonicalMotionTransfer: 'xai-canonical-motion-transfer-v1'",
    'The supplied image is a close facial identity reference.',
    'premium semi-realistic 3D fighting-game roster art',
    'never stylize anatomy, head size, apparent age, or identity',
    'approximately 7.5 heads',
    'about 13 percent of total body height',
    '70-85 mm equivalent camera',
    'no oversized head',
    'IMAGE 1 is the POSE, COMPOSITION, AND RENDERING MASTER only',
    'IMAGE 2 is the IDENTITY AND PHYSIQUE ANCHOR only',
    'Never blend the two faces',
    'IMAGE 1 is the MOTION POSE AND COMPOSITION MASTER only',
    'IMAGE 2 is the APPROVED CANONICAL CHARACTER AND RENDERING MASTER',
    'IMAGE 3 is the REAL IDENTITY SAFEGUARD only',
    'not a sprite sheet, contact sheet, sequence, or collage',
    'expect(prompt).not.toContain(\'neutral ready stance\')',
    'expect(prompt).not.toMatch(/clearly AI-generated|realistic 2\\.5D|documentary photography/i)',
    "XAI_SIDE_CANARY_EXPERIMENT_ID = 'arcade-side-xai-trump-pose-transfer-v2'",
    "XAI_SIDE_CANARY_SLUG = 'donald-trump'",
    "XAI_GLOBAL_SIDE_BATCH_EXPERIMENT_ID = 'arcade-side-xai-global-pose-transfer-v1'",
    "XAI_GLOBAL_SIDE_BATCH_CONFIRMATION = 'ARCADE_SIDE_XAI_GLOBAL_4_V1'",
    "XAI_HIGH_KICK_CANARY_EXPERIMENT_ID = 'arcade-high-kick-xai-trump-impact-v1'",
    "XAI_HIGH_KICK_CANARY_CONFIRMATION = 'ARCADE_HIGH_KICK_XAI_TRUMP_IMPACT_V1'",
    'arcade-qa-milei-high-punch-f4-xai-v1',
    'ARCADE_QA_MILEI_HIGH_PUNCH_F4_XAI_V1',
    'qa-atlas-high-punch-playback-04-v1',
    'gemini-javier-milei-side-clean-v1',
    'exact standing high-punch impact pose from IMAGE 1',
    'providerCatalogCostPerImage',
    'maxEstimatedCostUsd',
    'Pinned PixCLI model contract or price changed; new human approval is required.',
    'image: [poseAssetHash, canonicalAssetHash, sourceAssetHash]',
    'ip-motion-v1-${fighter.slug}-${candidate.motion.animation.replaceAll',
    "'cristiano-ronaldo'",
    "'lionel-messi'",
    "'bad-bunny'",
    "'mrbeast'",
    "id: 'grok-imagine-image-2-edit'",
    "endpoint: 'xai/grok-imagine-image/v2.0/edit'",
    "aspect_ratio: 'auto'",
    "resolution: '2k'",
    'expectedPaidCalls: 1',
    'expectedPaidCalls: XAI_GLOBAL_SIDE_BATCH_SLUGS.length',
    'enrich_prompt: false',
    "fallback: 'none'",
    'activation: false',
    'image: [poseMasterAssetHash, sourceAssetHash]',
    'referenceInputs: model.referenceInputs ?? []',
    "id: 'xai-milei-side-v1'",
    "contentSha256: '89bbecdfe8fc9cd08126f1c60b90e35ecc16427e3d0a227f0a4c1832f0960309'",
    "contentSha256: '43086a8d96acd9b153a1c38c3dd622bf0b7140d90d067a4459a0d3b7fd637bed'",
    "contentSha256: '9429960a62d833e1899d8572efde3f7df2cceb88ff1510b3c146e8489bf7f2c0'",
    'promptBuilder: buildXaiSideCanaryPrompt',
    'buildXaiSidePoseTransferPayload',
    'image: [motionMasterAssetHash, canonicalAssetHash, sourceAssetHash]',
    'plan.length !== expectedPaidCalls',
    'state.experimentId !== experimentId',
    'options.experimentId ?? BAKEOFF_EXPERIMENT_ID',
    '"arcade:pose-master": "node scripts/fetch-arcade-pose-master.mjs"',
    '"arcade:canary:xai-side": "node scripts/arcade-side-xai-canary.mjs"',
    '"arcade:batch:xai-global-sides": "node scripts/arcade-side-xai-global-batch.mjs"',
    '"arcade:motion-master": "node scripts/fetch-arcade-motion-master.mjs"',
    '"arcade:canary:xai-high-kick": "node scripts/arcade-high-kick-xai-canary.mjs"',
    '"arcade:qa-motion-references": "node scripts/fetch-arcade-qa-motion-references.mjs"',
    '"arcade:canary:xai-qa-motion": "node scripts/arcade-motion-xai-canary.mjs"',
    '"test:arcade:xai-qa-motion": "vitest run scripts/arcade-provider-prompts.test.mjs scripts/arcade-qa-motion-candidate.test.mjs scripts/arcade-motion-xai-canary.test.mjs scripts/arcade-side-xai-canary.test.mjs scripts/arcade-side-bakeoff.test.mjs"',
    '"test:arcade:xai-global": "vitest run scripts/arcade-provider-prompts.test.mjs scripts/arcade-side-xai-canary.test.mjs scripts/arcade-side-xai-global-batch.test.mjs scripts/arcade-side-bakeoff.test.mjs"',
    '"test:arcade:xai-high-kick": "vitest run scripts/arcade-provider-prompts.test.mjs scripts/arcade-high-kick-xai-canary.test.mjs scripts/arcade-side-xai-canary.test.mjs scripts/arcade-side-bakeoff.test.mjs"',
  ];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`XAI Arcade provider prompt isolation is incomplete: ${missing.join(', ')}`);
  }
}

function assertArcadeExperimentArchiveIsImmutable() {
  const archive = readFileSync(join(root, 'scripts/archive-arcade-experiment.mjs'), 'utf8');
  const archiveTests = readFileSync(join(root, 'scripts/archive-arcade-experiment.test.mjs'), 'utf8');
  const archiveUploader = readFileSync(join(root, 'scripts/archive-r2-upload-worker.mjs'), 'utf8');
  const archiveUploaderTests = readFileSync(
    join(root, 'scripts/archive-r2-upload-worker.test.mjs'),
    'utf8',
  );
  const archiveUploaderConfig = readFileSync(
    join(root, 'scripts/wrangler.archive-uploader.jsonc'),
    'utf8',
  );
  const catalog = readFileSync(join(root, 'arcade/experiment-archive-2026.json'), 'utf8');
  const migration = readFileSync(
    join(root, 'worker/migrations/0027_immutable_arcade_experiments.sql'),
    'utf8',
  );
  const migrationTests = readFileSync(
    join(root, 'worker/src/arcadeExperimentMigration.integration.test.ts'),
    'utf8',
  );
  const workflow = readFileSync(
    join(root, '.github/workflows/archive-arcade-experiment-production.yml'),
    'utf8',
  );
  const combined = [
    archive,
    archiveTests,
    archiveUploader,
    archiveUploaderTests,
    archiveUploaderConfig,
    catalog,
    migration,
    migrationTests,
    workflow,
  ].join('\n');
  const required = [
    "const ARCHIVE_PREFIX = 'arcade-experiments/v1'",
    "const R2_JURISDICTION = 'eu'",
    'Artifact bytes do not match the sealed state',
    'R2 round-trip hash mismatch',
    "const ARCHIVE_PREFIX = 'arcade-experiments/v1/'",
    "onlyIf: { etagDoesNotMatch: '*' }",
    'immutable_archive_conflict',
    'ARCADE_ARCHIVE_UPLOAD_URL',
    'Delete isolated R2 upload bridge',
    '--request DELETE',
    '/workers/scripts/$ARCADE_ARCHIVE_WORKER_NAME',
    'scripts/wrangler.archive-uploader.jsonc',
    'D1 archive index verification failed',
    'INSERT OR IGNORE INTO arcade_generation_experiments',
    'arcade_generation_experiments_immutable_update',
    'arcade_generation_experiments_immutable_delete',
    'arcade_generation_experiment_slots_immutable_update',
    'arcade_generation_experiment_artifacts_immutable_delete',
    'ARCHIVE_IMMUTABLE_ARCADE_EXPERIMENT_V1',
    'Verify all local bytes without mutating production',
    'Provider calls: `0`',
    'arcade-side-xai-trump-pose-transfer-v2',
    'arcade-side-xai-global-pose-transfer-v1',
    'arcade-high-kick-xai-trump-impact-v1',
  ];
  const missing = required.filter((snippet) => !combined.includes(snippet));
  if (missing.length > 0) {
    throw new Error(`Immutable Arcade experiment archive is incomplete: ${missing.join(', ')}`);
  }
  if (workflow.includes('PIXCLI_API_KEY') || workflow.includes('arcade:canary:')) {
    throw new Error('The immutable Arcade archive workflow must never have provider access.');
  }
  if (/r2\s+object\s+delete/i.test(archive) || /DELETE\s+FROM\s+arcade_generation/i.test(archive)) {
    throw new Error('The immutable Arcade archive path must be append-only.');
  }
}

assertNodeVersion();
run('deployment branch policy', node, ['scripts/check-deployment-policy.mjs']);
assertGeminiImageModelsAreGa();
assertVideoSpriteProductionToolchainGate();
run('frontend style guard', npm, ['run', 'check:frontend']);
run('tier parity guard', node, ['scripts/check-tier-parity.mjs']);
run('approved image-provider boundary', node, ['processor/scripts/assert-approved-image-providers.mjs']);
assertLiveSmokeHasNoUndefinedNames();
run('unit tests', npm, ['test']);
run(
  'deterministic video sprite compiler tests',
  npm,
  ['--prefix', 'processor', 'run', 'test:video-sprite'],
  root,
  {
    VIDEO_SPRITE_TEST_FFMPEG:
      process.env.VIDEO_SPRITE_PRODUCTION_TOOLCHAIN_VALIDATED === '1' ? '0' : '1',
  },
);
run('processor benchmark tests', npm, ['--prefix', 'processor', 'run', 'benchmark:providers:test']);
run('frontend typecheck', npx, ['tsc', '--noEmit']);
run('Worker binding type drift check', npm, ['--prefix', 'worker', 'run', 'types:check']);
run('worker typecheck', npx, ['tsc', '--noEmit'], join(root, 'worker'));
replayMigrations();
assertNoLegacyApiRoutes();
assertBillingUsesRequestOrigin();
assertProxyIsProductionScoped();
assertWorkerRequestBodiesAreBounded();
assertOperationalDataRetentionIsSafe();
assertApiOperationsAreSessionScoped();
assertUploadAbuseLimits();
assertAppConsoleLogsAreDebugGated();
assertFrontendDeployIsProductionScoped();
assertNoClientProviderSecrets();
assertLiveConfigHelperIsWired();
assertSandboxIsolationIsWired();
assertLegalConsentAndPrivacyIsWired();
assertClerkAuthIsWired();
assertClerkUserLifecycleIsWired();
assertCommunityAssetsAreSanitized();
assertCommunityModerationIsWired();
assertMatchReportingIsWired();
assertLeaderboardSurfaceIsWired();
assertLiveSmokeCoversCriticalPaths();
assertLaunchGateIsWired();
assertBrandingPlumbingIsWired();
assertRateLimitingIsWired();
assertAnonymousRookieTurnstileIsWired();
assertHeavyRoutesStayLazy();
assertCrossDeviceRosterImportIsWired();
assertRuntimeSpriteFallbacksAreSafe();
assertSourceViewsStayProScoped();
assertTierPricingAndPipelineParity();
assertSourceUploadsAreVersioned();
assertSpriteUploadsAreIdempotent();
assertLocalCachePreservesSpriteVersions();
assertWorkerErrorsDoNotLeakInProduction();
assertLaunchMetadataIsWired();
assertLaunchRasterAssetsAreFresh();
assertOfficialArcadeIsWired();
assertDurableGenerationIsWired();
assertXaiArcadeSidePromptIsProviderScoped();
assertArcadeExperimentArchiveIsImmutable();
assertStageScoutIsWired();
assertCanonicalProductionReleaseIsWired();
assertGithubActionsAreWired();
run('prelaunch bundle isolation', node, ['scripts/build-prelaunch.mjs', '--skip-checks']);

console.log('Production checks passed.');
