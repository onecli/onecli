import { describe, expect, it } from "vitest";
import { classifyGraphqlBody, classifyGraphqlDocument } from "./graphql";

// The TS twin of `policy-engine/src/graphql.rs`'s tests - the same cases, so
// a divergence between the two ports' classifiers turns BOTH suites' shared
// examples red (plus the corpus, which exercises the classifier through the
// full evaluator).

const body = (document: string): string => JSON.stringify({ query: document });

describe("classifyGraphqlBody", () => {
  // ── The pure-query arm (the ONLY way to reach "query") ─────────────────

  it("classifies pure queries as query", () => {
    expect(classifyGraphqlBody(body("query { viewer { login } }"))).toBe(
      "query",
    );
    expect(classifyGraphqlBody(body("{ viewer { login } }"))).toBe("query");
    expect(
      classifyGraphqlBody(
        body("query Named($n: Int!) @cached { repos(first: $n) { name } }"),
      ),
    ).toBe("query");
    // Multiple queries + fragments are still pure.
    expect(
      classifyGraphqlBody(
        body(
          "query A { viewer { ...F } } query B { rateLimit { cost } } " +
            "fragment F on User { login }",
        ),
      ),
    ).toBe("query");
    // gh CLI-style: leading comment.
    expect(
      classifyGraphqlBody(
        body(
          '# list PRs\nquery { repository(owner: "o", name: "r") { pullRequests(first: 10) { nodes { title } } } }',
        ),
      ),
    ).toBe("query");
  });

  it("is not confused by braces inside strings", () => {
    expect(
      classifyGraphqlBody(
        body('query { search(query: "mutation { } } }", first: 1) { count } }'),
      ),
    ).toBe("query");
    expect(
      classifyGraphqlBody(
        body('query { f(arg: """block } { string""") { x } }'),
      ),
    ).toBe("query");
  });

  // ── The fail-closed arms ───────────────────────────────────────────────

  it("classifies mutations as mutation", () => {
    expect(
      classifyGraphqlBody(
        body(
          "mutation { createPullRequest(input: {}) { pullRequest { number } } }",
        ),
      ),
    ).toBe("mutation");
    // A mutation hidden behind a query in the same document.
    expect(
      classifyGraphqlBody(
        body(
          "query Q { viewer { login } } mutation M { deleteRef(input: {}) { ok } }",
        ),
      ),
    ).toBe("mutation");
    expect(classifyGraphqlBody(body("subscription { events { id } }"))).toBe(
      "mutation",
    );
  });

  it("classifies doubtful inputs as mutation (fail-closed)", () => {
    // No body at all / empty.
    expect(classifyGraphqlBody(undefined)).toBe("mutation");
    expect(classifyGraphqlBody(null)).toBe("mutation");
    expect(classifyGraphqlBody("")).toBe("mutation");
    // Not JSON (covers a 16KB-truncated buffer).
    expect(classifyGraphqlBody('{"query": "query { viewer ')).toBe("mutation");
    // JSON without a string `query` field.
    expect(classifyGraphqlBody("{}")).toBe("mutation");
    expect(classifyGraphqlBody('{"query": 42}')).toBe("mutation");
    expect(classifyGraphqlBody("[1,2]")).toBe("mutation");
    // Unbalanced / unterminated documents.
    expect(classifyGraphqlBody(body("query { viewer { login }"))).toBe(
      "mutation",
    );
    expect(classifyGraphqlBody(body("query { viewer } }"))).toBe("mutation");
    expect(
      classifyGraphqlBody(body('query { f(arg: "unterminated) { x } }')),
    ).toBe("mutation");
    // Fragments only - no executable operation.
    expect(classifyGraphqlBody(body("fragment F on User { login }"))).toBe(
      "mutation",
    );
    // Dangling header without a selection set.
    expect(classifyGraphqlBody(body("query Named"))).toBe("mutation");
    // Empty / junk documents.
    expect(classifyGraphqlBody(body(""))).toBe("mutation");
    expect(classifyGraphqlBody(body("!!!"))).toBe("mutation");
  });
});

describe("classifyGraphqlDocument", () => {
  it("handles unterminated strings fail-closed", () => {
    expect(classifyGraphqlDocument('query { f(a: "x')).toBe("mutation");
    expect(classifyGraphqlDocument('query { f(a: """x')).toBe("mutation");
  });
});

describe("the duplicate/escaped query-key guard", () => {
  it("fails closed on duplicate or escaped top-level query keys", () => {
    // Duplicate `query` keys: JSON.parse reads last-wins, an upstream might
    // read first-wins - refuse to classify at all.
    expect(
      classifyGraphqlBody(
        '{"query": "mutation { x }", "query": "query { y }"}',
      ),
    ).toBe("mutation");
    // An escape inside a top-level key could alias `query` post-decode.
    expect(classifyGraphqlBody('{"quer\\u0079": "query { y }"}')).toBe(
      "mutation",
    );
  });

  it("does not trip on nested query keys or query-valued strings", () => {
    expect(
      classifyGraphqlBody(
        '{"variables": {"query": "mutation { x }"}, "query": "query { y }"}',
      ),
    ).toBe("query");
    expect(
      classifyGraphqlBody('{"operationName": "query", "query": "query { y }"}'),
    ).toBe("query");
  });
});
