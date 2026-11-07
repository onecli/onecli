// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SavedSecret } from "@/lib/api";
import { SecretsContent } from "./secrets-content";

/**
 * A workspace's custom connection starts on for no agent, so the Custom tab
 * opens the "choose agents" window straight after one is added, and each
 * card keeps an Agents door to it. Neither appears where agents can't be
 * chosen: an org page, or the LLM-keys tab.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The card, dialog, and window bring their own data graphs; the unit here is
// the wiring between them. The dialog stub mimics the real contract: onSaved
// carries the created secret, or nothing after an edit.
vi.mock("./secret-card", () => ({
  SecretCard: ({
    secret,
    onChooseAgents,
  }: {
    secret: { name: string };
    onChooseAgents?: () => void;
  }) =>
    onChooseAgents ? (
      <button onClick={onChooseAgents}>{secret.name} agents</button>
    ) : (
      <span>{secret.name}</span>
    ),
}));
vi.mock("./secret-dialog", () => ({
  SecretDialog: ({
    open,
    onSaved,
    onOpenChange,
  }: {
    open: boolean;
    onSaved?: (created: SavedSecret | undefined) => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <button
        onClick={() => {
          onSaved?.({ id: "sec-new", name: "Stripe API" });
          onOpenChange(false);
        }}
      >
        save
      </button>
    ) : null,
}));
vi.mock("@/lib/components/policy-reflect", () => ({
  SecretAgentsDialog: ({
    secretId,
    justAdded,
    open,
  }: {
    secretId: string;
    justAdded?: boolean;
    open: boolean;
  }) =>
    open ? (
      <div role="dialog">
        {secretId}: {justAdded ? "just added" : "reopened"}
      </div>
    ) : null,
}));

const existing = {
  id: "sec-1",
  name: "Linear token",
  type: "generic",
  typeLabel: "Generic",
  hostPattern: "api.linear.app",
  pathPattern: null,
  injectionConfig: null,
  metadata: null,
  scope: null,
  createdAt: new Date(),
};

const renderContent = (
  props: Partial<React.ComponentProps<typeof SecretsContent>> = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <SecretsContent
      typeFilter="generic"
      getSecrets={async () => [existing]}
      {...props}
    />,
    { wrapper },
  );
};

describe("SecretsContent: choosing agents for a custom connection", () => {
  it("opens the window as 'just added' straight after a workspace custom connection is added", async () => {
    renderContent();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add connection" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("sec-new: just added");
  });

  it("reopens the window from a card as an edit, not as just added", async () => {
    renderContent();
    await userEvent.click(
      await screen.findByRole("button", { name: "Linear token agents" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("sec-1: reopened");
  });

  it("offers no agent choice on an org page, where agents don't live", async () => {
    renderContent({ pageScope: "organization" });
    expect(await screen.findByText("Linear token")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Add connection" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no agent choice for an LLM key, which reaches keyless agents by itself", async () => {
    renderContent({
      typeFilter: "llm",
      getSecrets: async () => [{ ...existing, type: "anthropic" }],
    });
    expect(await screen.findByText("Linear token")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add LLM Key" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
