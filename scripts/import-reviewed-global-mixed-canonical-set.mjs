import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authenticatedAssetClient,
  authenticatedRequestClient,
  createAdminTokenProvider,
} from './import-reviewed-xai-canonical-bundle.mjs';
import {
  INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN,
  normalizeProductionWorkerUrl,
  runReviewedGlobalMixedCanonicalImport,
} from './import-reviewed-elon-mixed-canonical-set.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_ROSTER_PATH = join(root, 'arcade/roster-2026.json');

function parseArg(args, name, fallback = '') {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--execute-production')) {
    throw new Error('Global mixed import requires --execute-production.');
  }
  const clerkSecret = process.env.ASF_ARCADE_CLERK_SECRET_KEY?.trim() ?? '';
  const clerkUserId = process.env.ASF_ARCADE_ADMIN_CLERK_USER_ID?.trim() ?? '';
  const bridgeSecret = process.env.CLERK_BACKEND_AUTH_BRIDGE_SECRET?.trim() ?? '';
  if (!clerkSecret || !clerkUserId || bridgeSecret.length < 32) {
    throw new Error('Production Clerk admin secrets are incomplete.');
  }
  const workerUrl = normalizeProductionWorkerUrl(
    process.env.ASF_WORKER_URL?.trim() || INSERT_PLAYER_PRODUCTION_WORKER_ORIGIN,
  );
  const getToken = await createAdminTokenProvider(clerkSecret, clerkUserId);
  const outputDirectory = resolve(parseArg(args, '--output-dir'));
  const result = await runReviewedGlobalMixedCanonicalImport({
    confirmation: parseArg(args, '--confirm'),
    safetyConfirmation: parseArg(args, '--confirm-safety'),
    reviewedBy: parseArg(args, '--reviewed-by'),
    assemblyPlanPath: parseArg(args, '--assembly-plan'),
    assemblyPlanSha256: parseArg(args, '--assembly-plan-sha256'),
    sideBundleDirectory: parseArg(args, '--side-bundle-dir'),
    crouchBundleDirectory: parseArg(args, '--crouch-bundle-dir'),
    outputDirectory,
    statePath: parseArg(args, '--state', join(outputDirectory, 'import-state.json')),
    rosterPath: parseArg(args, '--roster', DEFAULT_ROSTER_PATH),
    workerUrl,
    requestApi: authenticatedRequestClient(workerUrl, getToken, bridgeSecret),
    requestAsset: authenticatedAssetClient(workerUrl, getToken, bridgeSecret),
  });
  console.log(
    `Global reviewed canonical set imported for ${result.reviewedManifest.slug}; no generation or activation started.`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
