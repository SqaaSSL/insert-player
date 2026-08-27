import { describe, expect, it } from 'vitest';
import { sanitizeClientErrorReport } from './clientErrors';

describe('sanitizeClientErrorReport', () => {
  it('rejects payloads without a usable message', () => {
    expect(sanitizeClientErrorReport({})).toBeNull();
    expect(sanitizeClientErrorReport({ message: '   ' })).toBeNull();
    expect(sanitizeClientErrorReport({ message: 42 })).toBeNull();
  });

  it('bounds every stored field', () => {
    const report = sanitizeClientErrorReport({
      message: 'x'.repeat(10_000),
      stack: 'y'.repeat(10_000),
      debugTail: 'z'.repeat(10_000),
      route: `/fight${'a'.repeat(500)}`,
      appContext: 'c'.repeat(10_000),
      userAgent: 'u'.repeat(10_000),
    });
    expect(report).not.toBeNull();
    expect(report!.message.length).toBe(600);
    expect(report!.stack!.length).toBe(4000);
    expect(report!.debugTail!.length).toBe(4000);
    expect(report!.route.length).toBe(120);
    expect(report!.appContext!.length).toBe(400);
    expect(report!.userAgent!.length).toBe(300);
  });

  it('normalizes non-path routes to unknown and preserves clean fields', () => {
    const report = sanitizeClientErrorReport({
      message: 'TypeError: sprite is undefined',
      route: 'javascript:alert(1)',
    });
    expect(report!.route).toBe('unknown');
    expect(report!.message).toBe('TypeError: sprite is undefined');
    expect(report!.stack).toBeNull();

    const clean = sanitizeClientErrorReport({ message: 'boom', route: '/fight' });
    expect(clean!.route).toBe('/fight');
  });
});
