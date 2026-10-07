// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppConfigForm } from "./app-config-form";

// The unit is what the Custom credentials section shows, so the config hooks
// return a fixed "nothing saved yet" state instead of hitting the API.
vi.mock("@/hooks/use-app-config", () => {
  const idle = { mutateAsync: vi.fn(), isPending: false };
  return {
    useAppConfigStatus: () => ({
      data: { hasCredentials: false, enabled: false },
      isPending: false,
    }),
    useSaveAppConfig: () => idle,
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

const renderForm = (setupGuideUrl?: string) =>
  render(
    <AppConfigForm
      provider="gmail"
      appName="Gmail"
      fields={fields}
      setupGuideUrl={setupGuideUrl}
      hasEnvDefaults
      isConnected={false}
    />,
  );

const openSection = () =>
  userEvent.click(screen.getByRole("button", { name: /Custom credentials/ }));

describe("AppConfigForm setup guide", () => {
  // The app's guide sits inside Custom credentials, right above the Redirect
  // URI the guide tells you to register.
  it("shows the app's setup guide above the Redirect URI", async () => {
    renderForm("https://onecli.sh/docs/integrations/gmail");
    await openSection();
    const guide = screen.getByRole("link", {
      name: /Follow the Gmail setup guide/,
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
});
