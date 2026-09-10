#!/usr/bin/env node
/**
 * Measure a music track's tempo and first-beat offset for Aura charts.
 *
 *   node scripts/measure-aura-track.mjs public/assets/audio/neon-arena-battle-v1.mp3
 *   node scripts/measure-aura-track.mjs track.mp3 --seconds 60 --min-bpm 120 --max-bpm 180 --json
 *
 * Decodes the first N seconds with the local `ffmpeg` binary, builds a
 * spectral-flux onset envelope, picks the tempo whose beat period (and its
 * 2x/4x multiples) best autocorrelates, then finds the beat phase from the
 * kick band. Tempo is reliable to about 0.05 BPM. The offset is a starting
 * point (about ±40 ms on busy mixes): confirm it by ear with the in-game
 * timing meter before locking a track into the Aura catalogue.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { pathToFileURL } from 'node:url';

/** Sum of the onset envelope sampled on a beat grid (tempo, phase). */
function combSum(envelope, period, phase) {
  let sum = 0;
  let count = 0;
  for (let position = phase; position < envelope.flux.length - 1; position += period) {
    const i = Math.floor(position);
    const fraction = position - i;
    sum += envelope.flux[i] * (1 - fraction) + envelope.flux[i + 1] * fraction;
    count += 1;
  }
  return count ? sum / count : 0;
}

/** Search tempo within ±span BPM (step) and phase within one beat for the comb maximum.
 * Returns bpm, phaseMs, and a 0..1 confidence (peak over mean comb response). */
function combLock(envelope, centreBpm, span, step) {
  let best = { score: -Infinity, bpm: centreBpm, phaseMs: 0 };
  let total = 0;
  let samples = 0;
  for (let bpm = centreBpm - span; bpm <= centreBpm + span; bpm += step) {
    const period = 60 / bpm * envelope.fps;
    const phaseStep = Math.max(1, envelope.fps * 0.002);
    for (let phase = 0; phase < period; phase += phaseStep) {
      const score = combSum(envelope, period, phase);
      total += score;
      samples += 1;
      if (score > best.score) best = { score, bpm, phaseMs: phase / envelope.fps * 1000 };
    }
  }
  const mean = samples ? total / samples : 0;
  const confidence = mean > 0 ? Math.min(1, Math.max(0, (best.score / mean - 1) / 4)) : 0;
  return { bpm: Number(best.bpm.toFixed(3)), phaseMs: best.phaseMs, confidence };
}

/** Local maxima of an onset envelope above its 99th percentile, at least 150 ms apart. */
function pickPeaks(flux, fps) {
  const sorted = Float64Array.from(flux).sort();
  const threshold = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  const minGap = Math.round(fps * 0.15);
  const peaks = [];
  for (let i = 1; i < flux.length - 1; i += 1) {
    if (flux[i] > threshold && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) {
      peaks.push(i / fps * 1000);
      i += minGap;
    }
  }
  return peaks;
}

/** Measure one audio file. Returns { bpm, beatMs, firstBeatOffsetMs, fullBandOffsetMs, durationMs }. */
export function measureTrack(path, { seconds = 120, minBpm = 120, maxBpm = 180 } = {}) {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  const SAMPLE_RATE = 22050;
  const decoded = spawnSync('ffmpeg', [
    '-v', 'error', '-i', path, '-t', String(seconds), '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
  ], { maxBuffer: 1 << 30 });
  if (decoded.status !== 0) {
    throw new Error(decoded.stderr?.toString() || 'ffmpeg failed (is ffmpeg installed?)');
  }
  const samples = new Float32Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength / 4);

  // ---- in-place radix-2 FFT ----------------------------------------------------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
      const wRe = Math.cos(angle);
      const wIm = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let cRe = 1;
        let cIm = 0;
        for (let k = 0; k < len / 2; k += 1) {
          const aRe = re[i + k];
          const aIm = im[i + k];
          const bRe = re[i + k + len / 2] * cRe - im[i + k + len / 2] * cIm;
          const bIm = re[i + k + len / 2] * cIm + im[i + k + len / 2] * cRe;
          re[i + k] = aRe + bRe;
          im[i + k] = aIm + bIm;
          re[i + k + len / 2] = aRe - bRe;
          im[i + k + len / 2] = aIm - bIm;
          const nRe = cRe * wRe - cIm * wIm;
          cIm = cRe * wIm + cIm * wRe;
          cRe = nRe;
        }
      }
    }
  }

  // ---- onset envelopes -----------------------------------------------------------
  function onsetEnvelope(hop, win, lowHz, highHz) {
    const frames = Math.floor((samples.length - win) / hop);
    const window = Float32Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1)));
    const binLow = Math.max(1, Math.floor(lowHz * win / SAMPLE_RATE));
    const binHigh = Math.min(win / 2, Math.ceil(highHz * win / SAMPLE_RATE));
    const re = new Float64Array(win);
    const im = new Float64Array(win);
    let previous = null;
    const flux = new Float64Array(Math.max(0, frames - 1));
    for (let frame = 0; frame < frames; frame += 1) {
      const offset = frame * hop;
      for (let i = 0; i < win; i += 1) {
        re[i] = samples[offset + i] * window[i];
        im[i] = 0;
      }
      fft(re, im);
      const magnitude = new Float64Array(binHigh - binLow);
      for (let bin = binLow; bin < binHigh; bin += 1) {
        magnitude[bin - binLow] = Math.log1p(10 * Math.hypot(re[bin], im[bin]));
      }
      if (previous) {
        let sum = 0;
        for (let i = 0; i < magnitude.length; i += 1) sum += Math.max(0, magnitude[i] - previous[i]);
        flux[frame - 1] = sum;
      }
      previous = magnitude;
    }
    // Remove the slow trend so sustained sounds do not count as onsets.
    const smooth = 32;
    const out = new Float64Array(flux.length);
    let acc = 0;
    for (let i = 0; i < flux.length; i += 1) {
      acc += flux[i] - (i >= smooth ? flux[i - smooth] : 0);
      out[i] = Math.max(0, flux[i] - acc / Math.min(smooth, i + 1));
    }
    // A transient registers when the window reaches it, so phases sit one window early.
    return { flux: out, fps: SAMPLE_RATE / hop, latencyMs: win / SAMPLE_RATE * 1000 };
  }

  const full = onsetEnvelope(256, 1024, 30, 8000);
  const kick = onsetEnvelope(128, 2048, 30, 130);

  // ---- tempo by autocorrelation with harmonic support ---------------------------
  function autocorrelation(signal, maxLag) {
    const out = new Float64Array(maxLag + 2);
    for (let lag = 0; lag <= maxLag + 1; lag += 1) {
      let sum = 0;
      for (let i = lag; i < signal.length; i += 1) sum += signal[i] * signal[i - lag];
      out[lag] = sum;
    }
    return out;
  }
  const maxLag = Math.ceil(60 / minBpm * full.fps * 4) + 2;
  const ac = autocorrelation(full.flux, maxLag);
  const at = (lag) => {
    const i = Math.floor(lag);
    const fraction = lag - i;
    return ac[i] * (1 - fraction) + ac[i + 1] * fraction;
  };
  let bestBpm = minBpm;
  let bestScore = -Infinity;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.01) {
    const lag = 60 / bpm * full.fps;
    const score = at(lag) + 0.5 * at(lag * 2) + 0.5 * at(lag * 4);
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  // ---- refine: the autocorrelation grid is coarse (about 0.4 BPM here), and
  // that error compounds to >100 ms across a chart. Lock the tempo with a
  // two-dimensional comb (tempo x phase) over the kick onset envelope: the
  // comb sum over ~230 beats has a sharp peak only at the true period.
  const refined = combLock(kick, bestBpm, 1.5, 0.005);
  bestBpm = refined.bpm;
  const beatMs = 60_000 / bestBpm;

  // ---- beat phase from the kick band ---------------------------------------------
  function phaseFor(envelope) {
    const period = 60 / bestBpm * envelope.fps;
    let bestPhase = 0;
    let best = -Infinity;
    for (let phase = 0; phase < period; phase += 0.25) {
      let sum = 0;
      for (let position = phase; position < envelope.flux.length - 1; position += period) {
        const i = Math.floor(position);
        const fraction = position - i;
        sum += envelope.flux[i] * (1 - fraction) + envelope.flux[i + 1] * fraction;
      }
      if (sum > best) {
        best = sum;
        bestPhase = phase;
      }
    }
    return bestPhase / envelope.fps * 1000;
  }
  const kickOffsetMs = (refined.phaseMs + kick.latencyMs) % beatMs;
  const fullOffsetMs = (phaseFor(full) + full.latencyMs) % beatMs;
  const confidence = Number(refined.confidence.toFixed(2));


  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
  const durationSeconds = probe.status === 0 ? Number(probe.stdout.toString().trim()) : NaN;

  return {
    bpm: Number(bestBpm.toFixed(3)),
    beatMs: Number(beatMs.toFixed(3)),
    firstBeatOffsetMs: Math.round(kickOffsetMs),
    fullBandOffsetMs: Math.round(fullOffsetMs),
    /** 0..1 sharpness of the tempo lock (comb peak over mean); below 0.25 the track is not steady. */
    confidence,
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : undefined,
  };
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const file = args.find((value) => !value.startsWith('--'));
  if (!file) {
    console.error('usage: measure-aura-track.mjs <audio file> [--seconds 60] [--min-bpm 120] [--max-bpm 180] [--json]');
    process.exit(2);
  }
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
  };
  const path = resolve(file);
  const measured = measureTrack(path, {
    seconds: option('seconds', 120),
    minBpm: option('min-bpm', 120),
    maxBpm: option('max-bpm', 180),
  });
  const result = { file: path, ...measured, note: 'bpm is reliable; confirm firstBeatOffsetMs by ear with the in-game timing meter' };
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`track: ${path}`);
    console.log(`bpm: ${result.bpm}  (beat ${result.beatMs} ms)`);
    console.log(`first beat offset: ${result.firstBeatOffsetMs} ms from kick band (${result.fullBandOffsetMs} ms full band)`);
    console.log(`grid confidence: ${result.confidence} (${result.confidence >= 0.25 ? 'steady' : 'UNSTEADY: regenerate or check by ear'})`);
    console.log(result.note);
  }
}
