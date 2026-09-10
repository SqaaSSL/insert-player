#!/usr/bin/env node
/**
 * Build the Aura track catalogue.
 *
 *   node scripts/measure-aura-tracks.mjs            # measure new/changed files, write catalogue
 *   node scripts/measure-aura-tracks.mjs --force    # re-measure everything
 *
 * Scans public/assets/audio/aura/*.mp3 (plus the legacy Neon Arena file),
 * measures tempo and first-beat offset with measure-aura-track.mjs, keeps the
 * results in public/assets/audio/aura/aura-tracks.json, and regenerates
 * src/game/aura/aura-tracks.generated.ts. Hand-confirmed offsets belong in
 * AURA_TRACK_OVERRIDES (src/game/aura/AuraTracks.ts); they always win.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { measureTrack } from './measure-aura-track.mjs';
import { serializeAuraTrackCatalog } from './aura-track-catalog-source.mjs';

const root = resolve(import.meta.dirname, '..');
const audioDir = resolve(root, 'public/assets/audio/aura');
const inboxDir = resolve(root, 'audio-src/aura-inbox');
const STAGE_IDS = ['insert-player-arena', 'executive-rumble', 'mars-incorporated', 'tablao-3000', 'la-jaula-304', 'side-street'];
const stageFor = (id) => STAGE_IDS.find((stage) => id.startsWith(stage)) ?? (id.startsWith('neon-arena') ? 'insert-player-arena' : undefined);
/** Game cut: loudness-normalised, trimmed to 120 s with a fade, 160 kbps. */
const TARGET_SECONDS = 120;
const catalogPath = resolve(audioDir, 'aura-tracks.json');
const generatedPath = resolve(root, 'src/game/aura/aura-tracks.generated.ts');
const force = process.argv.includes('--force');

const LEGACY = [{ file: resolve(root, 'public/assets/audio/neon-arena-battle-v1.mp3'), id: 'neon-arena', title: 'Neon Arena', url: '/assets/audio/neon-arena-battle-v1.mp3' }];

const slug = (name) => name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (id) => id.split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');

// Inbox: raw downloads (any format) become game cuts in the public folder.
if (existsSync(inboxDir)) {
  mkdirSync(audioDir, { recursive: true });
  for (const name of readdirSync(inboxDir).filter((entry) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(entry))) {
    const id = slug(name);
    const target = resolve(audioDir, `${id}.mp3`);
    const source = resolve(inboxDir, name);
    if (existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs && !force) continue;
    const encoded = spawnSync('ffmpeg', [
      '-v', 'error', '-y', '-i', source,
      '-t', String(TARGET_SECONDS),
      '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st=${TARGET_SECONDS - 3}:d=3`,
      '-ac', '2', '-ar', '44100', '-b:a', '160k', '-id3v2_version', '3', target,
    ]);
    if (encoded.status !== 0) {
      console.error(`ffmpeg failed for ${name}: ${encoded.stderr?.toString()}`);
      process.exit(1);
    }
    console.log(`~ encoded ${name} -> aura/${id}.mp3`);
  }
}

const existing = existsSync(catalogPath) ? JSON.parse(readFileSync(catalogPath, 'utf8')) : { tracks: [] };
const byId = new Map(existing.tracks.map((track) => [track.id, track]));

const candidates = [
  ...LEGACY.filter((entry) => existsSync(entry.file)),
  ...(existsSync(audioDir) ? readdirSync(audioDir) : [])
    .filter((name) => /\.(mp3|m4a|ogg|wav)$/i.test(name))
    .map((name) => ({ file: resolve(audioDir, name), id: slug(name), title: titleCase(slug(name)), url: `/assets/audio/aura/${name}` })),
];

const tracks = [];
for (const candidate of candidates) {
  const stats = statSync(candidate.file);
  const fingerprint = `${stats.size}:${Math.round(stats.mtimeMs)}`;
  const previous = byId.get(candidate.id);
  if (previous && previous.fingerprint === fingerprint && !force) {
    tracks.push({ ...previous, title: previous.title ?? candidate.title, url: candidate.url });
    console.log(`= ${candidate.id} (unchanged, ${previous.bpm} BPM)`);
    continue;
  }
  const measured = measureTrack(candidate.file);
  const track = {
    id: candidate.id,
    title: previous?.title ?? candidate.title,
    url: candidate.url,
    bpm: measured.bpm,
    beatOffsetMs: measured.firstBeatOffsetMs,
    durationMs: measured.durationMs,
    stageId: previous?.stageId ?? stageFor(candidate.id),
    confidence: measured.confidence,
    fingerprint,
    measuredAt: new Date().toISOString(),
  };
  tracks.push(track);
  console.log(`+ ${candidate.id}: ${track.bpm} BPM, first beat ${track.beatOffsetMs} ms, ${Math.round((track.durationMs ?? 0) / 1000)} s, confidence ${track.confidence}${track.confidence < 0.25 ? ' (UNSTEADY)' : ''}`);
}
tracks.sort((a, b) => (a.id === 'neon-arena' ? -1 : b.id === 'neon-arena' ? 1 : a.id.localeCompare(b.id)));

writeFileSync(catalogPath, `${JSON.stringify({ tracks }, null, 2)}\n`);
writeFileSync(generatedPath, serializeAuraTrackCatalog(tracks));
console.log(`wrote ${tracks.length} track(s) to ${catalogPath} and ${generatedPath}`);
