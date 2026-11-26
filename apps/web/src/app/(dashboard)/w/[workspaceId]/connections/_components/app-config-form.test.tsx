// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppConfigForm } from "./app-config-form";

// The unit is what the Custom credentials section shows, so the config hooks
// return a fixed "nothing saved yet" state instead of hitting the API.
const save = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-app-config", () => {
  const idle = { mutateAsync: vi.fn(), isPending: false };
  return {
    useAppConfigStatus: () => ({
      data: { hasCredentials: false, enabled: false },
      isPending: false,
    }),
    useSaveAppConfig: () => ({ mutateAsync: save, isPending: false }),
    useDeleteAppConfig: () => idle,
    useToggleAppConfig: () => idle,
  };
});
vi.mock("@/hooks/use-copy-to-clipboard", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const fields = [
  { name: "clientId", label: "Client ID", placeholder: "client-id" },
  {
    name: "clientSecret",
    label: "Client Secret",
    placeholder: "secret",
    secret: true,
  },
];

const renderForm = (
  setupGuideUrl?: string,
  { provider = "github", appName = "GitHub", isConnected = false } = {},
) =>
  render(
    <AppConfigForm
      provider={provider}
      appName={appName}
      fields={fields}
      setupGuideUrl={setupGuideUrl}
      hasEnvDefaults
      isConnected={isConnected}
    />,
  );

const openSection = () =>
  userEvent.click(screen.getByRole("button", { name: /Custom credentials/ }));

describe("AppConfigForm setup guide", () => {
  // The app's guide sits inside Custom credentials, right above the Redirect
  // URI the guide tells you to register.
  it("shows the app's setup guide above the Redirect URI", async () => {
    renderForm("https://onecli.sh/docs/integrations/github");
    await openSection();
    const guide = screen.getByRole("link", {
      name: /Follow the GitHub setup guide/,
    });
    const redirect = screen.getByText("Redirect URI");
    expect(
      guide.compareDocumentPosition(redirect) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no guide link when the app has none", async () => {
    renderForm();
    await openSection();
    expect(screen.queryByRole("link", { name: /setup guide/ })).toBeNull();
  });

  // One Google client serves every Google app, so a Google app links the
  // Google guide once, never its own page as a second guide.
  it("links the vendor's guide, once, for an app that shares a vendor client", async () => {
    renderForm("https://onecli.sh/docs/integrations/gmail", {
      provider: "gmail",
      appName: "Gmail",
    });
    await openSection();
    const guides = screen.getAllByRole("link", { name: /setup guide/ });
    expect(guides).toHaveLength(1);
    expect(guides[0]).toHaveAccessibleName(/Follow the Google setup guide/);
  });
});

describe("AppConfigForm save on a vendor-shared client", () => {
  // Saving replaces the client every Google app in this scope uses, so the
  // confirm names the vendor, not just the app on screen.
  it("confirms that every connected app of the vendor will be disconnected", async () => {
    renderForm(undefined, {
      provider: "gmail",
      appName: "Gmail",
      isConnected: true,
    });
    await openSection();
    await userEvent.type(screen.getByLabelText("Client ID"), "cid");
    await userEvent.click(
      screen.getByRole("button", { name: "Save credentials" }),
    );
    expect(
      screen.getByRole("heading", {
        name: "This will disconnect your Google apps",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/disconnect every Google app connected here/),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});
