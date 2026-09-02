// @vitest-environment jsdom
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { AttachmentMeta } from "@/lib/api/types";
import { Composer } from "./composer";

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
});
