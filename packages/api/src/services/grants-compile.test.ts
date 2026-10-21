import type { Prisma } from "@onecli/db";
import { describe, expect, it } from "vitest";
import {
  getAppPermissionDefinition,
  getAppPermissionDefinitions,
} from "../apps/app-permissions";
import { getApps } from "../apps/registry";
import { catalogToolIds } from "../apps/app-permissions/validate";
import {
  compileConnectionStack,
  defaultConnectionGrant,
  stackToGrant,
} from "./grants-compile";

/** The terminal "everything else" row (see `compileConnectionStack`). */
describe("compileConnectionStack: unlisted requests", () => {
  const shape = (
    provider: string,
    allow: string[],
    ask: string[] = [],
    conditions: Prisma.JsonValue | null = null,
  ) =>
    compileConnectionStack(
      "Grant: a · c",
      provider,
      { access: "custom", allow, ask },
      conditions,
    ).map((r) => ({
      name: r.name,
      action: r.action,
      requireApproval: r.requireApproval,
      tools: r.tools,
      conditions: r.conditions ?? null,
    }));

  it("a customized Cloudflare grant ends in a whole-app NEEDS-APPROVAL row", () => {
    const stack = shape(
      "cloudflare",
      ["deploy_worker", "write_kv"],
      ["delete_worker"],
    );
    expect(stack.map((r) => r.name)).toEqual([
      "Grant: a · c: allowed",
      "Grant: a · c: needs approval",
      "Grant: a · c: blocked",
      "Grant: a · c: everything else",
    ]);
    expect(stack.at(-1)).toMatchObject({
      action: "allow",
      requireApproval: true,
      tools: [],
    });
    // Every catalog tool is spoken for BEFORE the terminal, so an unpicked
    // catalog tool is an explicit block and never reaches the approval row.
    expect(new Set(stack.slice(0, -1).flatMap((r) => r.tools))).toEqual(
      new Set(catalogToolIds("cloudflare")),
    );
  });

  it("no catalog's customized stack ends in a silent whole-app allow", () => {
    for (const { provider, unlisted } of getAppPermissionDefinitions()) {
      const tools = catalogToolIds(provider);
      // The narrowest and the widest customization the API accepts.
      for (const allow of [tools.slice(0, 1), tools]) {
        expect(shape(provider, allow).at(-1), provider).toMatchObject(
          unlisted === "block"
            ? { action: "block", requireApproval: false, tools: [] }
            : { action: "allow", requireApproval: true, tools: [] },
        );
      }
    }
  });

  it("choosing every catalog tool leaves only the allow row and the approval terminal", () => {
    const stack = shape("cloudflare", catalogToolIds("cloudflare"));
    expect(stack.map((r) => [r.name, r.action, r.requireApproval])).toEqual([
      ["Grant: a · c: allowed", "allow", false],
      ["Grant: a · c: everything else", "allow", true],
    ]);
  });

  it("the approval terminal carries the stack's session policy; block rows never do", () => {
    const resources = { repositories: ["acme/api"] };
    const stack = shape(
      "github",
      [catalogToolIds("github")[0]!],
      [],
      resources,
    );
    for (const row of stack) {
      expect(row.conditions).toEqual(row.action === "allow" ? resources : null);
    }
    expect(stack.at(-1)).toMatchObject({
      requireApproval: true,
      conditions: resources,
    });
  });

  it.each(["aws", "aws-role"])(
    "%s opts in: its customized grant keeps the terminal whole-app block",
    (provider) => {
      const stack = shape(provider, ["s3_read_objects"]);
      expect(stack.at(-1)).toEqual({
        name: "Grant: a · c: everything else",
        action: "block",
        requireApproval: false,
        tools: [],
        conditions: null,
      });
    },
  );

  it("full access is a single whole-app allow for every provider", () => {
    for (const provider of ["cloudflare", "aws"]) {
      expect(
        compileConnectionStack("Grant: a · c", provider, { access: "full" }),
      ).toEqual([
        {
          name: "Grant: a · c",
          action: "allow",
          requireApproval: false,
          tools: [],
          conditions: null,
        },
      ]);
    }
  });
});

/** "All other reads" / "All other writes": the two catch-all rows. */
describe("compileConnectionStack: all other reads / writes", () => {
  const compile = (
    provider: string,
    extra: {
      otherReads?: "allow" | "ask" | "never";
      otherWrites?: "allow" | "ask" | "never";
    },
  ) =>
    compileConnectionStack("Grant: a · c", provider, {
      access: "custom",
      allow: [catalogToolIds(provider)[0] ?? ""],
      ask: [],
      ...extra,
    });

  it("absent choices compile exactly as before: one approval terminal", () => {
    const before = compile("github-app", {});
    const explicit = compile("github-app", {
      otherReads: "ask",
      otherWrites: "ask",
    });
    expect(explicit).toEqual(before);
    expect(before.at(-1)).toMatchObject({
      name: "Grant: a · c: everything else",
      action: "allow",
      requireApproval: true,
      tools: [],
    });
    expect(before.at(-1)?.method).toBeUndefined();
  });

  it("AWS defaults both to Never: the terminal block it always had", () => {
    expect(compile("aws", {}).at(-1)).toMatchObject({
      name: "Grant: a · c: everything else",
      action: "block",
      tools: [],
    });
  });

  it("different choices split the terminal: the stricter row first, narrowed", () => {
    const stack = compile("github-app", { otherReads: "allow" });
    const [writes, reads] = stack.slice(-2);
    // Writes (Needs approval) is stricter than reads (Allowed): it comes
    // first, narrowed to every method but GET/HEAD.
    expect(writes).toMatchObject({
      name: "Grant: a · c: all other writes",
      action: "allow",
      requireApproval: true,
      tools: [],
      method: "!GET,HEAD",
    });
    expect(reads).toMatchObject({
      name: "Grant: a · c: all other reads",
      action: "allow",
      requireApproval: false,
      tools: [],
    });
    expect(reads?.method).toBeUndefined();
    // The blocked complement still sits before both catch-alls.
    const blockedAt = stack.findIndex((r) => r.name.endsWith(": blocked"));
    expect(blockedAt).toBeGreaterThanOrEqual(0);
    expect(blockedAt).toBeLessThan(stack.length - 2);
  });

  it("stricter reads come first narrowed to GET,HEAD", () => {
    const [reads, writes] = compile("github-app", {
      otherReads: "never",
      otherWrites: "ask",
    }).slice(-2);
    expect(reads).toMatchObject({
      name: "Grant: a · c: all other reads",
      action: "block",
      method: "GET,HEAD",
    });
    expect(writes).toMatchObject({
      name: "Grant: a · c: all other writes",
      requireApproval: true,
    });
    expect(writes?.method).toBeUndefined();
  });

  // A gateway that predates method narrowing reads every whole-app row as
  // "any method". The first catch-all row then decides EVERY unlisted
  // request, so it must be the stricter choice: mid-deploy, a split grant
  // is never looser than the user asked.
  it("an old gateway (no method narrowing) only ever applies the stricter choice", () => {
    const rank = { allow: 0, ask: 1, never: 2 } as const;
    const choices = ["allow", "ask", "never"] as const;
    for (const otherReads of choices) {
      for (const otherWrites of choices) {
        const last = compile("github-app", { otherReads, otherWrites }).filter(
          (r) => r.tools.length === 0,
        );
        const first = last[0];
        const applied =
          first?.action === "block"
            ? "never"
            : first?.requireApproval
              ? "ask"
              : "allow";
        const stricter =
          rank[otherReads] >= rank[otherWrites] ? otherReads : otherWrites;
        expect(applied, `${otherReads}/${otherWrites}`).toBe(stricter);
      }
    }
  });

  it("Never on writes is a block; block rows carry no conditions", () => {
    const stack = compileConnectionStack(
      "Grant: a · c",
      "github-app",
      {
        access: "custom",
        allow: ["get_repo"],
        ask: [],
        otherReads: "allow",
        otherWrites: "never",
      },
      { repos: ["acme/web"] },
    );
    const byName = (n: string) => stack.find((r) => r.name.endsWith(n));
    const reads = byName(": all other reads");
    const writes = byName(": all other writes");
    expect(reads?.conditions).toEqual({ repos: ["acme/web"] });
    expect(writes).toMatchObject({ action: "block", requireApproval: false });
    expect(writes?.conditions ?? null).toBeNull();
  });
});

/** A stored stack reads back as the choices that compiled it. */
describe("stackToGrant: round-trips the catch-all choices", () => {
  type Row = Parameters<typeof stackToGrant>[0][number];
  // The minimal row shape `stackToGrant` reads, as `writeStack` stores it.
  const asRows = (stack: ReturnType<typeof compileConnectionStack>): Row[] =>
    stack.map(
      (r) =>
        ({
          action: r.action,
          requireApproval: r.requireApproval,
          targets: [
            {
              appTools: r.tools,
              method: r.method ?? null,
            },
          ],
        }) as unknown as Row,
    );
  const choices = ["allow", "ask", "never"] as const;
  /** The stack as if the catalog gained `added` after it was written: no row
   * names them (the blocked complement never listed them). */
  const withoutBlocked = (rows: Row[], added: string[]): Row[] =>
    rows.map((row) =>
      row.action === "block"
        ? ({
            ...row,
            targets: row.targets.map((t) => ({
              ...t,
              appTools: t.appTools.filter((id) => !added.includes(id)),
            })),
          } as Row)
        : row,
    );

  it.each(
    choices.flatMap((otherReads) =>
      choices.map((otherWrites) => ({ otherReads, otherWrites })),
    ),
  )("reads=$otherReads writes=$otherWrites", ({ otherReads, otherWrites }) => {
    const stack = compileConnectionStack("Grant: a · c", "github-app", {
      access: "custom",
      allow: ["get_repo"],
      ask: ["create_issue"],
      otherReads,
      otherWrites,
    });
    expect(stackToGrant(asRows(stack), "github-app")).toEqual({
      access: "custom",
      allow: ["get_repo"],
      ask: ["create_issue"],
      otherReads,
      otherWrites,
    });
  });

  it("a stack written before the rows existed reads as Ask + Ask", () => {
    const legacy = compileConnectionStack("Grant: a · c", "github-app", {
      access: "custom",
      allow: ["get_repo"],
      ask: [],
    });
    expect(stackToGrant(asRows(legacy), "github-app")).toMatchObject({
      otherReads: "ask",
      otherWrites: "ask",
    });
  });

  // A tool added to the catalog after the stack was written has no row of its
  // own: the gateway decides it on the catch-alls, so it must read back as
  // their choice, not as Never (a save would then block it).
  it("a tool no row names reads as the catch-all choice it falls to", () => {
    const stack = compileConnectionStack("Grant: a · c", "github-app", {
      access: "custom",
      allow: ["get_repo"],
      ask: [],
      otherReads: "allow",
      otherWrites: "never",
    });
    // A GET-only read and a POST-only write, both unnamed by any row.
    const grant = stackToGrant(
      withoutBlocked(asRows(stack), ["list_issues", "create_issue"]),
      "github-app",
    );
    expect(grant.allow).toEqual(["get_repo", "list_issues"]);
    expect(grant.ask).toEqual([]);
  });

  it("a later tool lands on the stricter catch-all when its methods span both", () => {
    // linear's tools name no method (any method, all on POST /graphql).
    const stack = compileConnectionStack("Grant: a · c", "linear", {
      access: "custom",
      allow: ["get_issue"],
      ask: [],
      otherReads: "allow",
      otherWrites: "ask",
    });
    const grant = stackToGrant(
      withoutBlocked(asRows(stack), ["list_issues"]),
      "linear",
    );
    expect(grant.allow).toEqual(["get_issue"]);
    expect(grant.ask).toEqual(["list_issues"]);
  });
});

describe("defaultConnectionGrant", () => {
  const toolsOf = (provider: string, category: "read" | "write") =>
    (getAppPermissionDefinition(provider)?.groups ?? [])
      .filter((g) => g.category === category)
      .flatMap((g) => g.tools.map((t) => t.id))
      .sort();

  it("allows reads, holds every write/delete tool and unlisted requests for approval", () => {
    const stack = compileConnectionStack(
      "G",
      "github",
      defaultConnectionGrant("github"),
    );
    expect(toolsOf("github", "write").length).toBeGreaterThan(0);
    expect(stack.map((r) => [r.action, r.requireApproval, r.tools])).toEqual([
      ["allow", false, toolsOf("github", "read")],
      ["allow", true, toolsOf("github", "write")],
      ["allow", true, []],
    ]);
  });

  it("AWS gets the same shape: reads allowed, writes need approval", () => {
    const stack = compileConnectionStack(
      "G",
      "aws-role",
      defaultConnectionGrant("aws-role"),
    );
    expect(stack.map((r) => [r.action, r.requireApproval, r.tools])).toEqual([
      ["allow", false, toolsOf("aws-role", "read")],
      ["allow", true, toolsOf("aws-role", "write")],
      ["allow", true, []],
    ]);
  });

  it("no catalog tool is ever 'Always allow' for writes by default, in any app", () => {
    for (const app of getApps()) {
      const grant = defaultConnectionGrant(app.id);
      if (grant.access !== "custom") continue;
      const writes = toolsOf(app.id, "write");
      expect(grant.allow.filter((t) => writes.includes(t))).toEqual([]);
    }
  });

  it("keeps full access for an app with no catalog", () => {
    expect(defaultConnectionGrant("jfrog-artifactory")).toEqual({
      access: "full",
    });
  });
});
