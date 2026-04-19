import { useEffect, useRef, useState } from 'react';

interface SpritePreviewCanvasProps {
  blob: Blob;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  className?: string;
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

    canvas.width = frameWidth;
    canvas.height = frameHeight;
    ctx.clearRect(0, 0, frameWidth, frameHeight);

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
      frameWidth,
      frameHeight,
    );
  }, [image, frameWidth, frameHeight, frameIndex]);

  return <canvas ref={canvasRef} className={className} />;
}
