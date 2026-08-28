// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sync-boundary proof for analytics: the PostHog key/host and Fathom site
 * id come ONLY from `NEXT_PUBLIC_*` build args baked by the cloud image. With
 * them unset — every self-host and OSS build — the provider must render its
 * children untouched and never initialize PostHog, so no identifier exists to
 * ship. The enabled arm pins the flip side: setting the vars is sufficient,
 * so the cloud build needs no code branch of its own.
 */

// The components read the env at module load, so each arm pins the env inside
// vi.hoisted-free isolation: reset the module graph and set the env BEFORE the
// dynamic import.
const posthogInit = vi.hoisted(() => vi.fn());
vi.mock("posthog-js", () => ({
  default: { init: posthogInit, identify: vi.fn() },
}));
vi.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="posthog-provider">{children}</div>
  ),
}));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: undefined }),
}));
vi.mock("@/ee/analytics-pageview", () => ({
  AnalyticsPageview: () => null,
}));
vi.mock("next/script", () => ({
  default: (props: { "data-site"?: string }) => (
    <div data-testid="fathom-script" data-site={props["data-site"]} />
  ),
}));

beforeEach(() => {
  vi.resetModules();
  posthogInit.mockClear();
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  delete process.env.NEXT_PUBLIC_FATHOM_SITE_ID;
});

describe("AnalyticsProvider without baked identifiers (self-host/OSS build)", () => {
  it("renders children plain and never initializes PostHog", async () => {
    const { AnalyticsProvider } = await import("@/ee/analytics");

    render(
      <AnalyticsProvider>
        <span>child-content</span>
      </AnalyticsProvider>,
    );

    expect(screen.getByText("child-content")).toBeDefined();
    expect(screen.queryByTestId("posthog-provider")).toBeNull();
    expect(posthogInit).not.toHaveBeenCalled();
  });

  it("renders no Fathom script without a site id", async () => {
    const { FathomAnalytics } = await import("@/ee/fathom");

    render(<FathomAnalytics />);

    expect(screen.queryByTestId("fathom-script")).toBeNull();
  });
});

describe("AnalyticsProvider with baked identifiers (cloud build)", () => {
  it("initializes PostHog with the baked key and host", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://t.example.test";
    process.env.NEXT_PUBLIC_FATHOM_SITE_ID = "TESTSITE";
    const { AnalyticsProvider } = await import("@/ee/analytics");

    render(
      <AnalyticsProvider>
        <span>child-content</span>
      </AnalyticsProvider>,
    );

    expect(screen.getByTestId("posthog-provider")).toBeDefined();
    expect(screen.getByText("child-content")).toBeDefined();
    expect(posthogInit).toHaveBeenCalledWith(
      "phc_test_key",
      expect.objectContaining({ api_host: "https://t.example.test" }),
    );
    expect(screen.getByTestId("fathom-script").getAttribute("data-site")).toBe(
      "TESTSITE",
    );
  });
});
