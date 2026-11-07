import { describe, expect, it } from "vitest";
import { breadcrumbSegmentLabel } from "./breadcrumb-segment-label";

describe("breadcrumbSegmentLabel", () => {
  const inConnections = { inConnections: true };

  it("names a connections tab the way the tab itself reads", () => {
    expect(breadcrumbSegmentLabel("llms", inConnections)).toBe("LLMs");
    expect(breadcrumbSegmentLabel("custom", inConnections)).toBe("Custom");
    expect(breadcrumbSegmentLabel("apps", inConnections)).toBe("Apps");
    expect(breadcrumbSegmentLabel("connected", inConnections)).toBe(
      "Connected",
    );
  });

  it("names an app by its display name, not its title-cased id", () => {
    expect(breadcrumbSegmentLabel("github", inConnections)).toBe("GitHub");
  });

  it("falls back to title-casing an unknown slug", () => {
    expect(breadcrumbSegmentLabel("not-an-app", inConnections)).toBe(
      "Not an app",
    );
  });

  it("outside a connections section, never reinterprets a segment as an app", () => {
    expect(breadcrumbSegmentLabel("github", { inConnections: false })).toBe(
      "Github",
    );
    expect(breadcrumbSegmentLabel("api-keys", { inConnections: false })).toBe(
      "Api keys",
    );
  });
});
