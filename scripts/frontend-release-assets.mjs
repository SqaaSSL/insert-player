const RELEASE_ASSET_PATTERN = /\/assets\/[A-Za-z0-9._-]+\.(?:css|gif|jpe?g|js|mp4|png|svg|webm|webp|woff2?)/g;
const MEDIA_CONTENT_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
]);

export function collectFrontendReleaseAssetPaths({ entryAssetPath, sourceTexts }) {
  const paths = new Set([entryAssetPath]);
  for (const text of sourceTexts) {
    for (const match of text.matchAll(RELEASE_ASSET_PATTERN)) paths.add(match[0]);
  }
  return [...paths].sort();
}

export function chunkFrontendReleaseAssets(assetPaths, origins, maxFilesPerRequest = 20) {
  if (!Number.isInteger(maxFilesPerRequest) || maxFilesPerRequest < origins.length) {
    throw new Error('maxFilesPerRequest must fit at least one asset across every origin.');
  }
  const assetsPerChunk = Math.max(1, Math.floor(maxFilesPerRequest / origins.length));
  const chunks = [];
  for (let index = 0; index < assetPaths.length; index += assetsPerChunk) {
    chunks.push(
      assetPaths
        .slice(index, index + assetsPerChunk)
        .flatMap((path) => origins.map((origin) => `${origin}${path}`)),
    );
  }
  return chunks;
}

export function expectedMediaContentType(assetPath) {
  const extension = [...MEDIA_CONTENT_TYPES.keys()].find((candidate) =>
    assetPath.endsWith(candidate),
  );
  return extension ? MEDIA_CONTENT_TYPES.get(extension) : null;
}

export async function waitForLiveMediaAsset({
  url,
  expectedType,
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxAttempts = 12,
  retryDelayMs = 5_000,
  requestTimeoutMs = 30_000,
  onRetry = () => {},
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer.');
  }

  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const actualType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
      lastResult = {
        status: response.status,
        actualType,
        contentLength,
      };
      if (
        response.ok
        && actualType === expectedType
        && (contentLength === null || (Number.isFinite(contentLength) && contentLength > 0))
      ) {
        return { ...lastResult, attempt };
      }
    } catch (error) {
      lastResult = {
        status: null,
        actualType: '',
        contentLength: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (attempt < maxAttempts) {
      onRetry({ ...lastResult, attempt, maxAttempts });
      await sleep(retryDelayMs);
    }
  }

  const detail = lastResult?.error
    ? `error=${lastResult.error}`
    : `status=${lastResult?.status ?? 'unavailable'} type=${lastResult?.actualType || 'missing'} bytes=${lastResult?.contentLength ?? 'unspecified'}`;
  throw new Error(`Live media verification failed for ${url}: ${detail}.`);
}
