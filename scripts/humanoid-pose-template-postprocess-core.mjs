const ALPHA_THRESHOLD = 8;

export const HUMANOID_POSTPROCESS_CANVAS = Object.freeze({
  sourceWidth: 768,
  sourceHeight: 1024,
  outputWidth: 1776,
  outputHeight: 2368,
  scaleNumerator: 37,
  scaleDenominator: 16,
});

export const HUMANOID_POSTPROCESS_THRESHOLDS = Object.freeze({
  largestComponentReview: 0.88,
  largestComponentHard: 0.55,
  greenSpillReview: 0.04,
  greenSpillHard: 0.18,
  secondaryDeviationReview: 0.15,
  secondaryDeviationHard: 0.40,
  scaleReviewMin: 0.60,
  scaleReviewMax: 1.10,
  scaleHardMin: 0.45,
  scaleHardMax: 1.25,
  primaryAxisTolerancePixels: 2,
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function hueAndSaturation(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const saturation = maximum === 0 ? 0 : delta / maximum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
    if (hue < 0) hue += 360;
  }
  return { hue, saturation };
}

// Deliberately has no value/luminosity floor. Grok's nominally flat green
// canvases can contain a dark vignette; topology and hue are more reliable
// than brightness for deciding whether an edge pixel belongs to that canvas.
export function isFloodFillGreen(red, green, blue) {
  if (green < red || green < blue) return false;
  const { hue, saturation } = hueAndSaturation(red, green, blue);
  return saturation >= 0.16 && hue >= 65 && hue <= 175;
}

// The humanoid contract contains no legitimate green material. A stricter
// global predicate safely removes enclosed chroma pockets that cannot be
// reached from the canvas edge, while leaving low-saturation neutral shadows
// untouched for human review.
export function isStrictInternalGreen(red, green, blue) {
  if (green < red || green < blue) return false;
  const { hue, saturation } = hueAndSaturation(red, green, blue);
  return saturation >= 0.55 && hue >= 75 && hue <= 165;
}

function rgbaInput(input, width, height) {
  const pixels = width * height;
  invariant(Buffer.isBuffer(input) || input instanceof Uint8Array || input instanceof Uint8ClampedArray, 'Image pixels are required.');
  invariant(input.length === pixels * 3 || input.length === pixels * 4, 'Image pixel dimensions do not match.');
  const rgba = new Uint8ClampedArray(pixels * 4);
  if (input.length === rgba.length) {
    rgba.set(input);
    return rgba;
  }
  for (let source = 0, destination = 0; source < input.length; source += 3, destination += 4) {
    rgba[destination] = input[source];
    rgba[destination + 1] = input[source + 1];
    rgba[destination + 2] = input[source + 2];
    rgba[destination + 3] = 255;
  }
  return rgba;
}

export function keyHumanoidChroma(input, width, height) {
  invariant(Number.isSafeInteger(width) && width > 0, 'Image width is invalid.');
  invariant(Number.isSafeInteger(height) && height > 0, 'Image height is invalid.');
  const rgba = rgbaInput(input, width, height);
  const pixelCount = width * height;
  const background = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueStart = 0;
  let queueEnd = 0;

  const enqueue = (index) => {
    if (background[index]) return;
    const offset = index * 4;
    if (rgba[offset + 3] <= ALPHA_THRESHOLD || isFloodFillGreen(rgba[offset], rgba[offset + 1], rgba[offset + 2])) {
      background[index] = 1;
      queue[queueEnd] = index;
      queueEnd += 1;
    }
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (queueStart < queueEnd) {
    const index = queue[queueStart];
    queueStart += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  let strictInternalPixels = 0;
  let removedPixels = 0;
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    if (rgba[offset + 3] <= ALPHA_THRESHOLD) background[index] = 1;
    if (!background[index] && isStrictInternalGreen(rgba[offset], rgba[offset + 1], rgba[offset + 2])) {
      background[index] = 1;
      strictInternalPixels += 1;
    }
    if (background[index]) {
      rgba[offset] = 0;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 0;
      removedPixels += 1;
    }
  }

  return {
    rgba,
    keyMetrics: {
      edgeFloodPixels: queueEnd,
      strictInternalPixels,
      removedPixels,
      retainedPixels: pixelCount - removedPixels,
    },
  };
}

function isPureChromaGreen(red, green, blue) {
  return red < 55 && blue < 55 && green >= 130 && green >= red * 1.5 && green >= blue * 1.5;
}

function isChromaGreen(red, green, blue) {
  if (green < 30 || green - Math.max(red, blue) < 14) return false;
  const { hue, saturation } = hueAndSaturation(red, green, blue);
  return saturation >= 0.2 && hue >= 70 && hue <= 170;
}

// This is the browser-independent equivalent of decontaminateGreenEdges in
// src/services/AlphaMask.ts. Keep the implementation in lock-step with that
// proven runtime cleanup, but do not import its browser/TypeScript module into
// the private production CLI.
function buildAlphaDistanceMap(rgba, width, height) {
  const maximumDistance = 31;
  const distances = new Uint8Array(width * height);
  distances.fill(maximumDistance);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (rgba[index * 4 + 3] <= 8) distances[index] = 0;
      else if (x === 0 || y === 0 || x === width - 1 || y === height - 1) distances[index] = 1;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let distance = distances[index];
      if (x > 0) distance = Math.min(distance, distances[index - 1] + 1);
      if (y > 0) {
        distance = Math.min(distance, distances[index - width] + 1);
        if (x > 0) distance = Math.min(distance, distances[index - width - 1] + 1);
        if (x + 1 < width) distance = Math.min(distance, distances[index - width + 1] + 1);
      }
      distances[index] = Math.min(distance, maximumDistance);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let distance = distances[index];
      if (x + 1 < width) distance = Math.min(distance, distances[index + 1] + 1);
      if (y + 1 < height) {
        distance = Math.min(distance, distances[index + width] + 1);
        if (x > 0) distance = Math.min(distance, distances[index + width - 1] + 1);
        if (x + 1 < width) distance = Math.min(distance, distances[index + width + 1] + 1);
      }
      distances[index] = Math.min(distance, maximumDistance);
    }
  }
  return distances;
}

function buildSupportedGreenMap(rgba, alphaDistances, width, height) {
  const pixelCount = width * height;
  const green = new Uint8Array(pixelCount);
  const visited = new Uint8Array(pixelCount);
  const supported = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    green[index] = rgba[offset + 3] > 0 && isChromaGreen(rgba[offset], rgba[offset + 1], rgba[offset + 2]) ? 1 : 0;
  }
  for (let start = 0; start < pixelCount; start += 1) {
    if (!green[start] || visited[start]) continue;
    const component = [];
    const stack = [start];
    visited[start] = 1;
    let interiorPixels = 0;
    while (stack.length > 0) {
      const index = stack.pop();
      component.push(index);
      if (rgba[index * 4 + 3] >= 220 && alphaDistances[index] > 12) interiorPixels += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy += 1) {
        const neighbourY = y + dy;
        if (neighbourY < 0 || neighbourY >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighbourX = x + dx;
          if ((dx === 0 && dy === 0) || neighbourX < 0 || neighbourX >= width) continue;
          const neighbour = neighbourY * width + neighbourX;
          if (!green[neighbour] || visited[neighbour]) continue;
          visited[neighbour] = 1;
          stack.push(neighbour);
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

function replaceWithNearestInteriorColor(target, source, width, height, x, y) {
  for (let radius = 1; radius <= 12; radius += 1) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let totalWeight = 0;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const neighbourX = x + dx;
        const neighbourY = y + dy;
        if (neighbourX < 0 || neighbourX >= width || neighbourY < 0 || neighbourY >= height) continue;
        const offset = (neighbourY * width + neighbourX) * 4;
        const alpha = source[offset + 3];
        if (alpha < 180 || isChromaGreen(source[offset], source[offset + 1], source[offset + 2])) continue;
        const weight = alpha / 255;
        red += source[offset] * weight;
        green += source[offset + 1] * weight;
        blue += source[offset + 2] * weight;
        totalWeight += weight;
      }
    }
    if (totalWeight > 0) {
      const targetOffset = (y * width + x) * 4;
      target[targetOffset] = Math.round(red / totalWeight);
      target[targetOffset + 1] = Math.round(green / totalWeight);
      target[targetOffset + 2] = Math.round(blue / totalWeight);
      return;
    }
  }
}

export function decontaminateGreenEdges(rgba, width, height) {
  invariant(width > 0 && height > 0 && rgba.length === width * height * 4, 'RGBA buffer dimensions do not match.');
  const source = new Uint8ClampedArray(rgba);
  const alphaDistances = buildAlphaDistanceMap(source, width, height);
  const supportedGreen = buildSupportedGreenMap(source, alphaDistances, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (source[offset + 3] === 0 || !isChromaGreen(source[offset], source[offset + 1], source[offset + 2])) continue;
      const index = y * width + x;
      if (alphaDistances[index] > 12) continue;
      if (source[offset + 3] < 30) {
        rgba[offset + 3] = 0;
        continue;
      }
      if (supportedGreen[index] && !isPureChromaGreen(source[offset], source[offset + 1], source[offset + 2])) continue;
      replaceWithNearestInteriorColor(rgba, source, width, height, x, y);
    }
  }

  const filled = new Uint8Array(width * height);
  for (let index = 0; index < filled.length; index += 1) filled[index] = rgba[index * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const pending = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (filled[index]) continue;
        let red = 0;
        let green = 0;
        let blue = 0;
        let neighbours = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          const neighbourY = y + dy;
          if (neighbourY < 0 || neighbourY >= height) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            const neighbourX = x + dx;
            if ((dx === 0 && dy === 0) || neighbourX < 0 || neighbourX >= width) continue;
            const neighbour = neighbourY * width + neighbourX;
            if (!filled[neighbour]) continue;
            const offset = neighbour * 4;
            red += rgba[offset];
            green += rgba[offset + 1];
            blue += rgba[offset + 2];
            neighbours += 1;
          }
        }
        if (neighbours > 0) pending.push({ index, red: Math.round(red / neighbours), green: Math.round(green / neighbours), blue: Math.round(blue / neighbours) });
      }
    }
    for (const pixel of pending) {
      const offset = pixel.index * 4;
      rgba[offset] = pixel.red;
      rgba[offset + 1] = pixel.green;
      rgba[offset + 2] = pixel.blue;
      filled[pixel.index] = 1;
    }
  }
}

export function decontaminateForegroundRegion(rgba, width, height, bbox, padding = 16) {
  invariant(bbox && bbox.w > 0 && bbox.h > 0, 'Foreground bbox is required.');
  const left = Math.max(0, bbox.x - padding);
  const top = Math.max(0, bbox.y - padding);
  const right = Math.min(width, bbox.x + bbox.w + padding);
  const bottom = Math.min(height, bbox.y + bbox.h + padding);
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  const region = new Uint8ClampedArray(regionWidth * regionHeight * 4);
  for (let y = 0; y < regionHeight; y += 1) {
    const sourceStart = ((top + y) * width + left) * 4;
    region.set(rgba.subarray(sourceStart, sourceStart + regionWidth * 4), y * regionWidth * 4);
  }
  decontaminateGreenEdges(region, regionWidth, regionHeight);
  for (let y = 0; y < regionHeight; y += 1) {
    const destinationStart = ((top + y) * width + left) * 4;
    rgba.set(region.subarray(y * regionWidth * 4, (y + 1) * regionWidth * 4), destinationStart);
  }
}

export function suppressGreenSpill(rgba) {
  let spillPixelsBefore = 0;
  let foregroundPixels = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] <= ALPHA_THRESHOLD) continue;
    foregroundPixels += 1;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const target = Math.max(red, blue);
    if (green <= target || green < Math.round(target * 1.05)) continue;
    const { hue, saturation } = hueAndSaturation(red, green, blue);
    if (hue >= 65 && hue <= 175 && saturation >= 0.12) spillPixelsBefore += 1;
    rgba[offset + 1] = Math.round(target + (green - target) * 0.2);
  }
  return { foregroundPixels, spillPixelsBefore };
}

function bboxRecord(minimumX, minimumY, maximumX, maximumY) {
  if (maximumX < minimumX || maximumY < minimumY) return null;
  return {
    x: minimumX,
    y: minimumY,
    w: maximumX - minimumX + 1,
    h: maximumY - minimumY + 1,
  };
}

export function analyzeForeground(rgba, width, height, alphaThreshold = ALPHA_THRESHOLD) {
  invariant(rgba.length === width * height * 4, 'RGBA analysis dimensions do not match.');
  const pixelCount = width * height;
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components = [];
  let totalPixels = 0;
  let allMinX = width;
  let allMinY = height;
  let allMaxX = -1;
  let allMaxY = -1;
  let touchesEdge = false;
  let greenSpillPixels = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    if (rgba[offset + 3] <= alphaThreshold) continue;
    totalPixels += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    allMinX = Math.min(allMinX, x);
    allMinY = Math.min(allMinY, y);
    allMaxX = Math.max(allMaxX, x);
    allMaxY = Math.max(allMaxY, y);
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    const { hue, saturation } = hueAndSaturation(red, green, blue);
    if (green > Math.max(red, blue) + 8 && saturation >= 0.12 && hue >= 65 && hue <= 175) greenSpillPixels += 1;
  }

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || rgba[start * 4 + 3] <= alphaThreshold) continue;
    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd] = start;
    queueEnd += 1;
    visited[start] = 1;
    let pixels = 0;
    let minimumX = width;
    let minimumY = height;
    let maximumX = -1;
    let maximumY = -1;
    while (queueStart < queueEnd) {
      const index = queue[queueStart];
      queueStart += 1;
      pixels += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        const neighbourY = y + dy;
        if (neighbourY < 0 || neighbourY >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const neighbourX = x + dx;
          if ((dx === 0 && dy === 0) || neighbourX < 0 || neighbourX >= width) continue;
          const neighbour = neighbourY * width + neighbourX;
          if (visited[neighbour] || rgba[neighbour * 4 + 3] <= alphaThreshold) continue;
          visited[neighbour] = 1;
          queue[queueEnd] = neighbour;
          queueEnd += 1;
        }
      }
    }
    components.push({ pixels, bbox: bboxRecord(minimumX, minimumY, maximumX, maximumY) });
  }

  components.sort((left, right) => right.pixels - left.pixels);
  const largest = components[0] ?? null;
  return {
    totalPixels,
    componentCount: components.length,
    significantSecondaryComponents: components.slice(1).filter((component) => component.pixels >= 64).length,
    largestComponentPixels: largest?.pixels ?? 0,
    largestComponentRatio: totalPixels > 0 ? (largest?.pixels ?? 0) / totalPixels : 0,
    largestComponentBbox: largest?.bbox ?? null,
    allForegroundBbox: bboxRecord(allMinX, allMinY, allMaxX, allMaxY),
    touchesEdge,
    greenSpillPixels,
    greenSpillRatio: totalPixels > 0 ? greenSpillPixels / totalPixels : 0,
  };
}

export function scaleSourceBbox(sourceBbox, canvas = HUMANOID_POSTPROCESS_CANVAS) {
  invariant(sourceBbox && sourceBbox.w > 0 && sourceBbox.h > 0, 'Source bbox is required.');
  const scaleEdge = (value) => Math.round((value * canvas.scaleNumerator) / canvas.scaleDenominator);
  const left = scaleEdge(sourceBbox.x);
  const top = scaleEdge(sourceBbox.y);
  const right = scaleEdge(sourceBbox.x + sourceBbox.w);
  const bottom = scaleEdge(sourceBbox.y + sourceBbox.h);
  const bbox = { x: left, y: top, w: right - left, h: bottom - top };
  invariant(bbox.x >= 0 && bbox.y >= 0 && bbox.x + bbox.w <= canvas.outputWidth && bbox.y + bbox.h <= canvas.outputHeight, 'Scaled source bbox escapes the output canvas.');
  return bbox;
}

export function computeRegistrationTransform({ generatedBbox, targetBbox, mode }) {
  invariant(generatedBbox && targetBbox, 'Generated and target bboxes are required.');
  invariant(mode === 'vertical' || mode === 'horizontal', 'Registration mode is invalid.');
  const scale = mode === 'horizontal'
    ? targetBbox.w / generatedBbox.w
    : targetBbox.h / generatedBbox.h;
  const targetCenterX = targetBbox.x + targetBbox.w / 2;
  const generatedCenterX = generatedBbox.x + generatedBbox.w / 2;
  const translateX = mode === 'horizontal'
    ? targetBbox.x - generatedBbox.x * scale
    : targetCenterX - generatedCenterX * scale;
  const translateY = mode === 'horizontal'
    ? targetBbox.y + targetBbox.h - (generatedBbox.y + generatedBbox.h) * scale
    : targetBbox.y - generatedBbox.y * scale;
  return {
    mode,
    scale,
    translateX,
    translateY,
    primaryAxis: mode === 'horizontal' ? 'width' : 'height',
    anchor: mode === 'horizontal' ? 'source-left-and-bottom' : 'source-top-and-horizontal-center',
  };
}

export function transformedBbox(bbox, transform) {
  const left = transform.translateX + bbox.x * transform.scale;
  const top = transform.translateY + bbox.y * transform.scale;
  const right = transform.translateX + (bbox.x + bbox.w) * transform.scale;
  const bottom = transform.translateY + (bbox.y + bbox.h) * transform.scale;
  return { left, top, right, bottom };
}

export function applyUniformTransform(source, width, height, transform, fullForegroundBbox) {
  invariant(source.length === width * height * 4, 'Transform source dimensions do not match.');
  invariant(Number.isFinite(transform?.scale) && transform.scale > 0, 'Transform scale is invalid.');
  invariant(fullForegroundBbox && fullForegroundBbox.w > 0 && fullForegroundBbox.h > 0, 'Full foreground bbox is required.');
  const projected = transformedBbox(fullForegroundBbox, transform);
  invariant(projected.left >= 0 && projected.top >= 0 && projected.right <= width && projected.bottom <= height, 'Uniform registration would crop retained foreground.');
  const destination = new Uint8ClampedArray(width * height * 4);
  const minimumX = Math.max(0, Math.floor(projected.left) - 2);
  const minimumY = Math.max(0, Math.floor(projected.top) - 2);
  const maximumX = Math.min(width - 1, Math.ceil(projected.right) + 1);
  const maximumY = Math.min(height - 1, Math.ceil(projected.bottom) + 1);

  for (let y = minimumY; y <= maximumY; y += 1) {
    const sourceY = (y + 0.5 - transform.translateY) / transform.scale - 0.5;
    const y0 = Math.floor(sourceY);
    const yFraction = sourceY - y0;
    for (let x = minimumX; x <= maximumX; x += 1) {
      const sourceX = (x + 0.5 - transform.translateX) / transform.scale - 0.5;
      const x0 = Math.floor(sourceX);
      const xFraction = sourceX - x0;
      let alpha = 0;
      let redPremultiplied = 0;
      let greenPremultiplied = 0;
      let bluePremultiplied = 0;
      for (let dy = 0; dy <= 1; dy += 1) {
        const sampleY = y0 + dy;
        if (sampleY < 0 || sampleY >= height) continue;
        const yWeight = dy === 0 ? 1 - yFraction : yFraction;
        for (let dx = 0; dx <= 1; dx += 1) {
          const sampleX = x0 + dx;
          if (sampleX < 0 || sampleX >= width) continue;
          const weight = yWeight * (dx === 0 ? 1 - xFraction : xFraction);
          const sourceOffset = (sampleY * width + sampleX) * 4;
          const sampleAlpha = source[sourceOffset + 3] / 255;
          const alphaWeight = sampleAlpha * weight;
          alpha += alphaWeight;
          redPremultiplied += source[sourceOffset] * alphaWeight;
          greenPremultiplied += source[sourceOffset + 1] * alphaWeight;
          bluePremultiplied += source[sourceOffset + 2] * alphaWeight;
        }
      }
      if (alpha <= 0) continue;
      const destinationOffset = (y * width + x) * 4;
      destination[destinationOffset] = Math.round(redPremultiplied / alpha);
      destination[destinationOffset + 1] = Math.round(greenPremultiplied / alpha);
      destination[destinationOffset + 2] = Math.round(bluePremultiplied / alpha);
      destination[destinationOffset + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return destination;
}

export function compositeRgbaOnPureChroma(rgba, width, height) {
  invariant(rgba.length === width * height * 4, 'Composite source dimensions do not match.');
  const rgb = Buffer.allocUnsafe(width * height * 3);
  for (let sourceOffset = 0, destinationOffset = 0; sourceOffset < rgba.length; sourceOffset += 4, destinationOffset += 3) {
    const alpha = rgba[sourceOffset + 3];
    const inverseAlpha = 255 - alpha;
    rgb[destinationOffset] = Math.round((rgba[sourceOffset] * alpha) / 255);
    rgb[destinationOffset + 1] = Math.round(((rgba[sourceOffset + 1] * alpha) + 255 * inverseAlpha) / 255);
    rgb[destinationOffset + 2] = Math.round((rgba[sourceOffset + 2] * alpha) / 255);
  }
  return rgb;
}

export function evaluatePostprocessMetrics({ before, after, targetBbox, transform, mode, thresholds = HUMANOID_POSTPROCESS_THRESHOLDS }) {
  invariant(before?.totalPixels > 0 && after?.totalPixels > 0, 'Foreground must be nonempty.');
  const actualBbox = after.largestComponentBbox;
  const primaryActual = mode === 'horizontal' ? actualBbox.w : actualBbox.h;
  const primaryTarget = mode === 'horizontal' ? targetBbox.w : targetBbox.h;
  const secondaryActual = mode === 'horizontal' ? actualBbox.h : actualBbox.w;
  const secondaryTarget = mode === 'horizontal' ? targetBbox.h : targetBbox.w;
  const primaryAxisErrorPixels = Math.abs(primaryActual - primaryTarget);
  const secondaryDimensionDeviation = Math.abs(secondaryActual - secondaryTarget) / secondaryTarget;
  const reviewReasons = [];
  const hardFailures = [];
  const checkLow = (value, review, hard, label) => {
    if (value < hard) hardFailures.push(`${label}:${value.toFixed(6)}<${hard}`);
    else if (value < review) reviewReasons.push(`${label}:${value.toFixed(6)}<${review}`);
  };
  const checkHigh = (value, review, hard, label) => {
    if (value > hard) hardFailures.push(`${label}:${value.toFixed(6)}>${hard}`);
    else if (value > review) reviewReasons.push(`${label}:${value.toFixed(6)}>${review}`);
  };
  checkLow(before.largestComponentRatio, thresholds.largestComponentReview, thresholds.largestComponentHard, 'largest_component_ratio');
  checkHigh(after.greenSpillRatio, thresholds.greenSpillReview, thresholds.greenSpillHard, 'green_spill_ratio');
  checkHigh(secondaryDimensionDeviation, thresholds.secondaryDeviationReview, thresholds.secondaryDeviationHard, 'secondary_dimension_deviation');
  if (transform.scale < thresholds.scaleHardMin || transform.scale > thresholds.scaleHardMax) hardFailures.push(`scale:${transform.scale.toFixed(6)} outside hard range`);
  else if (transform.scale < thresholds.scaleReviewMin || transform.scale > thresholds.scaleReviewMax) reviewReasons.push(`scale:${transform.scale.toFixed(6)} outside review range`);
  if (primaryAxisErrorPixels > thresholds.primaryAxisTolerancePixels) hardFailures.push(`primary_axis_error:${primaryAxisErrorPixels}>${thresholds.primaryAxisTolerancePixels}`);
  if (before.significantSecondaryComponents > 0) reviewReasons.push(`ambiguous_disconnected_components:${before.significantSecondaryComponents}`);
  if (before.touchesEdge || after.touchesEdge) hardFailures.push('foreground_touches_canvas_edge');
  return {
    primaryAxisErrorPixels,
    secondaryDimensionDeviation,
    reviewReasons,
    hardFailures,
  };
}

export function resizeRgbaNearest(source, sourceWidth, sourceHeight, outputWidth, outputHeight) {
  invariant(source.length === sourceWidth * sourceHeight * 4, 'Thumbnail source dimensions do not match.');
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < outputHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / outputHeight));
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / outputWidth));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      const outputOffset = (y * outputWidth + x) * 4;
      output.set(source.subarray(sourceOffset, sourceOffset + 4), outputOffset);
    }
  }
  return output;
}

export function buildCheckerboardContactSheet(thumbnails, thumbnailWidth, thumbnailHeight) {
  invariant(Array.isArray(thumbnails) && thumbnails.length > 0, 'Contact-sheet thumbnails are required.');
  const width = thumbnailWidth * thumbnails.length;
  const height = thumbnailHeight;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tile = (Math.floor(x / 8) + Math.floor(y / 8)) % 2;
      const checker = tile ? 168 : 220;
      const thumbnailIndex = Math.floor(x / thumbnailWidth);
      const localX = x % thumbnailWidth;
      const sourceOffset = (y * thumbnailWidth + localX) * 4;
      const source = thumbnails[thumbnailIndex];
      invariant(source.length === thumbnailWidth * thumbnailHeight * 4, 'Contact-sheet thumbnail dimensions do not match.');
      const alpha = source[sourceOffset + 3];
      const inverseAlpha = 255 - alpha;
      const destinationOffset = (y * width + x) * 3;
      rgb[destinationOffset] = Math.round((source[sourceOffset] * alpha + checker * inverseAlpha) / 255);
      rgb[destinationOffset + 1] = Math.round((source[sourceOffset + 1] * alpha + checker * inverseAlpha) / 255);
      rgb[destinationOffset + 2] = Math.round((source[sourceOffset + 2] * alpha + checker * inverseAlpha) / 255);
    }
  }
  return { rgb, width, height };
}
