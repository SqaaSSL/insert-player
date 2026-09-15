import { describe, expect, it } from 'vitest';
import { resolveActiveClerkOrganization } from './auth';

describe('active Clerk Organization claims', () => {
  it('reads Clerk session-token v2 compact claims', () => {
    expect(resolveActiveClerkOrganization({
      o: { id: 'org_night_shift', slg: 'night-shift', rol: 'org:admin' },
    })).toEqual({
      id: 'org_night_shift',
      slug: 'night-shift',
      role: 'org:admin',
    });
  });

  it('keeps legacy organization claims working during token rollovers', () => {
    expect(resolveActiveClerkOrganization({
      org_id: 'org_old_guard',
      org_slug: 'old-guard',
      org_role: 'org:member',
    })).toEqual({
      id: 'org_old_guard',
      slug: 'old-guard',
      role: 'org:member',
    });
  });

  it('rejects malformed organization identifiers', () => {
    expect(resolveActiveClerkOrganization({ o: { id: '../other-crew', rol: 'org:admin' } })).toBeNull();
    expect(resolveActiveClerkOrganization({ o: { id: 'organization-without-clerk-prefix' } })).toBeNull();
  });
});
