export const INSERT_PLAYER_CLERK_FRONTEND_API_HOST = 'clerk.insertplayer.ai';

export function decodeClerkPublishableKey(value) {
  const match = String(value ?? '').trim().match(/^pk_(test|live)_([A-Za-z0-9_-]+)$/);
  if (!match) return null;

  let decoded;
  try {
    decoded = Buffer.from(match[2], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.endsWith('$')) return null;

  const frontendApiHost = decoded.slice(0, -1).toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(frontendApiHost)
  ) {
    return null;
  }

  return {
    environment: match[1],
    frontendApiHost,
    frontendApiOrigin: `https://${frontendApiHost}`,
  };
}

export function clerkPublishableKeyIssues(value, options = {}) {
  const decoded = decodeClerkPublishableKey(value);
  if (!decoded) return ['payload must decode to a valid Clerk Frontend API hostname'];

  const issues = [];
  if (options.expectedEnvironment && decoded.environment !== options.expectedEnvironment) {
    issues.push(`environment must be ${options.expectedEnvironment}`);
  }
  if (
    options.expectedFrontendApiHost
    && decoded.frontendApiHost !== options.expectedFrontendApiHost.toLowerCase()
  ) {
    issues.push(`Frontend API must be ${options.expectedFrontendApiHost}`);
  }
  return issues;
}
