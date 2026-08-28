// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grants, secrets } from "@/lib/api";
import type { SecretActions } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/types";
import { AddConnectionButton } from "./add-connection-button";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1",
  useRouter: () => ({ push: vi.fn() }),
}));

// The dialogs bring their own data graphs; the unit here is the button's
// create-then-attach seam and the deep link it mints. The stubs mimic the
// real dialogs' contracts: SecretDialog awaits createSecret and calls onSaved
// only on success; the picker fires onGranted with the fresh connection id.
vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  () => ({
    SecretDialog: ({
      onSaved,
      secretActions,
    }: {
      onSaved?: () => void;
      secretActions?: Partial<SecretActions>;
    }) => (
      <>
        <button
          data-testid="save-secret"
          onClick={() => {
            void secretActions
              ?.createSecret?.({ name: "n", type: "generic" } as never)
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
vi.mock("./connect-app-picker-dialog", () => ({
  ConnectAppPickerDialog: ({
    onGranted,
  }: {
    onGranted?: (connectionId: string) => void;
  }) => (
    <button
      data-testid="simulate-granted"
      onClick={() => onGranted?.("conn-9")}
    >
      granted
    </button>
  ),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    secrets: { ...actual.secrets, create: vi.fn() },
    grants: { ...actual.grants, attachSecret: vi.fn().mockResolvedValue({}) },
  };
});

const renderButton = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <AddConnectionButton
      agentId="agent-1"
      tab="custom"
      pickerOpen={false}
      onPickerOpenChange={vi.fn()}
      secretOpen={true}
      onSecretOpenChange={vi.fn()}
    />,
    { wrapper },
  );
};

describe("AddConnectionButton", () => {
  afterEach(() => {
    vi.mocked(secrets.create).mockReset();
    vi.mocked(grants.attachSecret).mockClear();
    window.history.replaceState(null, "", "/w/ws-1/agents/agent-1");
  });

  it("attaches the created secret to the agent — once, with the captured id", async () => {
    vi.mocked(secrets.create).mockResolvedValue({ id: "sec-9" } as never);
    renderButton();

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
    renderButton();

    await userEvent.click(screen.getByTestId("save-secret"));
    await new Promise((r) => setTimeout(r, 0));
    expect(grants.attachSecret).not.toHaveBeenCalled();
  });

  it("routes the button by tab — apps opens the picker, custom the secret dialog", async () => {
    const onPickerOpenChange = vi.fn();
    const onSecretOpenChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { rerender } = render(
      <AddConnectionButton
        agentId="agent-1"
        tab="apps"
        pickerOpen={false}
        onPickerOpenChange={onPickerOpenChange}
        secretOpen={false}
        onSecretOpenChange={onSecretOpenChange}
      />,
      { wrapper },
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add connection" }),
    );
    expect(onPickerOpenChange).toHaveBeenCalledWith(true);
    expect(onSecretOpenChange).not.toHaveBeenCalled();

    rerender(
      <AddConnectionButton
        agentId="agent-1"
        tab="custom"
        pickerOpen={false}
        onPickerOpenChange={onPickerOpenChange}
        secretOpen={false}
        onSecretOpenChange={onSecretOpenChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add connection" }),
    );
    expect(onSecretOpenChange).toHaveBeenCalledWith(true);
  });

  it("mints the manage deep link shallowly, preserving foreign params and dropping tab", async () => {
    window.history.replaceState(
      null,
      "",
      "/w/ws-1/agents/agent-1?tab=custom&foo=bar",
    );
    renderButton();

    await userEvent.click(screen.getByTestId("simulate-granted"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("connection")).toBe("conn-9");
    expect(params.get("manage")).toBe("1");
    expect(params.get("foo")).toBe("bar");
    expect(params.get("tab")).toBeNull();
  });
});
