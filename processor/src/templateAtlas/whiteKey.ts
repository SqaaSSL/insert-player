import assert from 'node:assert/strict';

type Pixels = Uint8Array | Uint8ClampedArray;
export const WHITE_KEY_POLICY = Object.freeze({
  method: 'local-white-key-v1', connectivity: 4, minimumChannel: 225,
  maximumChroma: 18, fullyTransparentMinimum: 245,
  rgbEdited: false, interiorWhitesPreserved: true, bodyFit: false,
});
export const WHITE_HOLE_POLICY = Object.freeze({
  method: 'local-template-assisted-white-key-v2', minimumAreaFraction: .0001,
  minimumStrongWhiteFraction: .90, minimumPriorBackgroundAgreement: .80,
  minimumPriorClosedHoleAgreement: .80, minimumSilhouetteIou: .70,
  priorBackgroundAlphaMax: 16, wholeComponentClassification: true,
  rgbEdited: false, bodyFit: false,
});
/** Byte-for-byte algorithm port of the frozen white-key-v1 experiment. */
export function whiteKey(pixels: Pixels, width: number, height: number) {
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0);
  assert.equal(pixels.length, width * height * 4);
  const n = width * height, candidates = new Uint8Array(n), exterior = new Uint8Array(n), queue = new Uint32Array(n);
  let head = 0, tail = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4, min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]), max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
    candidates[p] = Number(min >= WHITE_KEY_POLICY.minimumChannel && max - min <= WHITE_KEY_POLICY.maximumChroma);
  }
  const seed = (p: number) => { if (candidates[p] && !exterior[p]) { exterior[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width;
    if (x) seed(p - 1); if (x + 1 < width) seed(p + 1);
    if (p >= width) seed(p - width); if (p + width < n) seed(p + width);
  }
  const out = new Uint8Array(pixels), mask = new Uint8Array(n);
  let removed = 0, softened = 0, interiorWhites = 0, rgbChanges = 0, interiorChanges = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (exterior[p]) {
      const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      const t = Math.max(0, Math.min(1, (WHITE_KEY_POLICY.fullyTransparentMinimum - min) / (WHITE_KEY_POLICY.fullyTransparentMinimum - WHITE_KEY_POLICY.minimumChannel)));
      out[i + 3] = Math.round(pixels[i + 3] * t * t * (3 - 2 * t));
      if (out[i + 3] === 0) removed++; else if (out[i + 3] < pixels[i + 3]) softened++;
    } else {
      if (candidates[p]) interiorWhites++;
      if (out[i + 3] !== pixels[i + 3]) interiorChanges++;
    }
    mask[p] = out[i + 3];
    for (let c = 0; c < 3; c++) if (out[i + c] !== pixels[i + c]) rgbChanges++;
  }
  assert.equal(rgbChanges, 0); assert.equal(interiorChanges, 0);
  return { pixels: out, mask, metrics: { connectedExteriorPixels: tail, removedPixels: removed, softenedPixels: softened,
    preservedEnclosedWhitePixels: interiorWhites, rgbChannelChanges: rgbChanges, nonExteriorAlphaChanges: interiorChanges } };
}

export function closedTemplateBackground(prior: Pixels, width: number, height: number): Uint8Array {
  assert.equal(prior.length, width * height);
  const n = prior.length, exterior = new Uint8Array(n), queue = new Uint32Array(n);
  let head = 0, tail = 0;
  const seed = (p: number) => { if (prior[p] <= 16 && !exterior[p]) { exterior[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width;
    if (x) seed(p - 1); if (x + 1 < width) seed(p + 1);
    if (p >= width) seed(p - width); if (p + width < n) seed(p + width);
  }
  const closed = new Uint8Array(n);
  for (let p = 0; p < n; p++) closed[p] = Number(prior[p] <= 16 && !exterior[p]);
  return closed;
}

export function priorAgreement(v1: Pixels, priorAlpha: Pixels) {
  assert.equal(v1.length, priorAlpha.length * 4);
  let intersection = 0, union = 0, priorForeground = 0, currentForeground = 0;
  for (let p = 0; p < priorAlpha.length; p++) {
    const a = priorAlpha[p] >= 128, b = v1[p * 4 + 3] >= 128;
    if (a) priorForeground++; if (b) currentForeground++; if (a && b) intersection++; if (a || b) union++;
  }
  return { iou: union ? intersection / union : 0, priorForeground, currentForeground };
}

export function enclosedComponents(raw: Pixels, priorAlpha: Pixels, width: number, height: number) {
  const n = width * height;
  assert.equal(raw.length, n * 4); assert.equal(priorAlpha.length, n);
  const candidate = new Uint8Array(n), visited = new Uint8Array(n), queue = new Uint32Array(n);
  const components: Array<{ indices: Uint32Array; area: number; bbox: { left: number; top: number; right: number; bottom: number };
    priorBackgroundAgreement: number; priorClosedHoleAgreement: number; strongWhiteFraction: number }> = [];
  const closedPrior = closedTemplateBackground(priorAlpha, width, height);
  for (let p = 0; p < n; p++) {
    const i = p * 4, min = Math.min(raw[i], raw[i + 1], raw[i + 2]), max = Math.max(raw[i], raw[i + 1], raw[i + 2]);
    candidate[p] = Number(min >= WHITE_KEY_POLICY.minimumChannel && max - min <= WHITE_KEY_POLICY.maximumChroma);
  }
  for (let start = 0; start < n; start++) {
    if (!candidate[start] || visited[start]) continue;
    let head = 0, tail = 0, left = width, top = height, right = -1, bottom = -1;
    let exterior = false, background = 0, strongWhite = 0, closedBackground = 0;
    const seed = (p: number) => { if (candidate[p] && !visited[p]) { visited[p] = 1; queue[tail++] = p; } };
    seed(start);
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width), i = p * 4;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) exterior = true;
      if (priorAlpha[p] <= 16) background++; if (closedPrior[p]) closedBackground++;
      if (Math.min(raw[i], raw[i + 1], raw[i + 2]) >= 245) strongWhite++;
      if (x) seed(p - 1); if (x + 1 < width) seed(p + 1);
      if (p >= width) seed(p - width); if (p + width < n) seed(p + width);
    }
    if (!exterior) components.push({ indices: new Uint32Array(queue.subarray(0, tail)), area: tail,
      bbox: { left, top, right, bottom }, priorBackgroundAgreement: background / tail,
      priorClosedHoleAgreement: closedBackground / tail, strongWhiteFraction: strongWhite / tail });
  }
  return components;
}

/** Identical v2 thresholds: retain ambiguous white clothing; never repaint RGB. */
export function refineWhite(raw: Pixels, v1: Pixels, priorAlpha: Pixels, width: number, height: number) {
  assert(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0);
  assert.equal(raw.length, width * height * 4); assert.equal(v1.length, raw.length); assert.equal(priorAlpha.length, width * height);
  const out = new Uint8Array(v1), silhouette = priorAgreement(v1, priorAlpha);
  const components = enclosedComponents(raw, priorAlpha, width, height), acceptedMask = new Uint8Array(width * height);
  const minimumArea = Math.ceil(width * height * WHITE_HOLE_POLICY.minimumAreaFraction);
  const decisions = components.map(component => {
    const reasons: string[] = [];
    if (silhouette.iou < WHITE_HOLE_POLICY.minimumSilhouetteIou) reasons.push('mismatched_prior_silhouette');
    if (component.area < minimumArea) reasons.push('too_small');
    if (component.strongWhiteFraction < WHITE_HOLE_POLICY.minimumStrongWhiteFraction) reasons.push('not_uniformly_white_enough');
    if (component.priorBackgroundAgreement < WHITE_HOLE_POLICY.minimumPriorBackgroundAgreement) reasons.push('prior_background_ambiguous');
    if (component.priorClosedHoleAgreement < WHITE_HOLE_POLICY.minimumPriorClosedHoleAgreement) reasons.push('not_closed_template_hole');
    const accepted = reasons.length === 0;
    let changedPixels = 0;
    if (accepted) for (const p of component.indices) {
      const i = p * 4, min = Math.min(raw[i], raw[i + 1], raw[i + 2]);
      const t = Math.max(0, Math.min(1, (WHITE_KEY_POLICY.fullyTransparentMinimum - min) / (WHITE_KEY_POLICY.fullyTransparentMinimum - WHITE_KEY_POLICY.minimumChannel)));
      acceptedMask[p] = 1;
      const alpha = Math.min(v1[i + 3], Math.round(raw[i + 3] * t * t * (3 - 2 * t)));
      if (alpha !== v1[i + 3]) changedPixels++;
      out[i + 3] = alpha;
    }
    const { indices: _indices, ...description } = component;
    return { ...description, status: accepted ? 'classified_template_background' : 'retained_ambiguous', reasons, changedPixels };
  });
  let rgbChanges = 0, alphaIncreases = 0, changedOutsideClassifiedComponents = 0, changedAlphaPixels = 0;
  for (let p = 0; p < acceptedMask.length; p++) {
    const i = p * 4;
    for (let c = 0; c < 3; c++) if (out[i + c] !== raw[i + c]) rgbChanges++;
    if (out[i + 3] > v1[i + 3]) alphaIncreases++;
    if (out[i + 3] !== v1[i + 3]) { changedAlphaPixels++; if (!acceptedMask[p]) changedOutsideClassifiedComponents++; }
  }
  assert.equal(rgbChanges, 0); assert.equal(alphaIncreases, 0); assert.equal(changedOutsideClassifiedComponents, 0);
  return { pixels: out, acceptedMask, metrics: { silhouette, minimumArea, components: decisions,
    acceptedComponents: decisions.filter(component => component.status === 'classified_template_background').length,
    changedAlphaPixels, rgbChannelChanges: rgbChanges, alphaIncreases, changedOutsideClassifiedComponents,
    failClosed: silhouette.iou < WHITE_HOLE_POLICY.minimumSilhouetteIou } };
}
