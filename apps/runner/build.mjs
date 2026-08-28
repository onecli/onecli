import { build } from "esbuild";

// Production bundle: inline the app plus its @onecli/* workspace deps (which
// export raw .ts), keep every npm package external so it resolves from
// node_modules at runtime.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
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
