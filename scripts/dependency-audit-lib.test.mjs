import { describe, expect, it } from 'vitest';
import {
  auditVulnerabilityCounts,
  classifyAuditResult,
  formatAuditCounts,
  parseAuditReport,
} from './dependency-audit-lib.mjs';

function report(vulnerabilities = {}) {
  return JSON.stringify({
    auditReportVersion: 2,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
        ...vulnerabilities,
      },
    },
  });
}

describe('dependency audit result classification', () => {
  it('passes a successful audit while retaining lower-severity counts', () => {
    const result = classifyAuditResult({
      exitCode: 0,
      stdout: report({ low: 2, moderate: 1, total: 3 }),
    });
    expect(result).toMatchObject({
      kind: 'passed',
      retryable: false,
      vulnerabilities: { high: 0, critical: 0, total: 3 },
    });
  });

  it('fails immediately when high or critical vulnerabilities are reported', () => {
    const result = classifyAuditResult({
      exitCode: 1,
      stdout: report({ high: 2, critical: 1, total: 3 }),
    });
    expect(result).toMatchObject({
      kind: 'vulnerabilities',
      retryable: false,
      vulnerabilities: { high: 2, critical: 1 },
    });
  });

  it('retries only registry and network failures', () => {
    expect(classifyAuditResult({
      exitCode: 1,
      stderr: 'npm error audit endpoint returned an error',
    })).toMatchObject({ kind: 'service_error', retryable: true });
    expect(classifyAuditResult({
      exitCode: 1,
      stderr: 'npm error code EAUDITNOLOCK',
    })).toMatchObject({ kind: 'tool_error', retryable: false });
  });

  it('treats a bounded timeout as a retryable service failure', () => {
    expect(classifyAuditResult({
      exitCode: null,
      timedOut: true,
    })).toMatchObject({ kind: 'service_error', retryable: true });
  });

  it('parses JSON surrounded by npm diagnostics and formats a stable summary', () => {
    const parsed = parseAuditReport(`npm notice\n${report({ moderate: 1, total: 1 })}\nnpm notice done`);
    const counts = auditVulnerabilityCounts(parsed);
    expect(counts).toMatchObject({ moderate: 1, total: 1 });
    expect(formatAuditCounts(counts)).toBe('0 critical, 0 high, 1 moderate, 0 low, 0 info');
  });
});
