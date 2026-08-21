import { describe, expect, it } from 'vitest';
import {
  STRIPE_LIVE_ORIGIN,
  STRIPE_SANDBOX_ORIGIN,
  stripeBusinessProfileIssues,
} from './stripe-business-profile.mjs';

function accountProfile(origin = STRIPE_LIVE_ORIGIN) {
  return {
    details_submitted: true,
    charges_enabled: true,
    payouts_enabled: true,
    business_profile: {
      name: 'Insert Player',
      url: `${origin}/`,
      support_url: `${origin}/refunds`,
    },
  };
}

describe('Stripe business profile preflight', () => {
  it('accepts the complete live profile and harmless trailing slashes', () => {
    const account = accountProfile();
    account.business_profile.support_url += '/';

    expect(stripeBusinessProfileIssues(account)).toEqual([]);
  });

  it('accepts the deployed QA legal origin only when sandbox is allowed', () => {
    const account = accountProfile(STRIPE_SANDBOX_ORIGIN);

    expect(stripeBusinessProfileIssues(account, {
      allowedOrigins: [STRIPE_LIVE_ORIGIN, STRIPE_SANDBOX_ORIGIN],
    })).toEqual([]);
    expect(stripeBusinessProfileIssues(account)).toContain('website');
  });

  it('accepts Stripe-supported phone or email support when no support URL is exposed', () => {
    const phoneAccount = accountProfile();
    delete phoneAccount.business_profile.support_url;
    Object.assign(phoneAccount.business_profile, { support_phone: '+34 900 000 000' });
    expect(stripeBusinessProfileIssues(phoneAccount)).toEqual([]);

    const emailAccount = accountProfile();
    delete emailAccount.business_profile.support_url;
    Object.assign(emailAccount.business_profile, { support_email: 'support@insertplayer.ai' });
    expect(stripeBusinessProfileIssues(emailAccount)).toEqual([]);
  });

  it('reports account activation and the public fields exposed by the Account API', () => {
    expect(stripeBusinessProfileIssues({ business_profile: { name: 'Other product' } })).toEqual([
      'account details submitted',
      'charges enabled',
      'payouts enabled',
      'customer-facing name',
      'website',
      'public support contact',
    ]);
  });
});
