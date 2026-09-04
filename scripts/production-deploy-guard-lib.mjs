const FULL_GIT_SHA = /^[a-f0-9]{40}$/;
const ALLOWED_GITHUB_EVENTS = new Set(['push', 'workflow_dispatch']);
const ATTESTED_CI_GENERATED_PATHS = new Set(['worker/wrangler.toml']);

function clean(value) {
  return String(value ?? '').trim();
}

function issue(code, message) {
  return { code, message };
}

const WRANGLER_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '--config',
  '--cwd',
  '-e',
  '--env',
  '--env-file',
  '--profile',
]);

function optionValue(args, ...options) {
  for (const option of options) {
    const inline = args.find((arg) => arg.startsWith(`${option}=`));
    if (inline) return inline.slice(option.length + 1);
    const index = args.indexOf(option);
    if (index >= 0) return args[index + 1] ?? '';
  }
  return '';
}

function wranglerCommandPath(args) {
  const path = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (WRANGLER_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    path.push(arg);
  }
  return path;
}

function isSandboxWranglerTarget(args) {
  const config = optionValue(args, '--config', '-c');
  const environment = optionValue(args, '--env', '-e');
  const pagesProject = optionValue(args, '--project-name');
  return /(?:^|\/)wrangler\.sandbox\.toml$/.test(config)
    || environment === 'sandbox'
    || pagesProject === 'insert-player-sandbox'
    || args.some((arg) => /insert-player-(?:api-)?sandbox(?:-|$)/.test(arg));
}

export function isProductionWranglerMutation(rawArgs) {
  const args = rawArgs.map((arg) => String(arg));
  if (args.includes('--dry-run') || args.includes('--local') || isSandboxWranglerTarget(args)) {
    return false;
  }

  const [command, subcommand, action] = wranglerCommandPath(args);
  if (['deploy', 'rollback', 'delete'].includes(command)) return true;
  if (command === 'triggers' && subcommand === 'deploy') return true;
  if (command === 'containers' && ['delete', 'push'].includes(subcommand)) return true;
  if (command === 'pages' && subcommand === 'deploy') return true;
  if (
    command === 'pages'
    && subcommand === 'deployment'
    && ['create', 'delete'].includes(action)
  ) return true;
  if (
    command === 'pages'
    && subcommand === 'project'
    && ['create', 'delete'].includes(action)
  ) return true;
  if (
    command === 'pages'
    && subcommand === 'secret'
    && ['put', 'bulk', 'delete'].includes(action)
  ) return true;
  if (command === 'versions' && ['upload', 'deploy', 'delete'].includes(subcommand)) return true;
  if (
    command === 'versions'
    && subcommand === 'secret'
    && ['put', 'bulk', 'delete'].includes(action)
  ) return true;
  if (command === 'secret' && ['put', 'bulk', 'delete'].includes(subcommand)) return true;
  if (command === 'd1' && ['create', 'delete', 'execute'].includes(subcommand)) return true;
  if (command === 'd1' && subcommand === 'migrations' && action === 'apply') return true;
  if (command === 'd1' && subcommand === 'time-travel' && action === 'restore') return true;
  return false;
}

export function statusOutsideAttestedCiGeneration({
  statusPorcelain,
  githubActions,
  attestedSha,
  headSha,
}) {
  const status = String(statusPorcelain ?? '').trimEnd();
  const normalizedHead = clean(headSha).toLowerCase();
  if (
    !status.trim()
    || clean(githubActions) !== 'true'
    || !FULL_GIT_SHA.test(normalizedHead)
    || clean(attestedSha).toLowerCase() !== normalizedHead
  ) {
    return status;
  }

  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).replace(/^"|"$/g, '');
      return !ATTESTED_CI_GENERATED_PATHS.has(path);
    })
    .join('\n');
}

export function evaluateProductionDeployGuard(input) {
  const headSha = clean(input.headSha).toLowerCase();
  const statusPorcelain = clean(input.statusPorcelain);
  const githubActions = clean(input.githubActions) === 'true';
  const issues = [];

  if (!FULL_GIT_SHA.test(headSha)) {
    issues.push(issue('invalid_head', 'HEAD is not a full Git commit SHA.'));
  }
  if (statusPorcelain) {
    issues.push(issue(
      'dirty_tree',
      'The Git worktree has modified, staged, or untracked files. Production artifacts must come from a clean commit.',
    ));
  }

  if (githubActions) {
    const githubSha = clean(input.githubSha).toLowerCase();
    const githubRef = clean(input.githubRef);
    const githubEventName = clean(input.githubEventName);
    if (!FULL_GIT_SHA.test(githubSha)) {
      issues.push(issue('invalid_github_sha', 'GITHUB_SHA is missing or invalid.'));
    } else if (headSha !== githubSha) {
      issues.push(issue('github_sha_mismatch', 'HEAD does not match the commit GitHub Actions authorized.'));
    }
    if (githubRef !== 'refs/heads/main') {
      issues.push(issue('wrong_github_ref', 'Production deploys are allowed only from refs/heads/main.'));
    }
    if (!ALLOWED_GITHUB_EVENTS.has(githubEventName)) {
      issues.push(issue('wrong_github_event', 'Production deploys require a main push or an explicit workflow dispatch.'));
    }
    return {
      allowed: issues.length === 0,
      issues,
      context: {
        channel: 'github-actions',
        gitSha: headSha,
        runId: clean(input.githubRunId) || null,
        runAttempt: clean(input.githubRunAttempt) || null,
      },
    };
  }

  const breakGlass = clean(input.breakGlass) === '1';
  const expectedSha = clean(input.expectedSha).toLowerCase();
  const remoteMainSha = clean(input.remoteMainSha).toLowerCase();
  const reason = clean(input.breakGlassReason);

  if (!breakGlass) {
    issues.push(issue(
      'ci_only',
      'Routine production deploys are CI-only. Merge to main and let the protected GitHub Actions workflow publish.',
    ));
  }
  if (!FULL_GIT_SHA.test(expectedSha)) {
    issues.push(issue('invalid_expected_sha', 'Break-glass deploys require ASF_EXPECTED_PRODUCTION_SHA as a full SHA.'));
  } else if (headSha !== expectedSha) {
    issues.push(issue('expected_sha_mismatch', 'HEAD does not match ASF_EXPECTED_PRODUCTION_SHA.'));
  }
  if (!FULL_GIT_SHA.test(remoteMainSha)) {
    issues.push(issue('invalid_remote_main', 'The current origin/main SHA could not be verified remotely.'));
  } else if (headSha !== remoteMainSha) {
    issues.push(issue('remote_main_mismatch', 'HEAD is not the exact commit currently published at origin/main.'));
  }
  if (reason.length < 20) {
    issues.push(issue(
      'missing_break_glass_reason',
      'Break-glass deploys require ASF_PRODUCTION_BREAK_GLASS_REASON with at least 20 characters.',
    ));
  }

  return {
    allowed: issues.length === 0,
    issues,
    context: {
      channel: 'break-glass',
      gitSha: headSha,
      runId: null,
      runAttempt: null,
    },
  };
}

export function assertAllowedProductionContext(result) {
  if (result.allowed) return result.context;
  const details = result.issues.map(({ message }) => `- ${message}`).join('\n');
  throw new Error([
    'Production mutation blocked by the canonical release guard.',
    details,
    '',
    'Normal path: merge a reviewed commit to main and use GitHub Actions.',
    'Emergency path: use a clean origin/main checkout and set ASF_PRODUCTION_BREAK_GLASS=1,',
    'ASF_EXPECTED_PRODUCTION_SHA=<full HEAD sha>, and ASF_PRODUCTION_BREAK_GLASS_REASON=<reason>.',
  ].join('\n'));
}

export { FULL_GIT_SHA };
