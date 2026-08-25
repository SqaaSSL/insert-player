import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildQaPoseAtlas,
  loadQaPoseAtlasManifest,
  summarizeQaPoseAtlas,
} from './qaPoseAtlas.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_MANIFEST_PATH = resolve(PROJECT_ROOT, 'arcade/qa-pose-atlas-2026.json');

function readArgument(args: string[], name: string, fallback = ''): string {
  return args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function parsePathBindings(args: string[], name: '--source' | '--archive'): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const argument of args.filter((entry) => entry.startsWith(`${name}=`))) {
    const value = argument.slice(name.length + 1);
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`${name} must use ${name}=<source-id>=<absolute-path>.`);
    }
    bindings[value.slice(0, separator)] = resolve(value.slice(separator + 1));
  }
  return bindings;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'plan';
  const manifestPath = resolve(readArgument(args, '--manifest', DEFAULT_MANIFEST_PATH));
  const loaded = await loadQaPoseAtlasManifest(manifestPath);
  if (command === 'plan') {
    console.log(`${loaded.manifest.atlasId} (${loaded.manifest.status})`);
    console.log(`manifest sha256 ${loaded.sha256}`);
    for (const line of summarizeQaPoseAtlas(loaded.manifest)) console.log(line);
    console.log('No network requests or paid inference were made.');
    return;
  }
  if (command !== 'build') throw new Error('Command must be plan or build.');
  const outputDir = resolve(readArgument(
    args,
    '--output-dir',
    resolve(PROJECT_ROOT, '.qa/pose-atlas', loaded.manifest.atlasId),
  ));
  const report = await buildQaPoseAtlas({
    manifestPath,
    sourceDirs: parsePathBindings(args, '--source'),
    archivePaths: parsePathBindings(args, '--archive'),
    outputDir,
  });
  console.log(`Built ${report.atlasId}: ${report.animations.length} animations.`);
  console.log(`Review ${resolve(outputDir, report.reviewSheet.path)}`);
  console.log(`Manifest ${resolve(outputDir, 'derived-manifest.json')}`);
  console.log('No network requests or paid inference were made.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
