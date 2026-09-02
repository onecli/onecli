// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * Baked-fallback arm: a source-checkout self-host, where the api-server has
 * no APP_VERSION (reports "unknown") but the web build baked the root
 * package.json version. This file exists to pin the component-level WIRING —
 * that SidebarVersion really passes the real baked APP_VERSION into
 * displayVersion — which the onprem arm (baked with "dev") cannot see.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  process.env.NEXT_PUBLIC_APP_VERSION = "9.9.9";
  delete process.env.EDITION;
});

vi.mock("@/lib/api/instance", () => ({
  get: (): Promise<InstanceInfo> =>
    Promise.resolve({ edition: "onprem", entitled: false, version: "unknown" }),
}));

const { SidebarVersion } = await import("./sidebar-version");
const { APP_VERSION, IS_CLOUD } = await import("@/lib/env");

it("premise: an onprem build with a real baked version", () => {
  expect(IS_CLOUD).toBe(false);
  expect(APP_VERSION).toBe("9.9.9");
});

it("an unknown API version falls back to the baked build version", async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SidebarVersion />
    </QueryClientProvider>,
  );
  await screen.findByText("v9.9.9");
});
