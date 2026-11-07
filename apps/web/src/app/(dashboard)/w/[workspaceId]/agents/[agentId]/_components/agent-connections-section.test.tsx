// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Secret } from "@/lib/api";
import { AgentConnectionsSection } from "./agent-connections-section";

// The unit here is the Custom tab's edit door: a row's pencil opens the
// shared SecretDialog in edit mode for exactly that secret, a second row
// remounts it fresh, and closing keeps it mounted (closed) for the exit
// animation. The data-heavy children are stubbed at their contracts.
const nav = vi.hoisted(() => ({ search: "tab=custom" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1/connections",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/hooks/use-agent-active-connections", () => ({
  useAgentActiveConnections: () => ({ appCount: 0, secretCount: 2 }),
}));

vi.mock("./apps-section", () => ({
  AppsSection: () => <div data-testid="apps-section" />,
}));

vi.mock("./add-connection-button", () => ({
  AddConnectionButton: () => null,
}));

const row = (id: string, name: string) =>
  ({ id, name, type: "generic" }) as Secret;

vi.mock("./secret-grants-tab", () => ({
  SecretGrantsTab: ({ onEdit }: { onEdit?: (secret: Secret) => void }) => (
    <>
      <button onClick={() => onEdit?.(row("sec-1", "Prod key"))}>
        edit prod
      </button>
      <button onClick={() => onEdit?.(row("sec-2", "Staging key"))}>
        edit staging
      </button>
    </>
  ),
}));

const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock(
  "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog",
  async () => {
    const { useState } = await import("react");
    return {
      SecretDialog: ({
        open,
        onOpenChange,
        secret,
      }: {
        open: boolean;
        onOpenChange: (open: boolean) => void;
        secret?: { id: string };
      }) => {
        // Counts mounts: a fresh form per secret is the keyed remount.
        useState(() => {
          mounts.count += 1;
          return null;
        });
        return (
          <div data-testid="edit-dialog" data-open={String(open)}>
            {secret?.id}
            <button onClick={() => onOpenChange(false)}>close</button>
          </div>
        );
      },
    };
  },
);

describe("AgentConnectionsSection Custom tab edit door", () => {
  it("opens the shared dialog in edit mode for the clicked secret", async () => {
    nav.search = "tab=custom";
    mounts.count = 0;
    render(<AgentConnectionsSection agentId="agent-1" />);
    expect(screen.queryByTestId("edit-dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "edit prod" }));
    const dialog = screen.getByTestId("edit-dialog");
    expect(dialog.textContent).toContain("sec-1");
    expect(dialog.getAttribute("data-open")).toBe("true");

    // Closing keeps it mounted, just closed, so the exit animation plays.
    await userEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByTestId("edit-dialog").getAttribute("data-open")).toBe(
      "false",
    );

    // Another row mounts a fresh form for that secret.
    await userEvent.click(screen.getByRole("button", { name: "edit staging" }));
    expect(screen.getByTestId("edit-dialog").textContent).toContain("sec-2");
    expect(screen.getByTestId("edit-dialog").getAttribute("data-open")).toBe(
      "true",
    );
    expect(mounts.count).toBe(2);
  });

  it("offers no edit door on the Apps tab", () => {
    nav.search = "";
    render(<AgentConnectionsSection agentId="agent-1" />);
    expect(screen.getByTestId("apps-section")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "edit prod" })).toBeNull();
    expect(screen.queryByTestId("edit-dialog")).toBeNull();
  });
});
