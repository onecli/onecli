// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PDF_MAX_PIXELS,
  PDF_MAX_SIDE,
  PDF_RENDER_TIMEOUT_MS,
  pdfRenderScale,
  renderPdfFirstPage,
} from "./pdf-thumbnail";

const pdf = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(),
  destroyWorker: vi.fn(),
  cancel: vi.fn(),
  render: vi.fn(),
  width: 612,
  height: 792,
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: pdf.getDocument,
  PDFWorker: { create: () => ({ destroy: pdf.destroyWorker }) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  pdf.width = 612;
  pdf.height = 792;
  pdf.destroy.mockResolvedValue(undefined);
  pdf.render.mockReturnValue({
    promise: Promise.resolve(),
    cancel: pdf.cancel,
  });
  pdf.getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: pdf.width * scale,
          height: pdf.height * scale,
        }),
        render: pdf.render,
      }),
    }),
    destroy: pdf.destroy,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,ok",
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const blob = () => {
  const value = new Blob(["pdf"]);
  value.arrayBuffer = async () => new ArrayBuffer(3);
  return value;
};

describe("PDF canvas limits", () => {
  it.each([
    [1, 1e12],
    [1e12, 1],
    [612, 792],
    [1e100, 1e100],
  ])("bounds %s x %s pages", async (width, height) => {
    pdf.width = width;
    pdf.height = height;
    const result = await renderPdfFirstPage(blob());
    expect(result.image).not.toBeNull();
    const canvas = pdf.render.mock.calls[0]?.[0].canvas;
    // The canvas backing store is explicitly freed after encoding.
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    const scale = pdfRenderScale(width, height);
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    expect(w).toBeLessThanOrEqual(PDF_MAX_SIDE);
    expect(h).toBeLessThanOrEqual(PDF_MAX_SIDE);
    expect(w * h).toBeLessThanOrEqual(PDF_MAX_PIXELS);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects invalid dimensions %s before allocation",
    async (width) => {
      pdf.width = width;
      expect(await renderPdfFirstPage(blob())).toEqual({
        image: null,
        pages: 0,
      });
      expect(pdf.render).not.toHaveBeenCalled();
      expect(pdf.destroy).toHaveBeenCalledOnce();
    },
  );

  it("awaits cleanup on render rejection and caches only one job per blob", async () => {
    pdf.render.mockReturnValue({
      promise: Promise.reject(new Error("bad page")),
      cancel: pdf.cancel,
    });
    const file = blob();
    const first = renderPdfFirstPage(file);
    expect(renderPdfFirstPage(file)).toBe(first);
    expect(await first).toEqual({ image: null, pages: 0 });
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it("renders static thumbnails without animation-frame scheduling", async () => {
    vi.useFakeTimers();
    await renderPdfFirstPage(blob());
    expect(pdf.render).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "print" }),
    );
    expect(pdf.destroyWorker).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows only two active renders and starts the next after cleanup", async () => {
    const finish: (() => void)[] = [];
    pdf.render.mockImplementation(() => ({
      promise: new Promise<void>((resolve) => finish.push(resolve)),
      cancel: pdf.cancel,
    }));
    const jobs = [
      renderPdfFirstPage(blob()),
      renderPdfFirstPage(blob()),
      renderPdfFirstPage(blob()),
    ];
    await vi.waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(2));
    expect(pdf.getDocument).toHaveBeenCalledTimes(2);
    finish[0]?.();
    await vi.waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(3));
    finish[1]?.();
    finish[2]?.();
    await Promise.all(jobs);
    expect(pdf.destroyWorker).toHaveBeenCalledTimes(3);
  });

  it("times out a stalled render, terminates its worker and permits a retry", async () => {
    vi.useFakeTimers();
    pdf.render.mockReturnValueOnce({
      promise: new Promise<void>(() => {}),
      cancel: pdf.cancel,
    });
    const file = blob();
    const job = renderPdfFirstPage(file);
    await vi.advanceTimersByTimeAsync(0);
    expect(pdf.render).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PDF_RENDER_TIMEOUT_MS);
    expect(await job).toEqual({ image: null, pages: 0 });
    expect(pdf.cancel).toHaveBeenCalledOnce();
    expect(pdf.destroyWorker).toHaveBeenCalledOnce();
    expect((await renderPdfFirstPage(file)).image).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled document load and asynchronous cleanup, then releases the queue", async () => {
    vi.useFakeTimers();
    pdf.getDocument.mockReturnValue({
      promise: new Promise(() => {}),
      destroy: pdf.destroy,
    });
    pdf.destroy.mockReturnValue(new Promise(() => {}));
    const jobs = [
      renderPdfFirstPage(blob()),
      renderPdfFirstPage(blob()),
      renderPdfFirstPage(blob()),
    ];
    await vi.advanceTimersByTimeAsync(0);
    expect(pdf.getDocument).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PDF_RENDER_TIMEOUT_MS + 1000);
    expect(pdf.destroyWorker).toHaveBeenCalledTimes(2);
    expect(pdf.getDocument).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(PDF_RENDER_TIMEOUT_MS + 1000);
    expect(await Promise.all(jobs)).toEqual(
      Array.from({ length: 3 }, () => ({ image: null, pages: 0 })),
    );
    expect(pdf.destroyWorker).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects oversized input before reading its bytes", async () => {
    const file = blob();
    Object.defineProperty(file, "size", { value: 33 * 1024 * 1024 });
    expect(await renderPdfFirstPage(file)).toEqual({ image: null, pages: 0 });
    expect(pdf.getDocument).not.toHaveBeenCalled();
  });
});
