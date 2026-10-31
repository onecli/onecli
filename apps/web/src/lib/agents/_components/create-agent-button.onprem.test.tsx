// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The ONPREM arm of the quota gate: a billing-less edition has no plan usage
 * to read (`usePlanUsage` never fetches without `CAPS.billing`), so the gate
 * holds nothing back and asks the server for nothing. The real hooks, no
 * quota mock: the gate's onprem arm is exactly what is under test.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const getPlanUsage = vi.hoisted(() => vi.fn());
vi.mock("@/ee/billing/api-request-actions", () => ({ getPlanUsage }));
vi.mock("next/navigation", () => ({ usePathname: () => "/w/ws-1/agents" }));

const { CreateAgentButton } = await import("./create-agent-button");

afterEach(cleanup);

describe("CreateAgentButton (onprem)", () => {
  it("lets the click through and never reads plan usage", async () => {
    const onClick = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CreateAgentButton onClick={onClick} label="New agent" />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(getPlanUsage).not.toHaveBeenCalled();
    expect(screen.queryByText(/limit reached/i)).toBeNull();
  });
});
