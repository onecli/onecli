// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { guideHref } from "@/lib/components/setup-guide-link";
import { CredentialsFlow } from "./credentials-flow";

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: vi.fn(),
}));

const app = {
  id: "navan",
  name: "Navan",
  icon: "/icons/navan.svg",
  connectionType: "credentials_import",
};

const fields = [
  { name: "clientId", label: "Client ID", placeholder: "xxxx" },
  {
    name: "clientSecret",
    label: "Secret Key",
    placeholder: "Enter Secret Key",
    secret: true,
  },
];

describe("CredentialsFlow setup guide", () => {
  it("links the setup guide in a new tab when the app has one", () => {
    render(
      <CredentialsFlow
        app={{
          ...app,
          setupGuideUrl: "https://onecli.sh/docs/integrations/navan",
        }}
        fields={fields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    const link = screen.getByRole("link", {
      name: /Follow the Navan setup guide/,
    });
    expect(link.getAttribute("href")).toBe(
      guideHref("https://onecli.sh/docs/integrations/navan"),
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows no guide link when the app has none", () => {
    render(
      <CredentialsFlow
        app={app}
        fields={fields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    expect(screen.queryByRole("link", { name: /setup guide/ })).toBeNull();
  });
});

// A field's hint and the vendor's help link read as one line, not two.
describe("CredentialsFlow field hint", () => {
  it("puts the field hint and its help link on one line", () => {
    const field = {
      name: "apiKey",
      label: "API key",
      description: "In Circleback, go to Settings → API keys.",
      placeholder: "cb_...",
      secret: true,
      helpUrl: "https://circleback.ai/docs/api",
      helpLabel: "Get your API key",
    };
    render(
      <CredentialsFlow
        app={{ ...app, connectionType: "api_key" }}
        fields={[field]}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    const help = screen.getByRole("link", { name: "Get your API key" });
    expect(help.getAttribute("href")).toBe(field.helpUrl);
    expect(help.getAttribute("target")).toBe("_blank");
    expect(help.parentElement?.textContent).toBe(
      `${field.description} ${field.helpLabel}`,
    );
  });
});
