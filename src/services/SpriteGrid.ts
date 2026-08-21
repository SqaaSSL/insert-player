export interface SubjectBox {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
}

export interface InferredSpriteGrid {
  cols: number;
  rows: number;
  subjectCount: number;
}

interface AxisCluster {
  center: number;
  count: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function clusterAxis(centers: number[], threshold: number): AxisCluster[] {
  const sorted = centers.slice().sort((a, b) => a - b);
  const clusters: AxisCluster[] = [];

  for (const center of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current || center - current.center > threshold) {
      clusters.push({ center, count: 1 });
      continue;
    }
    current.center = (current.center * current.count + center) / (current.count + 1);
    current.count += 1;
  }

  return clusters;
}

function nearestClusterIndex(value: number, clusters: AxisCluster[]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < clusters.length; index += 1) {
    const distance = Math.abs(value - clusters[index].center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function inferSpriteGridFromSubjects(
  imageWidth: number,
  imageHeight: number,
  subjects: SubjectBox[],
  expectedFrameCount: number,
): InferredSpriteGrid | null {
  if (imageWidth <= 0 || imageHeight <= 0 || expectedFrameCount <= 0 || subjects.length === 0) {
    return null;
  }

  const largestArea = Math.max(...subjects.map((subject) => subject.area));
  const minArea = Math.max(120, largestArea * 0.28, imageWidth * imageHeight * 0.001);
  const candidates = subjects.filter((subject) =>
    subject.area >= minArea &&
    subject.w >= imageWidth * 0.035 &&
    subject.h >= imageHeight * 0.07,
  );

  if (candidates.length < expectedFrameCount) return null;

  const medianWidth = median(candidates.map((subject) => subject.w));
  const medianHeight = median(candidates.map((subject) => subject.h));
  const columnClusters = clusterAxis(
    candidates.map((subject) => subject.x + subject.w / 2),
    Math.max(6, medianWidth * 0.55),
  );
  const rowClusters = clusterAxis(
    candidates.map((subject) => subject.y + subject.h / 2),
    Math.max(6, medianHeight * 0.5),
  );

  const cols = columnClusters.length;
  const rows = rowClusters.length;
  const cellCount = cols * rows;
  const maxPlausibleCells = Math.max(16, expectedFrameCount * 2);
  if (cols < 1 || rows < 1 || cols > 8 || rows > 8) return null;
  if (cellCount < expectedFrameCount || cellCount > maxPlausibleCells) return null;
  if (candidates.length > cellCount * 1.35) return null;

  const occupiedCells = new Set<string>();
  for (const subject of candidates) {
    const centerX = subject.x + subject.w / 2;
    const centerY = subject.y + subject.h / 2;
    const col = nearestClusterIndex(centerX, columnClusters);
    const row = nearestClusterIndex(centerY, rowClusters);
    occupiedCells.add(`${col}:${row}`);
  }

  const minimumOccupied = Math.min(expectedFrameCount, Math.ceil(cellCount * 0.75));
  if (occupiedCells.size < minimumOccupied) return null;

  const inferredCellWidth = imageWidth / cols;
  const inferredCellHeight = imageHeight / rows;
  const medianWidthFill = medianWidth / inferredCellWidth;
  const medianHeightFill = medianHeight / inferredCellHeight;
  if (medianWidthFill < 0.15 || medianWidthFill > 1.15) return null;
  if (medianHeightFill < 0.45 || medianHeightFill > 1.15) return null;

  return { cols, rows, subjectCount: candidates.length };
}
