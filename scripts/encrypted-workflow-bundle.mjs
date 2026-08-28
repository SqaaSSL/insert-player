import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('IPRB001\n', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 320 * 1024 * 1024;
const MAX_FILES = 64;
const KEY_ENV = 'ARCADE_RECURATION_ARTIFACT_KEY';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseArgs(argv) {
  const values = new Map();
  for (const arg of argv) {
    const separator = arg.indexOf('=');
    if (!arg.startsWith('--') || separator < 3) throw new Error(`Invalid argument: ${arg}`);
    const name = arg.slice(2, separator);
    const value = arg.slice(separator + 1);
    if (!value || values.has(name)) throw new Error(`Missing or duplicate --${name}.`);
    values.set(name, value);
  }
  const operation = values.get('operation');
  const allowed = operation === 'seal'
    ? new Set(['operation', 'source-dir', 'bundle'])
    : operation === 'open'
      ? new Set(['operation', 'bundle', 'destination-dir'])
      : null;
  if (!allowed || [...values.keys()].some((name) => !allowed.has(name))) {
    throw new Error('Operation must be exactly seal or open with its bounded arguments.');
  }
  return values;
}

function encryptionKey() {
  const encoded = process.env[KEY_ENV] ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(encoded)) {
    throw new Error(`${KEY_ENV} must be an exact 32-byte hexadecimal production secret.`);
  }
  return Buffer.from(encoded, 'hex');
}

function assertDirectFile(path, maximumBytes = MAX_ARCHIVE_BYTES) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
    throw new Error(`${path} is not a bounded direct file.`);
  }
  return stat;
}

function assertSafeName(name) {
  if (!name || name === '.' || name === '..' || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Bundle contains an unsafe filesystem name.');
  }
}

function inspectSource(directory) {
  const root = realpathSync(resolve(directory));
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Bundle source must be a direct directory.');
  }
  let files = 0;
  let bytes = 0;
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      assertSafeName(entry.name);
      const child = join(path, entry.name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error('Bundle source cannot contain symlinks.');
      if (stat.isDirectory()) {
        visit(child);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (stat.size < 1 || stat.size > MAX_FILE_BYTES || files > MAX_FILES || bytes > MAX_ARCHIVE_BYTES) {
          throw new Error('Bundle source exceeded its bounded file contract.');
        }
      } else {
        throw new Error('Bundle source contains a non-regular entry.');
      }
    }
  };
  visit(root);
  if (files < 1) throw new Error('Bundle source is empty.');
  return root;
}

function emptyDestination(path) {
  const destination = resolve(path);
  if (existsSync(destination)) {
    const stat = lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(destination).length > 0) {
      throw new Error('Bundle destination must be an empty direct directory.');
    }
  } else {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  return realpathSync(destination);
}

function runTar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr.trim() || 'unknown error'}`);
  return result.stdout;
}

function validateArchive(archivePath) {
  const listed = runTar(['-tzf', archivePath]);
  const entries = listed.split(/\r?\n/).filter(Boolean);
  if (entries.length < 1 || entries.length > MAX_FILES * 2 + 16) {
    throw new Error('Encrypted bundle has an invalid archive entry count.');
  }
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.includes('\\')) throw new Error('Archive path escaped its root.');
    const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized) continue;
    for (const part of normalized.split('/')) assertSafeName(part);
  }
}

function writeExclusive(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}

function seal(sourceDirectory, bundlePath, key) {
  const source = inspectSource(sourceDirectory);
  const bundle = resolve(bundlePath);
  if (existsSync(bundle) || existsSync(`${bundle}.sha256`)) throw new Error('Encrypted bundle already exists.');
  const temporary = mkdtempSync(join(tmpdir(), 'insert-player-recuration-seal-'));
  try {
    const archive = join(temporary, 'payload.tar.gz');
    runTar(['-czf', archive, '-C', source, '.']);
    assertDirectFile(archive);
    const plaintext = readFileSync(archive);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(MAGIC);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const output = Buffer.concat([MAGIC, iv, ciphertext, cipher.getAuthTag()]);
    writeExclusive(bundle, output);
    const digest = sha256(output);
    writeExclusive(`${bundle}.sha256`, Buffer.from(`${digest}  ${basename(bundle)}\n`));
    return { operation: 'seal', bundleSha256: digest, byteLength: output.byteLength };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function open(bundlePath, destinationDirectory, key) {
  const bundle = resolve(bundlePath);
  assertDirectFile(bundle);
  assertDirectFile(`${bundle}.sha256`, 1024);
  const sealed = readFileSync(bundle);
  const digest = sha256(sealed);
  const sidecar = readFileSync(`${bundle}.sha256`, 'utf8');
  if (sidecar !== `${digest}  ${basename(bundle)}\n`) throw new Error('Encrypted bundle SHA sidecar is not exact.');
  if (
    sealed.byteLength <= MAGIC.byteLength + IV_BYTES + TAG_BYTES ||
    !sealed.subarray(0, MAGIC.byteLength).equals(MAGIC)
  ) throw new Error('Encrypted bundle header is invalid.');
  const ivStart = MAGIC.byteLength;
  const cipherStart = ivStart + IV_BYTES;
  const tagStart = sealed.byteLength - TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(ivStart, cipherStart));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(sealed.subarray(tagStart));
  let plaintext;
  try {
    plaintext = Buffer.concat([
      decipher.update(sealed.subarray(cipherStart, tagStart)),
      decipher.final(),
    ]);
  } catch {
    throw new Error('Encrypted bundle authentication failed.');
  }
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Decrypted bundle exceeded its bounded archive contract.');
  }
  const destination = emptyDestination(destinationDirectory);
  const temporary = mkdtempSync(join(tmpdir(), 'insert-player-recuration-open-'));
  try {
    const archive = join(temporary, 'payload.tar.gz');
    writeFileSync(archive, plaintext, { mode: 0o600 });
    validateArchive(archive);
    runTar(['-xzf', archive, '-C', destination]);
    inspectSource(destination);
    for (const entry of readdirSync(destination, { recursive: true })) {
      const resolved = realpathSync(join(destination, entry));
      const escaped = relative(destination, resolved);
      if (escaped.startsWith(`..${sep}`) || escaped === '..') throw new Error('Extracted bundle escaped its root.');
    }
    return { operation: 'open', bundleSha256: digest };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function runEncryptedWorkflowBundle(argv = process.argv.slice(2)) {
  const values = parseArgs(argv);
  const operation = values.get('operation');
  const key = encryptionKey();
  return operation === 'seal'
    ? seal(values.get('source-dir'), values.get('bundle'), key)
    : open(values.get('bundle'), values.get('destination-dir'), key);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runEncryptedWorkflowBundle()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
