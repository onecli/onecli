import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LICENSED_ROOTS,
  LICENSED_FILES,
  LICENSED_MIRRORS,
  MIRROR_NOTICE,
  DYNAMIC_SEAMS,
  SEAMS,
  CROSSING_DEBT,
  findLicensedDynamicImports,
  findLicensedImports,
  isBoundaryDefinition,
  isSourceFile,
  isTestFile,
  isUnderLicensedPath,
  seamFor,
} from "./ee-boundary";

// Enforces the enterprise-license boundary described in ./ee-boundary.ts.
// Reaching across the whole repo from this package follows the precedent set
// by apps/app-permissions/catalog-json.test.ts, which likewise reads the
// gateway tree — so this runs in the existing CI test job with no new wiring.
//
// When this fails, the fix is a decision, not a config tweak: either the file
// belongs on the other side of the boundary, or the crossing is legitimate and
// belongs in SEAMS with a reason.

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

// Inside a git hook (pre-push runs this suite via `pnpm check`), git exports
// GIT_DIR/GIT_INDEX_FILE pointing at the INVOKING checkout's git dir — from a
// worktree, that is the main repository's. Inherited by the child process,
// `git ls-files` then enumerates the wrong tree and the suite fails on
// phantom diffs. Scrub the vars so git resolves from cwd alone.
const gitCleanEnv = { ...process.env };
delete gitCleanEnv.GIT_DIR;
delete gitCleanEnv.GIT_WORK_TREE;
delete gitCleanEnv.GIT_INDEX_FILE;

const gitFiles = (): string[] =>
  // The boundary governs what would ship from THIS tree, so the enumeration
  // must match the worktree in both directions or local runs and CI disagree:
  // `--others --exclude-standard` adds new files that aren't committed yet
  // (bare `ls-files` reads only the index, so a brand-new licensed file was
  // invisible locally and first surfaced as a CI-only snapshot failure), and
  // the existsSync filter drops files deleted in the worktree that the index
  // still lists.
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: gitCleanEnv,
    },
  )
    .split("\n")
    .filter(Boolean)
    .filter((path) => existsSync(`${REPO_ROOT}${path}`));

const read = (path: string): string =>
  readFileSync(`${REPO_ROOT}${path}`, "utf8");

describe("enterprise-license boundary", () => {
  // ── Rule 2: direction ──────────────────────────────────────────────────
  // Shared code must not statically import licensed code, or the free product
  // depends on code a self-hoster may not run in production.
  it("shared code never statically imports licensed code, except at declared seams", () => {
    const offenders: string[] = [];
    const seamCounts = new Map<string, number>();

    for (const file of gitFiles()) {
      if (!isSourceFile(file) || isTestFile(file)) continue;
      if (isBoundaryDefinition(file)) continue;
      if (isUnderLicensedPath(file)) continue;
      const imports = findLicensedImports(read(file));
      if (imports.length === 0) continue;

      const seam = seamFor(file);
      if (!seam) {
        offenders.push(`${file} → ${imports.join(", ")}`);
        continue;
      }
      seamCounts.set(
        seam.from,
        (seamCounts.get(seam.from) ?? 0) + imports.length,
      );
    }

    expect(
      offenders,
      "shared files importing licensed code. Move the code out of ee/, make the " +
        "import type-only/dynamic, or declare a seam in ee-boundary.ts with a reason",
    ).toEqual([]);

    // A structural seam is pinned exactly, in both directions: new coupling
    // must be declared, and coupling that goes away must shrink the allowance
    // so it cannot be silently re-spent somewhere else.
    for (const seam of SEAMS.filter((s) => s.permanent)) {
      expect(
        seamCounts.get(seam.from) ?? 0,
        `seam count for ${seam.from}`,
      ).toBe(seam.count);
    }

    // The debt — free surfaces statically embedding enterprise controls — is
    // pinned EXACTLY, per seam and in total. `≤` once let removed crossings
    // leave silent slack a new crossing elsewhere could spend unreviewed;
    // now reducing debt means lowering the seam count AND CROSSING_DEBT in
    // the same change, and adding debt is always a declared decision.
    const debtSeams = SEAMS.filter((s) => !s.permanent);
    for (const seam of debtSeams) {
      expect(
        seamCounts.get(seam.from) ?? 0,
        `debt for ${seam.from} is pinned exactly; lower its count when you reduce it (never raise it without review)`,
      ).toBe(seam.count);
    }

    const debt = debtSeams.reduce(
      (n, s) => n + (seamCounts.get(s.from) ?? 0),
      0,
    );
    expect(
      debt,
      `ee/ crossing debt is pinned exactly (${CROSSING_DEBT}); lower CROSSING_DEBT when you reduce a seam`,
    ).toBe(CROSSING_DEBT);
  });

  // ── Rule 2b: dynamic seams ─────────────────────────────────────────────
  // `import("…/ee/…")` / next/dynamic sites carry no build-time coupling, but
  // they still execute licensed code at runtime — so every one is declared in
  // DYNAMIC_SEAMS and the full set is pinned in BOTH directions: an undeclared
  // site fails, and a declared site that disappears fails until it is removed
  // from the list.
  it("dynamic reaches into licensed code match DYNAMIC_SEAMS exactly", () => {
    const actual = new Map<string, readonly string[]>();
    for (const file of gitFiles()) {
      if (!isSourceFile(file) || isTestFile(file)) continue;
      if (isBoundaryDefinition(file)) continue;
      if (isUnderLicensedPath(file)) continue;
      const specifiers = findLicensedDynamicImports(read(file));
      if (specifiers.length > 0) actual.set(file, [...specifiers].sort());
    }

    const found = [...actual.entries()]
      .map(([from, specifiers]) => ({ from, specifiers }))
      .sort((a, b) => a.from.localeCompare(b.from));
    const declared = [...DYNAMIC_SEAMS]
      .map((s) => ({ from: s.from, specifiers: [...s.specifiers].sort() }))
      .sort((a, b) => a.from.localeCompare(b.from));

    expect(
      found,
      "dynamic ee/ imports must match DYNAMIC_SEAMS exactly — declare a new " +
        "site with a reason in review, and delete entries whose site is gone",
    ).toEqual(declared);
  });

  // ── Rule 1b: declared mirrors ──────────────────────────────────────────
  // A LICENSED_MIRRORS file implements enterprise semantics in Apache code
  // because free paths execute it. The acceptance is pinned: the file must
  // exist and carry the LICENSED-MIRROR header notice naming its licensed
  // twin, so the mirror can neither vanish silently nor lose its declaration.
  it("every declared mirror exists and carries its notice", () => {
    const files = gitFiles();
    for (const file of LICENSED_MIRRORS) {
      expect(
        files.includes(file),
        `${file} is declared in LICENSED_MIRRORS but does not exist — ` +
          "remove the entry (and celebrate: the mirror is gone)",
      ).toBe(true);
      expect(
        read(file).includes(MIRROR_NOTICE),
        `${file} must carry a "${MIRROR_NOTICE} <licensed path>" header notice`,
      ).toBe(true);
    }
  });

  // ── Rule 2c: Rust structural escapes ───────────────────────────────────
  // `#[path = "…"]` and `include!(…)` splice source across module boundaries
  // in ways the import detector cannot see — a shared file could textually
  // include licensed code with zero `crate::ee::` tokens. Neither construct
  // is used in the gateway today; any future use is a boundary decision, not
  // a convenience, so the guard is an empty allowlist. (`include_str!` is
  // fine — it embeds DATA, not code.)
  it("gateway Rust never uses #[path] or include!", () => {
    const offenders: string[] = [];
    for (const file of gitFiles()) {
      // The WHOLE workspace, not one crate: since the gateway became a Cargo
      // workspace a splice could hide in any member.
      if (!file.startsWith("apps/gateway/crates/") || !file.endsWith(".rs"))
        continue;
      const source = read(file);
      if (/#\[path\b/.test(source)) offenders.push(`${file} uses #[path]`);
      // `include_str!`/`include_bytes!` are fine (data, not code) and can
      // never match: their token is `include_str!(`, not `include!(`.
      if (/\binclude!\s*\(/.test(source))
        offenders.push(`${file} uses include!`);
    }
    expect(offenders).toEqual([]);
  });

  // The bin crate re-exports the licensed crate at its root (`use ee;`),
  // which makes a bare `ee::ha::…` path reachable in every one of its files.
  // Both spellings are detected, but only one may be used consistently or the
  // seam count would depend on spelling: inside the bin, always write
  // `crate::ee::…`. The guard covers the whole crate, not just `main.rs`.
  it("the bin crate never reaches ee through a bare path", () => {
    const offenders: string[] = [];
    for (const file of gitFiles()) {
      if (
        !file.startsWith("apps/gateway/crates/onecli-gateway/src/") ||
        !file.endsWith(".rs")
      )
        continue;
      const source = read(file);
      // The root re-export (`use ee;`) is the declaration and names no
      // module, so it is not itself a crossing; only an unprefixed `ee::`
      // USE would record the crossing under a second spelling.
      const bare = source.match(/(?<![:\w])ee::/g) ?? [];
      if (bare.length > 0) offenders.push(`${file} (${bare.length})`);
    }
    expect(offenders).toEqual([]);
  });

  // ── Rule 1: contents ───────────────────────────────────────────────────
  // Whether a file is *really* an enterprise feature is a judgement no script
  // can make, so the guard pins the exact contents of the licensed trees and
  // makes a human answer the question in review.
  //
  // The full file list, not just the feature areas: an area-level snapshot
  // only catches code arriving. Code LEAVING — a licensed file quietly moved
  // to a shared path, un-licensing revenue code — would keep the area name
  // and pass, which is the more expensive mistake of the two.
  it("the licensed file set changes only by deliberate review", () => {
    const files = gitFiles().filter(isSourceFile);
    const licensed: Record<string, string[]> = {};

    for (const root of LICENSED_ROOTS) {
      licensed[root] = files
        .filter((f) => f.startsWith(`${root}/`))
        .map((f) => f.slice(root.length + 1))
        .sort();
    }
    licensed["(files)"] = [...LICENSED_FILES].filter((f) => files.includes(f));

    expect(licensed).toMatchSnapshot();
  });

  // The file-list snapshot above catches a licensed FILE disappearing, but not
  // licensed CODE moving out of one — a function lifted from a licensed file
  // into a shared crate leaves the file (and the snapshot) intact while
  // un-licensing the logic. That is exactly what happened once: a licensed
  // principal parity test was relocated into an Apache-2.0 crate during the
  // gateway workspace split, and every path- and import-based check passed.
  //
  // So pin the licensed SYMBOLS too. Adding one is normal review; REMOVING one
  // means the code either died or emigrated, and the diff makes a human say
  // which.
  it("the licensed symbol set changes only by deliberate review", () => {
    // Rust items (the gateway) and TS exports (web/api) in one shape: the
    // question "what does the licence cover?" is language-independent.
    const RUST_ITEM =
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
    const TS_EXPORT =
      /^\s*export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

    const symbols: Record<string, string[]> = {};
    for (const file of gitFiles().filter(isSourceFile)) {
      if (!isUnderLicensedPath(file)) continue;
      const source = read(file);
      const pattern = file.endsWith(".rs") ? RUST_ITEM : TS_EXPORT;
      const found = [...source.matchAll(pattern)]
        .map((m) => m[1])
        .filter((name): name is string => Boolean(name));
      // COUNT each definition, do not just collect the name. A licensed
      // function lifted into a shared crate often leaves its name behind in
      // the licensed file (a trait impl forwarding to it, a test calling it),
      // so a name SET still matches while the definition has emigrated —
      // observed for real with `user_is_org_admin`. Counting makes the
      // departure visible: 2 -> 1 fails, and review says which.
      const tally = new Map<string, number>();
      for (const name of found) tally.set(name, (tally.get(name) ?? 0) + 1);
      if (tally.size > 0) {
        symbols[file] = [...tally.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
      }
    }

    expect(symbols).toMatchSnapshot();
  });

  it("every licensed root exists and carries its license copy", () => {
    for (const root of LICENSED_ROOTS) {
      expect(() => read(`${root}/LICENSE`), `${root}/LICENSE`).not.toThrow();
    }
    for (const file of LICENSED_FILES) {
      expect(() => read(file), file).not.toThrow();
    }
    // Each notice must NAME the license and POINT to the terms. It does not
    // restate them: four copies of a 51-line grant drifted the moment one was
    // edited, and a stale copy is a second, conflicting grant. What the notice
    // has to do is stop a reader who lands in this directory from assuming the
    // repository's Apache license covers it, and tell them where to look.
    for (const root of LICENSED_ROOTS) {
      const text = read(`${root}/LICENSE`);
      expect(
        text,
        `${root}/LICENSE must name the OneCLI Enterprise License`,
      ).toContain("OneCLI Enterprise License");
      expect(
        text,
        `${root}/LICENSE must point at the terms (/LICENSE-ENTERPRISE)`,
      ).toContain("/LICENSE-ENTERPRISE");
      expect(
        text,
        `${root}/LICENSE must say the Apache license does not cover it`,
      ).toMatch(/NOT covered by the Apache License/i);
      expect(
        text,
        `${root}/LICENSE must state the production-use condition`,
      ).toMatch(/production use requires/i);
    }
    // A licensed file with no adjacent LICENSE needs its notice in-file.
    for (const file of LICENSED_FILES) {
      expect(
        read(file),
        `${file} must carry an in-file license notice`,
      ).toMatch(/enterprise license/i);
    }
  });

  // ── The paperwork says what the code says ──────────────────────────────
  //
  // The path list is authored ONCE, in LICENSE-ENTERPRISE under "THE LICENSED
  // PATHS", and every other document points at it. It lives in the enterprise
  // license rather than the root LICENSE so the grant document defines its
  // own scope and the Apache file stays the pristine, tool-recognizable text
  // (GitHub's licensee needs a near-verbatim match to name it Apache-2.0).
  // That is what keeps a rename from needing seven edits — but it only works
  // if the one remaining copy cannot drift from
  // `LICENSED_ROOTS`/`LICENSED_FILES`, which is what the boundary is actually
  // enforced against. Prose that disagrees with the enforced boundary is
  // worse than no prose: it is a written claim we do not honour.
  it("the LICENSE-ENTERPRISE path list is exactly the boundary the code enforces", () => {
    const section = /THE LICENSED PATHS\.[\s\S]*?\n\n([\s\S]*?)\n\n/.exec(
      read("LICENSE-ENTERPRISE"),
    );
    expect(
      section,
      "LICENSE-ENTERPRISE must carry a THE LICENSED PATHS block",
    ).not.toBe(null);

    const listed = (section?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    // Roots are written with a trailing slash, so a reader cannot mistake
    // the licensed roots; the gateway root is a whole CRATE directory.
    const expected = [
      ...LICENSED_ROOTS.map((root) => `${root}/`),
      ...LICENSED_FILES,
    ];

    expect([...listed].sort()).toEqual([...expected].sort());
  });

  // The per-directory notices say the same thing as each other, so no reader
  // can be told a different story depending on which directory they opened.
  // They are pointers, so this is cheap to hold true — the previous full-text
  // copies made the same promise across 51 lines each and could not keep it.
  it("every licensed directory carries the same notice", () => {
    const [first, ...rest] = LICENSED_ROOTS;
    const expected = read(`${first}/LICENSE`);
    for (const dir of rest) {
      expect(
        read(`${dir}/LICENSE`),
        `${dir}/LICENSE differs from ${first}/LICENSE`,
      ).toBe(expected);
    }
  });

  // The notices are pointers, so the thing they point AT has to exist and has
  // to be the real grant. Without this the collapse could quietly leave every
  // licensed directory referring to a file that no longer states any terms.
  it("the terms the notices point at are the real grant", () => {
    const terms = read("LICENSE-ENTERPRISE");
    expect(terms, "LICENSE-ENTERPRISE must state the grant").toContain(
      "LICENSE GRANT",
    );
    expect(terms, "LICENSE-ENTERPRISE must state the restrictions").toContain(
      "RESTRICTIONS",
    );
    expect(terms, "LICENSE-ENTERPRISE must disclaim warranties").toContain(
      "DISCLAIMER",
    );
    expect(terms, "LICENSE-ENTERPRISE must limit liability").toContain(
      "LIMITATION OF LIABILITY",
    );
  });

  // The documents that defer to LICENSE-ENTERPRISE must actually say so, and
  // the root LICENSE must never restate the paths — a preamble there is both
  // duplication and exactly what broke GitHub's Apache-2.0 detection. Without
  // this a well-meaning edit re-inlines the list somewhere and the
  // duplication grows back, one file at a time.
  it("the other documents defer to LICENSE-ENTERPRISE rather than restating the paths", () => {
    for (const doc of [
      "LICENSE",
      "NOTICE",
      "README.md",
      "CONTRIBUTING.md",
      "CLA.md",
    ]) {
      const text = read(doc);
      // The root LICENSE is the one document that must not point anywhere:
      // it stays the verbatim Apache text and mentions no other file.
      if (doc !== "LICENSE") {
        expect(
          text,
          `${doc} must point at LICENSE-ENTERPRISE for the paths`,
        ).toMatch(/LICENSE-ENTERPRISE/);
      }
      for (const root of LICENSED_ROOTS) {
        expect(text, `${doc} restates the licensed path ${root}`).not.toContain(
          root,
        );
      }
    }
  });

  // ── Positive controls ──────────────────────────────────────────────────
  // A guard that cannot fail is testing nothing (same reasoning as the
  // client-bundle guard's server-graph control in ci.yml).
  describe("the detector actually detects", () => {
    it("flags each static import form", () => {
      expect(
        findLicensedImports('import { x } from "@/ee/groups/api";'),
      ).toEqual(["@/ee/groups/api"]);
      expect(
        findLicensedImports('import { y } from "@onecli/api/ee/scim";'),
      ).toEqual(["@onecli/api/ee/scim"]);
      expect(findLicensedImports('import { z } from "../ee/budget";')).toEqual([
        "../ee/budget",
      ]);
      expect(findLicensedImports("use crate::ee::budget;")).toEqual([
        "crate::ee::budget",
      ]);
    });

    // The forms that a first draft of this detector missed. `from "./ee"` with
    // no trailing slash hid the API's own licensed route mount, so each of
    // these is pinned rather than trusted.
    it("flags a directory import with no trailing path", () => {
      expect(findLicensedImports('import { r } from "./ee";')).toEqual([
        "./ee",
      ]);
      expect(findLicensedImports('import { r } from "../ee";')).toEqual([
        "../ee",
      ]);
      expect(findLicensedImports('import { r } from "@/ee";')).toEqual([
        "@/ee",
      ]);
      expect(
        findLicensedImports('import { r } from "@onecli/api/ee";'),
      ).toEqual(["@onecli/api/ee"]);
    });

    it("flags a bare side-effect import", () => {
      expect(findLicensedImports('import "../ee/register";')).toEqual([
        "../ee/register",
      ]);
    });

    it("flags a CJS require — eager execution is a dependency, not a seam", () => {
      expect(findLicensedImports('const x = require("../ee/scim");')).toEqual([
        "../ee/scim",
      ]);
    });

    it("the dynamic detector matches backtick literals too", () => {
      expect(
        findLicensedDynamicImports("await import(`@/ee/billing/actions`);"),
      ).toEqual(["@/ee/billing/actions"]);
    });

    it("flags a grouped Rust use", () => {
      expect(
        findLicensedImports("use crate::{ee::budget, policy::Rule};"),
      ).not.toEqual([]);
    });

    // Since the gateway became a Cargo workspace the licensed code is a CRATE
    // named `ee`, and a dependent names it with a BARE `ee::…` path (no
    // `crate::` prefix — that only applies within one crate), a spelling the
    // `crate::ee::` arm cannot see. Without this arm every crossing outside
    // the bin crate would be invisible.
    it("flags the workspace-crate spelling of the licensed gateway code", () => {
      expect(findLicensedImports("use ee::budget;")).toEqual(["ee::budget"]);
      expect(
        findLicensedImports("    ee::granular_access::enforce(x)"),
      ).toEqual(["ee::granular_access"]);
      // The bin's root re-export makes the bare form reachable crate-wide.
      expect(findLicensedImports("use ee;")).toEqual([]);
      // A lookalike crate/identifier must not match: the segment must be
      // exactly `ee`, never the tail of a longer name.
      expect(findLicensedImports("use employee::thing;")).toEqual([]);
      expect(findLicensedImports("use eels::thing;")).toEqual([]);
      expect(findLicensedImports("let x = free::ee_helper::y();")).toEqual([]);
      // One crossing counts ONCE: the bin's `crate::ee::x` must not also be
      // reported as a bare `ee::x`, or every seam count would inflate.
      expect(findLicensedImports("crate::ee::budget::bind()")).toEqual([
        "crate::ee::budget",
      ]);
      expect(findLicensedImports("super::ee::rbac::resolve()")).toEqual([
        "super::ee::rbac",
      ]);
    });

    it("strips a MULTI-LINE type import, not just its first line", () => {
      expect(
        findLicensedImports(
          'import type {\n  A,\n  B,\n} from "@/ee/billing/plans";',
        ),
      ).toEqual([]);
    });

    // Regression: an unanchored type-strip let the words "import type" inside
    // a COMMENT eat everything up to the next `from "…"`, hiding a real
    // crossing. The strip is anchored to the start of a line for this reason.
    it("a comment mentioning import type does not swallow a real crossing", () => {
      expect(
        findLicensedImports(
          '// see import type docs\nimport { X } from "@/ee/y";',
        ),
      ).toEqual(["@/ee/y"]);
    });

    it("flags the remaining Rust forms", () => {
      expect(findLicensedImports("use crate::{ee, apps};")).not.toEqual([]);
      expect(
        findLicensedImports("use crate::{apps::{a}, ee::budget};"),
      ).not.toEqual([]);
      expect(findLicensedImports("use super::super::ee::budget;")).not.toEqual(
        [],
      );
    });

    it("flags Rust include-form reaches into licensed files", () => {
      // MUTATION-TESTED (the include fence): drop either pattern and a shared
      // module outside the gateway-wide structural-escape ban could compile
      // licensed code by retargeting or splicing — `#[path]` / `include!`
      // never write `crate::ee`, so the use-path arms above cannot see them.
      expect(
        findLicensedImports('#[path = "ee/budget.rs"]\nmod budget;'),
      ).not.toEqual([]);
      expect(
        findLicensedImports('#[path = "../ee.rs"]\nmod hidden;'),
      ).not.toEqual([]);
      expect(
        findLicensedImports('include!("src/ee/generated.rs");'),
      ).not.toEqual([]);
    });

    it("does not flag ee-lookalike or data-only Rust includes", () => {
      // `ee` must be a whole path segment: employee.rs must stay invisible,
      // exactly like the employee-list guard below. And `include_str!` embeds
      // DATA, not code — the same decision the gateway structural-escape
      // guard documents — so even an ee/ path through it is not a crossing.
      expect(
        findLicensedImports('#[path = "employee.rs"]\nmod people;'),
      ).toEqual([]);
      expect(findLicensedImports('include!("tree/leaves.rs");')).toEqual([]);
      expect(
        findLicensedImports('let s = include_str!("ee/prompt.txt");'),
      ).toEqual([]);
    });

    it("ignores the seams: type-only and dynamic imports carry no runtime coupling", () => {
      expect(
        findLicensedImports('import type { P } from "@/ee/policy-editor/x";'),
      ).toEqual([]);
      expect(
        findLicensedImports(
          'const C = dynamic(() => import("@/ee/billing/x"));',
        ),
      ).toEqual([]);
    });

    it("does not flag ordinary imports", () => {
      expect(
        findLicensedImports('import { a } from "@/lib/api/agents";'),
      ).toEqual([]);
      expect(
        findLicensedImports('import { b } from "./employee-list";'),
      ).toEqual([]);
    });

    it("classifies paths and seams correctly", () => {
      expect(isUnderLicensedPath("packages/api/src/ee/scim/users.ts")).toBe(
        true,
      );
      expect(isUnderLicensedPath("apps/gateway/crates/ee/ee/src/lib.rs")).toBe(
        true,
      );
      expect(isUnderLicensedPath("packages/api/src/routes/agents.ts")).toBe(
        false,
      );
      // "employee" must not read as "ee/"
      expect(isUnderLicensedPath("apps/web/src/lib/employee.ts")).toBe(false);
      expect(seamFor("packages/api/src/edition-defaults.ts")?.count).toBe(15);
      expect(seamFor("apps/web/src/app/auth/cli/page.tsx")).toBeDefined();
      // No seam covers the API's shared code or the web's hooks — a crossing
      // from either is a hard failure, not a counted one.
      expect(
        seamFor("packages/api/src/services/agent-service.ts"),
      ).toBeUndefined();
      expect(seamFor("apps/web/src/hooks/use-agents.ts")).toBeUndefined();
      expect(isTestFile("packages/api/src/routes/workspaces.test.ts")).toBe(
        true,
      );
      expect(
        isTestFile("packages/api/src/services/grants-service.pg.test.ts"),
      ).toBe(true);
      expect(isTestFile("packages/api/src/routes/workspaces.ts")).toBe(false);
    });
  });
});
