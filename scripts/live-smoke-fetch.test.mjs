import { describe, expect, it, vi } from 'vitest';
import { fetchWithTransientNetworkRetry } from './live-smoke-fetch.mjs';

describe('fetchWithTransientNetworkRetry', () => {
  it('retries transient GET failures with a fresh timeout signal', async () => {
    const expected = new Response('missing', { status: 404 });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('socket closed'))
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(expected);
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await fetchWithTransientNetworkRetry({
      fetchImpl,
      target: 'https://api.insertplayer.ai/share/not-a-real-fighter',
      timeoutMs: 1_000,
      maxAttempts: 3,
      baseDelayMs: 10,
      sleepImpl,
    });

    expect(result).toBe(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenNthCalledWith(1, 10);
    expect(sleepImpl).toHaveBeenNthCalledWith(2, 20);
    expect(fetchImpl.mock.calls[0][1].signal).not.toBe(fetchImpl.mock.calls[1][1].signal);
  });

  it('never retries a mutating request', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('connection reset'));

    await expect(fetchWithTransientNetworkRetry({
      fetchImpl,
      target: 'https://api.insertplayer.ai/api/fighters',
      init: { method: 'POST', body: '{}' },
      timeoutMs: 1_000,
      maxAttempts: 3,
      baseDelayMs: 0,
    })).rejects.toThrow('connection reset');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the caller owns the abort signal', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const controller = new AbortController();

    await expect(fetchWithTransientNetworkRetry({
      fetchImpl,
      target: 'https://api.insertplayer.ai/health',
      init: { signal: controller.signal },
      timeoutMs: 1_000,
      maxAttempts: 3,
      baseDelayMs: 0,
    })).rejects.toThrow('aborted');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('returns HTTP failures without retrying them', async () => {
    const expected = new Response('unavailable', { status: 503 });
    const fetchImpl = vi.fn().mockResolvedValue(expected);

    const result = await fetchWithTransientNetworkRetry({
      fetchImpl,
      target: 'https://api.insertplayer.ai/health',
      timeoutMs: 1_000,
      maxAttempts: 3,
      baseDelayMs: 0,
    });

    expect(result).toBe(expected);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
