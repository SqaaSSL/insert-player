import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MAGIC = Buffer.from('IPHTB1\0', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const MAX_BYTES = 8 * 1024 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function deriveKey(passphrase, salt) {
  invariant(typeof passphrase === 'string' && passphrase.length >= 40, 'HUMANOID_ARTIFACT_KEY is missing or too short.');
  return scryptSync(passphrase, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function temporaryPath(outputPath) {
  return `${outputPath}.writing-${process.pid}-${randomBytes(8).toString('hex')}`;
}

export async function encryptHumanoidBundle({ inputPath, outputPath, passphrase }) {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  invariant(existsSync(input) && statSync(input).isFile(), 'Encryption input is not one file.');
  invariant(statSync(input).size > 0 && statSync(input).size <= MAX_BYTES, 'Encryption input size is outside bounds.');
  invariant(!existsSync(output), 'Encrypted output already exists.');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  cipher.setAAD(header);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(output);
  try {
    writeFileSync(temporary, header, { mode: 0o600 });
    await pipeline(createReadStream(input), cipher, createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
    appendFileSync(temporary, cipher.getAuthTag());
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export async function decryptHumanoidBundle({ inputPath, outputPath, passphrase }) {
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  invariant(existsSync(input) && statSync(input).isFile(), 'Encrypted input is not one file.');
  const size = statSync(input).size;
  invariant(size > HEADER_BYTES + TAG_BYTES && size <= MAX_BYTES, 'Encrypted input size is outside bounds.');
  invariant(!existsSync(output), 'Decrypted output already exists.');
  const descriptor = openSync(input, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    invariant(readSync(descriptor, header, 0, header.length, 0) === header.length, 'Encrypted header is truncated.');
    invariant(readSync(descriptor, tag, 0, tag.length, size - TAG_BYTES) === tag.length, 'Encrypted tag is truncated.');
  } finally {
    closeSync(descriptor);
  }
  invariant(header.subarray(0, MAGIC.length).equals(MAGIC), 'Encrypted bundle magic is invalid.');
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(output);
  try {
    await pipeline(
      createReadStream(input, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(temporary, { mode: 0o600 }),
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function parseArg(args, name) {
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? '';
}

async function main() {
  const args = process.argv.slice(2);
  const encrypt = args.includes('--encrypt');
  const decrypt = args.includes('--decrypt');
  invariant(encrypt !== decrypt, 'Choose exactly one of --encrypt or --decrypt.');
  const inputPath = parseArg(args, '--input');
  const outputPath = parseArg(args, '--output');
  invariant(inputPath && outputPath, '--input and --output are required.');
  const options = { inputPath, outputPath, passphrase: process.env.HUMANOID_ARTIFACT_KEY ?? '' };
  if (encrypt) await encryptHumanoidBundle(options);
  else await decryptHumanoidBundle(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
