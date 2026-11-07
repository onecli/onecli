// @vitest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/api/keys";

/**
 * `useDownloadAttachment`: presigned-first (the browser downloads straight
 * from the bucket, the api never touches the bytes), blob fallback when the
 * backend answers 204 (inline rows). Either way the click is an anchor with
 * `download`, never a navigation of the bytes in this origin.
 */

const api = vi.hoisted(() => ({
  fetchAttachmentDownloadUrl: vi.fn(),
  fetchAttachmentBlob: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  attachments: api,
  conversations: { sendMessage: api.sendMessage },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { useAttachmentBytes, useDownloadAttachment } =
  await import("./use-attachments");
const { useSendMessage } = await import("./use-conversations");

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
  api.sendMessage.mockReset();
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

describe("useAttachmentBytes", () => {
  const setup = () => {
    const client = new QueryClient();
    const provider = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, provider };
  };

  it("shares one fetch and revokes once after every reader unmounts", async () => {
    api.fetchAttachmentBlob.mockResolvedValue(new Blob(["image"]));
    const { client, provider } = setup();
    const first = renderHook(() => useAttachmentBytes("cv", "att", true), {
      wrapper: provider,
    });
    const second = renderHook(() => useAttachmentBytes("cv", "att", true), {
      wrapper: provider,
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(api.fetchAttachmentBlob).toHaveBeenCalledTimes(1);
    first.unmount();
    second.unmount();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    client.removeQueries({ queryKey: queryKeys.attachments.blob("cv", "att") });
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fake");
    client.clear();
  });

  it("a successful send never overwrites the shared byte cache with a local URL", async () => {
    const blob = new Blob(["image"]);
    api.fetchAttachmentBlob.mockResolvedValue(blob);
    api.sendMessage.mockResolvedValue({ turn: { id: "turn-sent" } });
    const { client, provider } = setup();
    const hook = renderHook(
      () => ({
        bytes: useAttachmentBytes("cv", meta.id, true),
        send: useSendMessage("cv"),
      }),
      { wrapper: provider },
    );
    await waitFor(() => expect(hook.result.current.bytes.isSuccess).toBe(true));
    // Older callers may still carry local preview metadata. It is never cache data.
    const outgoing = {
      message: "attached",
      attachments: [{ ...meta, objectUrl: "blob:staged" }],
    };
    await act(async () => {
      await hook.result.current.send.mutateAsync(outgoing);
    });
    expect(api.sendMessage).toHaveBeenCalledWith("cv", "attached", [meta.id]);
    expect(
      client.getQueryData(queryKeys.attachments.blob("cv", meta.id)),
    ).toEqual({
      blob,
      url: "blob:fake",
    });
    hook.unmount();
    client.clear();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fake");
  });

  it("releases replaced bytes without revoking the current URL", async () => {
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second");
    api.fetchAttachmentBlob.mockResolvedValue(new Blob(["image"]));
    const { client, provider } = setup();
    const hook = renderHook(() => useAttachmentBytes("cv", "att", true), {
      wrapper: provider,
    });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    await act(async () => {
      await hook.result.current.refetch();
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:first");
    hook.unmount();
    client.clear();
    expect(URL.revokeObjectURL).toHaveBeenLastCalledWith("blob:second");
  });

  it("does not allocate an orphan URL when a pending query is removed", async () => {
    let resolveBlob: (blob: Blob) => void = () => {};
    let signal: AbortSignal | undefined;
    api.fetchAttachmentBlob.mockImplementation(
      (
        _conversationId: string,
        _attachmentId: string,
        requestSignal?: AbortSignal,
      ) => {
        signal = requestSignal;
        return new Promise<Blob>((resolve) => {
          resolveBlob = resolve;
        });
      },
    );
    const { client, provider } = setup();
    const hook = renderHook(() => useAttachmentBytes("cv", "att", true), {
      wrapper: provider,
    });
    await waitFor(() => expect(api.fetchAttachmentBlob).toHaveBeenCalledOnce());
    hook.unmount();
    client.clear();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolveBlob(new Blob(["late"]));
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
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
