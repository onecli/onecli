// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { CreateSecretInput } from "@onecli/api/validations/secret";
import { FOCUS_HANDOFF_MS, SecretDialog } from "./secret-dialog";
import type { SecretActions } from "./types";
import type { SavedSecret } from "@/lib/api";

// The unit here is the dialog's own guidance surface: the provider hints
// (canonical console links, the copyable commands) and the focus handoff.
// The server graph stays out: the update action imports Prisma, the copy
// hook is the house clipboard seam, and toasts are observed, not rendered.
const mocks = vi.hoisted(() => ({
  copy: vi.fn<(text: string) => Promise<boolean>>(),
  create: vi.fn<(input: CreateSecretInput) => Promise<{ id: string }>>(),
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

// The dialog hands focus to an input FOCUS_HANDOFF_MS after it opens. A test
// that clicks into another field inside that beat has its focus moved
// mid-action, so a paste lands in Name instead. On a loaded CI runner the
// beat outlasts a test's first interactions, which made this suite flaky.
// Every render therefore waits the beat out first, as a person would. The
// margin keeps the wait strictly after the handoff, whatever order the timer
// queue picks for equal delays.
const renderDialog = async (
  props: Partial<Parameters<typeof SecretDialog>[0]>,
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = render(
    <SecretDialog open onOpenChange={() => {}} {...props} />,
    { wrapper },
  );
  await act(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, FOCUS_HANDOFF_MS + 20),
      ),
  );
  return view;
};

describe("SecretDialog provider guidance", () => {
  afterEach(() => {
    mocks.copy.mockReset();
    mocks.create.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it("links the CANONICAL Claude Console: platform.claude.com, the host the rest of the app uses", async () => {
    await renderDialog({ defaultType: "anthropic" });
    expect(
      screen.getByRole("link", { name: "Claude Console" }),
    ).toHaveAttribute("href", "https://platform.claude.com/settings/keys");
  });

  it("hands focus to the value input when the name arrives pre-filled", async () => {
    await renderDialog({ defaultType: "anthropic" });
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("sk-ant-oat01-… or sk-ant-api03-…"),
      ).toHaveFocus(),
    );
  });

  it("copies `claude setup-token` verbatim and toasts the follow-up — only when the copy ran", async () => {
    mocks.copy.mockResolvedValue(true);
    await renderDialog({ defaultType: "anthropic" });

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
    await renderDialog({ defaultType: "anthropic" });

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
    [
      "an identity-backed Console key",
      "sk-ant-usr-",
      "API Key",
      "Anthropic API Key",
    ],
  ])(
    "names %s by its kind: badge and auto-filled name",
    async (_name, prefix, badge, autoName) => {
      await renderDialog({ defaultType: "anthropic" });
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
        /From claude setup-token, or an API key from the Claude Console/,
      );
    },
  );

  it("names a TYPED subscription token by its final kind, not the API-key guess its `sk-ant-` stem allows", async () => {
    await renderDialog({ defaultType: "anthropic" });
    const nameInput = screen.getByPlaceholderText(
      "e.g. Anthropic Production Key",
    );
    await userEvent.clear(nameInput);
    await userEvent.type(
      screen.getByPlaceholderText("sk-ant-oat01-… or sk-ant-api03-…"),
      `sk-ant-oat01-${"x".repeat(40)}`,
    );

    expect(nameInput).toHaveValue("Claude Subscription");
  });

  it.each([
    ["anthropic", true],
    ["openai", false],
    ["generic", false],
  ] as const)(
    "%s: shows the Need help? guide link only for Anthropic",
    async (type, shown) => {
      await renderDialog({ defaultType: type });
      const link = screen.queryByRole("link", { name: "Need help?" });
      if (!shown) {
        expect(link).not.toBeInTheDocument();
        return;
      }
      expect(link).toHaveAttribute(
        "href",
        "https://onecli.sh/docs/integrations/anthropic",
      );
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
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
      "a Claude OAuth refresh token",
      `sk-ant-ort01-${"x".repeat(90)}`,
      /refresh token, which can.t call Claude models/,
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
      await renderDialog({ defaultType: type });
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

  it.each([
    ["an Anthropic Admin key", "sk-ant-admin01-"],
    ["a Claude OAuth refresh token", "sk-ant-ort01-"],
  ])("never badges %s: it is neither kind", async (_name, prefix) => {
    await renderDialog({ defaultType: "anthropic" });
    await userEvent.click(
      screen.getByPlaceholderText("sk-ant-oat01-… or sk-ant-api03-…"),
    );
    await userEvent.paste(`${prefix}${"x".repeat(90)}`);

    expect(screen.queryByText("Subscription")).not.toBeInTheDocument();
    expect(screen.queryByText("API Key")).not.toBeInTheDocument();
  });

  it("reports a failed copy honestly — an error toast, never a fake success and never silence", async () => {
    mocks.copy.mockResolvedValue(false);
    await renderDialog({ defaultType: "anthropic" });

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
    const view = await renderDialog({ defaultType: "generic" });
    await userEvent.type(
      screen.getByPlaceholderText("e.g. Airtable"),
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
      expect(screen.getByPlaceholderText("e.g. Airtable")).toHaveFocus(),
    );
  });

  it("teaches ONE codex command — the copy button carries the same --device-auth invocation as the prose", async () => {
    mocks.copy.mockResolvedValue(true);
    await renderDialog({ defaultType: "openai" });

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

  it("offers OpenCode Go and OpenRouter alongside the existing LLM providers", async () => {
    await renderDialog({});
    expect(screen.getByText("OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText("OpenRouter")).toBeInTheDocument();
  });

  it("keeps the OpenCode Go hint neutral with no fabricated key prefix", async () => {
    await renderDialog({ defaultType: "opencode-go" });
    expect(
      screen.getByPlaceholderText("Paste your OpenCode Go key"),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      /Paste the subscription key from your OpenCode Go account/,
    );

    await userEvent.paste("opaque-subscription-token");
    expect(screen.getByRole("status")).toHaveTextContent(
      /Paste the subscription key from your OpenCode Go account/,
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(/start with/);
  });

  it("hints OpenRouter's sk-or- convention and links its keys page", async () => {
    await renderDialog({ defaultType: "openrouter" });
    expect(screen.getByPlaceholderText("sk-or-…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "openrouter.ai" })).toHaveAttribute(
      "href",
      "https://openrouter.ai/settings/keys",
    );

    await userEvent.click(screen.getByPlaceholderText("sk-or-…"));
    await userEvent.paste("not-a-real-key");
    expect(screen.getByRole("status")).toHaveTextContent(
      /OpenRouter keys usually start with/,
    );
  });

  it("offers the Local (OpenAI-compatible) key type", async () => {
    await renderDialog({});
    expect(screen.getByText("Local (OpenAI-compatible)")).toBeInTheDocument();
  });

  it("prefills the Base URL from the Ollama and LM Studio presets, staying editable", async () => {
    renderDialog({ defaultType: "local" });
    const baseUrl = screen.getByLabelText("Base URL");

    await userEvent.click(screen.getByRole("radio", { name: "Ollama" }));
    expect(baseUrl).toHaveValue("http://localhost:11434/v1");

    await userEvent.click(screen.getByRole("radio", { name: "LM Studio" }));
    expect(baseUrl).toHaveValue("http://localhost:1234/v1");

    await userEvent.clear(baseUrl);
    await userEvent.type(baseUrl, "http://192.168.1.50:11434/v1");
    expect(baseUrl).toHaveValue("http://192.168.1.50:11434/v1");
  });

  it("creates a local key with baseUrl and no value when the API key is left empty", async () => {
    mocks.create.mockResolvedValue({ id: "sec-local" });
    await renderDialog({
      defaultType: "local",
      secretActions: actions({ createSecret: mocks.create }),
    });

    await userEvent.click(screen.getByRole("radio", { name: "Ollama" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const payload = mocks.create.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      type: "local",
      baseUrl: "http://localhost:11434/v1",
      hostPattern: "localhost:11434",
    });
    expect(payload).not.toHaveProperty("value");
  });

  it("rejects a non-http Base URL and keeps the key optional", async () => {
    await renderDialog({ defaultType: "local" });
    await userEvent.type(screen.getByLabelText("Base URL"), "ftp://nope");

    expect(
      screen.getByText(/Base URL must start with http:\/\/ or https:\/\//),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Secret" })).toBeDisabled();
  });
});

// The dialog takes the scope's whole action set; each test spies on one.
const actions = (overrides: Partial<SecretActions>): SecretActions => ({
  createSecret: vi
    .fn<SecretActions["createSecret"]>()
    .mockResolvedValue({ id: "sec-1" }),
  deleteSecret: vi.fn<SecretActions["deleteSecret"]>(),
  updateSecret: vi.fn<SecretActions["updateSecret"]>(),
  ...overrides,
});

const createSpy = () =>
  vi.fn<SecretActions["createSecret"]>().mockResolvedValue({ id: "sec-1" });
const updateSpy = () =>
  vi.fn<SecretActions["updateSecret"]>().mockResolvedValue();

/** An existing custom connection, for edit mode. */
const customSecret = (
  injectionConfig: unknown,
  pathPattern: string | null = null,
) => ({
  id: "s1",
  name: "Acme",
  type: "generic",
  hostPattern: "api.acme.io",
  pathPattern,
  injectionConfig,
  metadata: null,
});

// Paste, not type: one input event per field keeps these tests fast.
const pasteInto = async (placeholder: string, text: string) => {
  await userEvent.click(screen.getByPlaceholderText(placeholder));
  await userEvent.paste(text);
};

const fillBasics = async () => {
  await pasteInto("e.g. Airtable", "Acme");
  await pasteInto("Paste your API key / Secret", "key-123");
  await pasteInto("api.example.com", "api.acme.io");
};

const addConnection = () =>
  userEvent.click(screen.getByRole("button", { name: "Add connection" }));
const saveChanges = () =>
  userEvent.click(screen.getByRole("button", { name: "Save changes" }));
const openOptional = (label: string) =>
  userEvent.click(screen.getByRole("button", { name: `${label} (optional)` }));

describe("SecretDialog custom connection", () => {
  afterEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it.each([
    [
      "Bearer token",
      async () => {},
      { headerName: "Authorization", valueFormat: "Bearer {value}" },
    ],
    [
      "Custom header",
      () => pasteInto("X-Api-Key", "X-Token"),
      { headerName: "X-Token", valueFormat: "{value}" },
    ],
    [
      "URL parameter",
      () => pasteInto("api_key", "key"),
      { paramName: "key", paramFormat: "{value}" },
    ],
    [
      "URL path",
      () => pasteInto("/bot{value}", "/bot{value}"),
      { pathTemplate: "/bot{value}" },
    ],
  ] as const)("creates with %s", async (mode, fillMode, injectionConfig) => {
    const createSecret = createSpy();
    await renderDialog({
      defaultType: "generic",
      secretActions: actions({ createSecret }),
    });
    await fillBasics();
    await userEvent.click(screen.getByRole("radio", { name: mode }));
    await fillMode();
    await addConnection();
    await waitFor(() =>
      expect(createSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Acme",
          type: "generic",
          value: "key-123",
          hostPattern: "api.acme.io",
          injectionConfig,
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Connection added");
  });

  it("labels the key field as an API key or secret and promises nothing it can't do", async () => {
    await renderDialog({ defaultType: "generic" });
    expect(screen.getByText("API key / Secret")).toBeInTheDocument();
    expect(
      screen.getByText("Paste an API key / Secret and where it goes."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ask your agent/i)).toBeNull();
  });

  it.each([
    [
      "Airtable",
      "api.airtable.com",
      { headerName: "Authorization", valueFormat: "Bearer {value}" },
    ],
    [
      "Google Maps",
      "maps.googleapis.com",
      { paramName: "key", paramFormat: "{value}" },
    ],
    ["Telegram Bot", "api.telegram.org", { pathTemplate: "/bot{value}" }],
  ] as const)(
    "the %s example fills the form and saves that API's shape",
    async (name, host, injectionConfig) => {
      const createSecret = createSpy();
      await renderDialog({
        defaultType: "generic",
        secretActions: actions({ createSecret }),
      });
      await userEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByPlaceholderText("e.g. Airtable")).toHaveValue(name);
      expect(screen.getByPlaceholderText("api.example.com")).toHaveValue(host);
      await pasteInto("Paste your API key / Secret", "key-123");
      await addConnection();
      await waitFor(() =>
        expect(createSecret).toHaveBeenCalledWith(
          expect.objectContaining({ name, hostPattern: host, injectionConfig }),
        ),
      );
    },
  );

  it("previews how the key is sent", async () => {
    await renderDialog({ defaultType: "generic" });
    const preview = () => screen.getByTestId("sent-as-preview");
    expect(preview()).toHaveTextContent("Authorization: Bearer ••••••");
    await userEvent.click(screen.getByRole("radio", { name: "Custom header" }));
    expect(preview()).toHaveTextContent("X-Api-Key: ••••••");
    await pasteInto("X-Api-Key", "X-Key");
    expect(preview()).toHaveTextContent("X-Key: ••••••");
    await userEvent.click(screen.getByRole("radio", { name: "URL parameter" }));
    expect(preview()).toHaveTextContent("?api_key=••••••");
    await userEvent.click(screen.getByRole("radio", { name: "URL path" }));
    expect(screen.queryByTestId("sent-as-preview")).not.toBeInTheDocument();
  });

  it("moves through both pickers with arrow keys", async () => {
    await renderDialog({ defaultType: "generic" });
    screen.getByRole("radio", { name: "Bearer token" }).focus();
    await userEvent.keyboard("{ArrowLeft}");
    const path = screen.getByRole("radio", { name: "URL path" });
    expect(path).toHaveFocus();
    expect(path).toHaveAttribute("aria-checked", "true");

    screen.getByRole("radio", { name: "Template" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Regex" })).toHaveFocus();
    expect(screen.getByPlaceholderText("^/bot[^/]+(/.*)?$")).toBeVisible();
  });

  it("wraps the key in a value format, for APIs like DeepL", async () => {
    const createSecret = createSpy();
    await renderDialog({
      defaultType: "generic",
      secretActions: actions({ createSecret }),
    });
    await fillBasics();
    await userEvent.click(screen.getByRole("radio", { name: "Custom header" }));
    await pasteInto("X-Api-Key", "Authorization");
    await openOptional("Value format");
    await pasteInto("Token {value}", "DeepL-Auth-Key {value}");
    expect(screen.getByTestId("sent-as-preview")).toHaveTextContent(
      "Authorization: DeepL-Auth-Key ••••••",
    );
    await addConnection();
    await waitFor(() =>
      expect(createSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          injectionConfig: {
            headerName: "Authorization",
            valueFormat: "DeepL-Auth-Key {value}",
          },
        }),
      ),
    );
  });

  it("refuses a value format without {value}, and sends the key as-is once the format is closed", async () => {
    const createSecret = createSpy();
    await renderDialog({
      defaultType: "generic",
      secretActions: actions({ createSecret }),
    });
    await fillBasics();
    await userEvent.click(screen.getByRole("radio", { name: "URL parameter" }));
    await openOptional("Value format");
    await pasteInto("Token {value}", "token");
    const format = screen.getByRole("textbox", { name: "Value format" });
    expect(format).toBeInvalid();
    expect(format).toHaveAccessibleDescription(
      "Include {value} where the key goes.",
    );
    expect(
      screen.getByRole("button", { name: "Add connection" }),
    ).toBeDisabled();

    await openOptional("Value format");
    await addConnection();
    await waitFor(() =>
      expect(createSecret).toHaveBeenCalledWith(
        expect.objectContaining({
          injectionConfig: { paramName: "api_key", paramFormat: "{value}" },
        }),
      ),
    );
  });

  it("keeps a wrapped header format on an unchanged edit", async () => {
    const updateSecret = updateSpy();
    const config = {
      headerName: "Authorization",
      valueFormat: "Token {value}",
    };
    await renderDialog({
      secretActions: actions({ updateSecret }),
      secret: customSecret(config),
    });
    expect(
      screen.getByRole("radio", { name: "Custom header" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Value format")).toHaveValue("Token {value}");
    expect(screen.getByTestId("sent-as-preview")).toHaveTextContent(
      "Authorization: Token ••••••",
    );
    await saveChanges();
    await waitFor(() =>
      expect(updateSecret).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ injectionConfig: config, pathPattern: null }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Connection updated");
  });

  it.each([
    { headerName: "Authorization", valueFormat: "Bearer {value}" },
    { headerName: "authorization", valueFormat: "Bearer {value}" },
    { headerName: "X-Api-Key", valueFormat: "{value}" },
    { paramName: "key", paramFormat: "{value}" },
    { paramName: "token", paramFormat: "t:{value}" },
    { pathTemplate: "/bot{value}" },
    { pathRegex: "^/bot[^/]+(/.*)?$", pathReplacement: "/bot{value}$1" },
  ])("round-trips %o unchanged", async (config) => {
    const updateSecret = updateSpy();
    await renderDialog({
      secretActions: actions({ updateSecret }),
      secret: customSecret(config),
    });
    await saveChanges();
    await waitFor(() =>
      expect(updateSecret).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ injectionConfig: config }),
      ),
    );
  });

  it("saves a path limit only while it is open", async () => {
    const createSecret = createSpy();
    await renderDialog({
      defaultType: "generic",
      secretActions: actions({ createSecret }),
    });
    await fillBasics();
    await openOptional("Limit to a path");
    await pasteInto("/v1/*", "/v2/*");
    await openOptional("Limit to a path");
    await addConnection();
    await waitFor(() => expect(createSecret).toHaveBeenCalledTimes(1));
    expect(createSecret.mock.calls[0]?.[0]).toMatchObject({
      pathPattern: undefined,
    });

    await openOptional("Limit to a path");
    await addConnection();
    await waitFor(() => expect(createSecret).toHaveBeenCalledTimes(2));
    expect(createSecret.mock.calls[1]?.[0]).toMatchObject({
      pathPattern: "/v2/*",
    });
  });

  it("drops a typed path limit once URL path hides it", async () => {
    const createSecret = createSpy();
    await renderDialog({
      defaultType: "generic",
      secretActions: actions({ createSecret }),
    });
    await fillBasics();
    await openOptional("Limit to a path");
    await pasteInto("/v1/*", "/v2/*");
    await userEvent.click(screen.getByRole("radio", { name: "URL path" }));
    expect(screen.queryByPlaceholderText("/v1/*")).not.toBeInTheDocument();
    await pasteInto("/bot{value}", "/bot{value}");
    await addConnection();
    await waitFor(() => expect(createSecret).toHaveBeenCalled());
    expect(createSecret.mock.calls[0]?.[0]).toMatchObject({
      pathPattern: undefined,
      injectionConfig: { pathTemplate: "/bot{value}" },
    });
  });

  it("keeps a stored path limit on a URL-path connection's unchanged edit", async () => {
    const updateSecret = updateSpy();
    await renderDialog({
      secretActions: actions({ updateSecret }),
      secret: customSecret({ pathTemplate: "/bot{value}" }, "/bot*/getMe"),
    });
    expect(screen.getByPlaceholderText("/v1/*")).toHaveValue("/bot*/getMe");
    await saveChanges();
    await waitFor(() =>
      expect(updateSecret).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ pathPattern: "/bot*/getMe" }),
      ),
    );
  });

  it("opens the path limit on edit only when it limits something", async () => {
    const view = await renderDialog({
      secret: customSecret({ headerName: "X-Api-Key" }, "/v2/*"),
    });
    expect(screen.getByPlaceholderText("/v1/*")).toHaveValue("/v2/*");
    view.unmount();

    const updateSecret = updateSpy();
    await renderDialog({
      secretActions: actions({ updateSecret }),
      secret: customSecret({ headerName: "X-Api-Key" }, "/*"),
    });
    expect(screen.queryByPlaceholderText("/v1/*")).not.toBeInTheDocument();
    await saveChanges();
    await waitFor(() =>
      expect(updateSecret).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ pathPattern: null }),
      ),
    );
  });

  // The gateway's credential_not_found link opens this form with
  // `create=generic&host=…&path=/*` plus optional header/format/param.
  it.each([
    [
      { headerName: undefined, valueFormat: undefined },
      { headerName: "Authorization", valueFormat: "Bearer {value}" },
    ],
    [
      { headerName: "X-Api-Key", valueFormat: "{value}" },
      { headerName: "X-Api-Key", valueFormat: "{value}" },
    ],
    [
      { paramName: "api_key", paramFormat: undefined },
      { paramName: "api_key", paramFormat: "{value}" },
    ],
  ])(
    "takes the gateway's add-key link %o as %o, with no path limit",
    async (linkConfig, injectionConfig) => {
      const createSecret = createSpy();
      await renderDialog({
        defaultType: "generic",
        secretActions: actions({ createSecret }),
        prefill: {
          type: "generic",
          hostPattern: "api.acme.io",
          pathPattern: "/*",
          name: "Acme",
          ...linkConfig,
        },
      });
      expect(screen.queryByPlaceholderText("/v1/*")).not.toBeInTheDocument();
      await pasteInto("Paste your API key / Secret", "key-123");
      await addConnection();
      await waitFor(() =>
        expect(createSecret).toHaveBeenCalledWith(
          expect.objectContaining({
            hostPattern: "api.acme.io",
            pathPattern: undefined,
            injectionConfig,
          }),
        ),
      );
    },
  );
});

// The create-then-attach callers (models section, add-connection button,
// direct thread) attach exactly the secret `onSaved` hands them, so the
// dialog must call it ONLY after a create that succeeded: an attach after a
// failed create would 404 or attach a stale id.
describe("SecretDialog onSaved contract", () => {
  afterEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  const fillAndSave = async (
    createSecret: SecretActions["createSecret"],
    onSaved: (created: SavedSecret | undefined) => void,
  ) => {
    await renderDialog({
      defaultType: "anthropic",
      onSaved,
      secretActions: {
        createSecret,
        deleteSecret: vi.fn(),
        updateSecret: vi.fn(),
      },
    });
    await userEvent.click(
      screen.getByPlaceholderText("sk-ant-oat01-… or sk-ant-api03-…"),
    );
    await userEvent.paste(`sk-ant-api03-${"x".repeat(90)}`);
    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));
  };

  it("never calls onSaved when the create is refused, and toasts the reason", async () => {
    const onSaved = vi.fn();
    const createSecret = vi
      .fn<SecretActions["createSecret"]>()
      .mockRejectedValue(new Error("nope"));
    await fillAndSave(createSecret, onSaved);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"));
    expect(createSecret).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("calls onSaved once with exactly the created secret on success", async () => {
    const onSaved = vi.fn();
    const createSecret = vi
      .fn<SecretActions["createSecret"]>()
      .mockResolvedValue({ id: "sec-1" });
    await fillAndSave(createSecret, onSaved);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith({
      id: "sec-1",
      name: "Anthropic Token",
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
