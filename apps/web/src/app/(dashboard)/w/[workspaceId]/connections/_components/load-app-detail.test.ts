import { afterEach, describe, expect, it, vi } from "vitest";
import { getApp } from "@onecli/api/apps/registry";
import { loadAppDetail } from "./load-app-detail";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// The pages are redirects into the Settings modal: asserted by their
// arguments (the stub returns instead of throwing, so the page resolves).
const redirect = vi.hoisted(() => ({
  toModal: vi.fn<
    (
      scope: unknown,
      page: string,
      params: Record<string, string | string[] | undefined>,
    ) => Promise<void>
  >(async () => {}),
}));
vi.mock("@/lib/settings-modal/redirect-to-modal", () => ({
  redirectToSettingsModal: redirect.toModal,
}));

const GOOGLE_ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

const hasConfig = (value: boolean) => vi.fn(async () => value);

describe("loadAppDetail", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("404s an unknown provider without checking its config", async () => {
    const check = hasConfig(true);
    await expect(loadAppDetail("no-such-app", check)).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(check).not.toHaveBeenCalled();
  });

  it("maps the catalog entry to the detail page's app props", async () => {
    const attio = getApp("attio")!;
    const data = await loadAppDetail("attio", hasConfig(false));
    expect(data.app).toEqual({
      id: attio.id,
      name: attio.name,
      icon: attio.icon,
      darkIcon: attio.darkIcon,
      description: attio.description,
      connectionType: attio.connectionMethod.type,
      hasApiKeyAlternate: true,
      blocklist: attio.blocklist,
      setupGuideUrl: attio.setupGuideUrl,
    });
    expect(data.configurable).toBe(attio.configurable);
  });

  it("passes the app's blocklist through", async () => {
    const jfrog = getApp("jfrog-artifactory")!;
    expect(jfrog.blocklist?.length).toBeGreaterThan(0);
    const data = await loadAppDetail("jfrog-artifactory", hasConfig(false));
    expect(data.app.blocklist).toEqual(jfrog.blocklist);
  });

  it("reports no API-key alternate for an app without one", async () => {
    const data = await loadAppDetail("gmail", hasConfig(false));
    expect(data.app.hasApiKeyAlternate).toBe(false);
  });

  it("passes the provider to the scope's config check and returns its answer", async () => {
    const check = hasConfig(true);
    const data = await loadAppDetail("gmail", check);
    expect(check).toHaveBeenCalledWith("gmail");
    expect(data.hasAppConfig).toBe(true);
  });

  it("treats a failing config check as no config", async () => {
    const check = vi.fn(async () => {
      throw new Error("unauthenticated");
    });
    const data = await loadAppDetail("gmail", check);
    expect(data.hasAppConfig).toBe(false);
  });

  it("has env defaults only when every default variable is set", async () => {
    for (const name of GOOGLE_ENV) vi.stubEnv(name, "");
    expect(
      (await loadAppDetail("gmail", hasConfig(false))).hasEnvDefaults,
    ).toBe(false);

    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    expect(
      (await loadAppDetail("gmail", hasConfig(false))).hasEnvDefaults,
    ).toBe(false);

    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    expect(
      (await loadAppDetail("gmail", hasConfig(false))).hasEnvDefaults,
    ).toBe(true);
  });

  it("never has env defaults for an app without platform defaults", async () => {
    // Salesforce is configurable but ships no env defaults; Resend is not
    // configurable at all.
    expect(getApp("salesforce")?.configurable).toBeDefined();
    expect(
      Object.keys(getApp("salesforce")!.configurable!.envDefaults ?? {}),
    ).toEqual([]);
    expect(
      (await loadAppDetail("salesforce", hasConfig(false))).hasEnvDefaults,
    ).toBe(false);
    expect(getApp("resend")?.configurable).toBeUndefined();
    expect(
      (await loadAppDetail("resend", hasConfig(false))).hasEnvDefaults,
    ).toBe(false);
  });
});

describe("app detail pages", () => {
  const wsParams = (provider: string) =>
    Promise.resolve({ workspaceId: "ws_1", provider });
  const noQuery = Promise.resolve({});

  it("forwards both pages into the modal, the app and the query along", async () => {
    const { default: AppDetailPage } = await import("../apps/[provider]/page");
    const { default: GlobalAppDetailPage } =
      await import("@/app/(dashboard)/org/[orgId]/(admin)/settings/global-connections/_components/global-app-detail-page");
    redirect.toModal.mockClear();
    await AppDetailPage({
      params: wsParams("gmail"),
      searchParams: Promise.resolve({ connected: "c1" }),
    });
    expect(redirect.toModal).toHaveBeenCalledWith(
      { workspaceId: "ws_1" },
      "apps",
      { connected: "c1", app: "gmail" },
    );
    await GlobalAppDetailPage({
      params: Promise.resolve({ provider: "gmail", orgId: "org_1" }),
      searchParams: noQuery,
    });
    expect(redirect.toModal).toHaveBeenLastCalledWith(
      { organizationId: "org_1" },
      "shared-apps",
      { app: "gmail" },
    );
  });

  it("404s an unknown provider on both pages, never forwarding it", async () => {
    const { default: AppDetailPage } = await import("../apps/[provider]/page");
    const { default: GlobalAppDetailPage } =
      await import("@/app/(dashboard)/org/[orgId]/(admin)/settings/global-connections/_components/global-app-detail-page");
    redirect.toModal.mockClear();
    await expect(
      AppDetailPage({ params: wsParams("nope"), searchParams: noQuery }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(
      GlobalAppDetailPage({
        params: Promise.resolve({ provider: "nope", orgId: "org_1" }),
        searchParams: noQuery,
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(redirect.toModal).not.toHaveBeenCalled();
  });
});
