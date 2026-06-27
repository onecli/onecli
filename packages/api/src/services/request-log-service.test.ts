import { describe, expect, it } from "vitest";

import { LLM_HOST_FRAGMENTS } from "../lib/llm-hosts";
import { buildActivityWhere } from "./request-log-service";

const PROJECT_ID = "proj_activity_test";

describe("buildActivityWhere", () => {
  it("scopes to the project when given no filter or cursor", () => {
    expect(buildActivityWhere(PROJECT_ID)).toEqual({ projectId: PROJECT_ID });
  });

  it('applies no extra constraints for the "all" filter', () => {
    expect(buildActivityWhere(PROJECT_ID, { filter: "all" })).toEqual({
      projectId: PROJECT_ID,
    });
  });

  it('filters to status >= 400 for the "blocked" filter', () => {
    expect(buildActivityWhere(PROJECT_ID, { filter: "blocked" })).toEqual({
      projectId: PROJECT_ID,
      status: { gte: 400 },
    });
  });

  it('excludes every known AI host, case-insensitively, for "hide-llm"', () => {
    expect(buildActivityWhere(PROJECT_ID, { filter: "hide-llm" })).toEqual({
      projectId: PROJECT_ID,
      NOT: {
        OR: LLM_HOST_FRAGMENTS.map((fragment) => ({
          host: { contains: fragment, mode: "insensitive" },
        })),
      },
    });
  });

  it("classifies anthropic.com as AI but leaves non-AI hosts like github.com", () => {
    const fragments: readonly string[] = LLM_HOST_FRAGMENTS;
    expect(fragments).toContain("anthropic.com");
    expect(fragments).not.toContain("github.com");
  });

  it('keeps the keyset cursor clauses alongside the "hide-llm" exclusion', () => {
    const cursor = { createdAt: "2026-06-26T12:00:00.000Z", id: "log_42" };
    const where = buildActivityWhere(PROJECT_ID, {
      filter: "hide-llm",
      cursor,
    });

    expect(where.NOT).toBeDefined();
    expect(where.OR).toEqual([
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ]);
  });
});
