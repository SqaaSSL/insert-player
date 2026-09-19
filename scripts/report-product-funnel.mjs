// Read-only: never accepts tokens as CLI arguments or prints authentication data.
const args = process.argv.slice(2);
const days = args.find(arg => arg.startsWith('--days='))?.slice('--days='.length) ?? '7';
if (!/^\d{1,2}$/.test(days) || Number(days) < 1 || Number(days) > 90 || args.some(arg => !/^--days=/.test(arg) && arg !== '--json')) {
  console.error('Usage: node scripts/report-product-funnel.mjs [--days=1..90] [--json]');
  process.exit(1);
}
const token = process.env.INSERT_PLAYER_ADMIN_TOKEN?.trim();
if (!token) {
  console.error('Set INSERT_PLAYER_ADMIN_TOKEN to a current Clerk session token for an Insert Player admin account.');
  process.exit(1);
}
try {
  const response = await fetch(`https://api.insertplayer.ai/api/admin/product-events?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Report request returned HTTP ${response.status}`);
  const report = await response.json();
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Insert Player · ${report.fromDay} through ${report.throughDay} (UTC)`);
    console.log('Observed client activity — event counts, NOT unique players or cohort conversions');
    console.table(report.events.map(row => ({
      event: row.event, count: row.eventCount,
      durationSamples: row.durationSamples, averageSeconds: row.averageDurationMs === null ? null : row.averageDurationMs / 1000,
    })));
    console.log('Channels — in-page utm_source only; no cross-device attribution');
    console.table(report.channels.map(row => ({ channel: row.channel, event: row.event, count: row.eventCount })));
    console.log('Stored operational outcomes — includes test/admin activity; purchases are credit grants, not net revenue');
    console.table(report.operational);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not read product report');
  process.exitCode = 1;
}
