import { existsSync } from "node:fs";
import { build } from "esbuild";

// Production bundle: inline the app plus its @onecli/* workspace deps (which
// export raw .ts), keep every npm package external so it resolves from
// node_modules at runtime.
const bundle = (entry, outfile) =>
  build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    plugins: [
      {
        name: "external-node-modules",
        setup(builder) {
          // Bare specifiers only: relative ("./"), absolute ("/"), and
          // package-internal "#" subpath imports stay with esbuild's resolver.
          builder.onResolve({ filter: /^[^./#]/ }, (args) =>
            args.path.startsWith("@onecli/") ? undefined : { external: true },
          );
        },
      },
    ],
  });

await bundle("src/index.ts", "dist/index.mjs");
// A deployment's own entry, when it exists beside this file (a hosted
// deployment keeps one; a self-host checkout has none and builds nothing
// extra). Resolved at build time so its absence is never an error.
if (existsSync("cloud-main.mjs")) {
  await bundle("cloud-main.mjs", "dist/cloud.mjs");
}
