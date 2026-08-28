// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/api/keys";
import type { InstanceInfo } from "@/lib/api/types";

/**
 * Onprem arm of the sidebar version indicator: the real wire→hook→DOM chain
 * on a self-host build. The cloud arm (build-time gate) lives in
 * sidebar-version.cloud.test.tsx; the sidebar-composition integration
 * assertions live in the dashboard-sidebar test pair.
 */

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  delete process.env.EDITION;
  // The fallback-arm tests rely on the web bundle baking no version ("dev").
  delete process.env.NEXT_PUBLIC_APP_VERSION;
});

const state = vi.hoisted(() => ({
  edition: "onprem" as InstanceInfo["edition"],
  version: "test",
  hang: false,
}));

// The ONLY data mock: the wire. useInstance and the component run for real.
vi.mock("@/lib/api/instance", () => ({
  get: (): Promise<InstanceInfo> =>
    state.hang
      ? new Promise<InstanceInfo>(() => {})
      : Promise.resolve({
          edition: state.edition,
          entitled: false,
          version: state.version,
        }),
}));

const { SidebarVersion, displayVersion } = await import("./sidebar-version");
const { IS_CLOUD, APP_VERSION } = await import("@/lib/env");

// Radix popper layers want a ResizeObserver; jsdom has none. A tooltip may
// open incidentally around trigger focus, so keep the suite deterministic.
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const writeText = vi.fn<(text: string) => Promise<void>>(() =>
  Promise.resolve(),
);
Object.defineProperty(window.navigator, "clipboard", {
  value: { writeText },
  configurable: true,
});

const renderVersion = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <SidebarVersion />
    </QueryClientProvider>,
  );
  return { client, ...utils };
};

const instanceSettled = (client: QueryClient) =>
  waitFor(() =>
    expect(client.getQueryState(queryKeys.instance.all())?.status).toBe(
      "success",
    ),
  );

beforeEach(() => {
  state.edition = "onprem";
  state.version = "test";
  state.hang = false;
  writeText.mockClear();
});

it("premise: this file really runs the onprem build arm", () => {
  expect(IS_CLOUD).toBe(false);
  // The fallback arm below relies on the vitest env baking no version.
  expect(APP_VERSION).toBe("dev");
});

describe("displayVersion", () => {
  it("hides while the instance is unresolved", () => {
    expect(displayVersion(null, "2.2.0")).toBeNull();
  });

  it("hides when the API says the deployment is cloud", () => {
    expect(
      displayVersion({ edition: "cloud", version: "9.9.9" }, "2.2.0"),
    ).toBeNull();
  });

  it("prefers the API's version over the baked one", () => {
    expect(
      displayVersion({ edition: "onprem", version: "2.2.0" }, "9.9.9"),
    ).toBe("2.2.0");
  });

  it("falls back to the baked version when the API reports unknown", () => {
    expect(
      displayVersion({ edition: "onprem", version: "unknown" }, "2.2.0"),
    ).toBe("2.2.0");
  });

  it("falls back for an empty version too", () => {
    expect(displayVersion({ edition: "onprem", version: "" }, "2.2.0")).toBe(
      "2.2.0",
    );
  });

  it("hides entirely when neither source is real", () => {
    expect(
      displayVersion({ edition: "onprem", version: "unknown" }, "dev"),
    ).toBeNull();
  });
});

describe("the rendered indicator", () => {
  it("shows the installed version as a muted caption", async () => {
    renderVersion();
    const trigger = await screen.findByText("vtest");
    expect(trigger.getAttribute("aria-label")).toBe(
      "OneCLI version test, update instructions",
    );
  });

  it("click opens the minimal update dialog with both documented commands", async () => {
    renderVersion();
    await userEvent.click(await screen.findByText("vtest"));
    await screen.findByText("OneCLI vtest");
    expect(
      screen.getByText("curl -fsSL https://onecli.sh/install | sh"),
    ).toBeDefined();
    expect(
      screen.getByText("git pull && pnpm install && pnpm run setup --upgrade"),
    ).toBeDefined();
  });

  it("the copy button writes the installer command to the clipboard", async () => {
    renderVersion();
    await userEvent.click(await screen.findByText("vtest"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Copy install command" }),
    );
    expect(writeText).toHaveBeenCalledWith(
      "curl -fsSL https://onecli.sh/install | sh",
    );
  });

  it("renders nothing while the instance is still loading", () => {
    state.hang = true;
    const { client, container } = renderVersion();
    expect(client.getQueryState(queryKeys.instance.all())?.status).toBe(
      "pending",
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the API says the deployment is cloud", async () => {
    state.edition = "cloud";
    const { client, container } = renderVersion();
    await instanceSettled(client);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for an unknown version with no baked fallback", async () => {
    state.version = "unknown";
    const { client, container } = renderVersion();
    await instanceSettled(client);
    expect(container.firstChild).toBeNull();
  });
});
