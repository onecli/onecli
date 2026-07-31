import { describe, expect, it } from "vitest";
import {
  axisOf,
  coveredBy,
  deniesEverything,
  entriesOutside,
  intersectPolicies,
} from "./resource-axis";

// The parity suite: these cases mirror the gateway's Rust tests
// (ee/granular_access{,/github,/dropbox}.rs) case for case. The gateway
// enforces; this side only reflects and validates — a divergence would show an
// operator one scope while another is applied.

describe("axisOf", () => {
  it("recognizes each axis and nothing else", () => {
    expect(axisOf({ repositories: ["org/a"] })?.key).toBe("repositories");
    expect(axisOf({ folders: ["/x"] })?.key).toBe("folders");
    expect(axisOf({})).toBeUndefined();
    expect(axisOf(null)).toBeUndefined();
    expect(axisOf([{ type: "body_contains", value: "x" }])).toBeUndefined();
  });
});

describe("deniesEverything", () => {
  it("is true only for an explicitly empty allowlist", () => {
    expect(deniesEverything({ repositories: [] })).toBe(true);
    expect(deniesEverything({ folders: [] })).toBe(true);
    expect(deniesEverything({ repositories: ["org/a"] })).toBe(false);
    // Absent axis, empty object, behavioral conditions: not a restriction.
    expect(deniesEverything({})).toBe(false);
    expect(deniesEverything(null)).toBe(false);
    // A root folder is a real (widest) scope, not an empty one — normalization
    // would drop it, which is why the check reads the raw entries.
    expect(deniesEverything({ folders: ["/"] })).toBe(false);
  });
});

describe("coveredBy", () => {
  it("matches repositories exactly, case-insensitively", () => {
    const boundary = { repositories: ["org/a", "org/b"] };
    expect(coveredBy("org/a", boundary)).toBe(true);
    expect(coveredBy("ORG/A", boundary)).toBe(true);
    expect(coveredBy("org/c", boundary)).toBe(false);
    expect(coveredBy("org/a-extra", boundary)).toBe(false);
  });

  it("matches folders on the segment boundary, one-directionally", () => {
    const boundary = { folders: ["/clients"] };
    expect(coveredBy("/clients", boundary)).toBe(true);
    expect(coveredBy("/clients/acme", boundary)).toBe(true);
    expect(coveredBy("/Clients/ACME", boundary)).toBe(true);
    expect(coveredBy("/clientsfoo", boundary)).toBe(false);
    // An ancestor is not inside its own descendant.
    expect(coveredBy("/", { folders: ["/clients"] })).toBe(false);
    // A root boundary contains everything.
    expect(coveredBy("/anything", { folders: ["/"] })).toBe(true);
  });

  it("treats a non-policy boundary as unbounded", () => {
    expect(coveredBy("org/a", null)).toBe(true);
    expect(coveredBy("org/a", {})).toBe(true);
  });
});

describe("intersectPolicies", () => {
  it("keeps only what both scopes allow, sorted and deduped", () => {
    expect(
      intersectPolicies(
        { repositories: ["buckle/electron", "buckle/api"] },
        { repositories: ["buckle/api"] },
      ),
    ).toEqual({ repositories: ["buckle/api"] });
    expect(
      intersectPolicies(
        { repositories: ["org/b", "org/a"] },
        { repositories: ["ORG/A", "org/a", "org/c"] },
      ),
    ).toEqual({ repositories: ["org/a"] });
  });

  it("denies everything when the scopes are disjoint", () => {
    const composed = intersectPolicies(
      { repositories: ["org/a"] },
      { repositories: ["org/z"] },
    );
    expect(composed).toEqual({ repositories: [] });
    expect(deniesEverything(composed)).toBe(true);
  });

  it("keeps the deeper folder of a nested pair, from either side", () => {
    const outer = { folders: ["/clients"] };
    const inner = { folders: ["/clients/acme"] };
    expect(intersectPolicies(outer, inner)).toEqual({
      folders: ["/clients/acme"],
    });
    expect(intersectPolicies(inner, outer)).toEqual({
      folders: ["/clients/acme"],
    });
  });

  it("lets an unrestricted side stand alone", () => {
    const policy = { repositories: ["org/a"] };
    expect(intersectPolicies(policy, null)).toEqual(policy);
    expect(intersectPolicies(null, policy)).toEqual(policy);
    expect(intersectPolicies(policy, {})).toEqual(policy);
    // Behavioral conditions restrict no resources.
    expect(intersectPolicies([{ type: "body_contains" }], policy)).toEqual(
      policy,
    );
    expect(intersectPolicies(null, null)).toBeNull();
  });

  it("denies everything across mismatched axes", () => {
    expect(
      intersectPolicies({ repositories: ["org/a"] }, { folders: ["/x"] }),
    ).toEqual({ repositories: [] });
  });
});

describe("parity with the gateway's value semantics", () => {
  it("folds case ASCII-only, exactly as `to_ascii_lowercase` does", () => {
    // Full `toLowerCase()` would call these covered; the gateway would not, and
    // the gateway is what enforces.
    expect(coveredBy("/Ärende", { folders: ["/ärende"] })).toBe(false);
    expect(coveredBy("ORG/A", { repositories: ["org/a"] })).toBe(true);
  });

  it("only absolute folder paths can be covered", () => {
    expect(coveredBy("rev:123", { folders: ["/clients"] })).toBe(false);
    expect(coveredBy("id:abc", { folders: ["id:abc"] })).toBe(false);
  });

  it("a bare owner is not covered by one of its repositories", () => {
    expect(coveredBy("org", { repositories: ["org/a"] })).toBe(false);
  });

  it("a root boundary intersects to the other side", () => {
    expect(
      intersectPolicies({ folders: ["/"] }, { folders: ["/clients"] }),
    ).toEqual({
      folders: ["/clients"],
    });
  });

  it("a non-list axis value is not a restriction", () => {
    // Rust's `raw_entries` returns None for these, so they deny nothing.
    expect(deniesEverything({ repositories: "org/a" })).toBe(false);
    expect(deniesEverything(undefined)).toBe(false);
    expect(deniesEverything([{ type: "body_contains" }])).toBe(false);
  });
});

describe("entriesOutside", () => {
  it("names exactly the entries a boundary forbids", () => {
    expect(
      entriesOutside(
        { repositories: ["org/a", "org/z"] },
        { repositories: ["org/a"] },
      ),
    ).toEqual(["org/z"]);
    expect(
      entriesOutside({ folders: ["/clients/acme"] }, { folders: ["/clients"] }),
    ).toEqual([]);
    // No boundary: nothing is outside.
    expect(entriesOutside({ repositories: ["org/z"] }, null)).toEqual([]);
    // Axes that disagree overlap in nothing, so everything is outside — the
    // same fail-closed reading `intersectPolicies` applies.
    expect(
      entriesOutside({ repositories: ["org/a"] }, { folders: ["org"] }),
    ).toEqual(["org/a"]);
  });
});
