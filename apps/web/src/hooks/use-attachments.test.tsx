// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `useDownloadAttachment`: presigned-first (the browser downloads straight
 * from the bucket, the api never touches the bytes), blob fallback when the
 * backend answers 204 (inline rows). Either way the click is an anchor with
 * `download`, never a navigation of the bytes in this origin.
 */

const api = vi.hoisted(() => ({
  fetchAttachmentDownloadUrl: vi.fn(),
  fetchAttachmentBlob: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ attachments: api }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { useDownloadAttachment } = await import("./use-attachments");

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

const meta = {
  id: "att-1",
  name: "clip.webm",
  mimeType: "video/webm",
  sizeBytes: 3,
  status: "bound",
};

let clicks: HTMLAnchorElement[];

beforeEach(() => {
  api.fetchAttachmentDownloadUrl.mockReset();
  api.fetchAttachmentBlob.mockReset();
  clicks = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(this);
  });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
});

describe("useDownloadAttachment", () => {
  it("presigned: clicks an anchor at the bucket URL and never fetches the bytes", async () => {
    api.fetchAttachmentDownloadUrl.mockResolvedValue({
      url: "https://bucket.s3.amazonaws.com/attachments/cv/att-1?X-Amz-Signature=x",
      expiresAt: "2026-09-14T00:05:00.000Z",
    });
    const { result } = renderHook(() => useDownloadAttachment("cv-1"), {
      wrapper,
    });
    act(() => result.current.mutate(meta));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.fetchAttachmentDownloadUrl).toHaveBeenCalledWith(
      "cv-1",
      "att-1",
    );
    expect(api.fetchAttachmentBlob).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.href).toBe(
      "https://bucket.s3.amazonaws.com/attachments/cv/att-1?X-Amz-Signature=x",
    );
    expect(clicks[0]!.download).toBe("clip.webm");
    expect(clicks[0]!.rel).toBe("noopener");
  });

  it("inline (204): falls back to the authenticated blob, re-typed octet-stream, saved through an object URL", async () => {
    api.fetchAttachmentDownloadUrl.mockResolvedValue(null);
    api.fetchAttachmentBlob.mockResolvedValue(
      new Blob(["svg-ish"], { type: "image/svg+xml" }),
    );
    const { result } = renderHook(() => useDownloadAttachment("cv-1"), {
      wrapper,
    });
    act(() => result.current.mutate(meta));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.fetchAttachmentBlob).toHaveBeenCalledWith("cv-1", "att-1");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.href).toBe("blob:fake");
    expect(clicks[0]!.download).toBe("clip.webm");
    const created = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Blob;
    expect(created.type).toBe("application/octet-stream");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("a refusal on the URL step surfaces as the mutation's error (no anchor, no bytes)", async () => {
    api.fetchAttachmentDownloadUrl.mockRejectedValue(
      new Error("This file expired after 30 days."),
    );
    const { result } = renderHook(() => useDownloadAttachment("cv-1"), {
      wrapper,
    });
    act(() => result.current.mutate(meta));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(clicks).toHaveLength(0);
    expect(api.fetchAttachmentBlob).not.toHaveBeenCalled();
  });
});
