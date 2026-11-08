import { describe, expect, it } from "vitest";
import type { Connection } from "@/lib/api";
import {
  sortConnectionsForChooser,
  sortSecretsForChooser,
} from "./chooser-order";

const conn = (
  id: string,
  provider: string,
  label: string | null,
  scope: Connection["scope"] = "workspace",
): Connection => ({
  id,
  provider,
  label,
  status: "connected",
  scopes: [],
  scope,
  metadata: null,
  connectedAt: "2026-10-01T00:00:00Z",
});

describe("sortConnectionsForChooser", () => {
  it("groups by app A to Z, not by connect date, with org connections beside their app", () => {
    // The order the API answers in: newest first.
    const pool = [
      conn("gsc", "google-search-console", "alex@example.com"),
      conn("sf", "salesforce", "sam@example.org"),
      conn("rs", "resend", "API Key"),
      conn("gh-org-b", "github-app", "globex", "organization"),
      conn("gh-org-a", "github-app", "acme", "organization"),
      conn("nv", "navan", "Navan (US)"),
    ];
    expect(sortConnectionsForChooser(pool).map((c) => c.id)).toEqual([
      "gh-org-a", // GitHub App · acme
      "gh-org-b", // GitHub App · globex
      "gsc", // Google Search Console
      "nv", // Navan
      "rs", // Resend
      "sf", // Salesforce
    ]);
  });

  it("falls back to the provider id for an unknown app, and to the app name for an unlabeled account", () => {
    const pool = [
      conn("z", "zzz-unknown", null),
      conn("a", "resend", null),
      conn("b", "resend", "Billing"),
    ];
    expect(sortConnectionsForChooser(pool).map((c) => c.id)).toEqual([
      "b", // Resend · Billing
      "a", // Resend · (Resend)
      "z",
    ]);
  });

  it("does not mutate its input", () => {
    const pool = [conn("b", "salesforce", "b"), conn("a", "resend", "a")];
    sortConnectionsForChooser(pool);
    expect(pool.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("sortSecretsForChooser", () => {
  it("orders by name, case-insensitively and numerically", () => {
    const secrets = [
      { id: "1", name: "stripe" },
      { id: "2", name: "Anthropic proxy" },
      { id: "3", name: "key 10" },
      { id: "4", name: "key 2" },
    ];
    expect(sortSecretsForChooser(secrets).map((s) => s.name)).toEqual([
      "Anthropic proxy",
      "key 2",
      "key 10",
      "stripe",
    ]);
  });
});
