import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import { installGracefulShutdown } from '../gracefulShutdown.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function lifecycle(t: TestContext, server: Server, waitForRequests?: () => Promise<unknown>) {
  const signals = new EventEmitter();
  const exited = deferred<number>();
  const exitCodes: number[] = [];
  const close = t.mock.method(server, 'close');
  const uninstall = installGracefulShutdown(server, {
    signals: signals as unknown as NodeJS.Process,
    waitForRequests,
    exit: code => { exitCodes.push(code); exited.resolve(code); },
  });
  t.after(() => { uninstall(); server.closeAllConnections(); server.close(); });
  return { signals, exited, exitCodes, close, uninstall };
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`idle server drains and exits zero after ${signal}`, { timeout: 3_000 }, async t => {
    const server = createServer((_request, response) => response.end('ready'));
    await listen(server);
    const state = lifecycle(t, server);
    state.signals.emit(signal);
    assert.equal(await state.exited.promise, 0);
    assert.equal(server.listening, false);
    assert.deepEqual(state.exitCodes, [0]);
    assert.equal(state.close.mock.callCount(), 1);
  });
}

test('idle keep-alive connection cannot hold shutdown open', { timeout: 3_000 }, async t => {
  const server = createServer((_request, response) => response.end('ready'));
  const url = await listen(server);
  const state = lifecycle(t, server);
  const response = await fetch(url);
  assert.equal(await response.text(), 'ready');
  state.signals.emit('SIGTERM');
  assert.equal(await state.exited.promise, 0);
});

test('active request finishes intact; new connections are rejected and signals are idempotent', { timeout: 3_000 }, async t => {
  const accepted = deferred();
  const release = deferred();
  const server = createServer(async (_request, response) => {
    accepted.resolve();
    await release.promise;
    response.end('complete provider result');
  });
  const url = await listen(server);
  const state = lifecycle(t, server);
  const body = new Promise<string>((resolve, reject) => {
    get(url, { agent: false }, response => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { output += chunk; });
      response.once('end', () => resolve(output));
      response.once('error', reject);
    }).once('error', reject);
  });
  await accepted.promise;
  state.signals.emit('SIGTERM');
  state.signals.emit('SIGINT');
  state.signals.emit('SIGTERM');
  await nextTick();
  assert.equal(server.listening, false);
  assert.deepEqual(state.exitCodes, []);
  assert.equal(state.close.mock.callCount(), 1);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  release.resolve();
  assert.equal(await body, 'complete provider result');
  assert.equal(await state.exited.promise, 0);
  assert.deepEqual(state.exitCodes, [0]);
});

test('client disconnect does not terminate a still-running provider operation', { timeout: 3_000 }, async t => {
  const accepted = deferred();
  const disconnected = deferred();
  const provider = deferred();
  const drainStarted = deferred();
  const server = createServer(async (_request, response) => {
    response.once('close', () => disconnected.resolve());
    accepted.resolve();
    await provider.promise;
  });
  const url = await listen(server);
  const state = lifecycle(t, server, async () => {
    drainStarted.resolve();
    await Promise.allSettled([provider.promise]);
  });
  const request = get(url);
  request.on('error', () => {});
  await accepted.promise;
  request.destroy();
  await disconnected.promise;
  state.signals.emit('SIGTERM');
  await drainStarted.promise;
  await nextTick();
  assert.deepEqual(state.exitCodes, []);
  state.signals.emit('SIGINT');
  assert.equal(state.close.mock.callCount(), 1);
  provider.resolve();
  assert.equal(await state.exited.promise, 0);
});

test('signal before listen still exits safely and removes only its own listeners', { timeout: 3_000 }, async t => {
  const server = createServer();
  const state = lifecycle(t, server);
  let unrelatedCalls = 0;
  state.signals.on('SIGTERM', () => { unrelatedCalls += 1; });
  state.signals.emit('SIGTERM');
  assert.equal(await state.exited.promise, 0);
  state.uninstall();
  assert.equal(state.signals.listenerCount('SIGTERM'), 1);
  assert.equal(state.signals.listenerCount('SIGINT'), 0);
  state.signals.emit('SIGTERM');
  assert.equal(unrelatedCalls, 2);
  assert.deepEqual(state.exitCodes, [0]);
});

test('a failed drain reports a nonzero exit only after the drain has settled', { timeout: 3_000 }, async t => {
  const server = createServer();
  const release = deferred();
  const state = lifecycle(t, server, async () => {
    await release.promise;
    throw new Error('drain failed');
  });
  state.signals.emit('SIGINT');
  await nextTick();
  assert.deepEqual(state.exitCodes, []);
  release.resolve();
  assert.equal(await state.exited.promise, 1);
  assert.deepEqual(state.exitCodes, [1]);
});
