// @vitest-environment jsdom
import { createRef, StrictMode } from "react";
import type { ReactElement } from "react";
import {
  act,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@onecli/api/validations/attachments";
import { ApiError } from "@/lib/api/client";
import type { AttachmentMeta } from "@/lib/api/types";
import { Composer } from "./composer";
import type { ComposerHandle } from "./composer";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

const render = (ui: ReactElement) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderComponent(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const meta = (over: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  id: "att-1",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 3,
  status: "pending",
  ...over,
});

const baseProps = {
  onSend: () => {},
  uploadFile: async () => meta(),
  sendPending: false,
  sendError: null,
} as const;

describe("Composer", () => {
  it("keeps the remove face small inside a 44px target and honors reduced motion", () => {
    const ref = createRef<ComposerHandle>();
    render(
      <Composer
        {...baseProps}
        ref={ref}
        uploadFile={() => new Promise<AttachmentMeta>(() => {})}
      />,
    );
    act(() =>
      ref.current?.stageFiles([
        new File(["a"], "target.txt", { type: "text/plain" }),
      ]),
    );
    const remove = screen.getByRole("button", { name: "Remove target.txt" });
    expect(remove).toHaveClass("size-11", "motion-reduce:transition-none");
    expect(remove.querySelector("span")).toHaveClass("size-6");
    expect(remove.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    const spinner = screen
      .getByRole("button", { name: "Preview target.txt" })
      .querySelector("svg");
    expect(spinner).toHaveClass("motion-safe:animate-spin");
    expect(spinner).not.toHaveClass("animate-spin");
  });

  it.each(["resolve", "reject"] as const)(
    "ignores upload %s after removal without resurrecting the file",
    async (settlement) => {
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", {
        createObjectURL: () => "blob:removed",
        revokeObjectURL,
      });
      let resolveUpload: (value: AttachmentMeta) => void = () => {};
      let rejectUpload: (error: Error) => void = () => {};
      const uploadFile = () =>
        new Promise<AttachmentMeta>((resolve, reject) => {
          resolveUpload = resolve;
          rejectUpload = reject;
        });
      const ref = createRef<ComposerHandle>();
      const { unmount } = render(
        <Composer {...baseProps} ref={ref} uploadFile={uploadFile} />,
      );
      await act(async () =>
        ref.current?.stageFiles([
          new File(["a"], "removed.png", { type: "image/png" }),
        ]),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Remove removed.png" }),
      );
      await act(async () => {
        if (settlement === "resolve") resolveUpload(meta());
        else rejectUpload(new Error("removed upload failed"));
      });
      expect(screen.queryByText("removed.png")).not.toBeInTheDocument();
      expect(toast.error).not.toHaveBeenCalled();
      unmount();
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:removed");
    },
  );

  it("releases an image URL when its upload fails", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:failed",
      revokeObjectURL,
    });
    const ref = createRef<ComposerHandle>();
    const { unmount } = render(
      <Composer
        {...baseProps}
        ref={ref}
        uploadFile={async () => {
          throw new Error("unavailable");
        }}
      />,
    );
    await act(async () =>
      ref.current?.stageFiles([
        new File(["a"], "failed.png", { type: "image/png" }),
      ]),
    );
    expect(screen.queryByText("failed.png")).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledExactlyOnceWith(
      'Couldn\'t attach "failed.png". unavailable',
      { id: "unavailable" },
    );
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:failed");
  });

  it("reserves capacity across imperative staging calls before React renders", async () => {
    const ref = createRef<ComposerHandle>();
    const uploadFile = vi.fn(async (file: File) => meta({ name: file.name }));
    render(<Composer {...baseProps} ref={ref} uploadFile={uploadFile} />);
    const file = (i: number) => new File(["abc"], `rapid-${i}.txt`);
    act(() => {
      ref.current?.stageFiles(
        Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE - 1 }, (_, i) =>
          file(i),
        ),
      );
      ref.current?.stageFiles([file(100), file(101)]);
    });
    await waitFor(() =>
      expect(uploadFile).toHaveBeenCalledTimes(MAX_ATTACHMENTS_PER_MESSAGE),
    );
    expect(screen.queryByText("rapid-101.txt")).not.toBeInTheDocument();
  });

  it("releases unsent image URLs once on removal and unmount under StrictMode", async () => {
    const revokeObjectURL = vi.fn();
    let serial = 0;
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:staged-${++serial}`),
      revokeObjectURL,
    });
    const ref = createRef<ComposerHandle>();
    const { unmount } = render(
      <StrictMode>
        <Composer {...baseProps} ref={ref} />
      </StrictMode>,
    );
    act(() =>
      ref.current?.stageFiles([
        new File(["a"], "first.png", { type: "image/png" }),
        new File(["b"], "second.png", { type: "image/png" }),
      ]),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove first.png" }));
    expect(revokeObjectURL.mock.calls).toEqual([["blob:staged-1"]]);
    unmount();
    expect(revokeObjectURL.mock.calls).toEqual([
      ["blob:staged-1"],
      ["blob:staged-2"],
    ]);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores upload %s after unmount and releases its URL",
    async (settlement) => {
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", {
        createObjectURL: () => "blob:pending",
        revokeObjectURL,
      });
      let resolveUpload: (value: AttachmentMeta) => void = () => {};
      let rejectUpload: (error: Error) => void = () => {};
      const uploadFile = vi.fn(
        () =>
          new Promise<AttachmentMeta>((resolve, reject) => {
            resolveUpload = resolve;
            rejectUpload = reject;
          }),
      );
      const ref = createRef<ComposerHandle>();
      const { unmount } = render(
        <Composer {...baseProps} ref={ref} uploadFile={uploadFile} />,
      );
      act(() =>
        ref.current?.stageFiles([
          new File(["a"], "pending.png", { type: "image/png" }),
        ]),
      );
      await waitFor(() => expect(uploadFile).toHaveBeenCalledOnce());
      unmount();
      await act(async () => {
        if (settlement === "resolve") resolveUpload(meta());
        else rejectUpload(new Error("late failure"));
      });
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:pending");
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("sends metadata only and releases its local URL exactly once at submit", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:sent",
      revokeObjectURL,
    });
    const onSend = vi.fn();
    const ref = createRef<ComposerHandle>();
    const { unmount } = render(
      <Composer {...baseProps} ref={ref} onSend={onSend} />,
    );
    act(() =>
      ref.current?.stageFiles([
        new File(["a"], "sent.png", { type: "image/png" }),
      ]),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:sent");
    unmount();
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "",
      attachments: [meta()],
    });
    expect(onSend.mock.calls[0]?.[0].attachments[0]).not.toHaveProperty(
      "objectUrl",
    );
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:sent");
  });

  it("restores failed attachment metadata without creating a local URL", () => {
    const revokeObjectURL = vi.fn();
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const { unmount } = render(
      <Composer {...baseProps} failedAttachments={[meta()]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    unmount();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("sends the trimmed message on Enter and clears the field", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} />);

    const field = screen.getByRole("textbox", { name: "Message" });
    await user.type(field, "  hello there  ");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "hello there",
      attachments: [],
    });
    expect(field).toHaveValue("");
  });

  it("opens prefilled, focused, with the caret parked at the end of the draft", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <Composer
        {...baseProps}
        onSend={onSend}
        initialDraft="Hey Donna, what can you do for me?"
      />,
    );

    const field = screen.getByRole("textbox", {
      name: "Message",
    }) as HTMLTextAreaElement;
    expect(field).toHaveValue("Hey Donna, what can you do for me?");
    await waitFor(() => expect(field).toHaveFocus());
    // A caret, never a selection: selected text is one keystroke from gone.
    expect(field.selectionStart).toBe(field.value.length);
    expect(field.selectionEnd).toBe(field.value.length);

    // Enter accepts the prefilled draft as-is.
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "Hey Donna, what can you do for me?",
      attachments: [],
    });
    expect(field).toHaveValue("");
  });

  it("never resurrects a cleared prefilled draft on a re-render", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Composer
        {...baseProps}
        initialDraft="Hey Donna, what can you do for me?"
      />,
    );

    const field = screen.getByRole("textbox", { name: "Message" });
    await user.clear(field);
    rerender(
      <Composer
        {...baseProps}
        initialDraft="Hey Donna, what can you do for me?"
      />,
    );

    expect(field).toHaveValue("");
  });

  it("inserts a newline on Shift+Enter instead of sending", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} />);

    const field = screen.getByRole("textbox", { name: "Message" });
    await user.type(field, "line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onSend).not.toHaveBeenCalled();
    expect(field).toHaveValue("line one\n");
  });

  it("stays sendable regardless of availability — the server queues offline sends", async () => {
    // §3.18 rule 3 + OFFLINE_MESSAGE's own promise: configuration never
    // blocks conversation. The composer takes no availability prop at all.
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} />);
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "queue me",
    );
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "queue me",
      attachments: [],
    });
  });

  it("keeps Send live BESIDE Stop while a turn is active", async () => {
    // The mid-run contract: a message sent while the agent works becomes a
    // follow-up that steers into the live turn — Send never yields.
    const user = userEvent.setup();
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} onStop={onStop} />);

    await user.click(screen.getByRole("button", { name: "Stop the agent" }));
    expect(onStop).toHaveBeenCalledOnce();

    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "also do this",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "also do this",
      attachments: [],
    });
  });

  it("restores the draft after a failed send instead of eating it", () => {
    const { rerender } = render(<Composer {...baseProps} />);
    // The field cleared optimistically at submit; the failure brings the
    // words back.
    rerender(<Composer {...baseProps} failedDraft="lost words" />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "lost words",
    );
  });

  it("renders the server's refusal inline (the follow-up cap)", () => {
    // 409s are no longer "a turn is in flight" — the mid-run door accepts
    // those. The one refusal left carries its own honest copy, shown as-is.
    render(
      <Composer
        {...baseProps}
        sendError={
          new ApiError(
            "You've sent several messages I haven't gotten to yet. Give me a moment to catch up.",
            409,
          )
        }
      />,
    );
    expect(
      screen.getByText(
        "You've sent several messages I haven't gotten to yet. Give me a moment to catch up.",
      ),
    ).toBeInTheDocument();
  });

  it("stages a picked file, uploads it, and sends its id with the message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const uploadFile = vi.fn(async () => meta());
    const { container } = render(
      <Composer {...baseProps} onSend={onSend} uploadFile={uploadFile} />,
    );

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(["abc"], "photo.png", { type: "image/png" });
    await user.upload(input as HTMLInputElement, file);

    expect(uploadFile).toHaveBeenCalledExactlyOnceWith(file);
    // The chip lands once the upload resolves.
    await waitFor(() =>
      expect(screen.getByText("photo.png")).toBeInTheDocument(),
    );

    await user.type(screen.getByRole("textbox", { name: "Message" }), "look");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "look",
      attachments: [expect.objectContaining({ id: "att-1" })],
    });
    // The chips clear with the send.
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
  });

  it("uploads a picked file ONCE under StrictMode — no double upload", async () => {
    // REGRESSION (found in review): staging used to call uploadFile() inside a
    // setStaged updater, and React invokes updaters twice under StrictMode
    // (Next's dev default) — every attachment was uploaded twice, burning a
    // second pending row per file.
    const user = userEvent.setup();
    const uploadFile = vi.fn(async () => meta());
    const { container } = render(
      <StrictMode>
        <Composer {...baseProps} uploadFile={uploadFile} />
      </StrictMode>,
    );

    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["abc"], "once.png", { type: "image/png" }),
    );

    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    // And the chip appears exactly once, not twice.
    await waitFor(() =>
      expect(screen.getAllByText("once.png")).toHaveLength(1),
    );
  });

  it("a file with no words is sendable — attachments alone carry the message", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { container } = render(<Composer {...baseProps} onSend={onSend} />);

    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      input as HTMLInputElement,
      new File(["abc"], "notes.pdf", { type: "application/pdf" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "",
      attachments: [expect.objectContaining({ id: "att-1" })],
    });
  });

  it("blocks Send while an upload is still in flight", async () => {
    const user = userEvent.setup();
    let resolveUpload: (value: AttachmentMeta) => void = () => {};
    const uploadFile = vi.fn(
      () =>
        new Promise<AttachmentMeta>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const { container } = render(
      <Composer {...baseProps} uploadFile={uploadFile} />,
    );

    await user.type(screen.getByRole("textbox", { name: "Message" }), "hi");
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["abc"], "slow.bin", { type: "application/octet-stream" }),
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    resolveUpload(meta({ id: "att-2", name: "slow.bin" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
  });

  it("a removed chip does not ride the send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const { container } = render(<Composer {...baseProps} onSend={onSend} />);

    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["abc"], "oops.txt", { type: "text/plain" }),
    );
    await waitFor(() =>
      expect(screen.getByText("oops.txt")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Remove oops.txt" }));

    await user.type(screen.getByRole("textbox", { name: "Message" }), "sans");
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith({
      message: "sans",
      attachments: [],
    });
  });

  it("takes the first files up to the cap and says the limit", async () => {
    const cap = MAX_ATTACHMENTS_PER_MESSAGE;
    const user = userEvent.setup();
    const uploadFile = vi.fn(async (file: File) => meta({ name: file.name }));
    const { container } = render(
      <Composer {...baseProps} uploadFile={uploadFile} />,
    );

    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      Array.from(
        { length: cap + 2 },
        (_, i) => new File(["abc"], `f${i + 1}.txt`, { type: "text/plain" }),
      ),
    );
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(cap));
    expect(screen.queryByText(`f${cap + 1}.txt`)).not.toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalledWith(
      `You can add at most ${cap} attachments to a message. Please select fewer attachments.`,
    );
  });

  it("a failed upload is one toast and no chip, never a red row to clean up", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Composer
        {...baseProps}
        uploadFile={async () => {
          throw new Error("Server busy.");
        }}
      />,
    );
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["abc"], "a.pdf", { type: "application/pdf" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Couldn\'t attach "a.pdf". Server busy.',
        { id: "Server busy." },
      ),
    );
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  });

  it("clicking a staged file opens its preview (a CSV shows its text)", async () => {
    const user = userEvent.setup();
    const { container } = render(<Composer {...baseProps} />);
    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["Account,ARR\nBluepine,120000"], "pipeline.csv", {
        type: "text/csv",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Preview pipeline.csv" }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Bluepine,120000",
    );
  });

  it("stages pasted files (a screenshot paste) like picked ones", async () => {
    const user = userEvent.setup();
    const uploadFile = vi.fn(async () => meta());
    render(<Composer {...baseProps} uploadFile={uploadFile} />);

    const field = screen.getByRole("textbox", { name: "Message" });
    field.focus();
    await user.paste({
      getData: () => "",
      files: [new File(["abc"], "image.png", { type: "image/png" })],
      items: [],
      types: ["Files"],
    } as unknown as DataTransfer);

    await waitFor(() => expect(uploadFile).toHaveBeenCalledOnce());
  });

  it("follows the typed language's direction: Hebrew starts on the right", () => {
    // The browser's `dir="auto"` is right for an input: it keys on the
    // first strong character as the person types, so a Hebrew draft
    // starts on the right with no per-keystroke work of our own.
    render(<Composer {...baseProps} />);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "dir",
      "auto",
    );
  });
});
