import { build } from "esbuild";

// Production bundle: inline the app plus its @onecli/* workspace deps (which
// export raw .ts), keep every npm package external so it resolves from
// node_modules at runtime. The bundle's ONLY external npm import today is
// zod. Inlined-only workspace deps whose OWN npm tree the bundle never
// touches (@onecli/api — the pure-data app catalog and wire constants)
// belong in devDependencies as a statement of intent — but note the image
// does NOT get slimmer from that alone: turbo prune carries dev workspace
// deps into out/json, and a hoisted-linker `pnpm install --prod` there
// installs every pruned project's own prod tree (measured: +365MB of
// Prisma/AWS/Stripe for the Slack daemon; --filter/--filter-prod are
// ineffective under the hoisted linker). Slimming the runner image is a
// recorded follow-up (plans/v2-todo.md) — the fix belongs in
// docker/channel-adapter.Dockerfile with its own verification against
// publish.yml.
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
