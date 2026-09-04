import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCanonicalCleanupFixture } from './arcade-xai-canonical-bundle.mjs';

function parseArg(rawArgs, name) {
  return rawArgs.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

export function parseCanonicalCleanupFixtureCliArgs(rawArgs) {
  const outputPath = parseArg(rawArgs, '--output');
  if (!isAbsolute(outputPath)) throw new Error('--output must be an explicit absolute PNG path.');
  return { outputPath };
}

function main() {
  const result = verifyCanonicalCleanupFixture(parseCanonicalCleanupFixtureCliArgs(process.argv.slice(2)));
  console.log(`Pinned key/despill fixture verified: ${result.contentSha256}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
