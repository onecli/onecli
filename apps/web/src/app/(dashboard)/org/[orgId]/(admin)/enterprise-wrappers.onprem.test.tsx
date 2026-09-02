// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── The four admin EE route wrappers, unlicensed arm ────────────────────────
//
// Each wrapper is the ONLY server gate for org-sso-page and org-domains-page
// (those inner pages have no self-gate — groups/app-availability do, tested
// in their own onprem suites). Before this suite, deleting a wrapper's
// isEntitled branch was invisible to every test. Each arm is
// mutation-detectable: unlicensed → the locked card renders and the inner
// page module does NOT; licensed → the inner page renders.

vi.hoisted(() => {
  // All three deleted BEFORE the module graph loads: NEXT_PUBLIC_EDITION
  // freezes web CAPS at load, EDITION would silently force isEntitled, and
  // each test owns ENTERPRISE_ENABLED (isEntitled reads env at call time).
  delete process.env.NEXT_PUBLIC_EDITION;
  delete process.env.EDITION;
  delete process.env.ENTERPRISE_ENABLED;
});

// Inner ee pages stubbed with testids: rendering the stub means the wrapper
// let the licensed page through; its absence + the locked card = dark.
vi.mock("@/ee/groups/groups-page", () => ({
  default: () => <div data-testid="inner-groups" />,
}));
vi.mock("@/ee/settings/org-sso-page", () => ({
  default: () => <div data-testid="inner-sso" />,
}));
vi.mock("@/ee/settings/org-domains-page", () => ({
  default: () => <div data-testid="inner-domains" />,
}));
vi.mock("@/ee/app-availability/app-availability-page", () => ({
  default: () => <div data-testid="inner-app-availability" />,
}));

import GroupsWrapper from "./groups/page";
import SsoWrapper from "./settings/sso/page";
import DomainsWrapper from "./settings/domains/page";
import AppAvailabilityWrapper from "./settings/app-availability/page";

const WRAPPERS = [
  { name: "groups", Page: GroupsWrapper, inner: "inner-groups" },
  { name: "sso", Page: SsoWrapper, inner: "inner-sso" },
  { name: "domains", Page: DomainsWrapper, inner: "inner-domains" },
  {
    name: "app-availability",
    Page: AppAvailabilityWrapper,
    inner: "inner-app-availability",
  },
] as const;

beforeEach(() => vi.stubEnv("ENTERPRISE_ENABLED", ""));
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe.each(WRAPPERS.map((w) => [w.name, w] as const))(
  "%s wrapper",
  (_name, wrapper) => {
    it("unlicensed: renders the locked card, never the inner page", () => {
      render(<wrapper.Page />);
      expect(screen.getByText("Enterprise")).toBeInTheDocument();
      expect(screen.queryByTestId(wrapper.inner)).toBeNull();
    });

    it("licensed: the inner page renders (the gate stands down)", () => {
      vi.stubEnv("ENTERPRISE_ENABLED", "true");
      render(<wrapper.Page />);
      expect(screen.getByTestId(wrapper.inner)).toBeInTheDocument();
      expect(screen.queryByText("Enterprise")).toBeNull();
    });
  },
);
