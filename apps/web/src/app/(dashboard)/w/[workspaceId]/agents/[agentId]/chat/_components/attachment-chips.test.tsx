// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "@/lib/api/types";
import { AttachmentChips } from "./attachment-chips";

/**
 * Clicking an image thumbnail opens an in-app preview (the bytes only ever
 * render through `<img>`) with an explicit Download; any other live file
 * saves on click. Either way a save goes through `useDownloadAttachment`.
 */

const api = vi.hoisted(() => ({
  fetchAttachmentBlob: vi.fn(),
  fetchAttachmentDownloadUrl: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, attachments: { ...actual.attachments, ...api } };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

type Chip = AttachmentMeta & { objectUrl?: string };

const image: Chip = {
  id: "out-1",
  name: "chart.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  status: "bound",
  direction: "outbound",
  caption: "Records by object type",
  objectUrl: "blob:local-preview",
};

let clicks: HTMLAnchorElement[];

beforeEach(() => {
  api.fetchAttachmentBlob.mockReset().mockResolvedValue(new Blob(["png"]));
  api.fetchAttachmentDownloadUrl.mockReset().mockResolvedValue(null);
  clicks = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this);
  });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:fetched"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderChips = (attachments: Chip[]) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AttachmentChips conversationId="c1" attachments={attachments} />
    </QueryClientProvider>,
  );

describe("AttachmentChips: image preview", () => {
  it("clicking an image opens a larger preview with its caption, and downloads nothing", async () => {
    const user = userEvent.setup();
    renderChips([image]);

    await user.click(screen.getByRole("button", { name: "Preview chart.png" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("chart.png");
    expect(dialog).toHaveTextContent("Records by object type");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      "blob:local-preview",
    );
    expect(api.fetchAttachmentDownloadUrl).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(0);
  });

  it("a settled image shares the thumbnail's fetched bytes: one fetch, never a second", async () => {
    const user = userEvent.setup();
    renderChips([{ ...image, objectUrl: undefined }]);

    const thumb = screen.getByRole("button", { name: "Preview chart.png" });
    await waitFor(() =>
      expect(thumb.querySelector("img")?.getAttribute("src")).toBe(
        "blob:fetched",
      ),
    );
    await user.click(thumb);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      "blob:fetched",
    );
    expect(api.fetchAttachmentBlob).toHaveBeenCalledTimes(1);
  });

  it("the preview's Download button saves the file", async () => {
    const user = userEvent.setup();
    renderChips([image]);

    await user.click(screen.getByRole("button", { name: "Preview chart.png" }));
    await user.click(await screen.findByRole("button", { name: "Download" }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(api.fetchAttachmentDownloadUrl).toHaveBeenCalledWith("c1", "out-1");
    expect(clicks[0]!.download).toBe("chart.png");
  });

  it("closing the preview hands focus back to the thumbnail", async () => {
    const user = userEvent.setup();
    renderChips([image]);
    const thumb = screen.getByRole("button", { name: "Preview chart.png" });

    await user.click(thumb);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(thumb).toHaveFocus();
  });
});

describe("AttachmentChips: other files", () => {
  it("a non-image file saves on click, with no preview", async () => {
    const user = userEvent.setup();
    renderChips([
      { ...image, id: "f1", name: "report.pdf", mimeType: "application/pdf" },
    ]);

    await user.click(screen.getByRole("button", { name: "Save report.pdf" }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(api.fetchAttachmentDownloadUrl).toHaveBeenCalledWith("c1", "f1");
    expect(clicks[0]!.download).toBe("report.pdf");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
