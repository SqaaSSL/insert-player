// Local artifact transport for the unmodified product image pipeline. Never writes to Insert Player services.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';

export const LOCAL_ORIGIN = 'http://127.0.0.1:1';
export const METERKEY_ORIGIN = 'https://meter.hilo.cx';
export const FAL_RECONCILIATION_ID = 'casual-fal-meterkey-routing-v1';
export const FAL_SCOPE_RECONCILIATION_ID = 'casual-fal-meterkey-birefnet-scope-v1';
export const PILOT_UNKNOWN_RECOVERY_ID = 'casual-pilot-unknown-recovery-v1';
export const CASUAL_PILOT_UNKNOWN_ID = '4ece0c30ea84fb974500282ddcead5996d92d24f7d3766a001253cb1a48e3dbc';
const PILOT_UNKNOWN_CONTRACT = Object.freeze({ id: CASUAL_PILOT_UNKNOWN_ID, requestSha256: '5d4922ce5dec504ae7076febf0cfd88a786eb242cbc8386680010ab1bd29c3df',
  walletUserId: 'mk_usr_P47kwJ4xFO6ahsEkHmT8', stage: 'casual-low-kick-unique4-pose-primary-v1:render', counters: { gemini: 49, fal: 36 } });
export const CASUAL_METERKEY_MODEL403_ID = 'ae8d1899c3cebaf1750f4abb250e47012bd6571a28295e351ab07b9f9f2b3a3c';
const DEDICATED_METERKEY_FINGERPRINT = '08d594f84f67aa9c6f2e5b571fcf61f275e32d03d9fb77418777af71482c5502';
export const CASUAL_DIRECT_FAL403_IDS = Object.freeze([
  'f4ba56214a79484d00c5f256c4ce86d4bad7e9d0886fe64fdf91f95f00c00826',
  'b3d350464672ebbef3844b3a331f5dfc9b6421e6ca58e72a709ee682d7a4f890',
  '06f832e824f4a655a64aa973d37542fbad2ead20eb30d8c44bb000cd4c736cae',
]);
const DIRECT_FAL403_DETAIL = 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.';
const LEGACY_FALLBACK_ERROR = 'Unexpected provider fallback or operation requires review';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function installCasualWindow(diagnostics) {
  const previous = globalThis.window;
  globalThis.window = { __ASF_DEBUG_LOGS__: false,
    location: { href: `${LOCAL_ORIGIN}/`, origin: LOCAL_ORIGIN },
    localStorage: { getItem: () => null },
    dispatchEvent(event) { if (event.type === 'asf-debug-log') diagnostics.push(event.detail); return true; },
  };
  return () => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'window'); else globalThis.window = previous;
  };
}
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const stopped = message => jsonResponse({ code: 'provider_request_outcome_unknown', error: { message } }, 409,
  { 'X-Insert-Player-Upstream-Outcome': 'unknown' });
export function immutable(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) assert.equal(sha256(readFileSync(path)), sha256(bytes), 'Immutable artifact changed');
  else writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: sha256(bytes), sizeBytes: bytes.length };
}
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
export function acquireLock(directory) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'execution.lock');
  writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return () => unlinkSync(path);
}
function safeHeaders(headers) {
  return Object.fromEntries([...headers].filter(([name]) => /^(content-type|x-request-id|x-meterkey-|x-fal-)/i.test(name)
    && !/(secret|credential|token|authorization|cookie|api-key)/i.test(name)));
}
// Persist diagnostic categories only. Error messages/stacks can contain request URLs,
// authorization headers or image payloads and must never enter the operational ledger.
const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'AssertionError', 'AbortError', 'TimeoutError',
  'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError', 'SocketError', 'AggregateError', 'SystemError']);
const SAFE_ERROR_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED', 'ERR_ASSERTION', 'ABORT_ERR',
  'ERR_STREAM_PREMATURE_CLOSE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
const SAFE_SYSCALLS = new Set(['connect', 'getaddrinfo', 'read', 'write', 'send', 'recv', 'socket']);
function safeErrorProperty(error, key) {
  try { return error && (typeof error === 'object' || typeof error === 'function') ? error[key] : undefined; }
  catch { return undefined; }
}
function safeTransportError(error, depth = 0) {
  const result = {};
  const name = safeErrorProperty(error, 'name'), code = safeErrorProperty(error, 'code');
  const syscall = safeErrorProperty(error, 'syscall'), address = safeErrorProperty(error, 'address');
  const hostname = safeErrorProperty(error, 'hostname'), port = safeErrorProperty(error, 'port');
  if (SAFE_ERROR_NAMES.has(name)) result.name = name;
  if (SAFE_ERROR_CODES.has(code)) result.code = code;
  if (SAFE_SYSCALLS.has(syscall)) result.syscall = syscall;
  if (typeof address === 'string' && isIP(address)) result.address = address;
  if (hostname === new URL(METERKEY_ORIGIN).hostname) result.host = hostname;
  if (Number.isInteger(port) && port > 0 && port <= 65535) result.port = port;
  const cause = safeErrorProperty(error, 'cause');
  if (depth === 0 && cause && cause !== error) {
    const safeCause = safeTransportError(cause, 1);
    if (Object.keys(safeCause).length) result.cause = safeCause;
  }
  return result;
}
function resultImageUrls(value) {
  if (!value || typeof value !== 'object') return [];
  const candidates = [value.image, ...(Array.isArray(value.images) ? value.images : [])];
  return candidates.map(item => item?.url).filter(url => typeof url === 'string');
}
function validateOutputUrl(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.hash);
  assert.ok(url.hostname === 'fal.media' || url.hostname.endsWith('.fal.media'), 'Untrusted FAL image URL');
  return url.href;
}

export class CasualTransport {
  constructor({ directory, fingerprint, phase, caps, credentials, fetchImpl = fetch, sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    assert.ok(['canary', 'full'].includes(phase));
    assert.ok(Number.isInteger(caps.gemini) && caps.gemini > 0 && caps.gemini <= 500);
    assert.ok(Number.isInteger(caps.fal) && caps.fal >= 0 && caps.fal <= 200);
    this.directory = directory; this.path = join(directory, 'provider-ledger.json');
    this.credentials = credentials; this.nativeFetch = fetchImpl; this.phase = phase; this.pause = sleepImpl;
    this.inflight = new Map(); this.tempImages = new Map(); this.allowedImages = new Set();
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8'))
      : { schemaVersion: 1, fingerprint, phases: {}, requests: {}, outputDownloads: {} };
    assert.equal(this.state.fingerprint, fingerprint, 'Source or product contract changed; start a new artifact run');
    const existing = this.state.phases[phase];
    if (existing) assert.deepEqual(existing.caps, caps, 'Phase caps are immutable; do not silently enlarge a generation');
    else this.state.phases[phase] = { caps, submitted: { gemini: 0, fal: 0 } };
    this.save();
    this.stage = 'initializing';
  }
  save() { atomicJson(this.path, this.state); }
  setStage(stage) { this.stage = stage; }
  readVerified(artifact) {
    const bytes = readFileSync(artifact.path);
    assert.equal(sha256(bytes), artifact.sha256, 'Archived provider evidence was altered');
    assert.equal(bytes.length, artifact.sizeBytes, 'Archived provider evidence size changed');
    return bytes;
  }
  falReconciliation() {
    const audit = this.state.reconciliations?.[FAL_RECONCILIATION_ID];
    if (!audit) return null;
    const proof = JSON.parse(this.readVerified(audit));
    assert.equal(proof.id, FAL_RECONCILIATION_ID);
    assert.equal(proof.parents.length, 3);
    assert.equal(new Set(proof.parents.map(parent => parent.id)).size, 3);
    assert.equal(proof.childTransport, 'meterkey'); assert.equal(proof.maximumChildrenPerParent, 1);
    assert.equal(proof.exactBodyReplay, true);
    this.readVerified(proof.ledgerBefore);
    for (const parent of proof.parents) {
      const record = this.state.requests[parent.id];
      assert.equal(sha256(JSON.stringify(record)), parent.recordSha256, 'Reconciled parent record must remain immutable');
      assert.equal(record.status, 'rejected'); assert.equal(record.httpStatus, 403);
      assert.equal(record.provider, 'fal'); assert.equal(record.model, '/fal-ai/birefnet');
      assert.equal(parent.childId, sha256(`${FAL_RECONCILIATION_ID}\n${parent.id}`));
      assert.equal(record.request.sha256, parent.requestSha256);
      assert.equal(record.response.sha256, parent.responseSha256);
      this.readVerified(record.request); this.readVerified(record.response);
    }
    return proof;
  }
  // Explicit local-only authorization: never overwrites old attempts, requests, responses, or counters.
  reconcileDirectFal403({ confirmation, expectedParentIds = CASUAL_DIRECT_FAL403_IDS } = {}) {
    assert.equal(confirmation, FAL_RECONCILIATION_ID, 'Exact routing reconciliation confirmation required');
    assert.equal(this.phase, 'canary');
    assert.equal(this.inflight.size, 0, 'Cannot reconcile while requests are active');
    const existing = this.falReconciliation();
    if (existing) return { status: 'already-reconciled', audit: this.state.reconciliations[FAL_RECONCILIATION_ID], parents: existing.parents, submittedNewProviderCalls: 0 };
    assert.equal(expectedParentIds.length, 3); assert.equal(new Set(expectedParentIds).size, 3);
    const records = Object.values(this.state.requests);
    const fal = records.filter(record => record.provider === 'fal');
    assert.deepEqual(fal.map(record => record.id).sort(), [...expectedParentIds].sort(), 'Only the three reviewed direct FAL attempts may be reconciled');
    assert.equal(this.state.phases.canary.submitted.fal, 3, 'Preserve the three existing submitted FAL attempts');
    assert.ok(this.state.fatalError === undefined || this.state.fatalError === LEGACY_FALLBACK_ERROR, 'Unrelated fatal error requires its own review');
    for (const record of records) {
      assert.equal(record.phase, 'canary');
      const request = this.readVerified(record.request), response = this.readVerified(record.response);
      assert.equal(record.id, sha256(`${record.provider}\n${record.model}\n${request.toString()}`));
      if (record.provider === 'fal') {
        assert.equal(record.status, 'rejected'); assert.equal(record.httpStatus, 403);
        assert.equal(record.model, '/fal-ai/birefnet');
        assert.ok(!record.transport || record.transport === 'fal-direct', 'Never reconcile a Meterkey rejection as a legacy direct attempt');
        assert.equal(JSON.parse(response).detail, DIRECT_FAL403_DETAIL);
        for (const field of ['requestId', 'status_url', 'response_url', 'result']) assert.equal(record[field], undefined, 'Accepted or unresolved requests cannot be retried');
      } else {
        assert.equal(record.provider, 'gemini'); assert.equal(record.status, 'complete'); assert.equal(record.httpStatus, 200);
      }
    }
    assert.equal(this.state.phases.canary.submitted.gemini, records.filter(record => record.provider === 'gemini').length);
    const directory = join(this.directory, 'archive', FAL_RECONCILIATION_ID);
    const ledgerBefore = immutable(join(directory, 'provider-ledger.before.json'), readFileSync(this.path));
    const auditPath = join(directory, 'reconciliation.json');
    const auditTime = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')).createdAt : new Date().toISOString();
    const proof = { schemaVersion: 1, id: FAL_RECONCILIATION_ID, createdAt: auditTime,
      authorization: 'User instructed that Casual must exclusively use the dedicated Insert Player Meterkey credential; the three archived direct-key FAL attempts were definitively rejected.',
      priorFatalError: this.state.fatalError ?? null, ledgerBefore, countersBefore: this.state.phases,
      exactBodyReplay: true, maximumChildrenPerParent: 1, childTransport: 'meterkey',
      parents: fal.map(record => ({ id: record.id, recordSha256: sha256(JSON.stringify(record)),
        requestSha256: record.request.sha256, responseSha256: record.response.sha256,
        childId: sha256(`${FAL_RECONCILIATION_ID}\n${record.id}`) })) };
    const audit = immutable(auditPath, Buffer.from(`${JSON.stringify(proof, null, 2)}\n`));
    this.state.reconciliations = { ...(this.state.reconciliations ?? {}), [FAL_RECONCILIATION_ID]: audit };
    if (this.state.fatalError === LEGACY_FALLBACK_ERROR) delete this.state.fatalError;
    this.save();
    return { status: 'reconciled', audit, parents: proof.parents, submittedNewProviderCalls: 0 };
  }
  validateScopeEvidence(artifact) {
    const evidence = JSON.parse(this.readVerified(artifact));
    assert.equal(evidence.model, 'fal-ai/birefnet'); assert.equal(evidence.modelAllowed, true);
    assert.equal(evidence.keyFingerprint, DEDICATED_METERKEY_FINGERPRINT, 'Scope evidence must identify the dedicated Insert Player key');
    assert.ok(typeof evidence.keyId === 'string' && evidence.keyId.length > 0);
    assert.ok(typeof evidence.source === 'string' && evidence.source.length > 0);
    assert.ok(typeof evidence.verifiedAt === 'string' && Number.isFinite(Date.parse(evidence.verifiedAt)));
    return evidence;
  }
  falScopeReconciliation() {
    const audit = this.state.reconciliations?.[FAL_SCOPE_RECONCILIATION_ID];
    if (!audit) return null;
    const proof = JSON.parse(this.readVerified(audit));
    assert.equal(proof.id, FAL_SCOPE_RECONCILIATION_ID); assert.equal(proof.maximumChildrenPerParent, 1);
    assert.equal(proof.exactBodyReplay, true); assert.equal(proof.childTransport, 'meterkey');
    this.readVerified(proof.ledgerBefore); this.validateScopeEvidence(proof.scopeEvidence);
    const parent = proof.parent, record = this.state.requests[parent.id];
    assert.equal(sha256(JSON.stringify(record)), parent.recordSha256, 'Scope-denied parent must remain immutable');
    assert.equal(record.provider, 'fal'); assert.equal(record.transport, 'meterkey'); assert.equal(record.model, '/fal-ai/birefnet');
    assert.equal(record.status, 'rejected'); assert.equal(record.httpStatus, 403);
    assert.equal(record.request.sha256, parent.requestSha256); assert.equal(record.response.sha256, parent.responseSha256);
    assert.equal(parent.childId, sha256(`${FAL_SCOPE_RECONCILIATION_ID}\n${parent.id}`));
    this.readVerified(record.request);
    assert.equal(JSON.parse(this.readVerified(record.response)).error?.code, 'model_not_allowed');
    const routingParent = this.falReconciliation()?.parents.find(candidate => candidate.childId === parent.id);
    assert.ok(routingParent); assert.equal(record.parentAttemptId, routingParent.id);
    assert.equal(record.request.sha256, routingParent.requestSha256);
    return proof;
  }
  // The single known scope denial is different from a provider outcome ambiguity. Only an
  // archived verification of the same dedicated key's updated model scope can unlock one child.
  reconcileMeterkeyModel403({ confirmation, scopeEvidence, expectedRejectedId = CASUAL_METERKEY_MODEL403_ID } = {}) {
    assert.equal(confirmation, FAL_SCOPE_RECONCILIATION_ID, 'Exact model-scope reconciliation confirmation required');
    assert.equal(this.phase, 'canary'); assert.equal(this.inflight.size, 0);
    const existing = this.falScopeReconciliation();
    if (existing) {
      assert.equal(existing.parent.id, expectedRejectedId);
      return { status: 'already-reconciled', audit: this.state.reconciliations[FAL_SCOPE_RECONCILIATION_ID], parent: existing.parent, submittedNewProviderCalls: 0 };
    }
    const routing = this.falReconciliation(); assert.ok(routing, 'Direct-key reconciliation must already be archived');
    const routingParent = routing.parents.find(parent => parent.childId === expectedRejectedId); assert.ok(routingParent);
    assert.equal(this.state.fatalError, undefined, 'Unrelated fatal error requires separate review');
    assert.deepEqual(this.state.phases.canary.submitted, { gemini: 13, fal: 4 }, 'Only the reviewed 13 Gemini / 4 FAL state may be reconciled');
    const record = this.state.requests[expectedRejectedId]; assert.ok(record);
    assert.equal(record.status, 'rejected'); assert.equal(record.httpStatus, 403);
    assert.equal(record.provider, 'fal'); assert.equal(record.model, '/fal-ai/birefnet'); assert.equal(record.transport, 'meterkey');
    assert.equal(record.parentAttemptId, routingParent.id); assert.equal(record.reconciliationId, FAL_RECONCILIATION_ID);
    assert.equal(record.request.sha256, routingParent.requestSha256); this.readVerified(record.request);
    const error = JSON.parse(this.readVerified(record.response)).error;
    assert.equal(error?.type, 'model_not_allowed'); assert.equal(error.code, 'model_not_allowed');
    assert.equal(error.message, 'model is not allowed for this key');
    for (const field of ['requestId', 'status_url', 'response_url', 'result']) assert.equal(record[field], undefined, 'Accepted or unresolved requests cannot be retried');
    const allowedFal = new Set([...routing.parents.map(parent => parent.id), expectedRejectedId]);
    const records = Object.values(this.state.requests);
    assert.equal(records.length, 17);
    for (const item of records) {
      if (item.provider === 'fal') assert.ok(allowedFal.has(item.id), 'Unrelated FAL attempt requires separate review');
      else { assert.equal(item.provider, 'gemini'); assert.equal(item.status, 'complete'); assert.equal(item.httpStatus, 200); this.readVerified(item.request); this.readVerified(item.response); }
    }
    const verifiedScope = this.validateScopeEvidence(scopeEvidence);
    assert.ok(Date.parse(verifiedScope.verifiedAt) >= Date.parse(record.submittedAt), 'Scope must be verified after the denied request');
    const directory = join(this.directory, 'archive', FAL_SCOPE_RECONCILIATION_ID);
    const ledgerBefore = immutable(join(directory, 'provider-ledger.before.json'), readFileSync(this.path));
    const archivedEvidence = immutable(join(directory, 'verified-scope.json'), this.readVerified(scopeEvidence));
    const auditPath = join(directory, 'reconciliation.json');
    const auditTime = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')).createdAt : new Date().toISOString();
    const proof = { schemaVersion: 1, id: FAL_SCOPE_RECONCILIATION_ID, createdAt: auditTime,
      authorization: 'User authorized enabling the models needed by Casual on its dedicated Meterkey key; the exact BiRefNet model denial is retried only after scope verification.',
      ledgerBefore, scopeEvidence: archivedEvidence, countersBefore: this.state.phases,
      childTransport: 'meterkey', maximumChildrenPerParent: 1, exactBodyReplay: true,
      parent: { id: record.id, recordSha256: sha256(JSON.stringify(record)), requestSha256: record.request.sha256,
        responseSha256: record.response.sha256, childId: sha256(`${FAL_SCOPE_RECONCILIATION_ID}\n${record.id}`), reconciliationId: FAL_SCOPE_RECONCILIATION_ID } };
    const audit = immutable(auditPath, Buffer.from(`${JSON.stringify(proof, null, 2)}\n`));
    this.state.reconciliations = { ...this.state.reconciliations, [FAL_SCOPE_RECONCILIATION_ID]: audit }; this.save();
    return { status: 'reconciled', audit, parent: proof.parent, submittedNewProviderCalls: 0 };
  }
  pilotRecoveryContract() { return PILOT_UNKNOWN_CONTRACT; }
  validatePilotRecoveryWallet(artifact, record) {
    const evidence = JSON.parse(this.readVerified(artifact));
    assert.equal(evidence.httpStatus, 200);
    const endpoint = new URL(evidence.path, METERKEY_ORIGIN);
    assert.equal(endpoint.origin, METERKEY_ORIGIN);
    assert.equal(endpoint.pathname, `/admin/v1/users/${this.pilotRecoveryContract().walletUserId}/wallet/ledger`);
    assert.equal(endpoint.searchParams.get('limit'), '250');
    assert.ok(Date.parse(endpoint.searchParams.get('since')) <= Date.parse(record.submittedAt));
    assert.ok(Number.isFinite(evidence.at) && evidence.at * 1000 >= Date.parse(record.submittedAt));
    assert.ok(Array.isArray(evidence.body?.entries) && evidence.body.entries.length > 0 && evidence.body.entries.length < 250);
    for (const field of ['next_cursor', 'nextCursor', 'cursor', 'has_more', 'hasMore']) assert.ok(!evidence.body[field], 'Wallet audit must be complete');
    assert.ok(!JSON.stringify(evidence.body.entries).includes(`casual:${record.id}`), 'Wallet audit contains the unresolved request');
    const control = evidence.body.entries.find(entry => entry.kind === 'reserve' && typeof entry.ref?.request_id === 'string'
      && this.state.requests[entry.ref.request_id.replace(/^casual:/, '')]?.status === 'complete');
    assert.ok(control, 'Complete wallet audit needs an existing successful reservation control');
    const controlRecord = this.state.requests[control.ref.request_id.replace(/^casual:/, '')];
    assert.equal(controlRecord.httpStatus, 200); this.readVerified(controlRecord.request); this.readVerified(controlRecord.response);
    return { entryCount: evidence.body.entries.length, controlRequestId: control.ref.request_id, auditedAt: evidence.at };
  }
  previewPilotUnknownRecovery({ walletEvidence } = {}) {
    const contract = this.pilotRecoveryContract(), record = this.state.requests[contract.id]; assert.ok(record);
    assert.equal(this.phase, 'full'); assert.equal(this.inflight.size, 0); assert.equal(this.state.fatalError, undefined);
    assert.equal(record.id, contract.id); assert.equal(record.status, 'unknown'); assert.equal(record.transport, 'meterkey');
    assert.equal(record.provider, 'gemini'); assert.equal(record.model, '/v1beta/models/gemini-3.1-flash-image:generateContent');
    assert.equal(record.stage, contract.stage); assert.equal(record.request.sha256, contract.requestSha256);
    for (const key of ['response', 'httpStatus', 'requestId', 'status_url', 'response_url', 'result']) assert.equal(record[key], undefined);
    const bytes = this.readVerified(record.request);
    assert.equal(record.id, sha256(`gemini\n${record.model}\n${bytes.toString()}`));
    assert.deepEqual(this.state.phases.full.submitted, contract.counters, 'Reviewed cumulative counters must remain unchanged before recovery');
    const unresolved = Object.values(this.state.requests).filter(item => item.status === 'unknown' || item.status === 'submitting');
    assert.deepEqual(unresolved.map(item => item.id), [record.id], 'Only the exact reviewed unknown may be reconciled');
    const age = Date.now() - Date.parse(record.submittedAt);
    assert.ok(age >= 0 && age < 23 * 60 * 60 * 1000, 'Recovery must remain inside the upstream idempotency window');
    const wallet = this.validatePilotRecoveryWallet(walletEvidence, record);
    return { id: PILOT_UNKNOWN_RECOVERY_ID, parentId: record.id, childId: sha256(`${PILOT_UNKNOWN_RECOVERY_ID}\n${record.id}`),
      parentRecordSha256: sha256(JSON.stringify(record)), requestSha256: record.request.sha256,
      upstreamRequestId: `casual:${record.id}`, maximumChildrenPerParent: 1, wallet,
      interpretation: 'Suspected pre-dispatch network failure; authoritative wallet audit found no reservation. Deployed version not established, so original outcome remains unknown. Recovery retains upstream duplicate suppression.' };
  }
  pilotUnknownReconciliation() {
    const artifact = this.state.reconciliations?.[PILOT_UNKNOWN_RECOVERY_ID]; if (!artifact) return null;
    const proof = JSON.parse(this.readVerified(artifact)), contract = this.pilotRecoveryContract();
    assert.equal(proof.id, PILOT_UNKNOWN_RECOVERY_ID); assert.equal(proof.parent.id, contract.id);
    assert.equal(proof.parent.requestSha256, contract.requestSha256); assert.equal(proof.maximumChildrenPerParent, 1);
    assert.equal(proof.parent.childId, sha256(`${PILOT_UNKNOWN_RECOVERY_ID}\n${contract.id}`));
    assert.equal(proof.parent.upstreamRequestId, `casual:${contract.id}`);
    const record = this.state.requests[contract.id]; assert.equal(record.status, 'unknown');
    assert.equal(sha256(JSON.stringify(record)), proof.parent.recordSha256, 'Unknown parent must remain immutable');
    this.readVerified(record.request); this.readVerified(proof.ledgerBefore); this.validatePilotRecoveryWallet(proof.walletEvidence, record);
    return proof;
  }
  reconcilePilotUnknown({ confirmation, walletEvidence } = {}) {
    assert.equal(confirmation, PILOT_UNKNOWN_RECOVERY_ID, 'Exact one-attempt pilot recovery authorization required');
    const prior = this.pilotUnknownReconciliation();
    if (prior) return { status: 'already-reconciled', parent: prior.parent, submittedNewProviderCalls: 0 };
    const preview = this.previewPilotUnknownRecovery({ walletEvidence });
    const directory = join(this.directory, 'archive', PILOT_UNKNOWN_RECOVERY_ID);
    const ledgerBefore = immutable(join(directory, 'provider-ledger.before.json'), readFileSync(this.path));
    const archivedWallet = immutable(join(directory, 'wallet-audit.json'), this.readVerified(walletEvidence));
    const auditPath = join(directory, 'reconciliation.json');
    const createdAt = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')).createdAt : new Date().toISOString();
    const proof = { schemaVersion: 1, id: PILOT_UNKNOWN_RECOVERY_ID, createdAt,
      authorization: 'Explicitly reviewed one-child recovery retaining the exact upstream idempotency key; no reclassification or counter reset.',
      interpretation: preview.interpretation, ledgerBefore, walletEvidence: archivedWallet, wallet: preview.wallet,
      countersBefore: this.state.phases, maximumChildrenPerParent: 1, exactBodyReplay: true,
      parent: { id: preview.parentId, recordSha256: preview.parentRecordSha256, requestSha256: preview.requestSha256,
        childId: preview.childId, upstreamRequestId: preview.upstreamRequestId, reconciliationId: PILOT_UNKNOWN_RECOVERY_ID } };
    const audit = immutable(auditPath, Buffer.from(`${JSON.stringify(proof, null, 2)}\n`));
    this.state.reconciliations = { ...(this.state.reconciliations ?? {}), [PILOT_UNKNOWN_RECOVERY_ID]: audit }; this.save();
    return { status: 'reconciled', audit, parent: proof.parent, submittedNewProviderCalls: 0 };
  }
  assertHealthy() {
    const approvedParents = new Set(this.falReconciliation()?.parents.map(parent => parent.id) ?? []);
    const scopeParent = this.falScopeReconciliation()?.parent;
    if (scopeParent) approvedParents.add(scopeParent.id);
    const pilotParent = this.pilotUnknownReconciliation()?.parent;
    if (this.state.fatalError) throw new Error(this.state.fatalError);
    const bad = Object.values(this.state.requests).find(item => (item.status === 'unknown' && item.id !== pilotParent?.id)
      || (item.status === 'rejected' && !approvedParents.has(item.id))
      || (item.status === 'submitting' && !this.inflight.has(item.id)));
    if (bad) throw new Error(`Provider attempt ${bad.id} is ${bad.status}; no new submissions until explicitly reconciled`);
  }
  readCached(record) {
    const bytes = readFileSync(record.response.path);
    assert.equal(sha256(bytes), record.response.sha256, 'Cached provider response was altered');
    return new Response(bytes, { status: record.httpStatus, headers: record.headers });
  }
  async upstream(url, init, onResponse) {
    const response = await this.nativeFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(180_000) });
    onResponse?.(response);
    assert.ok(response.status < 300 || response.status >= 400, 'Provider redirects refused');
    return response;
  }
  async submit(provider, path, body) {
    assert.ok(provider === 'fal' ? path === '/fal-ai/birefnet'
      : provider === 'gemini' && /^\/v1beta\/models\/(gemini-3-pro-image|gemini-3\.1-flash-image):generateContent$/.test(path),
    'Provider route is not authorized for Casual');
    const serialized = JSON.stringify(body);
    const requestHash = sha256(`${provider}\n${path}\n${serialized}`);
    let approvedParent = provider === 'fal' ? this.falReconciliation()?.parents.find(parent => parent.id === requestHash) : undefined;
    const scopeParent = provider === 'fal' ? this.falScopeReconciliation()?.parent : undefined;
    if (scopeParent && approvedParent?.childId === scopeParent.id) approvedParent = scopeParent;
    const pilotParent = this.pilotUnknownReconciliation()?.parent;
    if (provider === 'gemini' && requestHash === pilotParent?.id) approvedParent = pilotParent;
    const id = approvedParent?.childId ?? requestHash;
    if (this.inflight.has(id)) return (await this.inflight.get(id)).clone();
    const promise = this.submitOnce(provider, path, serialized, id, approvedParent);
    this.inflight.set(id, promise);
    try { return (await promise).clone(); } finally { this.inflight.delete(id); }
  }
  async submitOnce(provider, path, serialized, id, approvedParent) {
    const prior = this.state.requests[id];
    if (prior) {
      if (prior.status !== 'complete') return stopped(`Existing request ${id} is ${prior.status}; no replay dispatch`);
      prior.reusedBy = [...new Set([...(prior.reusedBy ?? []), this.stage])]; this.save();
      return this.readCached(prior);
    }
    try { this.assertHealthy(); } catch (error) { return stopped(error.message); }
    const pilotParent = this.pilotUnknownReconciliation()?.parent;
    if (pilotParent && this.state.requests[pilotParent.childId]?.status !== 'complete' && id !== pilotParent.childId) {
      return stopped('Only the one linked pilot recovery may dispatch while its outcome is unresolved');
    }
    if (id === pilotParent?.childId) {
      const age = Date.now() - Date.parse(this.state.requests[pilotParent.id].submittedAt);
      if (!(age >= 0 && age < 23 * 60 * 60 * 1000)) return stopped('Pilot recovery idempotency window expired; no dispatch');
      if (sha256(serialized) !== pilotParent.requestSha256) return stopped('Pilot recovery body mismatch; no dispatch');
    }
    const phase = this.state.phases[this.phase];
    const disk = statfsSync(this.directory);
    if (Number(disk.bavail) * Number(disk.bsize) < 256 * 1024 * 1024) {
      this.state.fatalError = 'Less than 256 MiB free; stopped before provider dispatch to preserve outputs'; this.save();
      return jsonResponse({ code: 'provider_session_spend_limit', error: { message: this.state.fatalError } }, 429);
    }
    if (phase.submitted[provider] >= phase.caps[provider]) {
      this.state.fatalError = `${provider} phase submission cap reached`; this.save();
      return jsonResponse({ code: 'provider_session_spend_limit', error: { message: `${provider} phase submission cap reached` } }, 429);
    }
    const credentials = this.credentials;
    const secret = provider === 'fal' ? credentials.falMeterkeyKey : credentials.geminiKey;
    assert.equal(credentials.geminiTransport, 'meterkey', 'Direct provider credentials are disabled');
    assert.ok(secret, `Missing ${provider} credential; no dispatch`);
    const requestDirectory = join(this.directory, 'provider', id);
    const request = immutable(join(requestDirectory, 'request.json'), Buffer.from(serialized));
    const record = this.state.requests[id] = { id, provider, model: path, phase: this.phase, stage: this.stage,
      request, status: 'submitting', submittedAt: new Date().toISOString(), reusedBy: [], transport: 'meterkey',
      ...(approvedParent?.upstreamRequestId ? { upstreamRequestId: approvedParent.upstreamRequestId } : {}),
      ...(approvedParent ? { parentAttemptId: approvedParent.id, reconciliationId: approvedParent.reconciliationId ?? FAL_RECONCILIATION_ID } : {}) };
    phase.submitted[provider] += 1; this.save();
    const upstreamRequestId = approvedParent?.upstreamRequestId ?? `casual:${id}`;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`,
      'cf-aig-collect-log-payload': 'false', 'cf-aig-max-attempts': '1', 'x-meterkey-no-store': 'true',
      'Idempotency-Key': upstreamRequestId, 'X-Request-Id': upstreamRequestId };
    const url = provider === 'fal' ? `${METERKEY_ORIGIN}/fal${path}` : `${METERKEY_ORIGIN}/google-ai-studio${path}`;
    if (provider === 'fal') {
      // Explicit async queue target. This URL is a routing header, never a direct credentialed request.
      headers['x-fal-target-url'] = `https://queue.fal.run${path}`;
      headers['x-fal-no-retry'] = '1';
    }
    let responseReceived = false;
    try {
      const response = await this.upstream(url, { method: 'POST', headers, body: serialized }, observed => {
        responseReceived = true; record.httpStatus = observed.status; record.headers = safeHeaders(observed.headers);
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      record.response = immutable(join(requestDirectory, 'response.json'), bytes);
      record.httpStatus = response.status; record.headers = safeHeaders(response.headers);
      const parsed = JSON.parse(bytes.toString());
      if (!response.ok) {
        record.status = response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown'; this.save();
        return stopped(`Provider returned HTTP ${response.status}; archived, never automatically resubmitted`);
      }
      if (provider === 'fal') {
        assert.match(parsed.request_id ?? '', /^[a-zA-Z0-9_-]+$/);
        const base = `${METERKEY_ORIGIN}/fal${path}/requests/${parsed.request_id}`;
        record.requestId = parsed.request_id;
        for (const [field, fallback] of [['status_url', `${base}/status`], ['response_url', base]]) {
          const handle = new URL(parsed[field] ?? fallback);
          assert.equal(handle.origin, METERKEY_ORIGIN, 'FAL queue handles must stay on Meterkey');
          assert.ok(!handle.username && !handle.password && !handle.search && !handle.hash);
          const expectedPath = `/fal${path}/requests/${parsed.request_id}`;
          if (field === 'status_url') assert.equal(handle.pathname, `${expectedPath}/status`);
          else assert.ok([expectedPath, `${expectedPath}/response`].includes(handle.pathname), 'Unexpected Meterkey result handle');
          record[field] = handle.href;
        }
      }
      record.status = 'complete'; record.completedAt = new Date().toISOString(); this.save();
      return this.readCached(record);
    } catch (error) {
      // Receiving no Response does not prove the request was never dispatched.
      record.status = 'unknown';
      record.failure = { stage: responseReceived ? 'afterResponse' : 'beforeResponse',
        upstream: { host: new URL(METERKEY_ORIGIN).hostname, port: 443 }, error: safeTransportError(error) };
      this.save();
      return stopped(`Provider completion unknown for ${id}; recorded reservation prevents another paid POST`);
    }
  }
  async recoverKnownQueues() {
    const statuses = [];
    for (const record of Object.values(this.state.requests).filter(item => item.provider === 'fal' && item.status === 'complete' && item.requestId)) {
      const base = `${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet/requests/${record.requestId}`;
      const response = await this.handle(`${base}/status`);
      if (!response.ok) throw new Error('GET-only FAL status recovery did not succeed; handle retained');
      const status = await response.json(); statuses.push({ requestId: record.requestId, status: status.status });
      if (status.status === 'COMPLETED') {
        const result = await this.handle(base);
        if (!result.ok) throw new Error('GET-only FAL result recovery did not succeed; handle retained');
        const body = await result.json();
        for (const imageUrl of resultImageUrls(body)) await this.handle(`${LOCAL_ORIGIN}/proxy/image?url=${encodeURIComponent(imageUrl)}`);
      }
    }
    if (this.state.fatalError?.startsWith('FAL ') && statuses.length
      && statuses.every(item => ['COMPLETED', 'IN_QUEUE', 'IN_PROGRESS'].includes(item.status))) {
      delete this.state.fatalError; this.save();
    }
    return statuses;
  }
  async handle(input, init = {}) {
    const url = new URL(String(input));
    assert.equal(url.origin, LOCAL_ORIGIN, 'Only local product proxy calls may use this adapter');
    const method = init.method ?? 'GET';
    if (url.pathname === '/proxy/upload-temp' && method === 'POST') {
      const body = JSON.parse(String(init.body)); assert.equal(typeof body.image, 'string');
      const id = sha256(body.image); const bytes = Buffer.from(body.image, 'base64');
      immutable(join(this.directory, 'temp-inputs', `${id}.image`), bytes);
      this.tempImages.set(id, body.image);
      return jsonResponse({ url: `${LOCAL_ORIGIN}/temp/${id}` });
    }
    if (/^\/proxy\/gemini\/v1beta\/models\/(gemini-3-pro-image|gemini-3\.1-flash-image):generateContent$/.test(url.pathname) && method === 'POST') {
      return this.submit('gemini', url.pathname.replace('/proxy/gemini', ''), JSON.parse(String(init.body)));
    }
    if (url.pathname === '/proxy/fal/fal-ai/birefnet' && method === 'POST') {
      const body = JSON.parse(String(init.body)); const temporary = new URL(body.image_url);
      assert.equal(temporary.origin, LOCAL_ORIGIN); const id = temporary.pathname.split('/').at(-1);
      const base64 = this.tempImages.get(id); assert.ok(base64, 'Unknown local temp image');
      return this.submit('fal', '/fal-ai/birefnet', { image_url: `data:image/jpeg;base64,${base64}` });
    }
    const poll = url.pathname.match(/^\/proxy\/fal\/fal-ai\/birefnet\/requests\/([a-zA-Z0-9_-]+)(\/status)?$/);
    if (poll && method === 'GET') {
      const record = Object.values(this.state.requests).find(item => item.provider === 'fal' && item.requestId === poll[1]);
      assert.ok(record, 'Queue handle must already be archived');
      const kind = poll[2] ? 'status_url' : 'response_url';
      if (!poll[2] && record.result) {
        const bytes = readFileSync(record.result.path); assert.equal(sha256(bytes), record.result.sha256);
        resultImageUrls(JSON.parse(bytes)).forEach(value => this.allowedImages.add(validateOutputUrl(value)));
        return new Response(bytes, { headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(record.transport, 'meterkey', 'Direct FAL queue credentials are disabled');
      const target = new URL(record[kind]);
      assert.equal(target.origin, METERKEY_ORIGIN);
      const expectedPath = `/fal/fal-ai/birefnet/requests/${record.requestId}`;
      if (poll[2]) assert.equal(target.pathname, `${expectedPath}/status`);
      else assert.ok([expectedPath, `${expectedPath}/response`].includes(target.pathname), 'Unexpected Meterkey result handle');
      assert.ok(!target.username && !target.password && !target.search && !target.hash);
      assert.ok(this.credentials.falMeterkeyKey, 'Dedicated Meterkey FAL credential unavailable');
      let response, bytes, audit;
      // Meterkey writes queue ownership asynchronously. A brief initial 404 may occur after
      // accepted submission; retry only this exact GET, never dispatch another generation.
      const ownershipBackoff = [200, 500, 1000];
      for (let attempt = 0; ; attempt++) {
        response = await this.upstream(target.href, { headers: { Authorization: `Bearer ${this.credentials.falMeterkeyKey}` } });
        bytes = Buffer.from(await response.arrayBuffer());
        audit = immutable(join(this.directory, 'provider', record.id, `${poll[2] ? 'status' : 'result'}-${sha256(bytes)}.json`), bytes);
        record.lastPoll = { ...audit, status: response.status };
        record.pollHistory = [...(record.pollHistory ?? []), { ...record.lastPoll, kind, at: new Date().toISOString() }];
        this.save();
        if (response.status !== 404 || attempt >= ownershipBackoff.length) break;
        await this.pause(ownershipBackoff[attempt]);
      }
      if (!response.ok) {
        this.state.fatalError = `FAL ${poll[2] ? 'status' : 'result'} GET failed; existing handle retained for recovery`;
      } else if (!poll[2]) {
        resultImageUrls(JSON.parse(bytes)).forEach(value => this.allowedImages.add(validateOutputUrl(value)));
        record.result = audit;
      }
      this.save();
      return new Response(bytes, { status: response.status, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/proxy/image' && method === 'GET') {
      const target = validateOutputUrl(url.searchParams.get('url'));
      assert.ok(this.allowedImages.has(target), 'Image URL must come from an accepted provider result');
      let cached = this.state.outputDownloads[target];
      if (!cached) {
        const response = await this.upstream(target, {}); assert.ok(response.ok, 'Provider image download failed');
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.ok(bytes.length && bytes.length < 64 * 1024 * 1024);
        const mime = response.headers.get('Content-Type') ?? ''; assert.ok(mime.startsWith('image/'));
        cached = this.state.outputDownloads[target] = { ...immutable(join(this.directory, 'downloads', `${sha256(bytes)}.image`), bytes), mime };
        this.save();
      }
      const bytes = readFileSync(cached.path); assert.equal(sha256(bytes), cached.sha256);
      return new Response(bytes, { headers: { 'Content-Type': cached.mime } });
    }
    // In particular, no paid Freepik fallback is silently enabled for this artifact run.
    this.state.fatalError = 'Unexpected provider fallback or operation requires review'; this.save();
    return jsonResponse({ error: { message: 'Provider operation not authorized in this local artifact run' } }, 403);
  }
}
