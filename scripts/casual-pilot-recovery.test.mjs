import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasualTransport, PILOT_UNKNOWN_RECOVERY_ID, immutable, sha256 } from './casual-generation-transport.mjs';
const directories = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const model = '/v1beta/models/gemini-3.1-flash-image:generateContent';
const success = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fixture' }] } }] }));
function fixture(upstream = success, caps = { gemini: 4, fal: 2 }) {
  const directory = mkdtempSync(join(tmpdir(), 'casual-pilot-recovery-')); directories.push(directory);
  const body = { contents: [{ parts: [{ text: 'synthetic fixed pose request' }] }] }, serialized = JSON.stringify(body);
  const parentId = sha256(`gemini\n${model}\n${serialized}`), parentSha = sha256(serialized);
  // Only the synthetic fixture subclass substitutes the immutable production contract.
  // The shipping CLI always instantiates CasualTransport with its fixed real pilot IDs.
  const contract = { id: parentId, requestSha256: parentSha, walletUserId: 'fixture-user', stage: 'fixture-pilot:render', counters: { gemini: 2, fal: 0 } };
  class FixtureTransport extends CasualTransport { pilotRecoveryContract() { return contract; } }
  const calls = []; const options = { directory, fingerprint: 'fixture', phase: 'full', caps,
    credentials: { geminiTransport: 'meterkey', geminiKey: 'fixture-secret', falMeterkeyKey: 'fixture-secret' },
    fetchImpl: async (...args) => { calls.push(args); return upstream(...args); } };
  const transport = new FixtureTransport(options);
  const parent = { id: parentId, provider: 'gemini', model, phase: 'full', stage: contract.stage, status: 'unknown',
    transport: 'meterkey', submittedAt: new Date(Date.now() - 60_000).toISOString(), reusedBy: [],
    request: immutable(join(directory, 'provider', parentId, 'request.json'), Buffer.from(serialized)) };
  const control = { id: 'successful-control', status: 'complete', httpStatus: 200, provider: 'gemini', model, phase: 'full',
    request: immutable(join(directory, 'control-request.json'), Buffer.from('{}')),
    response: immutable(join(directory, 'control-response.json'), Buffer.from('{}')) };
  transport.state.requests = { [control.id]: control, [parent.id]: parent }; transport.state.phases.full.submitted = { gemini: 2, fal: 0 }; transport.save();
  const audit = { at: Date.now() / 1000, path: '/admin/v1/users/fixture-user/wallet/ledger?limit=250&since=2026-01-01T00%3A00%3A00Z', httpStatus: 200,
    body: { entries: [{ kind: 'reserve', ref: { request_id: 'casual:successful-control' } }] } };
  const walletEvidence = immutable(join(directory, 'wallet-audit.json'), Buffer.from(JSON.stringify(audit)));
  return { transport, FixtureTransport, options, calls, body, parent, audit, walletEvidence, directory };
}
const authorize = f => f.transport.reconcilePilotUnknown({ confirmation: PILOT_UNKNOWN_RECOVERY_ID, walletEvidence: f.walletEvidence });

describe('exact pilot unknown-outcome recovery', () => {
  it('appends one child with identical upstream IDs and body, preserving the unknown parent and counters', async () => {
    const f = fixture(), parentBefore = JSON.stringify(f.parent); const proof = authorize(f);
    expect(proof.submittedNewProviderCalls).toBe(0); expect(f.calls).toHaveLength(0);
    expect(f.transport.state.phases.full.submitted.gemini).toBe(2);
    expect((await f.transport.submit('gemini', model, { different: true })).status).toBe(409);
    expect(f.calls).toHaveLength(0);
    f.transport.setStage('fixture-pilot:render');
    expect((await f.transport.submit('gemini', model, f.body)).status).toBe(200);
    const [url, init] = f.calls[0];
    expect(url).toBe(`https://meter.hilo.cx/google-ai-studio${model}`);
    expect(init.body).toBe(JSON.stringify(f.body));
    expect(init.headers['Idempotency-Key']).toBe(`casual:${f.parent.id}`);
    expect(init.headers['X-Request-Id']).toBe(`casual:${f.parent.id}`);
    const child = f.transport.state.requests[proof.parent.childId];
    expect(child.status).toBe('complete'); expect(child.parentAttemptId).toBe(f.parent.id);
    expect(child.upstreamRequestId).toBe(`casual:${f.parent.id}`);
    expect(child.request.sha256).toBe(f.parent.request.sha256);
    expect(JSON.stringify(f.transport.state.requests[f.parent.id])).toBe(parentBefore);
    expect(f.transport.state.phases.full.submitted.gemini).toBe(3);
    const resumed = new f.FixtureTransport(f.options);
    expect((await resumed.submit('gemini', model, f.body)).status).toBe(200);
    expect(f.calls).toHaveLength(1); expect(resumed.state.phases.full.submitted.gemini).toBe(3);
  });

  it('keeps both attempts unresolved after a second ambiguity and blocks every subsequent submission', async () => {
    const f = fixture(async () => { throw new TypeError('connection lost'); }); const proof = authorize(f);
    expect((await f.transport.submit('gemini', model, f.body)).status).toBe(409);
    expect(f.transport.state.requests[f.parent.id].status).toBe('unknown');
    expect(f.transport.state.requests[proof.parent.childId].status).toBe('unknown');
    const resumed = new f.FixtureTransport(f.options);
    expect((await resumed.submit('gemini', model, f.body)).status).toBe(409);
    expect((await resumed.submit('gemini', model, { other: true })).status).toBe(409);
    expect(f.calls).toHaveLength(1); expect(resumed.state.phases.full.submitted.gemini).toBe(3);
  });

  it('stops on upstream duplicate suppression without resolving the parent or inventing another key', async () => {
    const f = fixture(() => new Response(JSON.stringify({ error: { code: 'idempotency_replay_unavailable' } }),
      { status: 409, headers: { 'x-meterkey-upstream-outcome': 'not-dispatched' } })); const proof = authorize(f);
    expect((await f.transport.submit('gemini', model, f.body)).status).toBe(409);
    const child = f.transport.state.requests[proof.parent.childId];
    expect(child.status).toBe('rejected'); expect(child.httpStatus).toBe(409);
    expect(child.headers['x-meterkey-upstream-outcome']).toBe('not-dispatched');
    expect(f.transport.state.requests[f.parent.id].status).toBe('unknown');
    expect((await f.transport.submit('gemini', model, f.body)).status).toBe(409);
    expect((await f.transport.submit('gemini', model, { changed: true })).status).toBe(409);
    expect(f.calls).toHaveLength(1);
  });

  it('enforces the existing cumulative cap and a fresh 23-hour idempotency check before dispatch', async () => {
    const capped = fixture(success, { gemini: 2, fal: 2 }); authorize(capped);
    expect((await capped.transport.submit('gemini', model, capped.body)).status).toBe(429); expect(capped.calls).toHaveLength(0);
    const expired = fixture(); authorize(expired);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.parent.submittedAt) + 23 * 60 * 60 * 1000);
    expect((await expired.transport.submit('gemini', model, expired.body)).status).toBe(409); expect(expired.calls).toHaveLength(0);
    expect(expired.transport.state.phases.full.submitted.gemini).toBe(2);
  });

  it.each(['wrong-user', 'cursor', 'missing-control', 'target-reserved', 'other-unknown', 'changed-body', 'stale'])('rejects %s evidence before any authorization or paid call', mutation => {
    const f = fixture();
    if (mutation === 'wrong-user') f.audit.path = f.audit.path.replace('fixture-user', 'wrong-user');
    if (mutation === 'cursor') f.audit.body.next_cursor = 'more';
    if (mutation === 'missing-control') f.audit.body.entries = [{ kind: 'reserve', ref: { request_id: 'casual:unrelated' } }];
    if (mutation === 'target-reserved') f.audit.body.entries.push({ kind: 'reserve', ref: { request_id: `casual:${f.parent.id}` } });
    if (mutation === 'other-unknown') f.transport.state.requests.other = { id: 'other', status: 'unknown' };
    if (mutation === 'changed-body') f.parent.request.sha256 = 'wrong-body';
    if (mutation === 'stale') f.parent.submittedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const evidence = immutable(join(f.directory, 'changed-audit.json'), Buffer.from(JSON.stringify(f.audit)));
    expect(() => f.transport.reconcilePilotUnknown({ confirmation: PILOT_UNKNOWN_RECOVERY_ID, walletEvidence: evidence })).toThrow();
    expect(f.transport.state.reconciliations?.[PILOT_UNKNOWN_RECOVERY_ID]).toBeUndefined(); expect(f.calls).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(f.directory, 'provider-ledger.json'))).phases.full.submitted.gemini).toBe(2);
  });
});
