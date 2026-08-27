import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const IMAGE = 'insert-player-xai-canonical-media-runtime:v1';
const PATH_ARGUMENTS = Object.freeze([
  '--manifest',
  '--source-dir',
  '--pose-manifest',
  '--state',
  '--output-dir',
]);

function argumentValue(args, name) {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

function requiredAbsolutePath(args, name, kind) {
  const value = argumentValue(args, name);
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an explicit absolute ${kind} path.`);
  return resolve(value);
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function requireExisting(path, label) {
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${path}.`);
}

export function buildXaiCanonicalContainerPlan(rawArgs, options = {}) {
  if (!rawArgs.includes('--execute')) throw new Error('Container execution requires --execute.');
  const repositoryRoot = resolve(options.repositoryRoot ?? root);
  const manifestPath = requiredAbsolutePath(rawArgs, '--manifest', 'roster manifest');
  const sourceDirectory = requiredAbsolutePath(rawArgs, '--source-dir', 'licensed-source directory');
  const poseManifestPath = requiredAbsolutePath(rawArgs, '--pose-manifest', 'pose-manifest');
  const statePath = requiredAbsolutePath(rawArgs, '--state', 'state');
  const outputDirectory = requiredAbsolutePath(rawArgs, '--output-dir', 'output-directory');
  requireExisting(manifestPath, 'Roster manifest');
  requireExisting(sourceDirectory, 'Licensed-source directory');
  requireExisting(poseManifestPath, 'Pose manifest');
  if (!isInside(repositoryRoot, manifestPath)) {
    throw new Error('--manifest must be the reviewed repository roster manifest.');
  }
  const stateDirectory = dirname(statePath);
  const poseDirectory = dirname(poseManifestPath);
  if (stateDirectory !== dirname(outputDirectory)) {
    throw new Error('--state and --output-dir must share one explicit private work directory.');
  }
  for (const [writable, label] of [[stateDirectory, 'state'], [outputDirectory, 'output']]) {
    if (
      isInside(repositoryRoot, writable)
      || isInside(sourceDirectory, writable)
      || isInside(poseDirectory, writable)
    ) throw new Error(`${label} target overlaps a read-only reviewed input.`);
  }
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const passthrough = rawArgs.filter((arg) => !PATH_ARGUMENTS.some((name) => arg.startsWith(`${name}=`)));
  const manifestRelative = relative(repositoryRoot, manifestPath).split(sep).join('/');
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 1000);
  const gid = options.gid ?? (typeof process.getgid === 'function' ? process.getgid() : 1000);
  return {
    image: IMAGE,
    build: [
      'build',
      '--file', resolve(repositoryRoot, 'Dockerfile.processor'),
      '--target', 'media-runtime',
      '--tag', IMAGE,
      repositoryRoot,
    ],
    run: [
      'run', '--rm',
      '--user', `${uid}:${gid}`,
      '--env', 'PIXCLI_API_KEY',
      '--env', 'PIXCLI_BASE_URL',
      '--volume', `${repositoryRoot}:/workspace:ro`,
      '--volume', `${sourceDirectory}:/private-sources:ro`,
      '--volume', `${poseDirectory}:/private-pose:ro`,
      '--volume', `${stateDirectory}:/private-work`,
      '--workdir', '/workspace',
      IMAGE,
      'node', 'scripts/arcade-xai-canonical-bundle.mjs',
      ...passthrough,
      `--manifest=/workspace/${manifestRelative}`,
      '--source-dir=/private-sources',
      `--pose-manifest=/private-pose/${basename(poseManifestPath)}`,
      `--state=/private-work/${basename(statePath)}`,
      `--output-dir=/private-work/${basename(outputDirectory)}`,
    ],
  };
}

function runDocker(dockerBinary, args, env) {
  const result = spawnSync(dockerBinary, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker canonical bundle command failed with exit ${String(result.status)}.`);
}

export function runXaiCanonicalBundleContainer(rawArgs, options = {}) {
  if (!options.env?.PIXCLI_API_KEY && !process.env.PIXCLI_API_KEY) throw new Error('PIXCLI_API_KEY is required.');
  const plan = buildXaiCanonicalContainerPlan(rawArgs, options);
  const dockerBinary = options.dockerBinary ?? 'docker';
  const env = options.env ?? process.env;
  const execute = options.runDocker ?? runDocker;
  execute(dockerBinary, plan.build, env);
  execute(dockerBinary, plan.run, env);
  return plan;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runXaiCanonicalBundleContainer(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
