// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// A field with fixed choices (a region) is a dropdown, starts on its default,
// and that default is submitted even if the user never opens the dropdown.
describe("CredentialsFlow option fields", () => {
  const regionFields = [
    {
      name: "apiKey",
      label: "API key",
      placeholder: "key",
      secret: true,
    },
    {
      name: "region",
      label: "Region",
      placeholder: "Select a region",
      secret: false,
      options: [
        { value: "us", label: "US (api.pagerduty.com)" },
        { value: "eu", label: "EU (api.eu.pagerduty.com)" },
      ],
      defaultValue: "us",
    },
  ];

  it("renders a dropdown showing the default, not a text box", () => {
    render(
      <CredentialsFlow
        app={{ ...app, connectionType: "api_key" }}
        fields={regionFields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    const trigger = screen.getByRole("combobox");
    expect(trigger.id).toBe("connect-region");
    expect(trigger.textContent).toContain("US (api.pagerduty.com)");
    expect(document.getElementById("connect-region")?.tagName).not.toBe(
      "INPUT",
    );
  });

  it("submits the default region without the user touching it", async () => {
    const { apiFetch } = await import("@/lib/api-fetch");
    const fetchMock = vi.mocked(apiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "c1", label: null }), { status: 200 }),
    );
    render(
      <CredentialsFlow
        app={{ ...app, name: "PagerDuty", connectionType: "api_key" }}
        fields={regionFields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    const key = document.getElementById("connect-apiKey") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "pd-key" } });
    const button = screen.getByRole("button", { name: "Connect PagerDuty" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { fields: Record<string, string>; agentId?: string };
    expect(body.fields).toEqual({ apiKey: "pd-key", region: "us" });
    // A workspace connect names no agent: the account lands on for none.
    expect(body).not.toHaveProperty("agentId");
  });

  it("sends the connecting agent, so the account lands on for it", async () => {
    const { apiFetch } = await import("@/lib/api-fetch");
    const fetchMock = vi.mocked(apiFetch);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "c1", label: null }), { status: 200 }),
    );
    render(
      <CredentialsFlow
        app={{ ...app, name: "PagerDuty", connectionType: "api_key" }}
        fields={regionFields}
        agentId="agent-7"
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    const key = document.getElementById("connect-apiKey") as HTMLInputElement;
    fireEvent.change(key, { target: { value: "pd-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect PagerDuty" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { agentId?: string };
    expect(body.agentId).toBe("agent-7");
  });
});
