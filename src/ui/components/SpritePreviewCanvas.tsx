import { useEffect, useRef, useState } from 'react';

interface SpritePreviewCanvasProps {
  blob: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  className?: string;
}

export const SPRITE_PREVIEW_RENDER_SCALE = 2;

export function spritePreviewRenderSize(frameWidth: number, frameHeight: number): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(1, Math.round(frameWidth * SPRITE_PREVIEW_RENDER_SCALE)),
    height: Math.max(1, Math.round(frameHeight * SPRITE_PREVIEW_RENDER_SCALE)),
  };
}

export function SpritePreviewCanvas({
  blob,
  frameWidth,
  frameHeight,
  frameCount,
  className,
}: SpritePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const renderSize = spritePreviewRenderSize(frameWidth, frameHeight);

  useEffect(() => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = url;
    return () => {
      URL.revokeObjectURL(url);
      setImage(null);
    };
  }, [blob]);

  useEffect(() => {
    setFrameIndex(0);
  }, [blob, frameCount]);

  useEffect(() => {
    if (frameCount <= 1) return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frameCount);
    }, 120);
    return () => window.clearInterval(timer);
  }, [frameCount]);

  useEffect(() => {
    if (!image || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, renderSize.width, renderSize.height);

    const gridCols = Math.max(1, Math.round(image.width / frameWidth));
    const sourceCol = frameIndex % gridCols;
    const sourceRow = Math.floor(frameIndex / gridCols);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      image,
      sourceCol * frameWidth,
      sourceRow * frameHeight,
      frameWidth,
      frameHeight,
      0,
      0,
      renderSize.width,
      renderSize.height,
    );
  }, [image, frameWidth, frameHeight, frameIndex, renderSize.width, renderSize.height]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      width={renderSize.width}
      height={renderSize.height}
      role="img"
      aria-label="Gameplay-scale animation preview"
    />
  );
}
