// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePreviewDialog } from "./file-preview-dialog";
import { FileTileFace } from "./file-tile-face";

vi.mock("./pdf-thumbnail", () => ({ renderPdfFirstPage: vi.fn() }));
afterEach(cleanup);

const mount = (
  loadBlob: (signal?: AbortSignal) => Promise<Blob>,
  mimeType = "image/png",
) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <FilePreviewDialog
        previewKey="workspace/agent/attachment"
        name="file"
        mimeType={mimeType}
        sizeBytes={4}
        loadBlob={loadBlob}
      >
        <button>Open</button>
      </FilePreviewDialog>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Open"));
  return view;
};

describe("preview lifecycle", () => {
  it("cancels a pending read on close and creates no late object URL", async () => {
    let resolve: (blob: Blob) => void = () => {};
    let signal: AbortSignal | undefined;
    const create = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }),
    );
    const load = vi.fn((next?: AbortSignal) => {
      signal = next;
      return new Promise<Blob>((done) => {
        resolve = done;
      });
    });
    mount(load);
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => {
      resolve(new Blob(["late"]));
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("revokes each image URL on close and unmount", async () => {
    const create = vi
      .fn()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }),
    );
    const load = vi.fn(async () => new Blob(["image"]));
    const view = mount(load);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByLabelText("Close"));
    expect(revoke).toHaveBeenCalledWith("blob:first");
    fireEvent.click(screen.getByText("Open"));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledOnce();
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:second");
  });

  it("shows an explicit failure when reading text rejects", async () => {
    const file = new Blob(["text"]);
    vi.spyOn(file, "slice").mockReturnValue(
      Object.assign(new Blob(), {
        text: async () => {
          throw new Error("read failed");
        },
      }),
    );
    mount(async () => file, "text/plain");
    expect(await screen.findByText("Preview unavailable.")).toBeTruthy();
  });

  it("does not show stale snippets or accept cancelled text results", async () => {
    let finish: (value: string) => void = () => {};
    const old = new Blob(["old"]);
    vi.spyOn(old, "slice").mockReturnValue(
      Object.assign(new Blob(), {
        text: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      }),
    );
    const fresh = new Blob(["fresh"]);
    vi.spyOn(fresh, "slice").mockReturnValue(
      Object.assign(new Blob(), { text: async () => "fresh text" }),
    );
    const view = render(<FileTileFace name="old.txt" kind="text" blob={old} />);
    view.rerender(<FileTileFace name="new.txt" kind="text" blob={fresh} />);
    expect(await screen.findByText("fresh text")).toBeTruthy();
    await act(async () => {
      finish("old text");
    });
    expect(screen.queryByText("old text")).toBeNull();
    view.rerender(<FileTileFace name="missing.txt" kind="text" />);
    expect(screen.queryByText("fresh text")).toBeNull();
  });
});
