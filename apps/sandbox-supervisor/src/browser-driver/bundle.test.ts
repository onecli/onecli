import { build } from "esbuild";
import { describe, expect, it } from "vitest";

/**
 * The command is the per-call cost: a fresh Node process for every verb the
 * agent runs. Its bundle must import nothing but Node's own modules; a
 * library pulled in by accident (zod through a value import from
 * protocol.ts, patchright through the driver) adds tens of milliseconds to
 * every verb and is invisible in the source. Bundled here the way build.mjs
 * does it (externals stay external), then the import list is read back.
 */
const externalImports = async (entry: string): Promise<string[]> => {
  const result = await build({
    entryPoints: [new URL(entry, import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    plugins: [
      {
        name: "external-node-modules",
        setup(builder) {
          builder.onResolve({ filter: /^[^./#]/ }, (args) =>
            args.path.startsWith("@onecli/") ? undefined : { external: true },
          );
        },
      },
    ],
  });
  const text = result.outputFiles[0]?.text ?? "";
  return [...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1] ?? "");
};

describe("the browser driver bundles", () => {
  it("the command imports only node: modules", async () => {
    const imports = await externalImports("./cli-main.ts");
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => !i.startsWith("node:"))).toEqual([]);
  });

  it("the daemon is where patchright and zod live", async () => {
    const imports = await externalImports("./daemon-main.ts");
    expect(imports).toContain("patchright");
    expect(imports).toContain("zod");
  });
});
