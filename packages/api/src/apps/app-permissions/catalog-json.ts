import { allGroupTools, type AppPermissionDefinition } from "./types";

// The gateway-facing projection of the #626 catalog: per provider, per tool id,
// the host + path(×alias) + method(s) that tool fans into — exactly the inputs
// `allRuleVariants` + `appTargetMatches` use. The Rust gateway `include_str!`s
// the generated JSON and re-expands an `app` target the identical way, so a
// backfilled app-target rule enforces byte-for-byte like today's network rows
// (§7.7). Single source of truth: the TypeScript catalog is authored; the JSON
// is DERIVED from it and drift-checked in CI, so the TS API and the Rust
// gateway can never disagree.
//
// SERVER-ONLY: the endpoint mapping must never reach a client bundle. The JSON
// is read only by the gateway (compile-time embed) and the cloud backfill.

/** One tool's endpoint fan-out. `methods: []` = any method (mirrors the
 * `[tool.method ?? null]` fallback in `allRuleVariants`). */
export interface CatalogTool {
  hostPattern: string;
  paths: string[];
  methods: string[];
}

/** provider → tool id → endpoints. */
export type CatalogJson = Record<string, Record<string, CatalogTool>>;

/** Derive the gateway catalog projection from catalog definitions. Includes the
 * wildcard tool of each group (via `allGroupTools`), keyed by tool id. */
export const buildCatalogJson = (
  defs: AppPermissionDefinition[],
): CatalogJson => {
  const out: CatalogJson = {};
  for (const def of defs) {
    const tools: Record<string, CatalogTool> = {};
    for (const group of def.groups) {
      for (const tool of allGroupTools(group)) {
        tools[tool.id] = {
          hostPattern: tool.hostPattern,
          paths: [tool.pathPattern, ...(tool.aliasPatterns ?? [])],
          // INVARIANT: empty `methods` means "any method" (the gateway's
          // catalog.rs reads `[]` as any). A tool must therefore never be
          // authored with an *explicit* empty `methods: []` to mean "no method" —
          // that would fan out to zero variants in TS `allRuleVariants` (matches
          // nothing) but any-method in the gateway (fail-open). Use a real method
          // list, or omit both `method`/`methods` for genuine any-method tools.
          methods: tool.methods ?? (tool.method ? [tool.method] : []),
        };
      }
    }
    // Sort tool keys for a stable, diff-friendly serialization.
    out[def.provider] = Object.fromEntries(
      Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
};

/** Canonical serialization (stable key order, trailing newline) — the exact
 * bytes committed and drift-checked. */
export const serializeCatalogJson = (catalog: CatalogJson): string =>
  `${JSON.stringify(catalog, null, 2)}\n`;
