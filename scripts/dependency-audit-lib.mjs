const RETRYABLE_SERVICE_PATTERNS = [
  /audit endpoint returned an error/i,
  /this endpoint is being retired/i,
  /\bEAI_AGAIN\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bENETUNREACH\b/i,
  /\bETIMEDOUT\b/i,
  /fetch failed/i,
  /network timeout/i,
  /operation timed out/i,
  /socket hang up/i,
  /\b(?:408|429|500|502|503|504)\b/,
];

function count(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function parseAuditReport(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

export function auditVulnerabilityCounts(report) {
  const vulnerabilities = report?.metadata?.vulnerabilities ?? {};
  return {
    info: count(vulnerabilities.info),
    low: count(vulnerabilities.low),
    moderate: count(vulnerabilities.moderate),
    high: count(vulnerabilities.high),
    critical: count(vulnerabilities.critical),
    total: count(vulnerabilities.total),
  };
}

export function classifyAuditResult({
  exitCode,
  stdout = '',
  stderr = '',
  timedOut = false,
}) {
  const report = parseAuditReport(stdout);
  const vulnerabilities = auditVulnerabilityCounts(report);

  if (vulnerabilities.high > 0 || vulnerabilities.critical > 0) {
    return {
      kind: 'vulnerabilities',
      retryable: false,
      report,
      vulnerabilities,
    };
  }

  if (!timedOut && exitCode === 0) {
    return {
      kind: 'passed',
      retryable: false,
      report,
      vulnerabilities,
    };
  }

  const diagnostic = `${stderr}\n${stdout}`;
  const serviceFailure = timedOut
    || RETRYABLE_SERVICE_PATTERNS.some((pattern) => pattern.test(diagnostic));

  return {
    kind: serviceFailure ? 'service_error' : 'tool_error',
    retryable: serviceFailure,
    report,
    vulnerabilities,
  };
}

export function formatAuditCounts(vulnerabilities) {
  return [
    `${vulnerabilities.critical} critical`,
    `${vulnerabilities.high} high`,
    `${vulnerabilities.moderate} moderate`,
    `${vulnerabilities.low} low`,
    `${vulnerabilities.info} info`,
  ].join(', ');
}
