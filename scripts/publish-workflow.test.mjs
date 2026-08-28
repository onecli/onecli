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

test("the matrix equals the docker/*.Dockerfile set", () => {
  const dockerfiles = readdirSync(
    fileURLToPath(new URL("../docker", import.meta.url)),
  )
    .filter((f) => f.endsWith(".Dockerfile"))
    .map((f) => f.replace(/\.Dockerfile$/, ""));
  assert.deepEqual(new Set(dockerfiles), services);
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
