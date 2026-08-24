// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Secret } from "@/lib/api";
import { SecretGrantsTab } from "./secret-grants-tab";

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/ws-1/agents/agent-1",
}));

// The unit here is the tab's row wiring — pools, grants, and above all the
// org-scope edit suppression (the workspace-fenced update can never own an
// org key, so the pencil must not render). The data hooks are stubbed.
const hoisted = vi.hoisted(() => ({
  secretsData: [] as Secret[],
}));

vi.mock("@/hooks/use-secrets", () => ({
  useSecrets: () => ({
    data: hoisted.secretsData,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/use-grants", () => ({
  useAgentGrants: () => ({
    data: { secrets: [] },
    isPending: false,
    isError: false,
  }),
  useAttachSecret: () => ({ mutate: vi.fn(), isPending: false }),
  useDetachSecret: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/api/policy-visibility", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/policy-visibility")>();
  return {
    ...actual,
    useEffectiveCredentials: () => ({
      data: { secrets: [] },
      isPending: false,
      isError: false,
    }),
  };
});

const secret = (id: string, scope: "workspace" | "organization") =>
  ({
    id,
    name: id,
    type: "anthropic",
    typeLabel: "Anthropic API Key",
    hostPattern: "api.anthropic.com",
    scope,
    lastError: null,
  }) as unknown as Secret;

describe("SecretGrantsTab", () => {
  it("suppresses the edit pencil on org-scoped keys, keeps it on workspace keys", () => {
    hoisted.secretsData = [
      secret("ws-key", "workspace"),
      secret("org-key", "organization"),
    ];
    render(<SecretGrantsTab agentId="agent-1" kind="llm" onEdit={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: "Edit ws-key" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit org-key" }),
    ).not.toBeInTheDocument();
  });

  it("renders no pencil at all when the section provides no edit door", () => {
    hoisted.secretsData = [secret("ws-key", "workspace")];
    render(<SecretGrantsTab agentId="agent-1" kind="llm" />);

    expect(
      screen.queryByRole("button", { name: /^Edit / }),
    ).not.toBeInTheDocument();
  });

  it("filters generic secrets out of the LLM view", () => {
    hoisted.secretsData = [
      secret("ws-key", "workspace"),
      { ...secret("generic-token", "workspace"), type: "generic" } as Secret,
    ];
    render(<SecretGrantsTab agentId="agent-1" kind="llm" onEdit={vi.fn()} />);

    expect(screen.getByText("ws-key")).toBeInTheDocument();
    expect(screen.queryByText("generic-token")).not.toBeInTheDocument();
  });
});
