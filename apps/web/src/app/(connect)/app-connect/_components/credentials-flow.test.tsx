// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import {
  fireEvent,
  render as testingRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { guideHref } from "@/lib/components/setup-guide-link";
import { CredentialsFlow } from "./credentials-flow";

vi.mock("@/lib/api-fetch", () => ({
  apiFetch: vi.fn(),
  getWorkspaceId: () => undefined,
  getOrganizationId: () => undefined,
}));

const render = (ui: ReactElement) =>
  testingRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());

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

describe("credential control accessibility", () => {
  it("reveals and hides a password with Tab and keyboard without submitting", async () => {
    const { apiFetch } = await import("@/lib/api-fetch");
    render(
      <CredentialsFlow
        workspaceId="w"
        app={app}
        fields={fields}
        onSuccess={vi.fn()}
        onError={vi.fn()}
      />,
    );
    const secret = screen.getByLabelText(/Secret Key/);
    fireEvent.change(secret, { target: { value: "kept-secret" } });
    await userEvent.tab();
    expect(secret).toHaveFocus();
    await userEvent.tab();
    const reveal = screen.getByRole("button", { name: "Show secret" });
    expect(reveal).toHaveFocus();
    expect(reveal).toHaveClass("size-11", "focus-visible:ring-2");
    expect(reveal.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    await userEvent.keyboard("{Enter}");
    expect(secret).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide secret" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue("kept-secret");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("exposes required semantics, touch sizes, readable helpers and reduced motion", () => {
    render(
      <CredentialsFlow
        workspaceId="w"
        app={app}
        fields={[
          ...fields,
          {
            name: "region",
            label: "Region",
            placeholder: "Region",
            options: [{ value: "us", label: "US" }],
            defaultValue: "us",
          },
          {
            name: "certificate",
            label: "Certificate",
            placeholder: "PEM",
            secret: false,
          },
          {
            name: "note",
            label: "Note",
            placeholder: "Optional",
            optional: true,
          },
        ]}
        onSuccess={vi.fn()}
        onError={vi.fn()}
      />,
    );
    for (const label of [/Client ID/, /Secret Key/, /Region/, /Certificate/])
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "aria-required",
        "true",
      );
    for (const label of [/Client ID/, /Secret Key/, /Region/])
      expect(screen.getByLabelText(label)).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: "Connect Navan" })).toHaveClass(
      "min-h-11",
    );
    const advanced = screen.getByRole("button", { name: "Advanced" });
    expect(advanced).toHaveClass(
      "text-muted-foreground",
      "dark:text-foreground/70",
    );
    expect(advanced.querySelector("svg")).toHaveClass(
      "motion-reduce:transition-none",
    );
    fireEvent.click(advanced);
    expect(screen.getByLabelText("Note")).toHaveAttribute(
      "aria-required",
      "false",
    );
    const label = screen.getByLabelText("Connection label");
    expect(label).toHaveAttribute("name", "label");
    expect(label).toHaveAttribute("autocomplete", "off");
    expect(document.getElementById("connect-label-help")).toHaveClass(
      "text-muted-foreground",
      "dark:text-foreground/70",
    );
    expect(
      document.getElementById(advanced.getAttribute("aria-controls") ?? ""),
    ).toHaveClass("motion-reduce:animate-none");
  });
});

describe("ordinary credentials ambient scope", () => {
  it("saves without an explicit workspace using the existing API ambient/default scope", async () => {
    const { apiFetch } = await import("@/lib/api-fetch");
    const fetchMock = vi.mocked(apiFetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true, connectionId: "ordinary" })),
    );
    const onSuccess = vi.fn();
    render(
      <CredentialsFlow
        app={app}
        fields={fields}
        onSuccess={onSuccess}
        onError={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Client ID/), {
      target: { value: "client" },
    });
    fireEvent.change(screen.getByLabelText(/Secret Key/), {
      target: { value: "secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Navan" }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(undefined));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });
});

describe("PostgreSQL advanced defaults", () => {
  it("submits certificate verification without opening Advanced", async () => {
    const { postgres } = await import("@onecli/api/apps/postgres");
    const { apiFetch } = await import("@/lib/api-fetch");
    if (postgres.connectionMethod.type !== "api_key")
      throw new Error("Expected credentials");
    const fetchMock = vi.mocked(apiFetch);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          connectionId: "database-proof",
          connection: { id: "database-proof", label: null },
        }),
      ),
    );
    render(
      <CredentialsFlow
        workspaceId="w"
        app={{
          id: "postgres",
          name: "PostgreSQL",
          icon: "/icons/postgresql.svg",
          connectionType: "api_key",
        }}
        fields={postgres.connectionMethod.fields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    for (const [label, value] of [
      [/Password/, "local-proof-password"],
      [/Host/, "db.example.com"],
      [/Database/, "orders"],
      [/Username/, "agent_readonly"],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Connect PostgreSQL" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
      '"sslmode":"require"',
    );
    // Encrypt only: no CA certificate is offered or sent.
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(
      "sslrootcert",
    );
  });
});

describe("CredentialsFlow setup guide", () => {
  it("links the setup guide in a new tab when the app has one", () => {
    render(
      <CredentialsFlow
        workspaceId="w"
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
        workspaceId="w"
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
        workspaceId="w"
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
    expect(help.parentElement).toHaveClass("dark:text-foreground/70");
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
        workspaceId="w"
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
      new Response(
        JSON.stringify({
          success: true,
          connectionId: "c1",
          connection: { id: "c1", label: null },
        }),
        { status: 200 },
      ),
    );
    render(
      <CredentialsFlow
        workspaceId="w"
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
      new Response(
        JSON.stringify({
          success: true,
          connectionId: "c1",
          connection: { id: "c1", label: null },
        }),
        { status: 200 },
      ),
    );
    render(
      <CredentialsFlow
        workspaceId="w"
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

describe("CredentialsFlow label placeholder", () => {
  it.each([
    ['e.g. "production", "dev-account"', '"production", "dev-account"'],
    ['e.g. "Orders (prod, read-only)"', "Orders (prod, read-only)"],
    [undefined, "personal, work…"],
  ])("shows %j as %j", (labelHint, placeholder) => {
    render(
      <CredentialsFlow
        workspaceId="w"
        app={{ ...app, labelHint }}
        fields={fields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByLabelText("Connection label")).toHaveAttribute(
      "placeholder",
      placeholder,
    );
  });
});

describe("CredentialsFlow conditional certificate upload", () => {
  const caFields = [
    { name: "host", label: "Host", placeholder: "h", secret: false },
    {
      name: "sslmode",
      label: "TLS",
      placeholder: "",
      optional: true,
      options: [
        { value: "verify-full", label: "Verify" },
        { value: "require", label: "Encrypt only" },
      ],
      defaultValue: "require",
    },
    {
      name: "sslrootcert",
      label: "CA certificate",
      placeholder: "",
      optional: true,
      secret: false,
      showWhen: { field: "sslmode", value: "verify-full" },
      fileUpload: { accept: ".pem", label: "Upload certificate" },
    },
  ];

  it("hides the CA under Encrypt only and offers an upload under Verify", async () => {
    render(
      <CredentialsFlow
        workspaceId="w"
        app={app}
        fields={caFields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.queryByText("CA certificate")).toBeNull();
    fireEvent.change(document.querySelector('select[name="sslmode"]')!, {
      target: { value: "verify-full" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Upload certificate/ }),
      ).toBeTruthy(),
    );
    const file = new File(
      ["-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n"],
      "ca.pem",
    );
    fireEvent.change(screen.getByLabelText("CA certificate"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByText("ca.pem")).toBeTruthy());
  });
});

describe("CredentialsFlow connection string paste", () => {
  const dbFields = [
    { name: "password", label: "Password", placeholder: "p", secret: true },
    { name: "host", label: "Host", placeholder: "h", secret: false },
    { name: "database", label: "Database", placeholder: "d", secret: false },
    { name: "username", label: "Username", placeholder: "u", secret: false },
    {
      name: "port",
      label: "Port",
      placeholder: "5432",
      secret: false,
      optional: true,
    },
  ];

  it("fills the fields, opens Advanced for a custom port, and clears the box", async () => {
    render(
      <CredentialsFlow
        workspaceId="w"
        app={{ ...app, database: { engine: "postgres" } }}
        fields={dbFields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Paste a connection string/ }),
    );
    const box = screen.getByLabelText("Connection string");
    fireEvent.change(box, {
      target: { value: "postgresql://agent:s3cret@db.example.com:6543/orders" },
    });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByLabelText(/Host/)).toHaveProperty(
        "value",
        "db.example.com",
      ),
    );
    expect(screen.getByLabelText(/Database/)).toHaveProperty("value", "orders");
    expect(screen.getByLabelText(/Username/)).toHaveProperty("value", "agent");
    expect(screen.getByLabelText(/Password/)).toHaveProperty("value", "s3cret");
    expect(screen.getByLabelText("Port")).toHaveProperty("value", "6543");
    // The box closes once it has filled the form, leaving a confirmation.
    expect(screen.queryByLabelText("Connection string")).toBeNull();
    expect(
      screen.getByText(/Filled in from the connection string/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Paste another/ })).toBeTruthy();
  });
});

describe("CredentialsFlow option warning", () => {
  const tlsFields = [
    { name: "host", label: "Host", placeholder: "h", secret: false },
    {
      name: "sslmode",
      label: "TLS",
      placeholder: "",
      optional: true,
      options: [
        { value: "require", label: "Encrypt only" },
        {
          value: "disable",
          label: "No encryption",
          warning: "Queries cross the internet unencrypted.",
        },
      ],
      defaultValue: "require",
    },
  ];

  it("shows an option's warning only while it is chosen", async () => {
    render(
      <CredentialsFlow
        workspaceId="w"
        app={app}
        fields={tlsFields}
        onSuccess={() => {}}
        onError={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.queryByText(/cross the internet unencrypted/)).toBeNull();
    fireEvent.change(document.querySelector('select[name="sslmode"]')!, {
      target: { value: "disable" },
    });
    await waitFor(() =>
      expect(screen.getByText(/cross the internet unencrypted/)).toBeTruthy(),
    );
  });
});
