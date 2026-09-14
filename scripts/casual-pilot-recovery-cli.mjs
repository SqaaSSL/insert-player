// Task-only offline reconciliation command; never dispatches a provider request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CasualTransport, PILOT_UNKNOWN_RECOVERY_ID, acquireLock, sha256 } from './casual-generation-transport.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), directory = join(root, '.artifacts/casual-generation-v1');
const args = process.argv.slice(2); assert.ok(args.every(arg => ['--authorize', `--confirm=${PILOT_UNKNOWN_RECOVERY_ID}`].includes(arg)));
const ledgerPath = join(directory, 'provider-ledger.json'), state = JSON.parse(readFileSync(ledgerPath));
const path = join(directory, 'recovery/pilot-meterkey-wallet-audit-v1.json'), bytes = readFileSync(path);
const walletEvidence = { path, sha256: sha256(bytes), sizeBytes: bytes.length };
const options = { directory, fingerprint: state.fingerprint, phase: 'full', caps: state.phases.full.caps,
  credentials: {}, fetchImpl: async () => { throw new Error('Reconciliation must never perform network calls'); } };
if (!args.includes('--authorize')) {
  // Read-only facade avoids the transport constructor's normal persistence.
  const reader = Object.assign(Object.create(CasualTransport.prototype), { directory, path: ledgerPath, state, phase: 'full', inflight: new Map() });
  console.log(JSON.stringify({ dryRun: true, ...(reader.pilotUnknownReconciliation() ?? reader.previewPilotUnknownRecovery({ walletEvidence })),
    paidCalls: 0, ledgerChanges: 0 }, null, 2));
} else {
  assert.ok(args.includes(`--confirm=${PILOT_UNKNOWN_RECOVERY_ID}`));
  const release = acquireLock(directory);
  try { console.log(JSON.stringify(new CasualTransport(options).reconcilePilotUnknown({ confirmation: PILOT_UNKNOWN_RECOVERY_ID, walletEvidence }), null, 2)); }
  finally { release(); }
}
