// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

/**
 * The workspace's file record: what it shows before the bytes (name, type,
 * size, who sent it and from where, when, how long it stays, the caption),
 * that Download goes through the chat's own hook, the expired state, and the
 * honest notices — an incomplete link, a fenced-off or gone file (404), a
 * transient error with a retry.
 */

const state = vi.hoisted(() => ({
  search: "c=cv-1",
  meta: undefined as unknown,
  metaError: undefined as unknown,
}));
const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "w1", attachmentId: "att-1" }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@/hooks/use-attachments", () => ({
  useAttachmentMeta: () => ({
    data: state.meta,
    isPending: state.meta === undefined && state.metaError === undefined,
    isError: state.metaError !== undefined,
    error: state.metaError,
    refetch: mocks.refetch,
  }),
  useDownloadAttachment: () => ({ mutate: mocks.download, isPending: false }),
}));

const { FileRecord } = await import("./file-record");

const renderRecord = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileRecord />
    </QueryClientProvider>,
  );

const bound = {
  id: "att-1",
  name: "clip.webm",
  mimeType: "video/webm",
  sizeBytes: 1_572_864,
  status: "bound",
  direction: "outbound",
  caption: "the run, recorded",
  createdAt: "2026-09-13T10:00:00.000Z",
  conversation: { source: "slack", agent: { id: "ag-1", name: "Donna" } },
};

beforeEach(() => {
  state.search = "c=cv-1";
  state.meta = undefined;
  state.metaError = undefined;
  mocks.download.mockReset();
  mocks.refetch.mockReset();
});

describe("FileRecord", () => {
  it("names the file, who sent it, its facts and the caption; Download goes through the chat's hook", async () => {
    state.meta = bound;
    renderRecord();
    // The page's own h1 — it stands on the dashboard chrome, no frame above it.
    expect(
      screen.getByRole("heading", { level: 1, name: "clip.webm" }),
    ).toBeInTheDocument();
    // The sender is a link to that agent's chat (Cmd-click works).
    expect(screen.getByRole("link", { name: "Donna" })).toHaveAttribute(
      "href",
      "/w/w1/agents/ag-1/chat",
    );
    // Facts as a definition list: jsdom's matcher normalizes NBSP.
    expect(screen.getByText("video/webm")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB")).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
    // When it landed, and retention stated as a date: 30 days after.
    const times = document.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute("dateTime", "2026-09-13T10:00:00.000Z");
    expect(screen.getByText("Available until")).toBeInTheDocument();
    expect(times[1]).toHaveAttribute("dateTime", "2026-10-13T10:00:00.000Z");
    expect(screen.getByText("the run, recorded")).toBeInTheDocument();
    expect(screen.getByText("Donna’s note")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(mocks.download).toHaveBeenCalledWith(bound);

    expect(
      screen.getByRole("link", { name: "Open chat with Donna" }),
    ).toHaveAttribute("href", "/w/w1/agents/ag-1/chat");
  });

  it("an expired file keeps its record, says so, and offers no Download", () => {
    state.meta = { ...bound, status: "expired", caption: null };
    renderRecord();
    expect(
      screen.getByRole("heading", { level: 1, name: "clip.webm" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This file expired after 30 days and can’t be downloaded.",
    );
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByText(/note$/)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open chat with Donna" }),
    ).toBeInTheDocument();
  });

  it("a malformed createdAt degrades the two date cells, never the page", () => {
    state.meta = { ...bound, createdAt: "not-a-date" };
    renderRecord();
    expect(
      screen.getByRole("heading", { level: 1, name: "clip.webm" }),
    ).toBeInTheDocument();
    expect(document.querySelector("time")).toBeNull();
    expect(screen.getByText(/files stay 30 days/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download" }),
    ).toBeInTheDocument();
  });

  it("labels a web conversation and an unknown source honestly", () => {
    state.meta = {
      ...bound,
      conversation: { ...bound.conversation, source: "web" },
    };
    const { unmount } = renderRecord();
    expect(screen.getByText("Web chat")).toBeInTheDocument();
    unmount();
    state.meta = {
      ...bound,
      conversation: { ...bound.conversation, source: "ms-teams" },
    };
    renderRecord();
    expect(screen.getByText("Ms teams")).toBeInTheDocument();
  });

  it("renders a skeleton while the metadata loads, never a half card", () => {
    renderRecord();
    expect(screen.getByLabelText("Loading file…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("a 404 (fenced off or gone) is an honest 'not available'", () => {
    state.metaError = new ApiError("Attachment not found", 404);
    renderRecord();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "This file isn’t available.",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("a transient error offers Try Again, which refetches", async () => {
    state.metaError = new ApiError("Request failed: 500", 500);
    renderRecord();
    expect(screen.getByText("Couldn’t load this file.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("a link without the conversation param says so instead of guessing", () => {
    state.search = "";
    renderRecord();
    expect(screen.getByText("This link is incomplete.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });
});
