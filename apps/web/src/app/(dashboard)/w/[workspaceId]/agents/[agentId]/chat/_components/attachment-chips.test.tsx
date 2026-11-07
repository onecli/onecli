// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta } from "@/lib/api/types";
import { AttachmentChips } from "./attachment-chips";

/**
 * Clicking any live file opens the shared in-app preview (images through
 * `<img>`, text as text, other types a plain card) with an explicit
 * Download; a save goes through `useDownloadAttachment`.
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

const image: AttachmentMeta = {
  id: "out-1",
  name: "chart.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  status: "bound",
  direction: "outbound",
  caption: "Records by object type",
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

const renderChips = (attachments: AttachmentMeta[]) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <AttachmentChips conversationId="c1" attachments={attachments} />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
};

describe("AttachmentChips: image preview", () => {
  it("clicking an image opens a larger preview with its caption, and downloads nothing", async () => {
    const user = userEvent.setup();
    renderChips([image]);

    await user.click(screen.getByRole("button", { name: "Preview chart.png" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("chart.png");
    expect(dialog).toHaveTextContent("Records by object type");
    await waitFor(() =>
      expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
        "blob:fetched",
      ),
    );
    expect(api.fetchAttachmentDownloadUrl).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(0);
  });

  it("optimistic and settled images share authenticated bytes with the preview: one fetch", async () => {
    const user = userEvent.setup();
    const { rerender } = renderChips([{ ...image, status: "pending" }]);

    const thumb = screen.getByRole("button", { name: "Preview chart.png" });
    expect(thumb).toHaveClass("motion-reduce:transition-none");
    await waitFor(() =>
      expect(thumb.querySelector("img")?.getAttribute("src")).toBe(
        "blob:fetched",
      ),
    );
    rerender(<AttachmentChips conversationId="c1" attachments={[image]} />);
    await user.click(thumb);

    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
      "blob:fetched",
    );
    expect(api.fetchAttachmentBlob).toHaveBeenCalledTimes(1);
  });

  it("both Download buttons (header icon and the one under the file) save the file", async () => {
    const user = userEvent.setup();
    renderChips([image]);

    await user.click(screen.getByRole("button", { name: "Preview chart.png" }));
    await user.click(
      await screen.findByRole("button", { name: "Download chart.png" }),
    );
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(api.fetchAttachmentDownloadUrl).toHaveBeenCalledWith("c1", "out-1");
    expect(clicks[0]!.download).toBe("chart.png");

    await user.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(clicks).toHaveLength(2));
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
  it("keeps failed and expired files inert without fetching bytes", () => {
    renderChips([
      { ...image, id: "failed", name: "failed.png", status: "failed" },
      { ...image, id: "expired", name: "expired.png", status: "expired" },
    ]);
    expect(screen.getByText("couldn't be retrieved")).toBeInTheDocument();
    expect(screen.getByText("expired")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(api.fetchAttachmentBlob).not.toHaveBeenCalled();
  });

  it("a text file's tile shows its first lines and its type badge, from one fetch shared with the preview", async () => {
    const user = userEvent.setup();
    api.fetchAttachmentBlob.mockResolvedValue(
      new Blob(["Account,ARR\nBluepine,120000"]),
    );
    renderChips([
      {
        ...image,
        id: "f3",
        name: "export.csv",
        mimeType: "text/csv",
      },
    ]);

    const tile = screen.getByRole("button", { name: "Preview export.csv" });
    await waitFor(() => expect(tile).toHaveTextContent("Bluepine,120000"));
    expect(tile).toHaveTextContent("CSV");

    await user.click(tile);
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent("Bluepine,120000"),
    );
    expect(api.fetchAttachmentBlob).toHaveBeenCalledTimes(1);
  });

  it("a type with no content view opens a plain card naming it, never an error", async () => {
    const user = userEvent.setup();
    renderChips([
      {
        ...image,
        id: "f2",
        name: "notes.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 3_581,
      },
    ]);

    await user.click(
      screen.getByRole("button", { name: "Preview notes.docx" }),
    );

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Word document · 3KB",
    );
    expect(api.fetchAttachmentBlob).not.toHaveBeenCalled();
  });
});
