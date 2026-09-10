/** Content revisions of the public challenge catalogue. Changing asset bytes
 * requires updating this manifest; existing links then fail compatibility checks.
 * These are public installed assets, never generated user media. */
export const AURA_CHALLENGE_ASSETS: Readonly<Record<string, { url: string; sha256: string }>> = {
  'stage:aura-plaza-v3': { url: '/assets/stages/aura/aura-plaza-v3.webp', sha256: 'c51a6b3f13840b4973979cb11d68d9cc0976b075b0e8e44fc939ba44a188139e' },
  'stage:aura-plaza-v2': { url: '/assets/stages/aura/aura-plaza-v2.webp', sha256: '365e72a1ea1808a08f06ea5d2de2e2afc8536620356355ee4f2fe08fc98b4fbb' },
  'stage:aura-plaza': { url: '/assets/stages/aura/aura-plaza-v1.webp', sha256: 'ad789a08901cdad0c068f22559acdecf7f9fb31378413761b0090f07f9b8ceda' },
  'track:neon-arena': { url: '/assets/audio/neon-arena-battle-v1.mp3', sha256: '297908bc9ff3e46d65e0fea7a90e2eb44d2b80e9fe4b974c1b1a9c499d434c00' },
  'track:neon-arena-155': { url: '/assets/audio/aura/neon-arena-155.mp3', sha256: '225cb1eb1287aa148e05a3c3ee3cb4e27f94c616cc7f02ceef504257eb63fd79' },
  'stage:insert-player-arena': { url: '/assets/stages/signature/insert-player-arena-pipeline-v1.png', sha256: 'fc014c0b3fee22ae18c70f683058b8861249090f2974e83c8321f95b7fa07df6' },
  'stage:executive-rumble': { url: '/assets/stages/signature/executive-rumble-pipeline-v1.png', sha256: 'a93c60e3af03bd8625ed6b1d067321b7dd89e2e9795943400bdcaa3b52c1a310' },
  'stage:mars-incorporated': { url: '/assets/stages/signature/mars-incorporated-pipeline-v1.png', sha256: 'a06e3b6b832d58b62f5ffe2a9d142bb3c5931963303d002e788207b7e239cd6b' },
  'stage:tablao-3000': { url: '/assets/stages/signature/tablao-3000-pipeline-v1.png', sha256: 'c6e857bfb6bc9fbf3d67aceb59a2738d1ec5372c0e1808e7e12454b369a1e844' },
  'stage:la-jaula-304': { url: '/assets/rush/la-jaula-304/la-jaula-304-fight-v2.webp', sha256: '61381a71d933e0157b988ee98ebea62b4c05f5a8804f33be59cfb298f75de3ce' },
  'stage:side-street': { url: '/assets/rush/side-street/side-street-fight-v1.webp', sha256: 'e0ed7141e09aa61b38325f2e4ebe81883703054763f39eabc70cc6e1ed52e91c' },
};
