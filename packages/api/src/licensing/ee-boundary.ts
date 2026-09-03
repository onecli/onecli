/**
 * The enterprise-license boundary, as data.
 *
 * The OneCLI Enterprise License covers exactly the paths in `LICENSED_ROOTS`
 * and `LICENSED_FILES`, and nothing else — a notice pointing at the terms
 * sits in each licensed directory, so the licence is scoped by where a file
 * lives. Two
 * rules keep that claim true, and `ee-boundary.test.ts` enforces both:
 *
 *   1. CONTENTS — only enterprise or hosted-platform code lives under a
 *      licensed root. A free feature there would make the free product's own
 *      code commercially licensed. This is a semantic judgement, so the test
 *      pins the file list: adding or removing one forces a conscious "is this
 *      actually enterprise?" decision in review.
 *   2. DIRECTION — licensed code may import shared code, never the reverse.
 *      Shared code importing `ee/` would make the free product depend on
 *      licensed code. Only the seams below may cross, and each is counted so
 *      a new crossing fails rather than accumulating quietly.
 *
 * Type-only imports and lazy `next/dynamic` / `import()` calls are seams, not
 * dependencies: they carry no runtime coupling in the free build. Only static
 * value imports are checked.
 */

/** Repo-root-relative directories the enterprise license covers. */
export const LICENSED_ROOTS = [
  "apps/web/src/ee",
  "packages/api/src/ee",
  "apps/gateway/crates/ee",
] as const;

/** Licensed files that sit outside a licensed directory (module roots).
 * Empty since the gateway's ee code became the `ee` crate — its old
 * module root (`ee.rs`) is now the crate's `src/lib.rs`, inside the root. */
export const LICENSED_FILES = [] as const;

/**
 * Shared files permitted to statically import licensed code, with the reason
 * and the exact number of crossings. A count mismatch in either direction is
 * a failure: new coupling must be declared, and coupling that goes away must
 * shrink the allowance so it cannot be silently re-spent elsewhere.
 *
 * `permanent: true` marks a structural seam that is correct by design.
 * Everything else is DEBT: a free surface that embeds an enterprise control
 * and should stop importing it once the entitlement gates land (the gating PR
 * turns these into conditional or lazily-loaded renders). The total is pinned
 * so the debt can only shrink.
 */
export interface Seam {
  /** Repo-root-relative file, or a glob ending in `/**`. */
  readonly from: string;
  readonly why: string;
  /** Exact static imports of licensed code expected from `from`. */
  readonly count: number;
  readonly permanent?: boolean;
}

export const SEAMS: readonly Seam[] = [
  {
    from: "packages/api/src/edition-defaults.ts",
    why: "The boot-time injector: the one place that wires cloud provider implementations into the shared seams. Called from server entry points only, never from a client-reachable module.",
    count: 15,
    permanent: true,
  },
  {
    from: "apps/web/src/app/**",
    why: "Next.js route files are mount points, not libraries — the app must be able to route to a licensed page when licensed. Each is a one-line re-export or a thin entitlement wrapper (server-side isEntitled() check → the licensed page or the locked card) carrying no feature logic. The two former residuals (`p/[workspaceId]/layout.tsx`, `(admin)/layout.tsx`) now mount free implementations that route role questions through the provider seam. The aws-marketplace fulfillment routes (cloud-billing-only pages; dark off cloud) mount the licensed billing actions the same way.",
    count: 15,
    permanent: true,
  },
  {
    from: "packages/api/src/app.ts",
    why: "Composition root: the one shared file that mounts the licensed route block (registerEeRoutes). Same role as edition-defaults.ts — it wires the app together rather than depending on a feature.",
    count: 1,
    permanent: true,
  },
  {
    from: "apps/api-server/src/**",
    why: "Host wiring: the standalone API server mounts the SCIM app, passes the cloud session provider and session hooks into createApiApp, and starts the AWS Marketplace metering job. Same role as edition-defaults.ts — a composition root, not a library.",
    count: 4,
    permanent: true,
  },
  {
    from: "apps/gateway/crates/onecli-gateway/**",
    why: "Composition root. The bin crate wires every licensed backend into the shared trait seams at startup (Redis cache/approval stores, the KMS envelope backend, the Cognito session validator, the RBAC role resolver, the budget spend sink) and runs the HA entitlement check. It re-exports the licensed crate at its root (`use ee;`), so the wiring reads `crate::ee::…` and stays countable by the `crate::` arm. The count is per FILE, not per module (imports are deduped within a file, then summed across files): `main.rs` reaches 1 module (`ha`, the entitlement check) and `wiring.rs` reaches 5 (`ha` for the two Redis stores, `kms_crypto`, `cognito`, `rbac`, `budget`) = 6. (This was 8 while the crates carried a `gateway-` prefix, but two of those were spelling artefacts rather than dependencies — the `use gateway_ee as ee;` alias declaration itself, and a doc comment naming `crate::ee::…`. The detector now reads Rust code with whole-line comments stripped, and the crate is named `ee`, so the number is the real seam count.)",
    count: 6,
    permanent: true,
  },
  {
    from: "apps/gateway/crates/proxy/**",
    why: "The proxy pipeline calls the licensed features at defined points: connect-time budget bindings, granular-access scoping and the platform trial credential; the forward/websocket app-availability check; the hooks' budget + granular guards; and the licensed agent-facing responses. One binary, so these are direct calls rather than a runtime seam.",
    count: 11,
    permanent: true,
  },
  {
    from: "apps/gateway/crates/policy-engine/**",
    why: "Connect-time policy assembly reads the licensed group-principal set and app-availability allowlist (`enforce.rs`), and the injection selection intersects the licensed granular-access scopes (`inject_select.rs`). Unlicensed deployments resolve these to empty without querying. (The licensed principal parity test lives in the ee crate and reaches the free twin here through a dev-dependency, so it is not a production crossing.) Was 3 while the crates carried a `gateway-` prefix: the third was `loaders.rs`, which only NAMES the licensed loader in doc comments and calls nothing. The detector now strips whole-line Rust comments, so prose no longer spends the allowance.",
    count: 2,
    permanent: true,
  },
  {
    from: "apps/gateway/crates/server/**",
    why: "Route mount: the control-plane router mounts the licensed org-scoped routes (`org_routes::mount`), which answer the license 403 per handler when unentitled. Same role as the API's app.ts — composition, not a feature dependency.",
    count: 1,
    permanent: true,
  },
  {
    from: "apps/web/src/lib/**",
    why: "DEBT. Free surfaces that statically embed an enterprise or hosted-platform control: quota dialogs and plan badges (inert without billing), workspace sharing, member provisioning and role management. Each render now sits behind the unified gate (usePlanGate locks by plan on cloud and by license on self-host), but the static imports remain; this number must only go down. (43 → 42 when the AWS-external-id server action — which reached requireRole directly — became an admin-gated API route, taking its crossing with it.)",
    count: 42,
  },
  {
    from: "packages/api/src/routes/**",
    why: "DEBT. Free route handlers calling services that stayed licensed: workspace CRUD reaches workspace-service (#62 is Free — the service itself is a follow-up move), and both it and cli-auth reach the RBAC guard + authorization-service (#66, correctly licensed). The `roleResolver` provider already exists as the seam these should use; routing them through it changes onprem behavior, so it belongs with the gating PR.",
    count: 4,
  },
  {
    from: "packages/api/src/lib/**",
    why: "DEBT. The identity-conflict guard (#79 Free) asks SSO trust (#74 licensed) whether a session can vouch for an email domain. It degrades correctly today (no SSO configured → no vouch), but the call should go through a provider seam like every other cross-boundary question.",
    count: 1,
  },
];

/**
 * Total declared debt: free code that still statically reaches licensed code.
 * Pinned exactly (the caps and this total behave as `=`): removing a crossing
 * must lower the seam count AND this total in the same change, so freed slack
 * can never be silently re-spent elsewhere.
 */
export const CROSSING_DEBT = 47;

/**
 * Dynamic (`import(...)` / `next/dynamic`) reaches into licensed code. These
 * carry no build-time coupling — the free build never evaluates them — but
 * they are still seams, so every site is DECLARED here and pinned exactly by
 * `ee-boundary.test.ts`: a new dynamic crossing fails until it is added, and
 * a removed one fails until it is deleted. One entry per file; `specifiers`
 * lists the exact licensed module strings the file may lazily load.
 */
export interface DynamicSeam {
  readonly from: string;
  readonly specifiers: readonly string[];
}

export const DYNAMIC_SEAMS: readonly DynamicSeam[] = [
  {
    from: "apps/web/src/lib/auth/auth-provider.tsx",
    specifiers: ["@/ee/auth/cognito-provider"],
  },
  {
    from: "apps/web/src/lib/auth/auth-server.ts",
    specifiers: ["@/ee/auth/cognito-server"],
  },
  {
    from: "apps/web/src/lib/auth/login-content.tsx",
    specifiers: ["@/ee/auth/login-content"],
  },
  {
    from: "apps/web/src/lib/onboarding/onboarding-layout.tsx",
    specifiers: ["@/ee/billing/actions"],
  },
  {
    from: "apps/web/src/lib/plan-gate.tsx",
    specifiers: ["@/ee/billing/_components/plan-paywall-dialog"],
  },
  {
    from: "apps/web/src/lib/policy-editor/resource-scope.tsx",
    specifiers: ["@/ee/policy-editor/_components/resource-scope-fields"],
  },
  {
    from: "apps/web/src/lib/user-plan.tsx",
    specifiers: ["@/ee/billing/actions"],
  },
  {
    from: "apps/web/src/lib/workspaces/workspace-layout.tsx",
    specifiers: ["@/ee/billing/_components/over-quota-banner"],
  },
  {
    from: "packages/api/src/services/policy-onprem-validator.ts",
    specifiers: ["../ee/granular-access/shape"],
  },
];

/**
 * Deliberate Apache MIRRORS of licensed enforcement: shared files that
 * implement (a slice of) an enterprise feature's semantics because FREE
 * paths execute them — moving them into ee/ would make the free product
 * depend on licensed code. Each carries a `LICENSED-MIRROR:` header notice
 * naming its licensed twin, pinned by `ee-boundary.test.ts`, so the
 * acceptance stays explicit, reviewed, and cannot silently grow: adding a
 * new mirror means adding it here, with the notice, in review.
 */
export const LICENSED_MIRRORS = [
  // The TS twin of the gateway's licensed principal CTE — feeds free hot
  // paths (credential injection, grants summaries, reflections).
  "packages/api/src/services/policy-simulate/principal-set.ts",
  // The TS twin of ee/granular_access.rs ResourceAxis — composes scopes for
  // free reflection routes and is client-bundle-reachable.
  "packages/api/src/lib/resource-axis.ts",
  // The TS twin of the gateway's boundary derivation — feeds the free
  // effective-permissions reflection.
  "packages/api/src/services/policy-reflect/org-resource-boundary.ts",
] as const;

/**
 * The header notice every LICENSED_MIRRORS file must carry — the prefix
 * includes "twin of" so a bare marker with no named licensed counterpart
 * cannot satisfy the pin.
 */
export const MIRROR_NOTICE = "LICENSED-MIRROR: deliberate Apache twin of";

/** Files that are not source and never participate in the boundary. */
export const IGNORED = ["LICENSE", ".gitignore", ".DS_Store"] as const;

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".rs",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

export const isSourceFile = (path: string): boolean =>
  SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));

/**
 * Tests are exempt from the direction rule. They are not shipped product code,
 * so a test reaching into licensed code cannot make the free product depend on
 * it — and a test SHOULD be able to exercise both sides of the boundary.
 * (JS/TS only, module-suffix variants included; Rust in-file `#[cfg(test)]`
 * blocks live in production files and are deliberately NOT exempt.)
 */
export const isTestFile = (path: string): boolean =>
  /\.(test|spec)\.[mc]?[jt]sx?$/.test(path) ||
  /\.[a-z]+\.test\.[mc]?[jt]sx?$/.test(path);

export const isUnderLicensedPath = (path: string): boolean =>
  LICENSED_ROOTS.some((root) => path.startsWith(`${root}/`)) ||
  LICENSED_FILES.some((file) => path === file);

/**
 * This file defines the boundary; it names licensed paths in prose and in
 * detector patterns, so scanning it would flag the definition as a consumer.
 * Exactly this one file — the suites beside it are already test-exempt, and
 * a whole-directory exemption would let a product module dropped into
 * `licensing/` import ee/ unseen.
 */
export const isBoundaryDefinition = (path: string): boolean =>
  path === "packages/api/src/licensing/ee-boundary.ts";

const globMatches = (pattern: string, path: string): boolean =>
  pattern.endsWith("/**")
    ? path.startsWith(pattern.slice(0, -2))
    : pattern === path;

export const seamFor = (path: string): Seam | undefined =>
  SEAMS.find((seam) => globMatches(seam.from, path));

/**
 * Static value imports of licensed code, one entry per import site.
 *
 * Deliberately excludes `import type` (erased at build time) and dynamic
 * `import(...)` (the lazy-load seam) — neither couples the free build to
 * licensed code. TypeScript specifiers are `@/ee/…` (web-internal),
 * `@onecli/api/ee/…` (cross-package), or a relative path into `ee/`; Rust
 * uses `crate::ee::…`.
 */
/**
 * The licensed-specifier alternation, parameterized on the quote characters a
 * match may not cross — the ONE definition both detectors build from, so a
 * new specifier form (a fresh path alias to `ee/`, say) cannot be added to
 * one and silently missed by the other.
 */
const licensedSpecifier = (quotes: string): string =>
  String.raw`@\/ee(?:\/[^${quotes}]*)?|@onecli\/api\/ee(?:\/[^${quotes}]*)?|(?:\.\.?\/)+ee(?:\/[^${quotes}]*)?`;

export const findLicensedImports = (source: string): readonly string[] => {
  // Strip whole `import type … from "…"` statements, single- or multi-line.
  // Filtering line-by-line is not enough (a multi-line type import leaves its
  // `} from "…"` line behind, which then reads as a value import) — but the
  // pattern MUST be anchored to the start of a line. Unanchored, the token
  // "import type" inside a comment eats everything up to the next `from "…"`,
  // swallowing a real crossing.
  const withoutTypeImports = source.replace(
    /^\s*import\s+type\s[\s\S]*?from\s+["'][^"']*["'];?/gm,
    "",
  );

  // A licensed specifier, with or without a trailing path. The optional tail
  // is load-bearing: `from "./ee"` (the directory's index) is every bit as
  // much a dependency as `from "./ee/scim"`, and omitting it hid the API's
  // own licensed route mount from this guard.
  const licensed = licensedSpecifier(`"'`);

  // Rust prose names licensed modules constantly ("the licensed backend in
  // `ee::ha`"), and since the licensed code became a crate literally named
  // `ee`, a doc comment is spelled exactly like a real use. A comment is
  // never a dependency, so the Rust arms below read a copy with whole-line
  // comments removed.
  //
  // Deliberately conservative: only lines whose FIRST non-space token starts
  // a comment (`//`, `///`, `//!`) are dropped, so this can never eat code.
  // A trailing comment on a code line is left in place — over-reporting a
  // crossing that is really prose is a reviewable annoyance, while dropping
  // real code would blind the guard. (The gateway has no `ee::` in a trailing
  // comment today, and the bare-path test below keeps the bin honest.)
  const withoutRustLineComments = withoutTypeImports.replace(
    /^[ \t]*\/\/.*$/gm,
    "",
  );

  const tsSpecifiers = [
    // TS/JS: `… from "<spec>"`.
    new RegExp(String.raw`\bfrom\s+["'](${licensed})["']`, "g"),
    // TS/JS: a bare side-effect import, `import "<spec>"`.
    new RegExp(String.raw`\bimport\s+["'](${licensed})["']`, "g"),
    // CJS: `require("<spec>")` executes eagerly — a real dependency, not a
    // seam. Nothing in the repo uses it today; the arm keeps that true.
    new RegExp(String.raw`\brequire\s*\(\s*["'](${licensed})["']`, "g"),
  ];

  const rustSpecifiers = [
    // Rust: `crate::ee::<module>` and `super::…::ee::<module>`.
    /\b(?:crate::|(?:super::)+)ee\b(?:::\w+)?/g,
    // Rust: the workspace-crate spelling. Since the gateway became a Cargo
    // workspace the licensed code is a CRATE named `ee`, so a dependent names
    // it with a BARE `ee::<module>` path — there is no `crate::` prefix from
    // another crate. Without this arm every crossing outside the bin would be
    // invisible to the guard.
    //
    // The lookbehind is load-bearing in two directions. It stops this arm
    // double-counting the `crate::ee::`/`super::ee::` forms the arm above
    // already reports (a Set of distinct strings would otherwise hold both
    // `crate::ee::budget` and `ee::budget` for one crossing, inflating the
    // seam count), and it keeps a suffix like `employee::x` from matching.
    /(?<![:\w])ee::\w+/g,
    // Rust: a grouped `use crate::{ee, …}` / `use crate::{a::{b}, ee::x}`.
    // Matches the `ee` member anywhere in the group, with or without a tail,
    // and tolerates nested groups before it.
    /\buse\s+crate::\{[\s\S]*?\bee\b(?:::\w+)?/g,
    // Rust: `#[path = "…"]` retargeting a module at a licensed file. A shared
    // module pointed into ee/ would compile licensed code under a free-looking
    // name without ever writing `crate::ee`. The `ee` must be a whole path
    // segment (`ee/…` or `ee.rs`) — `employee.rs` must not match. Unused
    // today; the arm keeps it so.
    /#\[\s*path\s*=\s*"(?:[^"]*\/)?ee(?:\/[^"]*|\.rs)"\s*\]/g,
    // Rust: `include!` splicing a licensed file's CODE into a shared one —
    // textual inclusion is a dependency the module system never sees. Same
    // whole-segment discipline. `include_str!`/`include_bytes!` stay
    // unmatched on purpose: they embed data, not code (the same decision the
    // gateway-wide structural-escape guard documents).
    /\binclude!\s*\(\s*"(?:[^"]*\/)?ee(?:\/[^"]*|\.rs)"\s*\)/g,
  ];

  const hits = new Set<string>();
  for (const [patterns, text] of [
    [tsSpecifiers, withoutTypeImports],
    [rustSpecifiers, withoutRustLineComments],
  ] as const) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        // A dynamic import is a seam, not a dependency: skip `import("…")`.
        const before = text.slice(Math.max(0, match.index - 20), match.index);
        if (/\bimport\s*\($/.test(before)) continue;
        hits.add(match[1] ?? match[0]);
      }
    }
  }
  // Deduped per file: the unit that matters is "this file depends on that
  // licensed module", not how many times it says so — otherwise a refactor
  // that inlines one extra call reads as new coupling.
  return [...hits];
};

/**
 * DYNAMIC reaches into licensed code — `import("<licensed>")`, including the
 * `next/dynamic(() => import(...))` form. The complement of the static
 * detector: a specifier counts here iff it is an `import(...)` call argument.
 * These are seams (evaluation is deferred; the free build never runs them),
 * but every site must be declared in `DYNAMIC_SEAMS` — the test pins the
 * full set in both directions.
 */
export const findLicensedDynamicImports = (
  source: string,
): readonly string[] => {
  // Backtick literals count too: `import(\`../ee/x\`)` is the same seam in a
  // different quote. (An INTERPOLATED specifier can't be matched statically —
  // but it can't be declared either, so the exact-set test still fails the
  // file the moment its literal form disappears from DYNAMIC_SEAMS.)
  const licensed = licensedSpecifier(`"'\x60`);
  const pattern = new RegExp(
    String.raw`\bimport\s*\(\s*["'\x60](${licensed})["'\x60]`,
    "g",
  );
  const hits = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) hits.add(specifier);
  }
  return [...hits];
};
