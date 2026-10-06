// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { SecretDialog } from "./secret-dialog";

// The unit here is the dialog's own guidance surface: the provider hints
// (canonical console links, the copyable commands) and the focus handoff.
// The server graph stays out: the update action imports Prisma, the copy
// hook is the house clipboard seam, and toasts are observed, not rendered.
const mocks = vi.hoisted(() => ({
  copy: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock("@/lib/actions/secrets", () => ({ updateSecret: vi.fn() }));
vi.mock("@/hooks/use-onepassword-picker", () => ({
  useOnePasswordReady: () => false,
}));
vi.mock("./onepassword-picker-dialog", () => ({
  OnePasswordPickerDialog: () => null,
}));
vi.mock("@/hooks/use-invalidate-cache", () => ({
  useInvalidateGatewayCache: () => vi.fn(),
}));
vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: mocks.copy }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix popper layers want a ResizeObserver; jsdom has none. The copy
// buttons' tooltips open incidentally around click/hover, so keep the suite
// deterministic (same shim as sidebar-version.onprem.test.tsx).
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const renderDialog = (props: Partial<Parameters<typeof SecretDialog>[0]>) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<SecretDialog open onOpenChange={() => {}} {...props} />, {
    wrapper,
  });
};

describe("SecretDialog provider guidance", () => {
  afterEach(() => {
    mocks.copy.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("links the CANONICAL Claude Console: platform.claude.com, the host the rest of the app uses", () => {
    renderDialog({ defaultType: "anthropic" });
    expect(
      screen.getByRole("link", { name: "Claude Console" }),
    ).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  });

  it("hands focus to the value input when the name arrives pre-filled", async () => {
    renderDialog({ defaultType: "anthropic" });
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("sk-ant-oat01-… or sk-ant-api03-…"),
      ).toHaveFocus(),
    );
  });

  it("copies `claude setup-token` verbatim and toasts the follow-up — only when the copy ran", async () => {
    mocks.copy.mockResolvedValue(true);
    renderDialog({ defaultType: "anthropic" });

    await userEvent.click(
      screen.getByRole("button", { name: "Copy claude setup-token" }),
    );
    expect(mocks.copy).toHaveBeenCalledWith("claude setup-token");
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Copied. Run it in your terminal, approve in the browser, then paste the token here.",
      ),
    );
  });

  it("leads with `claude setup-token` and explains on hover that it runs in the terminal", async () => {
    renderDialog({ defaultType: "anthropic" });

    const command = screen.getByRole("button", {
      name: "Copy claude setup-token",
    });
    const consoleLink = screen.getByRole("link", { name: "Claude Console" });
    // The command is offered first, ahead of the console link.
    expect(
      command.compareDocumentPosition(consoleLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Peers in every state: the command wears the anchor's exact class.
    expect(command.className).toBe(consoleLink.className);

    await userEvent.hover(command);
    expect(
      (await screen.findAllByText(/Run it in a terminal with Claude Code/))
        .length,
    ).toBeGreaterThan(0);
  });

  it.each([
    [
      "a setup-token subscription token",
      "sk-ant-oat01-",
      "Subscription",
      "Claude Subscription",
    ],
    ["a Console API key", "sk-ant-api03-", "API Key", "Anthropic API Key"],
  ])(
    "names %s by its kind: badge and auto-filled name",
    async (_name, prefix, badge, autoName) => {
      renderDialog({ defaultType: "anthropic" });
      const nameInput = screen.getByPlaceholderText(
        "e.g. Anthropic Production Key",
      );
      await userEvent.clear(nameInput);
      await userEvent.click(
        screen.getByPlaceholderText("sk-ant-oat01-… or sk-ant-api03-…"),
      );
      // Surrounding whitespace is what a terminal copy often carries; the
      // kind is read from the trimmed value, the one that gets saved.
      await userEvent.paste(`  ${prefix}${"x".repeat(90)}\n`);

      expect(screen.getByText(badge)).toBeInTheDocument();
      expect(nameInput).toHaveValue(autoName);
      // No amber warning: the guidance hint is still the one showing.
      expect(screen.getByRole("status")).toHaveTextContent(
        /Paste a subscription token from/,
      );
    },
  );

  it.each([
    [
      "anthropic",
      "an Anthropic Admin key",
      `sk-ant-admin01-${"x".repeat(90)}`,
      /Admin API key, which can.t call Claude models/,
    ],
    [
      "anthropic",
      "a token wrapped across terminal lines",
      // The input drops the line break but keeps the wrap's indentation.
      `sk-ant-oat01-${"x".repeat(40)}\n  ${"x".repeat(40)}`,
      /contains spaces/,
    ],
    [
      "anthropic",
      "an OpenAI key",
      `sk-proj-${"x".repeat(90)}`,
      /looks like an OpenAI key/,
    ],
    [
      "openai",
      "an OpenAI Admin key",
      `sk-admin-${"x".repeat(90)}`,
      /Admin API key, which can.t call models/,
    ],
  ] as const)(
    "%s: warns when pasting %s",
    async (type, _name, value, warning) => {
      renderDialog({ defaultType: type });
      await userEvent.click(
        screen.getByPlaceholderText(
          type === "anthropic"
            ? "sk-ant-oat01-… or sk-ant-api03-…"
            : "sk-proj-…",
        ),
      );
      await userEvent.paste(value);

      expect(screen.getByRole("status")).toHaveTextContent(warning);
    },
  );

  it("never badges an Anthropic Admin key as an API key: it is neither kind", async () => {
    renderDialog({ defaultType: "anthropic" });
    await userEvent.click(
      screen.getByPlaceholderText("sk-ant-oat01-… or sk-ant-api03-…"),
    );
    await userEvent.paste(`sk-ant-admin01-${"x".repeat(90)}`);

    expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
    expect(screen.queryByText("API Key")).not.toBeInTheDocument();
  });

  it("reports a failed copy honestly — an error toast, never a fake success and never silence", async () => {
    mocks.copy.mockResolvedValue(false);
    renderDialog({ defaultType: "anthropic" });

    await userEvent.click(
      screen.getByRole("button", { name: "Copy claude setup-token" }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't copy to clipboard"),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("hands focus back to the Name input when the generic door REOPENS", async () => {
    // The regression this pins: the persistent generic door (agent page's
    // Add connection) remounts the form with the PREVIOUS session's name
    // still in state, so mount-time autoFocus computes false; the open
    // effect must hand focus explicitly.
    const view = renderDialog({ defaultType: "generic" });
    await userEvent.type(
      screen.getByPlaceholderText("e.g. GitHub Token"),
      "My token",
    );
    view.rerender(
      <SecretDialog
        open={false}
        onOpenChange={() => {}}
        defaultType="generic"
      />,
    );
    view.rerender(
      <SecretDialog open onOpenChange={() => {}} defaultType="generic" />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("e.g. GitHub Token")).toHaveFocus(),
    );
  });

  it("teaches ONE codex command — the copy button carries the same --device-auth invocation as the prose", async () => {
    mocks.copy.mockResolvedValue(true);
    renderDialog({ defaultType: "openai" });

    // The api-key mode keeps its own auth.json door (the pre-existing hint);
    // the copyable command lives with the codex instructions, not here.
    expect(
      screen.getByRole("button", { name: "upload auth.json" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Codex (OAuth)" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy codex login --device-auth" }),
    );
    expect(mocks.copy).toHaveBeenCalledWith("codex login --device-auth");
  });
});
