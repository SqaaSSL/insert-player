import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const music = process.argv[2];
if (!music) throw new Error('Pass the private, original Neon Arena.mp3 file.');
const sha256 = value => createHash('sha256').update(value).digest('hex');
if (sha256(readFileSync(music)) !== '0a0ae79a32b00c3b68099a83d09b9044f9debede8130370ce8ce185d51c78b05') throw new Error('Unexpected music source.');
const bed = resolve(root, 'assets/generated/launch-bed-aura-v19.wav');
const voice = resolve(root, 'assets/generated/launch-voice-aura-v19.wav');
if (existsSync(bed) || existsSync(voice)) throw new Error('Version already exists; do not overwrite approved media.');
const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', ...args], { stdio: 'inherit' });
ffmpeg(['-i', resolve(root, 'assets/generated/launch-bed-original-neon-v11.wav'), '-i', music,
  '-filter_complex', '[0:a]atrim=0:4.65,asetpts=PTS-STARTPTS,afade=t=out:st=4.61:d=0.04[intro];[1:a]atrim=0:31.5,asetpts=PTS-STARTPTS,volume=-4.1dB,afade=t=in:d=0.04,afade=t=out:st=31.2:d=0.3[neon];[intro][neon]concat=n=2:v=0:a=1[out]',
  '-map', '[out]', '-ar', '48000', '-ac', '2', bed]);
ffmpeg(['-i', resolve(root, 'assets/generated/tts-launch-friends-v4.wav'),
  '-filter_complex', '[0:a]asplit=3[a][b][c];[a]atrim=0:5.6,asetpts=PTS-STARTPTS[intro];[b]atrim=6.02:9.58,asetpts=PTS-STARTPTS,adelay=9450:all=1[body];[c]atrim=start=9.58,asetpts=PTS-STARTPTS,adelay=30950:all=1[end];[intro][body][end]amix=inputs=3:normalize=0,apad=whole_dur=36.15,atrim=end=36.15[out]',
  '-map', '[out]', '-ar', '48000', '-ac', '2', voice]);
writeFileSync(resolve(root, 'provenance/aura-launch-v19-audio.json'), JSON.stringify({
  duration: 36.15, originalMusicSourceSha256: sha256(readFileSync(music)), musicSourceRange: [0, 31.5],
  musicStartsAt: 4.65, loops: 0, newGenerations: 0, voice: 'Approved Orus v4, only timing changed',
  bedSha256: sha256(readFileSync(bed)), voiceSha256: sha256(readFileSync(voice)),
}, null, 2));
