import type { AuthContext, PublicAuthContext } from './types';

type CrewAuthorizationContext = Pick<
  AuthContext | PublicAuthContext,
  'activeOrganizationRole' | 'claims'
>;

export function canManageCrew(auth: CrewAuthorizationContext): boolean {
  const role = auth.activeOrganizationRole?.toLowerCase() ?? '';
  if (role === 'admin' || role === 'org:admin' || role.endsWith(':admin')) return true;

  const compactOrganization = auth.claims?.o;
  if (!compactOrganization || typeof compactOrganization !== 'object' || Array.isArray(compactOrganization)) {
    return false;
  }
  const organizationClaims = compactOrganization as { per?: unknown; permissions?: unknown };
  const permissions = organizationClaims.per ?? organizationClaims.permissions;
  return Array.isArray(permissions) && permissions.some((permission) => (
    permission === 'org:sys_memberships:manage' || permission === 'org:sys_memberships:write'
  ));
}
