import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const severities = ['low', 'medium', 'high', 'critical'];
const states = new Set(['open', 'fixed', 'dismissed', 'auto_dismissed']);
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertRelativePath(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)
    || path.includes('\\') || path.split('/').some((part) => !/^[a-z0-9@_.-]+$/i.test(part) || part === '.' || part === '..')) {
    throw new Error('Unsupported or unsafe dependency manifest/package path.');
  }
}

function readLockfile(root, manifest) {
  assertRelativePath(manifest);
  if (basename(manifest) !== 'package-lock.json') throw new Error(`Unsupported dependency manifest: ${manifest}`);
  const canonicalRoot = realpathSync(root);
  const path = realpathSync(resolve(canonicalRoot, manifest));
  const location = relative(canonicalRoot, path);
  if (!location || location === '..' || location.startsWith('../') || isAbsolute(location) || !statSync(path).isFile()) {
    throw new Error(`Dependency manifest escapes the checkout or is not a file: ${manifest}`);
  }
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(lock) || ![2, 3].includes(lock.lockfileVersion) || !isRecord(lock.packages)
    || !isRecord(lock.packages[''])) {
    throw new Error(`Unsupported package-lock format: ${manifest}; expected npm lockfile v2 or v3 packages.`);
  }
  return lock;
}

function vulnerableRange(value) {
  if (typeof value !== 'string' || !value.trim() || value.split(',').some((part) => !part.trim())) {
    throw new Error('Missing or malformed vulnerable version range.');
  }
  // GitHub separates comparator intersections with commas; node-semver uses spaces.
  const normalized = value.replace(/,/g, ' ').trim();
  const range = semver.validRange(normalized, { loose: false });
  if (range === null) throw new Error(`Unsupported vulnerable version range: ${value}`);
  return range;
}

function installedOccurrences(lock, dependency) {
  const occurrences = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!isRecord(entry)) throw new Error(`Malformed package-lock entry: ${location}`);
    if (!location) continue;
    assertRelativePath(location);
    if (entry.link) throw new Error(`Unsupported linked package-lock entry: ${location}`);
    if (entry.name !== undefined && (typeof entry.name !== 'string' || !packageName.test(entry.name))) {
      throw new Error(`Malformed package name in package-lock: ${location}`);
    }
    const installedName = location.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1];
    if (!installedName) throw new Error(`Unsupported package-lock installation path: ${location}`);
    // npm aliases retain their real package name in the entry. Check both names
    // and every nested installation, including platform/optional dependencies.
    if (installedName !== dependency && entry.name !== dependency) continue;
    if (typeof entry.version !== 'string' || !/^\d/.test(entry.version)
      || entry.version.trim() !== entry.version || !semver.valid(entry.version, { loose: false })) {
      throw new Error(`Missing or invalid locked version for ${dependency} at ${location}`);
    }
    occurrences.push({ location, version: entry.version });
  }
  return occurrences;
}

/** Open alerts describe the default branch. Check whether this exact checkout
 * still contains any affected version, so a fix can pass before GitHub closes
 * the old alert. Unsupported evidence never becomes an implicit exemption. */
export function evaluateDependencyAlerts(alerts, { root = defaultRoot } = {}) {
  if (!Array.isArray(alerts)) throw new Error('Malformed Dependabot alerts response.');
  const blocking = [];
  const fixedInCheckout = [];
  const locks = new Map();
  for (const alert of alerts) {
    if (!isRecord(alert) || !states.has(alert.state)) throw new Error('Malformed Dependabot alert state.');
    if (alert.state !== 'open') continue;
    const reportedSeverities = [alert.security_advisory?.severity, alert.security_vulnerability?.severity]
      .filter((severity) => severity !== undefined);
    if (reportedSeverities.length === 0 || reportedSeverities.some((severity) => !severities.includes(severity))) {
      throw new Error('Missing or unsupported Dependabot severity.');
    }
    const severity = reportedSeverities.reduce((highest, value) => (
      severities.indexOf(value) > severities.indexOf(highest) ? value : highest
    ));
    if (severity !== 'high' && severity !== 'critical') continue;
    const dependency = alert.dependency?.package;
    const vulnerability = alert.security_vulnerability;
    if (!Number.isSafeInteger(alert.number) || alert.number < 1
      || dependency?.ecosystem !== 'npm' || vulnerability?.package?.ecosystem !== 'npm'
      || typeof dependency.name !== 'string' || !packageName.test(dependency.name)
      || vulnerability.package.name !== dependency.name) {
      throw new Error('Unsupported or inconsistent high/critical Dependabot dependency identity.');
    }
    const range = vulnerableRange(vulnerability.vulnerable_version_range);
    const manifest = alert.dependency.manifest_path;
    if (!locks.has(manifest)) locks.set(manifest, readLockfile(root, manifest));
    const occurrences = installedOccurrences(locks.get(manifest), dependency.name);
    // Include prereleases conservatively: an unspecified prerelease must not
    // evade a high/critical advisory merely because semver excludes it by default.
    const vulnerable = occurrences.filter(({ version }) => semver.satisfies(version, range, { includePrerelease: true }));
    const label = `#${alert.number} [${severity}] ${manifest}: ${dependency.name}`;
    if (vulnerable.length) {
      blocking.push(`${label} ${vulnerable.map(({ version, location }) => `${version} (${location})`).join(', ')} matches ${range}`);
    } else {
      fixedInCheckout.push(`${label}: ${occurrences.length ? 'all locked versions are outside the vulnerable range' : 'package is absent from this lockfile'}`);
    }
  }
  return { blocking, fixedInCheckout };
}

export function readDependabotAlerts(repository, { execute = execFileSync } = {}) {
  if (typeof repository !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must identify the repository being validated.');
  }
  let output;
  try {
    output = execute('gh', [
      'api', '--method', 'GET', `repos/${repository}/dependabot/alerts`,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28',
      '-f', 'state=open', '-f', 'per_page=100', '--paginate', '--slurp',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch {
    throw new Error('Could not read all Dependabot alerts from GitHub; dependency gate fails closed.');
  }
  const pages = JSON.parse(output);
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
    throw new Error('Malformed paginated Dependabot alerts response.');
  }
  return pages.flat();
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    const result = evaluateDependencyAlerts(readDependabotAlerts(process.env.GITHUB_REPOSITORY));
    for (const resolved of result.fixedInCheckout) console.log(`Fixed in checkout: ${resolved}`);
    if (result.blocking.length) throw new Error(`High or critical dependency alerts affect this checkout:\n${result.blocking.join('\n')}`);
    console.log('No open high or critical Dependabot alerts affect the current lockfiles.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
