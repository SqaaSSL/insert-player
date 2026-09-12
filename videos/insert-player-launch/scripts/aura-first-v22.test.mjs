import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cuts = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v22-cuts.json')));
const voice = JSON.parse(readFileSync(resolve(root, 'provenance/aura-launch-v22-cues.json')));

test('Aura is the opening, main experience and closing proposition, not one of three equals', () => {
  assert.equal(cuts.primaryGame, 'aura');
  assert.equal(cuts.chapters[0].game, 'aura');
  assert.equal(cuts.chapters.at(-1).game, 'aura');
  assert(cuts.chapters.filter(c => c.game !== 'aura').every(c => c.at >= 23.15));
  assert(cuts.auraSeconds / (cuts.auraSeconds + cuts.secondaryGameplaySeconds) > 0.75);
  assert.equal(cuts.closingCta, 'START FARMING AURA FOR FREE');
  let time = 4.65;
  for (const clip of cuts.clips) {
    assert(Math.abs(clip.at - time) < 0.001, 'No gap or overlap between gameplay clips');
    time += clip.duration;
  }
  assert(Math.abs(time - cuts.closingAt - 0.25) < 0.001);
});

test('Narration establishes Aura before optional activities without changing speech speed', () => {
  assert.equal(voice.playbackRate, 1);
  assert.equal(voice.cues[0].role, 'aura-hook');
  assert.equal(voice.cues.find(c => c.role === 'optional-fight').at, 23.15);
  assert.equal(voice.cues.find(c => c.role === 'optional-rush').at, 28.65);
  assert.equal(voice.cues.at(-2).role, 'return-to-aura');
  voice.cues.forEach((cue, i) => {
    assert(existsSync(resolve(root, voice.sources[cue.source])));
    assert(cue.range[1] > cue.range[0]);
    assert(cue.at + cue.range[1] - cue.range[0] <= (voice.cues[i + 1]?.at ?? voice.duration));
  });
  const copy = voice.captions.map(c => c.text).join(' ');
  assert.match(copy, /Start farming Aura/);
  assert.match(copy, /Want a change/);
  assert.doesNotMatch(copy, /three games|ridiculous|silly|absurd/i);
});

test('Reordering preserves the approved source footage and original music', () => {
  const hash = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  assert.equal(hash(cuts.source), cuts.sourceSha256);
  assert.equal(hash('assets/generated/launch-bed-aura-v21.wav'), '249bd37bd3e1497f2600edc51c3e51c88471f4b98a78c0362eae67557cc23fca');
  assert.equal(hash('compositions/frames/01-transform.html'), 'cee7b4a4914eb814a70e7bd716da5d118acbdac659305075ece7e4cdf6b5aa2f');
});
