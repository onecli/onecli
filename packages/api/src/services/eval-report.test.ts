import { describe, expect, it } from "vitest";
import { evalReportText, shouldSendEvalReport } from "./eval-report";
import type { EvalChange, EvalResultView } from "../validations/evals";

const r = (
  question: string,
  outcome: EvalResultView["outcome"],
  change: EvalChange | null = "same",
  patch: Partial<EvalResultView> = {},
): EvalResultView => ({
  questionId: question,
  question,
  expected: "42",
  kind: "numeric",
  expectedApps: [],
  outcome,
  answer: "42",
  missingApps: null,
  turnId: null,
  conversationId: null,
  error: null,
  judgement: null,
  judgeError: null,
  change,
  ...patch,
});

const base = {
  agentName: "Dana",
  status: "done" as const,
  error: null,
  runUrl: "https://app/run",
};

describe("evalReportText", () => {
  it("reads like a note: headline, what needs a look and why, what passed, then details", () => {
    const text = evalReportText({
      ...base,
      total: 4,
      model: "claude-sonnet-5",
      startedAt: new Date("2026-10-29T10:00:00Z"),
      finishedAt: new Date("2026-10-29T10:01:12Z"),
      configChanged: true,
      results: [
        r("Deals closed in Q3?", "passed", "fixed"),
        r("Summarize tickets.", "mismatch", "same", {
          kind: "custom",
          judgement: {
            passed: false,
            summary: "the top issues are missing",
            model: "claude-sonnet-5",
            criteria: [],
          },
        }),
        r("Revenue last week?", "mismatch", "regressed", { answer: "17" }),
        r("Open tickets?", "error", "same", {
          error: "the agent's model key was removed",
        }),
      ],
    });
    expect(text).toBe(
      [
        "**Dana's scheduled tests: 1 of 4 passed** (1 broke since last run, 1 fixed)",
        "",
        "**Needs a look**",
        "**3. Revenue last week?**",
        '> Broke since last run. Expected 42, the agent said "17".',
        "",
        "**2. Summarize tickets.**",
        "> The top issues are missing.",
        "",
        "**4. Open tickets?**",
        "> It didn't finish: the agent's model key was removed",
        "",
        "**Passing**",
        "1. Deals closed in Q3? (fixed since last run)",
        "",
        "_claude-sonnet-5 · took 1m 12s · the agent changed since last run_",
        "[Open the full results](https://app/run)",
      ].join("\n"),
    );
  });

  it("lists a custom check's criteria under it, met first, each with the judge's note", () => {
    const text = evalReportText({
      ...base,
      total: 1,
      results: [
        r("Summarize tickets.", "mismatch", null, {
          kind: "custom",
          judgement: {
            passed: false,
            summary: "Only the count is there.",
            model: "m",
            criteria: [
              {
                criterion: "States the three most common issues",
                met: false,
                note: "No issues are listed at all.",
              },
              {
                criterion: "States the total number of tickets",
                met: true,
                note: "Says 26 cases.",
              },
            ],
          },
        }),
      ],
    });
    expect(text).toContain(
      [
        "**1. Summarize tickets.**",
        "> Only the count is there.",
        "> 1 of 2 criteria met",
        "> ✅ States the total number of tickets: _Says 26 cases_",
        "> ❌ States the three most common issues: _No issues are listed at all_",
      ].join("\n"),
    );
  });

  it("shows a passing custom check's criteria too", () => {
    const text = evalReportText({
      ...base,
      total: 1,
      results: [
        r("Explain OneCLI.", "passed", null, {
          kind: "custom",
          judgement: {
            passed: true,
            summary: "All facts present.",
            model: "m",
            criteria: [
              { criterion: "Says it is a gateway", met: true, note: "Yes." },
              { criterion: "Under 150 words", met: false, note: "180 words." },
            ],
          },
        }),
      ],
    });
    expect(text).toContain(
      [
        "**Passing**",
        "1. Explain OneCLI.",
        "> 1 of 2 criteria met",
        "> ✅ Says it is a gateway: _Yes_",
        "> ❌ Under 150 words: _180 words_",
        "",
      ].join("\n"),
    );
  });

  it("celebrates a clean run", () => {
    expect(
      evalReportText({
        ...base,
        total: 2,
        configChanged: false,
        results: [r("a", "passed"), r("b", "passed")],
      }),
    ).toBe(
      [
        "**Dana's scheduled tests: all 2 passed** 🎉",
        "",
        "**Passing**",
        "1. a",
        "2. b",
        "",
        "_no changes to the agent since last run_",
        "[Open the full results](https://app/run)",
      ].join("\n"),
    );
  });

  it("names apps the agent didn't use, and strips markdown from model text", () => {
    const text = evalReportText({
      ...base,
      total: 1,
      results: [
        r("Owner of *Acme*?", "mismatch", null, {
          kind: "text",
          expected: "Dana",
          answer: "**Bob**\n> quoted",
          missingApps: ["salesforce"],
        }),
      ],
    });
    expect(text).toContain("**1. Owner of Acme?**");
    expect(text).toContain(
      '> Expected Dana, the agent said "Bob quoted". It didn\'t use salesforce.',
    );
  });

  it("caps the list, keeping failures over passes", () => {
    const many = [
      r("bad", "mismatch"),
      ...Array.from({ length: 17 }, (_, i) => r(`q${i}`, "passed")),
    ];
    const text = evalReportText({ ...base, total: 18, results: many });
    expect(text).toContain("**1. bad**");
    expect(text.split("\n").filter((l) => /^\d+\. q/.test(l))).toHaveLength(14);
    expect(text).toContain("…and 3 more.");
  });

  it("says a failed run didn't finish, and why", () => {
    const lines = evalReportText({
      ...base,
      status: "failed",
      error: "the run stopped making progress and was ended.",
      total: 3,
      results: [r("a", "passed")],
    }).split("\n");
    expect(lines[0]).toBe(
      "**Dana's scheduled tests didn't finish** (1 of 3 passed before it stopped)",
    );
    expect(lines).toContain("> The run stopped making progress and was ended.");
  });
});

describe("shouldSendEvalReport", () => {
  const passing = [r("a", "passed")];
  const failing = [r("a", "mismatch")];
  it("always: every run", () => {
    expect(
      shouldSendEvalReport("always", { status: "done", results: passing }),
    ).toBe(true);
  });
  it("changes: only a regression or a fix", () => {
    expect(
      shouldSendEvalReport("changes", { status: "done", results: failing }),
    ).toBe(false);
    expect(
      shouldSendEvalReport("changes", {
        status: "done",
        results: [r("a", "passed", "fixed")],
      }),
    ).toBe(true);
  });
  it("failures: anything not passing", () => {
    expect(
      shouldSendEvalReport("failures", { status: "done", results: passing }),
    ).toBe(false);
    expect(
      shouldSendEvalReport("failures", { status: "done", results: failing }),
    ).toBe(true);
  });
  it("a failed run is sent whatever `when` says", () => {
    expect(
      shouldSendEvalReport("changes", { status: "failed", results: [] }),
    ).toBe(true);
  });
});
