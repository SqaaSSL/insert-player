import {
  Canvas,
  Image,
  ImageData,
  createCanvas,
} from '@napi-rs/canvas';

interface RuntimeGlobal {
  document: Pick<Document, 'createElement'>;
  Image: typeof globalThis.Image;
  ImageData: typeof globalThis.ImageData;
  HTMLCanvasElement: typeof globalThis.HTMLCanvasElement;
}

let installed = false;

export function installCanvasRuntime(): void {
  if (installed) return;

  const runtime = globalThis as unknown as RuntimeGlobal;
  runtime.Image = Image as unknown as typeof globalThis.Image;
  runtime.ImageData = ImageData as unknown as typeof globalThis.ImageData;
  runtime.HTMLCanvasElement = Canvas as unknown as typeof globalThis.HTMLCanvasElement;
  runtime.document = {
    createElement(tagName: string) {
      if (tagName.toLowerCase() !== 'canvas') {
        throw new Error(`The image processor cannot create <${tagName}> elements.`);
      }
      return createCanvas(300, 150) as unknown as HTMLElement;
    },
  } as Pick<Document, 'createElement'>;

  installed = true;
}
