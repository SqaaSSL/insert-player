export function expandMirroredSequence<T>(
  sourceFrames: readonly T[],
  totalFrames: number,
): T[] {
  if (!Number.isInteger(totalFrames) || totalFrames < 0) {
    throw new Error('totalFrames must be a non-negative integer');
  }
  if (totalFrames === 0) return [];
  if (sourceFrames.length === 0) {
    throw new Error('Cannot expand an empty frame sequence');
  }

  const expanded = [...sourceFrames];
  const reversedInterior = sourceFrames.slice(1, -1).reverse();
  for (const frame of reversedInterior) {
    if (expanded.length >= totalFrames) break;
    expanded.push(frame);
  }
  while (expanded.length < totalFrames) expanded.push(sourceFrames[0]);
  return expanded.slice(0, totalFrames);
}
