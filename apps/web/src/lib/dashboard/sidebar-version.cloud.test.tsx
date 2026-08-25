// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * Cloud arm: on a cloud build the version indicator never renders, even when
 * the wire adversarially claims the deployment is onprem — the build-time
 * gate holds on its own. The onprem arm lives in
 * sidebar-version.onprem.test.tsx.
 */

// Pin cloud before the module graph loads; EDITION deleted so an ambient
// shell can't skew the parse (unset parses to onprem).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "cloud";
  delete process.env.EDITION;
});

// A lying wire: onprem edition with a perfectly real version.
vi.mock("@/lib/api/instance", () => ({
  get: (): Promise<InstanceInfo> =>
    Promise.resolve({ edition: "onprem", entitled: true, version: "9.9.9" }),
}));

const { SidebarVersion } = await import("./sidebar-version");
const { IS_CLOUD } = await import("@/lib/env");

it("premise: this file really runs the cloud build arm", () => {
  expect(IS_CLOUD).toBe(true);
});

it("a lying wire cannot surface the version line on a cloud build", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <SidebarVersion />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(client.getQueryState(queryKeys.instance.all())?.status).toBe(
      "success",
    ),
  );
  expect(container.firstChild).toBeNull();
});
