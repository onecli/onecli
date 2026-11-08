// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RequestLogEntry } from "@onecli/api/services/request-log-service";
import { ActivityDetailDialog } from "./activity-detail-dialog";

const statement = vi.hoisted(
  () =>
    'SELECT $1 AS "<img src=x onerror=alert(1)>"\n' +
    "long_identifier_".repeat(100),
);
vi.mock("@onecli/api/services/request-log-service", () => ({
  isBlockedRequest: () => false,
  isDefaultDenied: () => false,
  isOwnKey: () => false,
  isRateLimitedRequest: () => false,
  getBlockedByRule: () => null,
  getConnectionLabel: () => null,
  getMatchedRuleName: () => null,
  getMatchedRuleScope: () => null,
  getStatement: () => statement,
  getDatabaseRequestView: () => ({
    kind: "READ",
    connection: "Orders",
    statement,
  }),
}));

const log: RequestLogEntry = {
  id: "request-proof",
  agentId: "agent-proof",
  agentName: "Database agent",
  method: "GET",
  host: "db.postgres.onecli.invalid",
  path: "/sql/read",
  provider: "postgres",
  status: 200,
  latencyMs: 10,
  injectionCount: 1,
  extraData: {},
  matchedRuleLogicalId: null,
  approvedBy: null,
  createdAt: "2026-10-27T12:00:00Z",
};

describe("SQL activity details", () => {
  it("keeps a long masked statement focusable, bounded and escaped", () => {
    render(<ActivityDetailDialog log={log} onClose={() => {}} />);
    const sql = screen.getByLabelText("SQL statement");
    expect(sql.textContent).toBe(statement);
    expect(sql.tagName).toBe("PRE");
    expect(sql).toHaveAttribute("tabindex", "0");
    expect(sql).toHaveClass("max-h-64", "overflow-auto", "whitespace-pre-wrap");
    expect(sql.querySelector("img")).toBeNull();
  });

  it("names the kind and connection, never the synthetic host or path", () => {
    render(<ActivityDetailDialog log={log} onClose={() => {}} />);
    expect(screen.getByText("READ")).toBeTruthy();
    expect(screen.getByText("Orders")).toBeTruthy();
    expect(screen.queryByText("db.postgres.onecli.invalid")).toBeNull();
    expect(screen.queryByText("/sql/read")).toBeNull();
    expect(screen.queryByText("Extra Data")).toBeNull();
  });
});
