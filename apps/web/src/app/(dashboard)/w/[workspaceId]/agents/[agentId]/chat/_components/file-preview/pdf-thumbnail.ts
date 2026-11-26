"use client";

const RENDER_WIDTH = 512;
export const PDF_MAX_SIDE = 2048;
export const PDF_MAX_PIXELS = 1024 * 1024;
export const PDF_RENDER_TIMEOUT_MS = 15_000;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_RENDERS = 2;

export const pdfRenderScale = (width: number, height: number): number => {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid PDF page dimensions");
  }
  const scale = Math.min(
    RENDER_WIDTH / width,
    PDF_MAX_SIDE / height,
    Math.sqrt(PDF_MAX_PIXELS / width / height),
  );
  if (!Number.isFinite(scale) || scale <= 0)
    throw new Error("Invalid PDF scale");
  return scale;
};

const rendered = new WeakMap<Blob, Promise<RenderedPdf>>();
export interface RenderedPdf {
  image: string | null;
  pages: number;
}

let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;
const loadPdfjs = () =>
  (pdfjs ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    return lib;
  }));

let activeRenders = 0;
const waiting: (() => void)[] = [];
const acquireRender = async () => {
  if (activeRenders < MAX_CONCURRENT_RENDERS) activeRenders++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
};
const releaseRender = () => {
  const next = waiting.shift();
  if (next) next();
  else activeRenders--;
};

const render = async (blob: Blob): Promise<RenderedPdf> => {
  if (blob.size > MAX_PDF_BYTES) throw new Error("PDF too large to preview");
  await acquireRender();
  const controller = new AbortController();
  let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
  let worker: import("pdfjs-dist").PDFWorker | undefined;
  let renderTask: import("pdfjs-dist").RenderTask | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<RenderedPdf> => {
    const lib = await loadPdfjs();
    controller.signal.throwIfAborted();
    const data = new Uint8Array(await blob.arrayBuffer());
    controller.signal.throwIfAborted();
    // Own the worker so a stalled transport cannot prevent its termination.
    worker = lib.PDFWorker.create({});
    task = lib.getDocument({
      data,
      worker,
      enableXfa: false,
      useWorkerFetch: false,
      maxImageSize: 16 * 1024 * 1024,
      canvasMaxAreaInBytes: 4 * PDF_MAX_PIXELS,
    });
    const doc = await task.promise;
    controller.signal.throwIfAborted();
    const page = await doc.getPage(1);
    controller.signal.throwIfAborted();
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({
      scale: pdfRenderScale(base.width, base.height),
    });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    // maxImageSize bounds embedded images, not this output canvas.
    if (
      ![width, height].every(
        (value) => Number.isFinite(value) && value > 0 && value <= PDF_MAX_SIDE,
      ) ||
      width * height > PDF_MAX_PIXELS
    ) {
      throw new Error("PDF preview exceeds canvas limits");
    }
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    // A static PNG must complete even in a hidden tab. The documented print
    // intent avoids pdf.js's display-mode requestAnimationFrame scheduler.
    renderTask = page.render({ canvas, viewport, intent: "print" });
    await renderTask.promise;
    controller.signal.throwIfAborted();
    return { image: canvas.toDataURL("image/png"), pages: doc.numPages };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("PDF preview timed out")),
          PDF_RENDER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    renderTask?.cancel();
    // Observe async teardown failures, but do not let an unresponsive transport
    // hold a render slot forever. The explicitly owned worker terminates now.
    const cleanup = task?.destroy().catch(() => {});
    worker?.destroy();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          cleanupTimeout = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimeout);
      releaseRender();
    }
  }
};

/** Shared bounded work outlives individual tile mounts. Failures are not cached,
 * so a timeout or temporary worker failure can be retried on the next mount. */
export const renderPdfFirstPage = (blob: Blob): Promise<RenderedPdf> => {
  let job = rendered.get(blob);
  if (!job) {
    job = render(blob).catch(() => {
      rendered.delete(blob);
      return { image: null, pages: 0 };
    });
    rendered.set(blob, job);
  }
  return job;
};
