import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getAppPermissionDefinitions } from "./index";
import { buildCatalogJson, serializeCatalogJson } from "./catalog-json";
import { allGroupTools, hostPatternsOf } from "./types";
import { networkHostPatternShapeError } from "../../validations/secret";

// Drift check: the catalog JSON the gateway embeds (its own build artifact, next
// to the engine) must equal the current TS catalog — one unified file covering
// every provider. Regenerate with `pnpm generate:catalog` after editing any
// provider's tools.
const gatewayCatalog = (relPath: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(
        `../../../../../apps/gateway/crates/policy-engine/src/${relPath}`,
        import.meta.url,
      ),
    ),
    "utf8",
  );

describe("gateway catalog JSON stays in sync with the TS catalog", () => {
  it("catalog.generated.json (every registered provider)", () => {
    expect(gatewayCatalog("catalog.generated.json")).toBe(
      serializeCatalogJson(buildCatalogJson(getAppPermissionDefinitions())),
    );
  });
});

// Guards the one app-target fidelity divergence the step-4 shadow bake CANNOT
// catch (the shadow uses network-verbatim projection, no catalog): a tool
// authored with an explicit empty `methods: []` fans out to zero variants in TS
// `allRuleVariants` (matches nothing) but is read as "any method" by the
// gateway's catalog.rs (fail-open). Genuine any-method tools omit method/methods.
describe("catalog tools never author an explicit empty methods array", () => {
  it("every registered provider", () => {
    for (const def of getAppPermissionDefinitions()) {
      for (const group of def.groups) {
        for (const tool of allGroupTools(group)) {
          expect(
            Array.isArray(tool.methods) && tool.methods.length === 0,
            `${def.provider}/${tool.id}: explicit "methods: []" is fail-open — use a real method list or omit method/methods for any-method`,
          ).toBe(false);
        }
      }
    }
  });
});

// `buildCatalogJson` flattens each provider's groups into ONE id-keyed record
// (`tools[tool.id] = …`), so a duplicate id anywhere in a provider — including a
// tool reusing a wildcard's id, or the same id in the read and write groups —
// silently drops one endpoint fan-out from the gateway JSON (last write wins).
// The byte drift-test can't see that: it compares the regenerated file against
// itself. Pin uniqueness at the authored source instead.
describe("catalog tool ids are unique within each provider", () => {
  it("every registered provider", () => {
    for (const def of getAppPermissionDefinitions()) {
      const ids = def.groups.flatMap((group) =>
        allGroupTools(group).map((tool) => tool.id),
      );
      const seen = new Set<string>();
      for (const id of ids) {
        expect(
          seen.has(id),
          `${def.provider}/${id}: duplicate tool id — buildCatalogJson would silently drop one of its endpoint fan-outs`,
        ).toBe(false);
        seen.add(id);
      }
    }
  });
});

// A catalog host pattern must be a shape `hostMatches` can actually honour.
// Multi-wildcard patterns are now supported (label-bounded: each `*` stands for
// exactly one label), which is what lets `*.s3.*.amazonaws.com` cover a
// virtual-hosted bucket in any region. The shapes that remain forbidden are the
// ones that would silently misbehave:
//
//   - a PARTIAL-label wildcard (`s3*.amazonaws.com`) reads far narrower than it
//     matches — that one would also swallow `s3tables`/`s3-control`, separate
//     AWS services with their own IAM actions;
//   - a TRAILING wildcard (`*.notion.*`) spans every TLD, including ones anyone
//     can register.
//
// Both are rejected at authoring time by the same helper the user-facing
// surfaces use, so the catalog is held to the rule it documents.
describe("catalog host patterns are shapes the matcher can honour", () => {
  it("every registered provider", () => {
    for (const def of getAppPermissionDefinitions()) {
      for (const group of def.groups) {
        for (const tool of allGroupTools(group)) {
          for (const pattern of hostPatternsOf(tool)) {
            expect(
              networkHostPatternShapeError(pattern),
              `${def.provider}/${tool.id}: host pattern "${pattern}"`,
            ).toBeNull();
          }
        }
      }
    }
  });

  it("no tool declares a duplicate host pattern", () => {
    for (const def of getAppPermissionDefinitions()) {
      for (const group of def.groups) {
        for (const tool of allGroupTools(group)) {
          const patterns = hostPatternsOf(tool);
          expect(
            new Set(patterns).size,
            `${def.provider}/${tool.id}: duplicate host pattern in hostAliasPatterns`,
          ).toBe(patterns.length);
        }
      }
    }
  });
});
