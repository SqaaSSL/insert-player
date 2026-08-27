import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recleanXaiCanonicalBundle,
  XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION,
} from './arcade-xai-canonical-bundle.mjs';

function parseArg(rawArgs, name) {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

export function parseXaiCanonicalRecleanCliArgs(rawArgs) {
  if (!rawArgs.includes('--execute')) throw new Error('Offline re-clean requires --execute.');
  const bundleDirectory = parseArg(rawArgs, '--bundle-dir');
  const outputDirectory = parseArg(rawArgs, '--output-dir');
  if (!isAbsolute(bundleDirectory) || !isAbsolute(outputDirectory)) {
    throw new Error('--bundle-dir and --output-dir must be explicit absolute paths.');
  }
  return {
    confirmation: parseArg(rawArgs, '--confirm'),
    bundleDirectory,
    outputDirectory,
    reviewedDescriptorSha256: parseArg(rawArgs, '--reviewed-descriptor-sha256'),
  };
}

async function main() {
  const result = recleanXaiCanonicalBundle(parseXaiCanonicalRecleanCliArgs(process.argv.slice(2)));
  console.log(`Canonical bundle ${result.descriptor.bundleId} was re-cleaned offline without provider access.`);
  console.log(`Review descriptor: ${join(result.outputDirectory, 'review-descriptor.json')}`);
  console.log(`Review descriptor SHA-256: ${result.descriptor.descriptorSha256}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { XAI_CANONICAL_BUNDLE_RECLEAN_CONFIRMATION };
