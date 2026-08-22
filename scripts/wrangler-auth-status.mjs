export function wranglerAuthIssue({ status, output, expectedAccountId = '' }) {
  const text = String(output ?? '').trim();
  if (status !== 0) {
    return `wrangler whoami exited with status ${String(status ?? 'unknown')}`;
  }
  if (/not authenticated|not logged in|authentication required|please log in/i.test(text)) {
    return 'wrangler whoami reports that authentication is required';
  }

  const accountId = expectedAccountId.trim();
  if (accountId && !text.includes(accountId)) {
    return 'wrangler whoami does not list the expected Cloudflare account';
  }
  return '';
}
