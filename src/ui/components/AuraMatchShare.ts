import type { AuraVideoRecording } from '../../game/aura/AuraVideoRecorder.ts';

function filenamePart(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'player';
}

export function auraVideoFile(video: AuraVideoRecording, p1: string, p2: string): File {
  const mimeType = video.mimeType.split(';', 1)[0].trim().toLowerCase();
  if (mimeType !== 'video/mp4' && mimeType !== 'video/webm') throw new Error('Unknown video format');
  const extension = mimeType === 'video/mp4' ? 'mp4' : 'webm';
  return new File([video.blob], `Insert-Player-${filenamePart(p1)}-vs-${filenamePart(p2)}.${extension}`, { type: mimeType });
}

export function canShareAuraVideo(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [file] });
  } catch { return false; }
}

export function downloadAuraVideo(file: File): void {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = file.name;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    // Keep alive until the browser has consumed the click (including Safari).
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
