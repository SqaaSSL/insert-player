function isPureChromaGreen(r: number, g: number, b: number): boolean {
  return r < 55 && b < 55 && g >= 130 && g >= r * 1.5 && g >= b * 1.5;
}

function isChromaGreen(r: number, g: number, b: number): boolean {
  if (g < 30 || g - Math.max(r, b) < 14) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  if (saturation < 0.2) return false;

  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
  }
  return hue >= 70 && hue <= 170;
}

function buildAlphaDistanceMap(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const maxDistance = 31;
  const distances = new Uint8Array(width * height);
  distances.fill(maxDistance);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (rgba[index * 4 + 3] <= 8) {
        distances[index] = 0;
      } else if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        distances[index] = 1;
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      let distance = distances[index];
      if (x > 0) distance = Math.min(distance, distances[index - 1] + 1);
      if (y > 0) {
        distance = Math.min(distance, distances[index - width] + 1);
        if (x > 0) distance = Math.min(distance, distances[index - width - 1] + 1);
        if (x + 1 < width) distance = Math.min(distance, distances[index - width + 1] + 1);
      }
      distances[index] = Math.min(distance, maxDistance);
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const index = y * width + x;
      let distance = distances[index];
      if (x + 1 < width) distance = Math.min(distance, distances[index + 1] + 1);
      if (y + 1 < height) {
        distance = Math.min(distance, distances[index + width] + 1);
        if (x > 0) distance = Math.min(distance, distances[index + width - 1] + 1);
        if (x + 1 < width) distance = Math.min(distance, distances[index + width + 1] + 1);
      }
      distances[index] = Math.min(distance, maxDistance);
    }
  }
  return distances;
}

function buildSupportedGreenMap(
  rgba: Uint8ClampedArray,
  alphaDistances: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const pixelCount = width * height;
  const green = new Uint8Array(pixelCount);
  const visited = new Uint8Array(pixelCount);
  const supported = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index++) {
    const i = index * 4;
    green[index] = rgba[i + 3] > 0 && isChromaGreen(rgba[i], rgba[i + 1], rgba[i + 2]) ? 1 : 0;
  }

  for (let start = 0; start < pixelCount; start++) {
    if (!green[start] || visited[start]) continue;
    const component: number[] = [];
    const stack = [start];
    visited[start] = 1;
    let interiorPixels = 0;
    while (stack.length > 0) {
      const index = stack.pop()!;
      component.push(index);
      if (rgba[index * 4 + 3] >= 220 && alphaDistances[index] > 12) {
        interiorPixels += 1;
      }
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (!green[neighbor] || visited[neighbor]) continue;
          visited[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }
    const minimumInteriorPixels = Math.max(16, Math.ceil(component.length * 0.08));
    if (interiorPixels >= minimumInteriorPixels) {
      for (const index of component) supported[index] = 1;
    }
  }
  return supported;
}

function replaceWithNearestInteriorColor(
  target: Uint8ClampedArray,
  source: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): void {
  for (let radius = 1; radius <= 12; radius++) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let totalWeight = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const i = (ny * width + nx) * 4;
        const alpha = source[i + 3];
        if (alpha < 180 || isChromaGreen(source[i], source[i + 1], source[i + 2])) continue;
        const weight = alpha / 255;
        red += source[i] * weight;
        green += source[i + 1] * weight;
        blue += source[i + 2] * weight;
        totalWeight += weight;
      }
    }
    if (totalWeight > 0) {
      const targetIndex = (y * width + x) * 4;
      target[targetIndex] = Math.round(red / totalWeight);
      target[targetIndex + 1] = Math.round(green / totalWeight);
      target[targetIndex + 2] = Math.round(blue / totalWeight);
      return;
    }
  }
}

// Removes chroma-colored edge RGB without shrinking the matte. Legitimate
// green regions are retained when the color continues into opaque interior
// pixels. Transparent pixels immediately outside the matte receive nearby
// foreground RGB (alpha bleed), preventing canvas scaling from interpolating
// hidden green back into an otherwise clean silhouette.
export function decontaminateGreenEdges(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  if (width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error('RGBA buffer dimensions do not match.');
  }

  const source = new Uint8ClampedArray(rgba);
  const alphaDistances = buildAlphaDistanceMap(source, width, height);
  const supportedGreen = buildSupportedGreenMap(source, alphaDistances, width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (source[i + 3] === 0) continue;
      if (!isChromaGreen(source[i], source[i + 1], source[i + 2])) continue;
      const index = y * width + x;
      if (alphaDistances[index] > 12) continue;
      if (source[i + 3] < 30) {
        rgba[i + 3] = 0;
        continue;
      }
      if (
        supportedGreen[index] &&
        !isPureChromaGreen(source[i], source[i + 1], source[i + 2])
      ) continue;
      replaceWithNearestInteriorColor(rgba, source, width, height, x, y);
    }
  }

  const filled = new Uint8Array(width * height);
  for (let index = 0; index < filled.length; index++) {
    filled[index] = rgba[index * 4 + 3] > 0 ? 1 : 0;
  }
  for (let pass = 0; pass < 3; pass++) {
    const pending: Array<{ index: number; red: number; green: number; blue: number }> = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (filled[index]) continue;
        let red = 0;
        let green = 0;
        let blue = 0;
        let neighbors = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
            const neighbor = ny * width + nx;
            if (!filled[neighbor]) continue;
            const i = neighbor * 4;
            red += rgba[i];
            green += rgba[i + 1];
            blue += rgba[i + 2];
            neighbors += 1;
          }
        }
        if (neighbors > 0) {
          pending.push({
            index,
            red: Math.round(red / neighbors),
            green: Math.round(green / neighbors),
            blue: Math.round(blue / neighbors),
          });
        }
      }
    }
    for (const pixel of pending) {
      const i = pixel.index * 4;
      rgba[i] = pixel.red;
      rgba[i + 1] = pixel.green;
      rgba[i + 2] = pixel.blue;
      filled[pixel.index] = 1;
    }
  }
}

// Expands the chroma matte with DNN-only foreground coverage. Pixels restored
// by the DNN take its RGB as well as its alpha; otherwise transparent chroma
// RGB can reappear as a green fringe. Near-pure green remains background.
export function unionForegroundMasks(
  chroma: Uint8ClampedArray,
  dnn: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  if (chroma.length !== dnn.length || chroma.length % 4 !== 0) {
    throw new Error('Mask buffers must be equally sized RGBA data.');
  }
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0 || width * height * 4 !== chroma.length
  ) {
    throw new Error('Mask dimensions do not match the RGBA buffers.');
  }

  // Chroma can treat non-green or isolated green background patches as
  // foreground. Classify the DNN background topologically: anything connected
  // to the canvas edge is external background and cannot be restored by the
  // chroma mask. DNN holes enclosed by foreground remain eligible for union,
  // which protects facial highlights and clothing details.
  const externalDnnBackground = new Uint8Array(width * height);
  const queue: number[] = [];
  const enqueue = (pixelIndex: number): void => {
    if (externalDnnBackground[pixelIndex] || dnn[pixelIndex * 4 + 3] > 32) return;
    externalDnnBackground[pixelIndex] = 1;
    queue.push(pixelIndex);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pixelIndex = queue[cursor];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x + 1 < width) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y + 1 < height) enqueue(pixelIndex + width);
  }

  for (const pixelIndex of queue) {
    const offset = pixelIndex * 4;
    if (chroma[offset + 3] <= dnn[offset + 3]) continue;
    chroma[offset] = dnn[offset];
    chroma[offset + 1] = dnn[offset + 1];
    chroma[offset + 2] = dnn[offset + 2];
    chroma[offset + 3] = dnn[offset + 3];
  }

  for (let i = 0; i < chroma.length; i += 4) {
    const chromaAlpha = chroma[i + 3];
    const dnnAlpha = dnn[i + 3];
    if (dnnAlpha <= chromaAlpha) continue;

    const dnnR = dnn[i];
    const dnnG = dnn[i + 1];
    const dnnB = dnn[i + 2];
    if (chromaAlpha === 0 && isPureChromaGreen(dnnR, dnnG, dnnB)) continue;

    chroma[i] = dnnR;
    chroma[i + 1] = dnnG;
    chroma[i + 2] = dnnB;
    chroma[i + 3] = dnnAlpha;
  }
}
