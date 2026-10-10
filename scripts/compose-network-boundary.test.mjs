import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("PostgreSQL does not inherit the agent-reachable bind address", () => {
  for (const file of [
    "docker/docker-compose.yml",
    "docker/docker-compose.dev.yml",
  ]) {
    const compose = read(file);
    assert.doesNotMatch(
      compose,
      /\$\{ONECLI_BIND_HOST:-127\.0\.0\.1\}:\$\{POSTGRES_PORT:-5432\}:5432/,
    );
    assert.match(
      compose,
      /\$\{ONECLI_POSTGRES_BIND_HOST:-127\.0\.0\.1\}:\$\{POSTGRES_PORT:-5432\}:5432/,
    );
  }
});

test("the gateway retains the agent-reachable bind address", () => {
  assert.match(
    read("docker/docker-compose.yml"),
    /\$\{ONECLI_BIND_HOST:-127\.0\.0\.1\}:\$\{ONECLI_GATEWAY_PORT:-10255\}:10255/,
  );
});
