import { cpSync, mkdirSync } from "node:fs";
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

// The MCP bridge is spawned as a separate process (harness/jcode.ts), so no
// import reaches it and esbuild never emits it — copy it beside the bundle,
// where resolveMcpBridgePath() looks first.
mkdirSync("dist/mcp-bridge", { recursive: true });
cpSync("src/mcp-bridge/bridge.mjs", "dist/mcp-bridge/bridge.mjs");
