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
