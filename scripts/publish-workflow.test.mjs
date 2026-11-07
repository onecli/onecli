import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pins the publish contract three ways: the publish.yml matrix, the
// docker/*.Dockerfile set, and the image names docker/docker-compose.yml
// pulls must all agree — the failure this prevents is a compose that pulls
// `ghcr.io/onecli/onecli-<service>` images no workflow ever published, which
// breaks every clean-machine install. Also pins the repository guard that
// keeps both workflows inert outside onecli/onecli, and the prerelease gate
// that keeps an -rc tag from capturing `latest`.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const publishYml = read(".github/workflows/publish.yml");
const releaseYml = read(".github/workflows/release.yml");
const composeYml = read("docker/docker-compose.yml");

// The two matrix lines (build + merge jobs). `include:` entries and the
// arch axis don't match this shape, so the extraction can't over-collect.
const serviceLines = [...publishYml.matchAll(/^\s*service: \[([^\]]+)\]\s*$/gm)];
const services = new Set(
  serviceLines[0]?.[1].split(",").map((s) => s.trim()) ?? [],
);

test("publish.yml has exactly two identical service matrices (build + merge)", () => {
  assert.equal(serviceLines.length, 2);
  assert.equal(serviceLines[0][1], serviceLines[1][1]);
  assert.ok(services.size > 0);
});

test("the matrix equals the docker/*.Dockerfile set, minus the agent's base image", () => {
  // docker/agent-base.Dockerfile is not a service: it is the OS surface the
  // agent image stacks on, published as onecli-agent-base by the
  // agent's own matrix entry (below), never pulled by compose on its own.
  const dockerfiles = readdirSync(
    fileURLToPath(new URL("../docker", import.meta.url)),
  )
    .filter((f) => f.endsWith(".Dockerfile"))
    .map((f) => f.replace(/\.Dockerfile$/, ""));
  assert.ok(
    dockerfiles.includes("agent-base"),
    "agent-base.Dockerfile went missing",
  );
  assert.deepEqual(
    new Set(dockerfiles.filter((f) => f !== "agent-base")),
    services,
  );
});

test("the agent matrix entry builds its base first and stacks on it by digest", () => {
  // The base is built in the same job (per arch), pushed by digest to its
  // own GHCR name, and handed to the agent build through the one arg the
  // Dockerfile exposes. A tag here (not a digest) would let a re-pushed
  // base change a published agent image after the fact.
  assert.match(publishYml, /file: docker\/agent-base\.Dockerfile/);
  // Pushed by digest to the base's own name (composed like every other
  // image here), then consumed by that digest.
  assert.match(
    publishYml,
    /name=\$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}-agent-base,push-by-digest=true/,
  );
  assert.match(
    publishYml,
    /AGENT_BASE_IMAGE=\$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}-agent-base@\$\{\{ steps\.[\w-]+\.outputs\.digest \}\}/,
  );
  // Only the agent entry pays for the base build.
  assert.match(publishYml, /if: matrix\.service == 'agent'/);
});

test("the base gets its own tagged multi-arch manifest, from artifacts the agent's glob cannot swallow", () => {
  // The merge job tags `-agent-base` like every service (so a self-hoster
  // can `FROM ghcr.io/onecli/onecli-agent-base:<version>`, and GHCR does not
  // fill with untagged versions). Its per-arch digests travel in their own
  // artifact family: `digest-agent-*` matches `digest-agent-base-amd64`
  // too, which would hand the base's digest to the AGENT manifest.
  assert.match(publishYml, /name: base-digest-\$\{\{ matrix\.arch \}\}\n/);
  assert.match(publishYml, /pattern: base-digest-\*\n/);
  assert.doesNotMatch(publishYml, /name: digest-agent-base/);
  assert.match(
    publishYml,
    /images: \$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}-agent-base\n/,
  );
  assert.match(
    publishYml,
    /imagetools create[^\n]*\n\s+\$\(printf '\$\{\{ env\.REGISTRY \}\}\/\$\{\{ env\.IMAGE_NAME \}\}-agent-base@sha256:%s ' \*\)/,
  );
});

test("every image the compose pulls is in the matrix", () => {
  // Captures the `-<service>` suffix and stops at the tag colon, so the
  // nested RUNNER_AGENT_IMAGE default parses too; the legacy all-in-one
  // `ghcr.io/onecli/onecli:` (no dash suffix) intentionally doesn't match.
  const pulled = [
    ...composeYml.matchAll(/ghcr\.io\/onecli\/onecli-([a-z0-9-]+):/g),
  ].map((m) => m[1]);
  assert.ok(pulled.length > 0);
  for (const name of pulled)
    assert.ok(services.has(name), `compose pulls unpublished image: ${name}`);
  // The agent image is not a compose service (it's the RUNNER_AGENT_IMAGE
  // default the runner pulls lazily) — assert it explicitly so dropping it
  // from the compose default can't silently orphan the matrix entry.
  assert.ok(pulled.includes("agent"));
});

const jobBlocks = (yml) => {
  const tail = yml.slice(yml.indexOf("\njobs:"));
  const blocks = [];
  for (const line of tail.split("\n")) {
    const job = line.match(/^ {2}([\w-]+):\s*$/);
    if (job) blocks.push({ name: job[1], body: "" });
    else if (blocks.length) blocks[blocks.length - 1].body += `${line}\n`;
  }
  return blocks;
};

test("every job in both workflows carries the onecli/onecli repository guard", () => {
  const all = [...jobBlocks(publishYml), ...jobBlocks(releaseYml)];
  assert.ok(all.length >= 3);
  for (const { name, body } of all)
    assert.match(
      body,
      /^ {4}if: github\.repository == 'onecli\/onecli'$/m,
      `job "${name}" is missing the repository guard`,
    );
});

test("the latest tag is gated off prerelease refs", () => {
  assert.match(
    publishYml,
    /type=raw,value=latest,enable=\$\{\{ !contains\(github\.ref_name, '-'\) \}\}/,
  );
  assert.doesNotMatch(publishYml, /type=raw,value=latest\s*$/m);
});

// sigstore/cosign-installer publishes floating major tags only up to v3.
// `@v4` does not exist, so the chart job dies in "Set up job" before any
// step runs (release 2.11.0). A tag-push job runs nowhere else first, so
// this is the only gate between a floating pin and a broken release.
test("cosign-installer is pinned to an exact v4 release tag", () => {
  const refs = [
    ...publishYml.matchAll(/uses: sigstore\/cosign-installer@(\S+)/g),
  ].map((m) => m[1]);
  assert.equal(refs.length, 1, "the chart job installs cosign exactly once");
  assert.match(
    refs[0],
    /^v4\.\d+\.\d+$/,
    `cosign-installer@${refs[0]} is not an exact v4.x.y tag`,
  );
});

// `helm registry login` writes helm's own registry config, which cosign
// does not read: the chart pushed and the signature upload came back
// UNAUTHORIZED (release 2.11.1). docker/login-action writes the Docker
// credential store, which helm falls back to and cosign reads, so one
// login serves both tools.
test("the chart job logs in through docker/login-action, never helm registry login", () => {
  const chart = jobBlocks(publishYml).find(({ name }) => name === "chart");
  assert.ok(chart, "publish.yml has a chart job");
  const steps = chart.body
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.doesNotMatch(steps, /helm registry login/);
  assert.match(steps, /uses: docker\/login-action@v\d+/);
  assert.match(steps, /registry: \$\{\{ env\.REGISTRY \}\}/);
});
