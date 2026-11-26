import { cpSync, mkdirSync } from "node:fs";
import { build } from "esbuild";

// Production bundle: inline the app plus its @onecli/* workspace deps (which
// export raw .ts), keep every npm package external so it resolves from
// node_modules at runtime.
const shared = {
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
};

await build({
  ...shared,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
});

// The browser driver is two processes of its own, started by the agent's
// shell and not by the supervisor: the `onecli-browser` command (every
// call) and the daemon it spawns (once, then shared). Each gets its own
// bundle so neither loads the supervisor, and the command's stays small
// enough to be the per-call cost.
await build({
  ...shared,
  entryPoints: {
    "browser-driver/cli": "src/browser-driver/cli-main.ts",
    "browser-driver/daemon": "src/browser-driver/daemon-main.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
});

// The MCP bridge is spawned as a separate process (harness/jcode.ts), so no
// import reaches it and esbuild never emits it — copy it beside the bundle,
// where resolveMcpBridgePath() looks first.
mkdirSync("dist/mcp-bridge", { recursive: true });
cpSync("src/mcp-bridge/bridge.mjs", "dist/mcp-bridge/bridge.mjs");
