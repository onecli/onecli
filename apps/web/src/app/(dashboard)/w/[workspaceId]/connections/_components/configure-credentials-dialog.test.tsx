// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthConfigField } from "@onecli/api/apps/types";
import { ConfigureCredentialsDialog } from "./configure-credentials-dialog";

// The unit is the dialog's own form logic: how an `options` field renders,
// what reaches the save payload, and when the guide link shows. The real
// `useSaveAppConfig` → `appConfig.save` chain runs; only the HTTP client is
// stubbed, so the assertion is on the exact body the API would receive.
const mocks = vi.hoisted(() => ({
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
}));

vi.mock("@/lib/api/client", () => ({
  apiGet: vi.fn(),
  apiPost: mocks.apiPost,
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));
vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// Structural chrome (AppIcon renders through next/image).
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: unknown; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  ),
}));

const TEXT_FIELDS: OAuthConfigField[] = [
  { name: "clientId", label: "Consumer Key", placeholder: "3MVG9..." },
  {
    name: "clientSecret",
    label: "Consumer Secret",
    placeholder: "secret",
    secret: true,
  },
];

const ENVIRONMENT: OAuthConfigField = {
  name: "environment",
  label: "Environment",
  options: [
    { value: "production", label: "Production" },
    { value: "sandbox", label: "Sandbox" },
  ],
  defaultValue: "production",
};

const renderDialog = (
  props: Partial<Parameters<typeof ConfigureCredentialsDialog>[0]> = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const onConfigured = vi.fn();
  render(
    <ConfigureCredentialsDialog
      provider="salesforce"
      appName="Salesforce"
      appIcon="/icons/salesforce.svg"
      fields={[...TEXT_FIELDS, ENVIRONMENT]}
      open
      onOpenChange={() => {}}
      onConfigured={onConfigured}
      {...props}
    />,
    { wrapper },
  );
  return { onConfigured };
};

const fillTextFields = async () => {
  await userEvent.type(screen.getByLabelText(/Consumer Key/), "key");
  await userEvent.type(screen.getByLabelText(/Consumer Secret/), "secret");
};

describe("ConfigureCredentialsDialog", () => {
  afterEach(() => {
    mocks.apiPost.mockReset();
  });

  it("renders an options field as a labelled segmented control with the default pressed", () => {
    renderDialog();

    const group = screen.getByRole("group", { name: /Environment/ });
    const production = screen.getByRole("button", { name: "Production" });
    const sandbox = screen.getByRole("button", { name: "Sandbox" });
    expect(group).toContainElement(production);
    expect(production).toHaveAttribute("aria-pressed", "true");
    expect(sandbox).toHaveAttribute("aria-pressed", "false");
    // No text input competes with the control for the field.
    expect(screen.queryByRole("textbox", { name: /Environment/ })).toBeNull();
  });

  it("submits the untouched default alongside the typed fields", async () => {
    mocks.apiPost.mockResolvedValue({ success: true });
    const { onConfigured } = renderDialog();

    const save = screen.getByRole("button", { name: "Save & Connect" });
    // Two text fields are empty, so the default alone doesn't unlock save.
    expect(save).toBeDisabled();
    await fillTextFields();
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() => expect(onConfigured).toHaveBeenCalledOnce());
    expect(mocks.apiPost).toHaveBeenCalledWith("/v1/apps/salesforce/config", {
      clientId: "key",
      clientSecret: "secret",
      environment: "production",
    });
  });

  it("submits the switched option", async () => {
    mocks.apiPost.mockResolvedValue({ success: true });
    renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Sandbox" }));
    expect(screen.getByRole("button", { name: "Sandbox" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Production" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    await fillTextFields();
    await userEvent.click(
      screen.getByRole("button", { name: "Save & Connect" }),
    );

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledOnce());
    expect(mocks.apiPost.mock.calls[0]?.[1]).toMatchObject({
      environment: "sandbox",
    });
  });

  it("links the setup guide in a new tab only when the app declares one", () => {
    renderDialog({
      setupGuideUrl: "https://onecli.sh/docs/integrations/salesforce",
    });
    const link = screen.getByRole("link", {
      name: /Follow the Salesforce setup guide/,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://onecli.sh/docs/integrations/salesforce",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows no guide link for apps without one", () => {
    renderDialog({ fields: TEXT_FIELDS });
    expect(screen.queryByRole("link", { name: /setup guide/ })).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
  });
});
