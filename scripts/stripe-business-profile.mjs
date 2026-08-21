export const STRIPE_LIVE_ORIGIN = 'https://insertplayer.ai';
export const STRIPE_SANDBOX_ORIGIN = 'https://insert-player-sandbox.pages.dev';

function normalizedUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' || url.search || url.hash) return '';
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}

export function stripeBusinessProfileIssues(account, options = {}) {
  const brandName = options.brandName ?? 'Insert Player';
  const allowedOrigins = (options.allowedOrigins ?? [STRIPE_LIVE_ORIGIN])
    .map(normalizedUrl)
    .filter(Boolean);
  const profile = account?.business_profile ?? {};
  const matchesPath = (value, path = '') => {
    const actual = normalizedUrl(value);
    return allowedOrigins.some((origin) => actual === `${origin}${path}`);
  };
  const hasSupportContact = (
    matchesPath(profile.support_url, '/refunds') ||
    Boolean(String(profile.support_email ?? '').trim()) ||
    Boolean(String(profile.support_phone ?? '').trim())
  );
  const checks = [
    ['account details submitted', account?.details_submitted === true],
    ['charges enabled', account?.charges_enabled === true],
    ['payouts enabled', account?.payouts_enabled === true],
    ['customer-facing name', String(profile.name ?? '').toLowerCase().includes(brandName.toLowerCase())],
    ['website', matchesPath(profile.url)],
    ['public support contact', hasSupportContact],
  ];
  return checks.filter(([, configured]) => !configured).map(([label]) => label);
}
