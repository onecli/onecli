import type { Prisma } from "@onecli/db";
import { describe, expect, it } from "vitest";
import { getAppPermissionDefinitions } from "../apps/app-permissions";
import { catalogToolIds } from "../apps/app-permissions/validate";
import { compileConnectionStack } from "./grants-compile";

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
