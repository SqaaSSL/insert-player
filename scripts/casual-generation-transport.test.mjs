import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasualTransport, LOCAL_ORIGIN, FAL_RECONCILIATION_ID, FAL_SCOPE_RECONCILIATION_ID, acquireLock, atomicJson, immutable, installCasualWindow, sha256 } from './casual-generation-transport.mjs';
import { apiFetch, createDetachedApiRequestContext } from '../src/services/ApiClient.ts';
import { publishDebugLog } from '../src/services/DebugLog.ts';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup(fetchImpl, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'casual-transport-test-')); directories.push(directory);
  const options = { directory, fingerprint: 'same-source-and-product', phase: 'canary', caps: { gemini: 2, fal: 2 },
    credentials: { geminiKey: 'test-gemini-secret', falMeterkeyKey: 'test-meterkey-secret', geminiTransport: 'meterkey' }, fetchImpl, ...extra };
  return { transport: new CasualTransport(options), options, directory };
}
const path = `${LOCAL_ORIGIN}/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent`;
const request = value => ({ method: 'POST', body: JSON.stringify({ contents: [{ parts: [{ text: value }] }] }) });
const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'fixture' }] } }] }), { headers: { 'Content-Type': 'application/json' } });

describe('Casual local artifact transport', () => {
  it('runs real product apiFetch and diagnostic events through the actual Node window adapter', async () => {
    const calls = []; const diagnostics = [];
    const { transport } = setup(async (url, init) => { calls.push({ url, init }); return ok(); });
    const restoreWindow = installCasualWindow(diagnostics); const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = transport.handle.bind(transport);
      const context = createDetachedApiRequestContext({ apiBaseUrl: LOCAL_ORIGIN, authorizationToken: 'local-artifact-only', providerRequestScope: 'casual-v1' });
      const response = await apiFetch('/proxy/gemini/v1beta/models/gemini-3.1-flash-image:generateContent', request('actual-apiFetch'), context);
      expect(response.status).toBe(200); expect(calls).toHaveLength(1);
      expect(calls[0].init.headers.Authorization).toBe('Bearer test-gemini-secret');
      expect(calls[0].init.headers['X-Insert-Player-Provider-Request-Key']).toBeUndefined();
      publishDebugLog('full-runtime-diagnostic');
      expect(diagnostics).toEqual(['full-runtime-diagnostic']);
    } finally { globalThis.fetch = originalFetch; restoreWindow(); }
  });
  it('replays an identical Rookie scaffold for Champion across process resumes without another paid POST', async () => {
    const calls = []; const { transport, options, directory } = setup(async (...args) => { calls.push(args); return ok(); });
    transport.setStage('sprite:idle:rookie');
    const original = await (await transport.handle(path, request('idle'))).text();
    const resumed = new CasualTransport(options); resumed.setStage('sprite:idle:contender');
    expect(await (await resumed.handle(path, request('idle'))).text()).toBe(original);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://meter.hilo.cx/google-ai-studio/v1beta/models/gemini-3.1-flash-image:generateContent');
    expect(calls[0][1].headers['cf-aig-max-attempts']).toBe('1');
    const serializedLedger = readFileSync(join(directory, 'provider-ledger.json'), 'utf8');
    expect(serializedLedger).toContain('sprite:idle:contender');
    expect(serializedLedger).not.toContain('test-gemini-secret');
  });
  it('coalesces identical concurrent calls before dispatch', async () => {
    let count = 0; const { transport } = setup(async () => { count++; await new Promise(resolve => setTimeout(resolve, 5)); return ok(); });
    await Promise.all([transport.handle(path, request('same')), transport.handle(path, request('same'))]);
    expect(count).toBe(1);
  });
  it('permits distinct owned concurrent refinement calls but blocks orphan submitting records after restart', async () => {
    let release; let count = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const { transport, options } = setup(async () => { count++; await gate; return ok(); }, { caps: { gemini: 3, fal: 2 } });
    const first = transport.handle(path, request('frame-one'));
    const second = transport.handle(path, request('frame-two'));
    const third = transport.handle(path, request('frame-three'));
    expect(count).toBe(3);
    expect(() => new CasualTransport(options).assertHealthy()).toThrow('submitting');
    release();
    const results = await Promise.all([first, second, third]);
    expect(results.map(item => item.status)).toEqual([200, 200, 200]);
    expect(() => transport.assertHealthy()).not.toThrow();
  });
  it('reserves before dispatch and permanently fails closed after a transport ambiguity', async () => {
    let calls = 0; let options;
    const setupResult = setup(async () => {
      calls++;
      const ledger = JSON.parse(readFileSync(join(options.directory, 'provider-ledger.json'), 'utf8'));
      expect(Object.values(ledger.requests)[0].status).toBe('submitting');
      throw new Error('connection lost');
    }); options = setupResult.options;
    const first = await setupResult.transport.handle(path, request('unknown'));
    expect(first.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('unknown');
    const resumed = new CasualTransport(options);
    expect((await resumed.handle(path, request('unknown'))).status).toBe(409);
    expect((await resumed.handle(path, request('different'))).status).toBe(409);
    expect(calls).toBe(1);
  });
  it('records safe connect-timeout cause evidence but keeps the reservation unknown without a retry', async () => {
    let calls = 0;
    const cause = Object.assign(new Error('request URL and secret-payload must not be persisted'), {
      name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT', syscall: 'connect',
      hostname: 'meter.hilo.cx', address: '203.0.113.10', port: 443,
      headers: { Authorization: 'Bearer diagnostic-secret' }, url: 'https://meter.hilo.cx/private?token=diagnostic-secret',
    });
    const { transport, options, directory } = setup(async () => { calls++; throw new TypeError('fetch failed with diagnostic-secret', { cause }); });
    expect((await transport.handle(path, request('timeout-fixture'))).status).toBe(409);
    const record = Object.values(transport.state.requests)[0];
    expect(record.status).toBe('unknown'); expect(record.httpStatus).toBeUndefined(); expect(record.response).toBeUndefined();
    expect(record.failure).toEqual({ stage: 'beforeResponse', upstream: { host: 'meter.hilo.cx', port: 443 },
      error: { name: 'TypeError', cause: { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT',
        syscall: 'connect', host: 'meter.hilo.cx', address: '203.0.113.10', port: 443 } } });
    const ledger = readFileSync(join(directory, 'provider-ledger.json'), 'utf8');
    expect(ledger).not.toContain('diagnostic-secret'); expect(ledger).not.toContain('secret-payload');
    expect(ledger).not.toContain('fetch failed'); expect(ledger).not.toContain('private?token');
    const resumed = new CasualTransport(options);
    expect((await resumed.handle(path, request('timeout-fixture'))).status).toBe(409);
    expect((await resumed.handle(path, request('different-after-timeout'))).status).toBe(409);
    expect(calls).toBe(1); expect(resumed.state.phases.canary.submitted.gemini).toBe(1);
  });

  it('distinguishes malformed provider JSON after a received response while retaining exact response evidence', async () => {
    let calls = 0; const raw = 'provider-body-secret is not JSON';
    const { transport, options, directory } = setup(async () => { calls++; return new Response(raw, { status: 200,
      headers: { 'Content-Type': 'text/plain', Authorization: 'response-header-secret' } }); });
    const response = await transport.handle(path, request('malformed-response'));
    expect(response.headers.get('X-Insert-Player-Upstream-Outcome')).toBe('unknown');
    const record = Object.values(transport.state.requests)[0];
    expect(record.status).toBe('unknown'); expect(record.httpStatus).toBe(200);
    expect(record.failure).toEqual({ stage: 'afterResponse', upstream: { host: 'meter.hilo.cx', port: 443 }, error: { name: 'SyntaxError' } });
    expect(readFileSync(record.response.path, 'utf8')).toBe(raw); expect(record.response.sha256).toBe(sha256(raw));
    const ledger = readFileSync(join(directory, 'provider-ledger.json'), 'utf8');
    expect(ledger).not.toContain('provider-body-secret'); expect(ledger).not.toContain('response-header-secret');
    const resumed = new CasualTransport(options);
    expect((await resumed.handle(path, request('malformed-response'))).status).toBe(409);
    expect((await resumed.handle(path, request('different-after-parse'))).status).toBe(409);
    expect(calls).toBe(1); expect(resumed.state.phases.canary.submitted.gemini).toBe(1);
  });

  it('records a response received even when reading its body fails before archiving', async () => {
    const cause = Object.assign(new Error('body contains hidden payload'), { name: 'BodyTimeoutError', code: 'UND_ERR_BODY_TIMEOUT' });
    const { transport } = setup(async () => ({ status: 200, headers: new Headers(),
      arrayBuffer: async () => { throw new TypeError('body read failed', { cause }); } }));
    expect((await transport.handle(path, request('body-timeout'))).status).toBe(409);
    const record = Object.values(transport.state.requests)[0];
    expect(record.httpStatus).toBe(200); expect(record.response).toBeUndefined(); expect(record.status).toBe('unknown');
    expect(record.failure).toEqual({ stage: 'afterResponse', upstream: { host: 'meter.hilo.cx', port: 443 },
      error: { name: 'TypeError', cause: { name: 'BodyTimeoutError', code: 'UND_ERR_BODY_TIMEOUT' } } });
  });

  it('enforces persistent caps before another upstream request', async () => {
    let count = 0; const { transport, options } = setup(async () => { count++; return ok(); }, { caps: { gemini: 1, fal: 1 } });
    await transport.handle(path, request('first'));
    const resumed = new CasualTransport(options);
    expect((await resumed.handle(path, request('second'))).status).toBe(429);
    expect(count).toBe(1);
    expect(() => resumed.assertHealthy()).toThrow('cap');
    expect(() => new CasualTransport({ ...options, caps: { gemini: 2, fal: 1 } })).toThrow('immutable');
  });
  it('archives FAL handles then polls the exact known handle on resume', async () => {
    const calls = []; const { transport, options } = setup(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') return new Response(JSON.stringify({ request_id: 'known-id',
        status_url: 'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/known-id/status',
        response_url: 'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/known-id' }));
      return new Response(JSON.stringify({ status: 'COMPLETED' }));
    });
    const uploaded = await (await transport.handle(`${LOCAL_ORIGIN}/proxy/upload-temp`, { method: 'POST', body: JSON.stringify({ image: 'aW1hZ2U=' }) })).json();
    await transport.handle(`${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet`, { method: 'POST', body: JSON.stringify({ image_url: uploaded.url }) });
    const resumed = new CasualTransport(options);
    await resumed.handle(`${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet/requests/known-id/status`);
    expect(calls).toHaveLength(2); expect(calls[0].init.body).toContain('data:image/jpeg;base64,');
    expect(calls[0].url).toBe('https://meter.hilo.cx/fal/fal-ai/birefnet');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-meterkey-secret');
    expect(calls[1].url).toBe('https://meter.hilo.cx/fal/fal-ai/birefnet/requests/known-id/status');
    expect(calls[1].init.headers.Authorization).toBe('Bearer test-meterkey-secret');
    await expect(resumed.handle(`${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet/requests/unknown/status`)).rejects.toThrow('archived');
  });
  it('never forwards credentials through redirects, arbitrary input URLs, or unknown downloads', async () => {
    let count = 0; const { transport } = setup(async () => { count++; return new Response('', { status: 302, headers: { location: 'https://example.com' } }); });
    expect((await transport.handle(path, request('redirect'))).status).toBe(409);
    await expect(transport.handle('https://example.com')).rejects.toThrow('local');
    await expect(transport.handle(`${LOCAL_ORIGIN}/proxy/image?url=https://fal.media/unrecorded.png`)).rejects.toThrow('accepted');
    expect(count).toBe(1);
  });
  it('recovers an accepted queue with GET requests only after a temporary polling failure', async () => {
    const calls = []; let failStatus = true;
    const { transport, options } = setup(async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (init.method === 'POST') return new Response(JSON.stringify({ request_id: 'recover-id' }));
      if (failStatus) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ status: 'IN_PROGRESS' }));
    });
    await transport.submit('fal', '/fal-ai/birefnet', { image_url: 'data:image/jpeg;base64,aW1hZ2U=' });
    await transport.handle(`${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet/requests/recover-id/status`);
    expect(() => transport.assertHealthy()).toThrow('GET failed');
    failStatus = false;
    const resumed = new CasualTransport(options);
    expect(await resumed.recoverKnownQueues()).toEqual([{ requestId: 'recover-id', status: 'IN_PROGRESS' }]);
    expect(calls.filter(item => item.method === 'POST')).toHaveLength(1);
    expect(() => resumed.assertHealthy()).not.toThrow();
  });
  it('detects corrupted replay artifacts before any new paid dispatch', async () => {
    let count = 0; const { transport } = setup(async () => { count++; return ok(); });
    await transport.handle(path, request('persist'));
    const record = Object.values(transport.state.requests)[0]; writeFileSync(record.response.path, '{}');
    await expect(transport.handle(path, request('persist'))).rejects.toThrow('altered');
    expect(count).toBe(1);
  });
  it('requires source/product fingerprints and an exclusive artifact execution lock', () => {
    const { options, directory } = setup(async () => ok());
    expect(() => new CasualTransport({ ...options, fingerprint: 'other-source' })).toThrow('changed');
    const release = acquireLock(directory);
    expect(() => acquireLock(directory)).toThrow(); release();
    const nextRelease = acquireLock(directory); nextRelease();
  });
});

function legacyCanary(fetchImpl, caps = { gemini: 32, fal: 16 }) {
  const setupResult = setup(fetchImpl, { caps });
  const { directory, options, transport } = setupResult;
  const cachedGeminiRequests = [], parents = [];
  for (const provider of ['gemini', 'fal']) {
    for (let index = 0; index < (provider === 'gemini' ? 13 : 3); index++) {
      const model = provider === 'gemini' ? '/v1beta/models/gemini-3.1-flash-image:generateContent' : '/fal-ai/birefnet';
      const body = provider === 'gemini' ? JSON.parse(request(`cached-${index}`).body) : { image_url: `data:image/jpeg;base64,Zml4dHVyZS0${index}` };
      const serialized = JSON.stringify(body), id = sha256(`${provider}\n${model}\n${serialized}`);
      const requestFile = immutable(join(directory, 'provider', id, 'request.json'), Buffer.from(serialized));
      const responseFile = immutable(join(directory, 'provider', id, 'response.json'), Buffer.from(JSON.stringify(provider === 'gemini'
        ? { cachedFrame: index } : { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' })));
      transport.state.requests[id] = { id, provider, model, phase: 'canary', stage: 'legacy-fixture', request: requestFile,
        response: responseFile, status: provider === 'gemini' ? 'complete' : 'rejected', httpStatus: provider === 'gemini' ? 200 : 403,
        headers: { 'content-type': 'application/json' }, submittedAt: '2026-09-12T00:00:00Z', reusedBy: [] };
      if (provider === 'gemini') cachedGeminiRequests.push(body); else parents.push({ id, model, body });
    }
  }
  transport.state.phases.canary.submitted = { gemini: 13, fal: 3 };
  transport.state.fatalError = 'Unexpected provider fallback or operation requires review'; transport.save();
  return { ...setupResult, transport: new CasualTransport(options), parents, cachedGeminiRequests,
    reconciliation: { confirmation: FAL_RECONCILIATION_ID, expectedParentIds: parents.map(parent => parent.id) } };
}

describe('explicit one-time direct FAL403 to Meterkey reconciliation', () => {
  it('preserves all paid evidence/counters, replays 13 Gemini responses and appends exactly one child per body', async () => {
    const calls = [];
    const { transport, options, parents, cachedGeminiRequests, reconciliation, directory } = legacyCanary(async (url, init) => {
      calls.push({ url, init }); return new Response(JSON.stringify({ request_id: `child-${calls.length}` }));
    });
    const before = readFileSync(join(directory, 'provider-ledger.json'));
    const parentRecords = parents.map(parent => JSON.stringify(transport.state.requests[parent.id]));
    expect(transport.reconcileDirectFal403(reconciliation).status).toBe('reconciled');
    expect(calls).toHaveLength(0); expect(transport.state.phases.canary.submitted).toEqual({ gemini: 13, fal: 3 });
    const audit = JSON.parse(readFileSync(transport.state.reconciliations[FAL_RECONCILIATION_ID].path));
    expect(readFileSync(audit.ledgerBefore.path)).toEqual(before);
    for (const body of cachedGeminiRequests) expect((await transport.submit('gemini', '/v1beta/models/gemini-3.1-flash-image:generateContent', body)).status).toBe(200);
    expect(calls).toHaveLength(0);
    for (const parent of parents) expect((await transport.submit('fal', parent.model, parent.body)).status).toBe(200);
    expect(calls).toHaveLength(3); expect(calls.every(call => call.url === 'https://meter.hilo.cx/fal/fal-ai/birefnet')).toBe(true);
    expect(calls.map(call => call.init.body)).toEqual(parents.map(parent => JSON.stringify(parent.body)));
    expect(transport.state.phases.canary.submitted).toEqual({ gemini: 13, fal: 6 });
    const children = Object.values(transport.state.requests).filter(record => record.parentAttemptId);
    expect(children).toHaveLength(3); expect(children.every(record => record.transport === 'meterkey')).toBe(true);
    expect(parents.map(parent => JSON.stringify(transport.state.requests[parent.id]))).toEqual(parentRecords);
    for (const child of children) expect(readFileSync(child.request.path)).toEqual(readFileSync(transport.state.requests[child.parentAttemptId].request.path));
    const resumed = new CasualTransport(options);
    expect(resumed.reconcileDirectFal403(reconciliation).status).toBe('already-reconciled');
    for (const parent of parents) expect((await resumed.submit('fal', parent.model, parent.body)).status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(readFileSync(join(directory, 'provider-ledger.json'), 'utf8')).not.toContain('test-meterkey-secret');
  });
  it('never retries an ambiguous Meterkey child and blocks other fresh dispatches after it', async () => {
    let count = 0;
    const { transport, options, parents, reconciliation } = legacyCanary(async () => { count++; throw new Error('network ambiguity'); });
    transport.reconcileDirectFal403(reconciliation);
    expect((await transport.submit('fal', parents[0].model, parents[0].body)).status).toBe(409);
    const resumed = new CasualTransport(options);
    for (const parent of parents) expect((await resumed.submit('fal', parent.model, parent.body)).status).toBe(409);
    expect(count).toBe(1); expect(resumed.state.phases.canary.submitted).toEqual({ gemini: 13, fal: 4 });
  });
  it('counts retry children against the original immutable cumulative cap', async () => {
    let count = 0;
    const { transport, parents, reconciliation } = legacyCanary(async () => new Response(JSON.stringify({ request_id: `child-${++count}` })), { gemini: 32, fal: 5 });
    transport.reconcileDirectFal403(reconciliation);
    expect((await transport.submit('fal', parents[0].model, parents[0].body)).status).toBe(200);
    expect((await transport.submit('fal', parents[1].model, parents[1].body)).status).toBe(200);
    expect((await transport.submit('fal', parents[2].model, parents[2].body)).status).toBe(429);
    expect(count).toBe(2); expect(transport.state.phases.canary.submitted.fal).toBe(5);
  });
  it.each(['unknown', 'submitting', 'accepted', 'wrong-error', 'wrong-ids', 'unrelated-fatal'])('rejects %s before any reconciliation or submission', async mutation => {
    const { transport, parents, reconciliation } = legacyCanary(async () => { throw new Error('must not call'); });
    const first = transport.state.requests[parents[0].id];
    if (mutation === 'unknown' || mutation === 'submitting') first.status = mutation;
    if (mutation === 'accepted') first.requestId = 'accepted-handle';
    if (mutation === 'wrong-error') first.httpStatus = 401;
    if (mutation === 'wrong-ids') reconciliation.expectedParentIds = ['one', 'two', 'three'];
    if (mutation === 'unrelated-fatal') transport.state.fatalError = 'Unrelated fault';
    transport.save();
    const before = readFileSync(transport.path);
    expect(() => transport.reconcileDirectFal403(reconciliation)).toThrow();
    expect(readFileSync(transport.path)).toEqual(before);
    expect(transport.state.reconciliations).toBeUndefined();
  });
});

describe('Meterkey queue ownership and credential boundary', () => {
  it('retries a brief ownership404 with GET only and archives every response', async () => {
    const calls = [], pauses = [];
    const { transport } = setup(async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers });
      if (init.method === 'POST') return new Response(JSON.stringify({ request_id: 'ownership-race' }));
      if (calls.length < 4) return new Response('{"error":"ownership pending"}', { status: 404 });
      return new Response('{"status":"IN_PROGRESS"}');
    }, { sleepImpl: async ms => { pauses.push(ms); } });
    await transport.submit('fal', '/fal-ai/birefnet', { image_url: 'data:image/jpeg;base64,Zml4dHVyZQ==' });
    const response = await transport.handle(`${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet/requests/ownership-race/status`);
    expect(response.status).toBe(200); expect(calls.map(call => call.method)).toEqual(['POST', 'GET', 'GET', 'GET']);
    expect(pauses).toEqual([200, 500]);
    expect(calls.every(call => new URL(call.url).origin === 'https://meter.hilo.cx')).toBe(true);
    expect(calls[0].headers['x-fal-target-url']).toBe('https://queue.fal.run/fal-ai/birefnet');
    expect(calls.slice(1).every(call => call.headers['x-fal-target-url'] === undefined)).toBe(true);
    expect(Object.values(transport.state.requests)[0].pollHistory.map(item => item.status)).toEqual([404, 404, 200]);
    expect(transport.state.phases.canary.submitted.fal).toBe(1);
    expect(() => transport.assertHealthy()).not.toThrow();
  });
  it('bounds repeated404 polling and retains the handle without a second POST', async () => {
    let posts = 0, gets = 0;
    const { transport } = setup(async (_url, init) => {
      if (init.method === 'POST') { posts++; return new Response('{"request_id":"unresolved-ownership"}'); }
      gets++; return new Response('{}', { status: 404 });
    }, { sleepImpl: async () => {} });
    await transport.submit('fal', '/fal-ai/birefnet', { image_url: 'data:image/jpeg;base64,Zml4dHVyZQ==' });
    expect((await transport.handle(`${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet/requests/unresolved-ownership/status`)).status).toBe(404);
    expect(posts).toBe(1); expect(gets).toBe(4);
    expect(Object.values(transport.state.requests)[0].requestId).toBe('unresolved-ownership');
    expect(() => transport.assertHealthy()).toThrow('GET failed');
  });
  it('rejects direct FAL returned handles and does not read a supplied legacy credential', async () => {
    let calls = 0;
    const { transport } = setup(async () => { calls++; return new Response(JSON.stringify({ request_id: 'bad-origin',
      status_url: 'https://queue.fal.run/fal-ai/birefnet/requests/bad-origin/status' })); });
    expect((await transport.submit('fal', '/fal-ai/birefnet', { image_url: 'data:image/jpeg;base64,Zml4dHVyZQ==' })).status).toBe(409);
    expect(Object.values(transport.state.requests)[0].status).toBe('unknown'); expect(calls).toBe(1);
    const forbidden = setup(async () => { throw new Error('must not call'); }, {
      credentials: { geminiTransport: 'meterkey', geminiKey: 'fixture', get falKey() { throw new Error('legacy secret read'); } },
    }).transport;
    await expect(forbidden.submit('fal', '/fal-ai/birefnet', { image_url: 'fixture' })).rejects.toThrow('Missing fal credential');
    expect(Object.values(forbidden.state.requests)).toHaveLength(0);
    await expect(forbidden.submit('fal', '/unapproved/model', {})).rejects.toThrow('not authorized');
  });
});


describe('Meterkey preserved response handle paths', () => {
  it('archives and follows the explicit /response handle and replays the downloaded result on resume', async () => {
    const calls = [];
    const { transport, options } = setup(async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers });
      if (init.method === 'POST') return new Response(JSON.stringify({ request_id: 'response-suffix',
        status_url: 'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/response-suffix/status',
        response_url: 'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/response-suffix/response' }));
      return new Response(JSON.stringify({ image: { url: 'https://v3.fal.media/fixture-output.png' } }));
    });
    expect((await transport.submit('fal', '/fal-ai/birefnet', { image_url: 'data:image/jpeg;base64,Zml4dHVyZQ==' })).status).toBe(200);
    const localResult = `${LOCAL_ORIGIN}/proxy/fal/fal-ai/birefnet/requests/response-suffix`;
    const result = await (await transport.handle(localResult)).json();
    expect(result.image.url).toBe('https://v3.fal.media/fixture-output.png');
    expect(calls.map(call => call.url)).toEqual(['https://meter.hilo.cx/fal/fal-ai/birefnet',
      'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/response-suffix/response']);
    expect(calls[1].headers.Authorization).toBe('Bearer test-meterkey-secret');
    expect(await (await new CasualTransport(options).handle(localResult)).json()).toEqual(result);
    expect(calls).toHaveLength(2);
  });
  it.each([
    'https://meter.hilo.cx/fal/fal-ai/other-model/requests/right-id/response',
    'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/wrong-id/response',
    'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/right-id/response/other',
    'https://meter.hilo.cx/fal/fal-ai/birefnet/requests/right-id/response?target=other',
  ])('rejects an unrelated result handle %s', async response_url => {
    let calls = 0;
    const { transport } = setup(async () => { calls++; return new Response(JSON.stringify({ request_id: 'right-id', response_url })); });
    expect((await transport.submit('fal', '/fal-ai/birefnet', { image_url: 'fixture' })).status).toBe(409);
    expect(Object.values(transport.state.requests)[0].status).toBe('unknown');
    expect(calls).toBe(1);
  });
});


async function deniedScopeCanary(afterDenial, caps) {
  let count = 0;
  const result = legacyCanary(async (url, init) => {
    count++;
    if (count === 1) return new Response(JSON.stringify({ error: { type: 'model_not_allowed', code: 'model_not_allowed', message: 'model is not allowed for this key' } }), { status: 403 });
    return afterDenial(url, init);
  }, caps);
  result.transport.reconcileDirectFal403(result.reconciliation);
  await result.transport.submit('fal', result.parents[0].model, result.parents[0].body);
  const denied = Object.values(result.transport.state.requests).find(record => record.transport === 'meterkey');
  const evidence = { keyId: 'dedicated-fixture-key', keyFingerprint: '08d594f84f67aa9c6f2e5b571fcf61f275e32d03d9fb77418777af71482c5502',
    model: 'fal-ai/birefnet', modelAllowed: true, verifiedAt: new Date(Date.now() + 1000).toISOString(), source: 'offline verified-scope fixture' };
  const scopeEvidence = immutable(join(result.directory, 'verified-scope-fixture.json'), Buffer.from(JSON.stringify(evidence)));
  return { ...result, denied, evidence, getCalls: () => count,
    scopeReconciliation: { confirmation: FAL_SCOPE_RECONCILIATION_ID, scopeEvidence, expectedRejectedId: denied.id } };
}

describe('single audited Meterkey model_not_allowed403 retry after verified scope change', () => {
  it('preserves all17 prior records, appends one exact-body grandchild, and never repeats it on resume', async () => {
    const calls = [];
    const { transport, options, parents, denied, scopeReconciliation, getCalls, directory } = await deniedScopeCanary(async (url, init) => {
      calls.push({ url, init }); return new Response('{"request_id":"allowed-after-scope"}');
    });
    const before = readFileSync(transport.path);
    const recordsBefore = JSON.stringify(transport.state.requests);
    expect(transport.reconcileMeterkeyModel403(scopeReconciliation).status).toBe('reconciled');
    expect(getCalls()).toBe(1); expect(JSON.stringify(transport.state.requests)).toBe(recordsBefore);
    expect(transport.state.phases.canary.submitted).toEqual({ gemini: 13, fal: 4 });
    const audit = JSON.parse(readFileSync(transport.state.reconciliations[FAL_SCOPE_RECONCILIATION_ID].path));
    expect(readFileSync(audit.ledgerBefore.path)).toEqual(before);
    expect(audit.parent.id).toBe(denied.id); expect(audit.parent.responseSha256).toBe(denied.response.sha256);
    expect((await transport.submit('fal', parents[0].model, parents[0].body)).status).toBe(200);
    expect(getCalls()).toBe(2); expect(calls[0].url).toBe('https://meter.hilo.cx/fal/fal-ai/birefnet');
    expect(calls[0].init.body).toBe(readFileSync(denied.request.path, 'utf8'));
    expect(transport.state.requests[denied.id]).toEqual(JSON.parse(recordsBefore)[denied.id]);
    const grandchild = transport.state.requests[audit.parent.childId];
    expect(grandchild.parentAttemptId).toBe(denied.id); expect(grandchild.reconciliationId).toBe(FAL_SCOPE_RECONCILIATION_ID);
    expect(transport.state.phases.canary.submitted).toEqual({ gemini: 13, fal: 5 });
    const resumed = new CasualTransport(options);
    expect(resumed.reconcileMeterkeyModel403(scopeReconciliation).status).toBe('already-reconciled');
    expect((await resumed.submit('fal', parents[0].model, parents[0].body)).status).toBe(200);
    expect(getCalls()).toBe(2);
    expect(readFileSync(join(directory, 'provider-ledger.json'), 'utf8')).not.toContain('test-meterkey-secret');
  });
  it('does not retry an ambiguous grandchild or permit any other fresh submission after it', async () => {
    const { transport, options, parents, scopeReconciliation, getCalls } = await deniedScopeCanary(async () => { throw new Error('unknown outcome'); });
    transport.reconcileMeterkeyModel403(scopeReconciliation);
    expect((await transport.submit('fal', parents[0].model, parents[0].body)).status).toBe(409);
    const resumed = new CasualTransport(options);
    for (const parent of parents) expect((await resumed.submit('fal', parent.model, parent.body)).status).toBe(409);
    expect(getCalls()).toBe(2); expect(resumed.state.phases.canary.submitted.fal).toBe(5);
  });
  it('retains the cumulative original cap including both old denials', async () => {
    const { transport, parents, scopeReconciliation, getCalls } = await deniedScopeCanary(async () => { throw new Error('must not call'); }, { gemini: 32, fal: 4 });
    transport.reconcileMeterkeyModel403(scopeReconciliation);
    expect((await transport.submit('fal', parents[0].model, parents[0].body)).status).toBe(429);
    expect(getCalls()).toBe(1); expect(transport.state.phases.canary.submitted.fal).toBe(4);
  });
  it.each(['unknown', 'submitting', 'accepted-handle', 'other-error', 'other-child', 'wrong-key', 'scope-not-enabled', 'stale-evidence', 'unrelated-unknown'])('rejects %s without changing ledger or authorizing any retry', async mutation => {
    const { transport, denied, scopeReconciliation, directory, evidence, getCalls } = await deniedScopeCanary(async () => { throw new Error('must not call'); });
    if (mutation === 'unknown' || mutation === 'submitting') denied.status = mutation;
    if (mutation === 'accepted-handle') denied.requestId = 'accepted-job';
    if (mutation === 'other-error') denied.response = immutable(join(directory, 'other-error.json'), Buffer.from('{"error":{"type":"other","code":"other","message":"denied"}}'));
    if (mutation === 'other-child') scopeReconciliation.expectedRejectedId = 'unrelated-attempt';
    if (['wrong-key', 'scope-not-enabled', 'stale-evidence'].includes(mutation)) {
      const changed = { ...evidence, ...(mutation === 'wrong-key' ? { keyFingerprint: 'other-key' }
        : mutation === 'stale-evidence' ? { verifiedAt: '2000-01-01T00:00:00Z' } : { modelAllowed: false }) };
      scopeReconciliation.scopeEvidence = immutable(join(directory, 'invalid-evidence.json'), Buffer.from(JSON.stringify(changed)));
    }
    if (mutation === 'unrelated-unknown') Object.values(transport.state.requests).find(record => record.provider === 'gemini').status = 'unknown';
    transport.save(); const before = readFileSync(transport.path);
    expect(() => transport.reconcileMeterkeyModel403(scopeReconciliation)).toThrow();
    expect(readFileSync(transport.path)).toEqual(before); expect(getCalls()).toBe(1);
    expect(transport.state.reconciliations[FAL_SCOPE_RECONCILIATION_ID]).toBeUndefined();
  });
});
