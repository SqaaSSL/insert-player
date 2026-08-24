export async function purgeExactCloudflareFiles({
  token,
  zoneId,
  files,
  fetchImpl = fetch,
}) {
  try {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (response.ok && body?.success === true) {
      return { purged: true, warning: '' };
    }

    const detail = body?.errors
      ?.map((error) => error?.message)
      .filter(Boolean)
      .join('; ');
    return {
      purged: false,
      warning: `Cloudflare exact asset cache purge failed (${response.status}): ${detail || 'unknown error'}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      purged: false,
      warning: `Cloudflare exact asset cache purge failed: ${detail}`,
    };
  }
}
