// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grants, secrets } from "@/lib/api";
import type { Secret } from "@/lib/api";
import type { SecretActions } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/types";
import { ModelsSection } from "./models-section";

// The section composes data-graph-heavy children; the unit here is the
// create-then-attach seam, the header door's visibility, and the edit-door
// wiring. The stubs mimic the real contracts: SecretDialog awaits
// createSecret and calls onSaved only on success; the grants tab surfaces
// onEdit per row.
const hoisted = vi.hoisted(() => ({
  secretsData: [] as Secret[],
}));

vi.mock("@/hooks/use-secrets", () => ({
  useSecrets: () => ({ data: hoisted.secretsData, isPending: false }),
}));

vi.mock("./model-card", () => ({
  ModelCard: () => <div data-testid="model-card" />,
}));

vi.mock("./secret-grants-tab", () => ({
  SecretGrantsTab: ({
    onAdd,
    onEdit,
  }: {
    onAdd?: () => void;
    onEdit?: (secret: Secret) => void;
  }) => (
    <>
      <button data-testid="tab-add" onClick={() => onAdd?.()}>
        tab add
      </button>
      <button
        data-testid="edit-row"
        onClick={() => onEdit?.({ id: "sec-1", name: "My key" } as Secret)}
      >
        edit row
      </button>
    </>
  ),
}));

vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  () => ({
    SecretDialog: ({
      open,
      onSaved,
      secretActions,
      secret,
      allowedTypes,
    }: {
      open: boolean;
      onSaved?: () => void;
      secretActions?: Partial<SecretActions>;
      secret?: { id: string };
      allowedTypes?: string[];
    }) =>
      secret ? (
        <div data-testid="edit-dialog">{secret.id}</div>
      ) : (
        <>
          <span data-testid="create-open">{String(open)}</span>
          <span data-testid="allowed-types">{allowedTypes?.join(",")}</span>
          <button
            data-testid="save-secret"
            onClick={() => {
              void secretActions
                ?.createSecret?.({ name: "n", type: "anthropic" } as never)
                .then(() => onSaved?.())
                .catch(() => {
                  /* the real dialog toasts and does NOT call onSaved */
                });
            }}
          >
            save
          </button>
          {/* An onSaved with no create behind it — the edit-save shape. */}
          <button data-testid="save-no-create" onClick={() => onSaved?.()}>
            save edit
          </button>
        </>
      ),
  }),
);

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    secrets: { ...actual.secrets, create: vi.fn() },
    grants: { ...actual.grants, attachSecret: vi.fn().mockResolvedValue({}) },
  };
});

const llmKey = { id: "sec-a", name: "Anthropic", type: "anthropic" } as Secret;
const genericSecret = { id: "sec-g", name: "Token", type: "generic" } as Secret;

const renderSection = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<ModelsSection agentId="agent-1" />, { wrapper });
};

describe("ModelsSection", () => {
  afterEach(() => {
    vi.mocked(secrets.create).mockReset();
    vi.mocked(grants.attachSecret).mockClear();
    hoisted.secretsData = [];
  });

  it("attaches the created key to the agent — once, with the captured id", async () => {
    vi.mocked(secrets.create).mockResolvedValue({ id: "sec-9" } as never);
    renderSection();

    await userEvent.click(screen.getByTestId("save-secret"));
    await waitFor(() =>
      expect(grants.attachSecret).toHaveBeenCalledWith("agent-1", "sec-9"),
    );

    // The ref is consumed on save: an onSaved with no create behind it must
    // not replay the previous id.
    await userEvent.click(screen.getByTestId("save-no-create"));
    await new Promise((r) => setTimeout(r, 0));
    expect(grants.attachSecret).toHaveBeenCalledTimes(1);
  });

  it("never attaches when the create failed", async () => {
    vi.mocked(secrets.create).mockRejectedValue(new Error("nope"));
    renderSection();

    await userEvent.click(screen.getByTestId("save-secret"));
    await new Promise((r) => setTimeout(r, 0));
    expect(grants.attachSecret).not.toHaveBeenCalled();
  });

  it("hides the header door while the empty state carries the CTA", () => {
    hoisted.secretsData = [genericSecret]; // generic ≠ LLM pool
    renderSection();
    expect(
      screen.queryByRole("button", { name: "Add LLM key" }),
    ).not.toBeInTheDocument();
  });

  it("shows the header door once an LLM key exists", () => {
    hoisted.secretsData = [genericSecret, llmKey];
    renderSection();
    expect(
      screen.getByRole("button", { name: "Add LLM key" }),
    ).toBeInTheDocument();
  });

  it("opens the edit door for the row's secret", async () => {
    renderSection();
    expect(screen.queryByTestId("edit-dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("edit-row"));
    expect(screen.getByTestId("edit-dialog")).toHaveTextContent("sec-1");
  });

  it("constrains the create door to LLM key types — the Models page mints no generic secrets", () => {
    renderSection();
    expect(screen.getByTestId("allowed-types")).toHaveTextContent(
      "anthropic,openai",
    );
  });

  it("threads the tab's empty-state door to the same create dialog", async () => {
    renderSection();
    expect(screen.getByTestId("create-open")).toHaveTextContent("false");

    await userEvent.click(screen.getByTestId("tab-add"));
    expect(screen.getByTestId("create-open")).toHaveTextContent("true");
  });
});
