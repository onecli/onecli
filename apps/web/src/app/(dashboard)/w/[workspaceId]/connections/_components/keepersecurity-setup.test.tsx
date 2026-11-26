// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { KeeperSecuritySetup } from "./keepersecurity-setup";

// The connect/manage page for Keeper. The unit is what the page shows for each
// connection state and what it hands to the pair/disconnect actions; the hooks
// that talk to the gateway are covered in use-keepersecurity.test.tsx.
const h = vi.hoisted(() => ({
  status: {
    loading: false,
    isPaired: false,
    isReady: false,
    status: null as {
      status_data: import("@/hooks/use-vault-status").KeeperSecurityStatusData;
    } | null,
    fetchStatus: vi.fn(),
  },
  pair: vi.fn<(method: string, input: string) => Promise<boolean>>(),
  pairing: false,
  disconnect: vi.fn(),
  disconnecting: false,
  providers: [] as string[],
  statusOptions: [] as unknown[],
}));

vi.mock("@/hooks/use-vault-status", () => ({
  useVaultStatus: (provider: string, options?: unknown) => {
    h.providers.push(provider);
    h.statusOptions.push(options);
    return h.status;
  },
  useVaultDisconnect: (_fetch: unknown, provider: string) => {
    h.providers.push(provider);
    return { disconnect: h.disconnect, disconnecting: h.disconnecting };
  },
}));
vi.mock("@/hooks/use-keepersecurity", () => ({
  useKeeperSecurityPair: () => ({ pair: h.pair, pairing: h.pairing }),
}));

// Radix's Select drives its listbox through pointer-capture and scroll APIs
// jsdom does not implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  h.status = {
    loading: false,
    isPaired: false,
    isReady: false,
    status: null,
    fetchStatus: vi.fn(),
  };
  h.pair.mockResolvedValue(true);
  h.pairing = false;
  h.disconnecting = false;
  h.providers = [];
  h.statusOptions = [];
});
afterEach(() => vi.clearAllMocks());

const connectButton = () =>
  screen.getByRole("button", {
    name: /^Connect Keeper|Connecting/,
  });

const TOKEN_LABEL = "One-time access token";

const chooseMethod = async (option: string) => {
  await userEvent.click(
    screen.getByRole("combobox", { name: "Configuration method" }),
  );
  await userEvent.click(await screen.findByRole("option", { name: option }));
};

describe("KeeperSecuritySetup: not connected", () => {
  it("talks to the Keeper provider, not another vault's", () => {
    render(<KeeperSecuritySetup />);
    expect(new Set(h.providers)).toEqual(new Set(["keepersecurity"]));
  });

  it("offers a connect form, starting with the one-time access token method", () => {
    render(<KeeperSecuritySetup />);
    expect(screen.getAllByText(/^Connect Keeper/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("combobox", { name: "Configuration method" }),
    ).toHaveTextContent("One-time access token");
    expect(screen.getByLabelText(TOKEN_LABEL)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Paste your one-time access token"),
    ).toBeInTheDocument();
  });

  it("lists the three connection methods", async () => {
    render(<KeeperSecuritySetup />);
    await userEvent.click(
      screen.getByRole("combobox", { name: "Configuration method" }),
    );
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toEqual(["One-time access token", "Base64 string", "JSON configuration"]);
  });

  it("keeps Connect off until something is entered", async () => {
    render(<KeeperSecuritySetup />);
    expect(connectButton()).toBeDisabled();
    await userEvent.click(screen.getByLabelText(TOKEN_LABEL));
    await userEvent.paste("   ");
    expect(connectButton()).toBeDisabled();
    await userEvent.paste("US:abc");
    expect(connectButton()).toBeEnabled();
  });

  it("hands the method and the pasted text to pair, then clears the field", async () => {
    render(<KeeperSecuritySetup />);
    const field = screen.getByLabelText(TOKEN_LABEL);
    await userEvent.click(field);
    await userEvent.paste("US:abc123");
    await userEvent.click(connectButton());

    expect(h.pair).toHaveBeenCalledWith("one_time_token", "US:abc123");
    expect(field).toHaveValue("");
  });

  it.each([
    ["Base64 string", "Base64 configuration", "base64_config", "eyJhIjoiYiJ9"],
    ["JSON configuration", "JSON configuration", "json_config", '{"a":"b"}'],
  ])(
    "uses the %s method once chosen",
    async (option, fieldLabel, method, value) => {
      render(<KeeperSecuritySetup />);
      await chooseMethod(option);
      const field = screen.getByLabelText(fieldLabel);
      await userEvent.click(field);
      await userEvent.paste(value);
      await userEvent.click(connectButton());

      expect(h.pair).toHaveBeenCalledWith(method, value);
    },
  );

  it("keeps what was pasted when pairing fails, so it can be corrected", async () => {
    h.pair.mockResolvedValue(false);
    render(<KeeperSecuritySetup />);
    const field = screen.getByLabelText(TOKEN_LABEL);
    await userEvent.click(field);
    await userEvent.paste("US:abc123");
    await userEvent.click(connectButton());

    expect(h.pair).toHaveBeenCalledOnce();
    expect(field).toHaveValue("US:abc123");
  });

  it("masks the pasted credential", () => {
    render(<KeeperSecuritySetup />);
    expect(screen.getByLabelText(TOKEN_LABEL)).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("explains that the token is used once and only the configuration is stored", () => {
    render(<KeeperSecuritySetup />);
    expect(screen.getByText(/The token is used\s+once/)).toBeInTheDocument();
  });

  it("shows the form's loading state while connecting", () => {
    h.pairing = true;
    render(<KeeperSecuritySetup />);
    expect(
      screen.getByRole("button", { name: /Connecting/ }),
    ).toBeInTheDocument();
  });

  it("shows a skeleton, not the form, while status loads", () => {
    h.status.loading = true;
    render(<KeeperSecuritySetup />);
    expect(screen.queryByText(/^Connect Keeper/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(TOKEN_LABEL)).not.toBeInTheDocument();
  });
});

describe("KeeperSecuritySetup: connected", () => {
  beforeEach(() => {
    h.status.isPaired = true;
    h.status.isReady = true;
  });

  it("shows Connected and no connect form", () => {
    render(<KeeperSecuritySetup />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText(TOKEN_LABEL)).not.toBeInTheDocument();
  });

  it("tells the user how to use the connection", () => {
    render(<KeeperSecuritySetup />);
    expect(screen.getByText(/keeper:\/\//)).toBeInTheDocument();
  });

  it("shows Paired (not Connected) when stored but not yet confirmed live", () => {
    h.status.isReady = false;
    render(<KeeperSecuritySetup />);
    expect(screen.getByText("Paired")).toBeInTheDocument();
  });

  it("surfaces the last error and offers a refresh", async () => {
    h.status.status = {
      status_data: { last_error: "token decryption failed; re-pair to fix" },
    };
    render(<KeeperSecuritySetup />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(
      screen.getByText("Details: token decryption failed; re-pair to fix"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Refresh status/ }),
    );
    expect(h.status.fetchStatus).toHaveBeenCalledOnce();
  });

  it("asks for confirmation before disconnecting", async () => {
    render(<KeeperSecuritySetup />);
    await userEvent.click(screen.getByRole("button", { name: /^Disconnect$/ }));
    expect(h.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText("Disconnect Keeper?")).toBeInTheDocument();
    expect(
      screen.getByText(/removes the stored Keeper configuration/),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getAllByRole("button", { name: "Disconnect" }).at(-1)!,
    );
    expect(h.disconnect).toHaveBeenCalledOnce();
  });

  it("can be cancelled without disconnecting", async () => {
    render(<KeeperSecuritySetup />);
    await userEvent.click(screen.getByRole("button", { name: /^Disconnect$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.disconnect).not.toHaveBeenCalled();
  });
});

describe("KeeperSecuritySetup: when Keeper access is lost", () => {
  const paired = (status_data: Record<string, unknown>, isReady = true) => {
    h.status.isPaired = true;
    h.status.isReady = isReady;
    h.status.status = {
      status_data: { last_error: null, ...status_data },
    };
  };

  // A revocation on Keeper's side must show without a reload.
  it("keeps its status fresh", () => {
    render(<KeeperSecuritySetup />);
    expect(h.statusOptions).toContainEqual({ autoRefresh: true });
  });

  // OneCLI can't tell an expired configuration from a revoked one from an
  // outage, so every failure reads the same, keeps the detail, and points at
  // disconnecting and connecting again.
  it.each([
    [
      "Keeper refusing the application",
      "Keeper refused OneCLI's Secrets Manager application: Unable to validate Keeper application access",
    ],
    ["Keeper being unreachable", "internal keepersecurity API unreachable"],
  ])("handles %s generically", (_name, lastError) => {
    paired({ reason: "connection_failed", last_error: lastError }, false);
    render(<KeeperSecuritySetup />);

    expect(screen.getByText("Can't connect")).toBeInTheDocument();
    expect(
      screen.getByText(
        /disconnect below and connect again with a new configuration/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(`Details: ${lastError}`)).toBeInTheDocument();
    // The fix is the Disconnect card, not a second connect form.
    expect(
      screen.queryByLabelText("One-time access token"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Disconnect$/ }),
    ).toBeInTheDocument();
  });

  // A gateway from before `reason` existed reports only `last_error`.
  it("treats a bare error the same way", () => {
    paired({ last_error: "boom" }, false);
    render(<KeeperSecuritySetup />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText(/disconnect below/)).toBeInTheDocument();
  });

  it("warns when nothing is shared with the application any more", () => {
    paired({ reason: "no_records", record_count: 0 });
    render(<KeeperSecuritySetup />);
    expect(screen.getByText("No records shared")).toBeInTheDocument();
    expect(
      screen.getByText(/no records shared with OneCLI/),
    ).toBeInTheDocument();
    // Still connected: re-sharing in Keeper fixes it, no reconnect needed.
  });

  it("flags an access limit that has passed", () => {
    paired({ expires_on: "2020-01-01T00:00:00.000Z" });
    render(<KeeperSecuritySetup />);
    expect(screen.getByText(/Keeper access expired on/)).toBeInTheDocument();
  });

  it("shows Keeper's own warnings", () => {
    paired({ warnings: ["Share expires in 2 days"] });
    render(<KeeperSecuritySetup />);
    expect(
      screen.getByText("Keeper: Share expires in 2 days"),
    ).toBeInTheDocument();
  });

  it("reports a single reference that could not resolve, without failing the connection", () => {
    paired({
      resolve_error: {
        ref: "keeper://uid/field/password",
        message: "record not found",
      },
    });
    render(<KeeperSecuritySetup />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("keeper://uid/field/password")).toBeInTheDocument();
    expect(screen.getByText(/record not found/)).toBeInTheDocument();
  });
});
